import type { Db } from './db.ts'
import { newId, now, parseJson } from './db.ts'
import type { Domain, JobKind, JobSink } from './domain.ts'
import type { AgentRuntimePool } from './agents/runtime.ts'
import { buildPrompt } from './agents/prompts.ts'

interface JobRow {
  id: string
  kind: JobKind
  agent_id: string
  payload: string
  status: string
  attempts: number
}

const MAX_ATTEMPTS = 2

const ACTIVITY: Record<JobKind, string> = {
  triage: '整理新任务',
  execute: '执行任务',
  review_suggest: '看交付，准备确认建议',
  discussion_reply: '在讨论里发言',
  discussion_moderate: '总结讨论',
  decide_suggest: '准备定夺建议',
}

/**
 * Durable job queue. Jobs survive restarts; one agent runs one job at a time; the pool bounds total concurrency.
 * After each agent turn the runner checks that the expected effect happened, retries once, and otherwise falls
 * back to a state a human can act on, so the flow never silently stalls.
 */
export class JobRunner implements JobSink {
  private readonly db: Db
  private domain!: Domain
  private readonly pool: AgentRuntimePool
  private readonly busyAgents = new Set<string>()
  private readonly inflight = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private onIdleWaiters: Array<() => void> = []

  constructor(db: Db, pool: AgentRuntimePool) {
    this.db = db
    this.pool = pool
  }

  attach(domain: Domain): void {
    this.domain = domain
  }

  start(): void {
    this.db.run("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
    this.timer = setInterval(() => this.tick(), 500)
    this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await Promise.allSettled([...this.inflight])
  }

  enqueue(kind: JobKind, agentId: string, payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload)
    const dup = this.db.get("SELECT 1 FROM jobs WHERE kind = ? AND agent_id = ? AND payload = ? AND status = 'queued'", kind, agentId, json)
    if (dup) return
    this.db.insert('jobs', { id: newId('job'), kind, agent_id: agentId, payload: json, status: 'queued', attempts: 0, created_at: now(), updated_at: now() })
    queueMicrotask(() => this.tick())
  }

  /** Resolves when no job is queued or running (used by tests and graceful shutdown). */
  idle(timeoutMs = 120_000): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('jobs did not settle')), timeoutMs)
      this.onIdleWaiters.push(() => { clearTimeout(t); resolve() })
    })
  }

  private isIdle(): boolean {
    const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")
    return (row?.n ?? 0) === 0 && this.inflight.size === 0
  }

  private tick(): void {
    if (this.stopped || !this.domain) return
    const queued = this.db.all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 50")
    for (const job of queued) {
      if (this.busyAgents.has(job.agent_id)) continue
      this.busyAgents.add(job.agent_id)
      this.db.update('jobs', job.id, { status: 'running', attempts: job.attempts + 1, updated_at: now() })
      const p = this.execute({ ...job, attempts: job.attempts + 1 }).finally(() => {
        this.busyAgents.delete(job.agent_id)
        this.inflight.delete(p)
        if (this.isIdle()) for (const w of this.onIdleWaiters.splice(0)) w()
        else queueMicrotask(() => this.tick())
      })
      this.inflight.add(p)
    }
    if (this.isIdle()) for (const w of this.onIdleWaiters.splice(0)) w()
  }

  private async execute(job: JobRow): Promise<void> {
    const payload = parseJson<Record<string, unknown>>(job.payload, {})
    const d = this.domain
    let error: string | null = null
    try {
      if (!this.stillRelevant(job.kind, payload)) {
        this.db.update('jobs', job.id, { status: 'done', error: 'skipped: no longer relevant', updated_at: now() })
        return
      }
      const agent = d.agent(job.agent_id)
      d.setActivity(agent.id, ACTIVITY[job.kind])
      if (job.kind === 'execute') d.db.update('tasks', String(payload.taskId), { live: `${agent.name}在${payload.feedback ? '按打回意见修改' : '执行'}`, updated_at: now() })
      if (job.kind === 'execute' || job.kind === 'triage') d.touch(d.task(String(payload.taskId)).space_id)
      const prompt = buildPrompt(d, job.kind, agent.id, payload)
      const result = await this.pool.run(agent, prompt)
      this.db.update('jobs', job.id, { dsh_session_id: result.sessionId })
      if (!this.effectHappened(job.kind, payload, job.agent_id)) error = `agent 没有完成预期操作（${result.finishReason ?? 'unknown'}）：${result.finalResponse.slice(0, 300)}`
    } catch (e) {
      error = (e as Error).message
    } finally {
      try { d.setActivity(job.agent_id, '') } catch { /* agent may be gone */ }
    }
    if (!error) {
      if (job.kind === 'execute') d.countStandardUse(d.task(String(payload.taskId)).space_id)
      this.db.update('jobs', job.id, { status: 'done', error: null, updated_at: now() })
    } else if (job.attempts < MAX_ATTEMPTS) {
      this.db.update('jobs', job.id, { status: 'queued', error, updated_at: now() })
    } else {
      this.db.update('jobs', job.id, { status: 'failed', error, updated_at: now() })
      this.fallback(job.kind, payload, error)
    }
    if (job.kind === 'discussion_reply' && (this.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', job.id)?.status !== 'queued')) {
      d.maybeModerate(String(payload.discussionId))
    }
  }

  private stillRelevant(kind: JobKind, p: Record<string, unknown>): boolean {
    const d = this.domain
    switch (kind) {
      case 'triage': return d.task(String(p.taskId)).status === 'triage'
      case 'execute': { const t = d.task(String(p.taskId)); return t.status === 'in_progress' && !t.blocked_by_discussion }
      case 'review_suggest': return d.task(String(p.taskId)).status === 'review' && !this.hasOpenJudgment('confirm', String(p.taskId))
      case 'discussion_reply':
      case 'discussion_moderate': return d.discussion(String(p.discussionId)).status === 'open'
      case 'decide_suggest': return d.discussion(String(p.discussionId)).status === 'escalated' && !this.hasOpenJudgment('decide', String(p.discussionId))
    }
  }

  private effectHappened(kind: JobKind, p: Record<string, unknown>, agentId: string): boolean {
    const d = this.domain
    switch (kind) {
      case 'triage': return d.task(String(p.taskId)).status !== 'triage'
      case 'execute': { const t = d.task(String(p.taskId)); return t.status !== 'in_progress' || !!t.blocked_by_discussion }
      case 'review_suggest': return this.hasOpenJudgment('confirm', String(p.taskId)) || d.task(String(p.taskId)).status !== 'review'
      case 'discussion_reply': {
        const msgs = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM discussion_messages WHERE discussion_id = ? AND author_id = ?', String(p.discussionId), agentId)
        return (msgs?.n ?? 0) > 0 || d.discussion(String(p.discussionId)).status !== 'open'
      }
      case 'discussion_moderate': return d.discussion(String(p.discussionId)).status !== 'open'
      case 'decide_suggest': return this.hasOpenJudgment('decide', String(p.discussionId)) || d.discussion(String(p.discussionId)).status !== 'escalated'
    }
  }

  private hasOpenJudgment(kind: 'confirm' | 'decide', refId: string): boolean {
    return !!this.db.get("SELECT 1 FROM judgments WHERE kind = ? AND ref_id = ? AND status = 'open'", kind, refId)
  }

  /** Put the work in front of a person instead of letting it stall. */
  private fallback(kind: JobKind, p: Record<string, unknown>, error: string): void {
    const d = this.domain
    const short = error.slice(0, 160)
    switch (kind) {
      case 'triage': {
        const t = d.task(String(p.taskId))
        if (t.status !== 'triage') return
        d.db.update('tasks', t.id, { status: 'unclaimed', owner_id: t.creator_id, live: '空间助理没能整理，请人工认领', updated_at: now() })
        d.event(t.id, 'system', null, '空间', `空间助理整理失败，已转为待认领。原因：${short}`)
        d.touch(t.space_id)
        return
      }
      case 'execute': {
        const t = d.task(String(p.taskId))
        d.db.update('tasks', t.id, { live: '执行 agent 没能完成，需要人处理', updated_at: now() })
        d.event(t.id, 'system', null, '空间', `执行失败，已停止自动重试。原因：${short}`)
        d.touch(t.space_id)
        return
      }
      case 'review_suggest': {
        const t = d.task(String(p.taskId))
        if (!t.owner_id || this.hasOpenJudgment('confirm', t.id)) return
        d.db.insert('judgments', { id: newId('j'), space_id: t.space_id, user_id: t.owner_id, kind: 'confirm', ref_id: t.id, title: t.title, suggestion: '', suggested_action: '', basis: '你的 agent 没能给出建议，请直接查看交付', created_at: now() })
        d.bus.publish(`user:${t.owner_id}`, { type: 'judgments' })
        d.touch(t.space_id)
        return
      }
      case 'discussion_reply':
        return
      case 'discussion_moderate': {
        const disc = d.discussion(String(p.discussionId))
        if (disc.status !== 'open') return
        d.escalateDiscussion(d.assistantOf(disc.space_id), { discussion_id: disc.id, summary: `空间助理没能总结这次讨论（${short}），请 owner 直接看发言后定夺`, options: [] })
        return
      }
      case 'decide_suggest': {
        const disc = d.discussion(String(p.discussionId))
        if (this.hasOpenJudgment('decide', disc.id)) return
        const s = d.space(disc.space_id)
        d.db.insert('judgments', { id: newId('j'), space_id: s.id, user_id: s.owner_id, kind: 'decide', ref_id: disc.id, title: disc.title, suggestion: '', suggested_action: '', basis: '你的 agent 没能给出建议，请直接定夺', created_at: now() })
        d.bus.publish(`user:${s.owner_id}`, { type: 'judgments' })
        d.touch(s.id)
        return
      }
    }
  }
}
