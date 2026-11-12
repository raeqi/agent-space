import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from './config.ts'
import type { Domain, User } from './domain.ts'
import { DomainError } from './domain.ts'
import { newToken, now, parseJson } from './db.ts'
import type { AgentRuntimePool } from './agents/runtime.ts'
import { buildMemoryQuestion } from './agents/prompts.ts'
import type { BusEvent } from './bus.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

type Body = Record<string, unknown>
const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function registerApi(app: FastifyInstance, config: Config, domain: Domain, pool: AgentRuntimePool): void {
  const db = domain.db

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DomainError) return reply.status(error.status).send({ error: error.message })
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) app.log.error(error)
    return reply.status(status).send({ error: status >= 500 ? '服务出错了，请稍后再试' : (error as Error).message })
  })

  async function auth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = req.cookies.sid
    const unsigned = raw ? req.unsignCookie(raw) : null
    const token = unsigned?.valid ? unsigned.value : null
    const row = token ? db.get<{ user_id: string }>('SELECT user_id FROM login_sessions WHERE token = ?', token) : undefined
    if (!row) {
      await reply.status(401).send({ error: '请先登录' })
      return
    }
    req.user = domain.user(row.user_id)
  }

  const me = (req: FastifyRequest): User => req.user!

  // ---------- auth ----------

  app.post('/api/login', async (req, reply) => {
    const b = (req.body ?? {}) as Body
    if (config.accessCode && str(b.accessCode) !== config.accessCode) throw new DomainError('访问码不对', 403)
    const user = domain.ensureUser(str(b.email, 200), str(b.name, 40))
    const token = newToken()
    db.insert('login_sessions', { token, user_id: user.id, created_at: now() })
    reply.setCookie('sid', token, { path: '/', httpOnly: true, sameSite: 'lax', signed: true, maxAge: 60 * 60 * 24 * 30, secure: req.protocol === 'https' })
    return { user }
  })

  app.post('/api/logout', async (req, reply) => {
    const raw = req.cookies.sid
    const unsigned = raw ? req.unsignCookie(raw) : null
    if (unsigned?.valid && unsigned.value) db.run('DELETE FROM login_sessions WHERE token = ?', unsigned.value)
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })

  app.get('/api/health', async () => ({ ok: true }))
  // Lets the web app check the login state without a 401 in the console.
  app.get('/api/session', async (req) => {
    const raw = req.cookies.sid
    const unsigned = raw ? req.unsignCookie(raw) : null
    const row = unsigned?.valid && unsigned.value ? db.get<{ user_id: string }>('SELECT user_id FROM login_sessions WHERE token = ?', unsigned.value) : undefined
    return { loggedIn: !!row }
  })
  app.get('/api/config', async () => ({ accessCodeRequired: !!config.accessCode, model: config.model, demoMode: config.demoMode }))

  // ---------- me ----------

  app.get('/api/me', { preHandler: auth }, async (req) => {
    const agent = domain.personalAgent(me(req).id)
    return { user: me(req), agent: { id: agent.id, name: agent.name, public_profile: agent.public_profile, handbook: agent.handbook, activity: agent.activity } }
  })

  app.put('/api/me/agent', { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Body
    const a = domain.updatePersonalAgent(me(req).id, { public_profile: typeof b.public_profile === 'string' ? b.public_profile : undefined, handbook: typeof b.handbook === 'string' ? b.handbook : undefined })
    return { agent: { id: a.id, name: a.name, public_profile: a.public_profile, handbook: a.handbook } }
  })

  app.get('/api/judgments', { preHandler: auth }, async (req) => {
    return {
      judgments: domain.judgmentsFor(me(req).id).map((j) => {
        if (j.kind === 'confirm') {
          const art = db.get('SELECT id, title, kind, version, content, self_check FROM artifacts WHERE task_id = ? ORDER BY version DESC LIMIT 1', j.ref_id)
          return { ...j, artifact: art ? { ...art, self_check: parseJson(art.self_check, []) } : null, link: `/spaces/${j.space_id}/tasks/${j.ref_id}` }
        }
        const disc = db.get<{ summary: string; options: string }>('SELECT summary, options FROM discussions WHERE id = ?', j.ref_id)
        return { ...j, summary: disc?.summary ?? '', options: parseJson(disc?.options, []), link: `/spaces/${j.space_id}/discussions/${j.ref_id}` }
      }),
    }
  })

  app.post('/api/judgments/:id', { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Body
    const action = str(b.action) as 'pass' | 'reject' | 'accept' | 'override'
    domain.resolveJudgment(me(req).id, (req.params as { id: string }).id, { action, reason: str(b.reason, 300), choice: str(b.choice, 1000), saveAsStandard: b.saveAsStandard === true, standardScope: str(b.standardScope, 20) })
    return { ok: true }
  })

  app.get('/api/worklog', { preHandler: auth }, async (req) => {
    return { items: db.all(`SELECT w.*, s.name AS space_name FROM work_log w LEFT JOIN spaces s ON s.id = w.space_id WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT 200`, me(req).id) }
  })

  app.get('/api/tasks/mine', { preHandler: auth }, async (req) => {
    return { tasks: db.all(`SELECT t.id, t.title, t.status, t.live, t.space_id, s.name AS space_name FROM tasks t JOIN spaces s ON s.id = t.space_id
      WHERE t.owner_id = ? AND t.status NOT IN ('done','merged') ORDER BY t.updated_at DESC LIMIT 20`, me(req).id) }
  })

  // ---------- spaces ----------

  app.get('/api/spaces', { preHandler: auth }, async (req) => {
    const uid = me(req).id
    return {
      spaces: db.all(`SELECT s.id, s.name, s.goal_title, s.goal_due, s.owner_id,
        (SELECT COUNT(*) FROM judgments j WHERE j.space_id = s.id AND j.user_id = ? AND j.status = 'open') AS pending
        FROM spaces s JOIN members m ON m.space_id = s.id AND m.user_id = ? AND m.left_at IS NULL ORDER BY s.created_at`, uid, uid),
    }
  })

  app.post('/api/spaces', { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Body
    const members = Array.isArray(b.members) ? (b.members as Body[]).map((m) => ({ email: str(m.email, 200), name: str(m.name, 40), title: str(m.title, 40) })) : []
    const s = domain.createSpace(me(req).id, { name: str(b.name, 60), goalTitle: str(b.goalTitle, 200), goalDue: str(b.goalDue, 20), goalMetrics: strArr(b.goalMetrics), members, ownerTitle: str(b.ownerTitle, 40) || 'owner' })
    return { space: s }
  })

  function space(req: FastifyRequest): string {
    const id = (req.params as { id: string }).id
    domain.requireMember(id, me(req).id)
    return id
  }

  app.get('/api/spaces/:id', { preHandler: auth }, async (req) => {
    const id = space(req)
    const { webhook_token: _hidden, ...s } = domain.space(id)
    const counts = db.get(`SELECT
      SUM(status = 'triage') AS triage, SUM(status = 'unclaimed') AS unclaimed, SUM(status = 'in_progress') AS in_progress,
      SUM(status = 'review') AS review, SUM(status = 'done') AS done, COUNT(*) AS total FROM tasks WHERE space_id = ? AND status != 'merged'`, id)
    return {
      space: { ...s, goal_metrics: parseJson(s.goal_metrics, []) },
      members: domain.members(id),
      agents: domain.spaceAgents(id).map((a) => ({ id: a.id, kind: a.kind, name: a.name, specialty: a.specialty, activity: a.activity })),
      counts,
      waiting: db.all(`SELECT j.id, j.kind, j.title, j.ref_id, u.name AS user_name, j.user_id FROM judgments j JOIN users u ON u.id = j.user_id WHERE j.space_id = ? AND j.status = 'open' ORDER BY j.created_at`, id),
      openDiscussions: db.all("SELECT id, title, status FROM discussions WHERE space_id = ? AND status != 'resolved' ORDER BY created_at DESC", id),
      planning: !!db.get("SELECT 1 FROM jobs WHERE kind = 'plan' AND status IN ('queued','running') AND json_extract(payload, '$.spaceId') = ?", id),
      recentMemory: db.all('SELECT kind, text, created_at FROM memory WHERE space_id = ? ORDER BY created_at DESC LIMIT 5', id),
      activeTasks: db.all(`SELECT t.id, t.title, t.live, t.blocked_by_discussion, a.id AS agent_id, a.name AS agent_name FROM tasks t JOIN agents a ON a.id = t.executor_agent_id
        WHERE t.space_id = ? AND t.status = 'in_progress' ORDER BY t.updated_at DESC LIMIT 8`, id),
    }
  })

  app.put('/api/spaces/:id/goal', { preHandler: auth }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return { space: domain.updateGoal(id, me(req).id, { goalTitle: str(b.goalTitle, 200), goalDue: str(b.goalDue, 20), goalMetrics: strArr(b.goalMetrics) }) }
  })

  // Event entry: external systems (webhooks, IM bots) turn events into tasks. Authenticated by the space's token.
  app.post('/api/hooks/spaces/:id/events', async (req) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : str((req.query as Body).token, 200)
    const id = (req.params as { id: string }).id
    domain.spaceByWebhookToken(id, token)
    const b = (req.body ?? {}) as Body
    const t = domain.createTaskFromEvent(id, { source: str(b.source, 40) || 'webhook', text: str(b.text, 4000), from: str(b.from, 40) })
    return { task: { id: t.id, status: t.status } }
  })

  app.get('/api/spaces/:id/hook', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { url: `/api/hooks/spaces/${id}/events`, token: domain.webhookToken(id, me(req).id) }
  })

  app.post('/api/spaces/:id/hook/rotate', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { token: domain.webhookToken(id, me(req).id, true) }
  })

  app.post('/api/spaces/:id/hook/test', { preHandler: auth }, async (req) => {
    const id = space(req)
    domain.webhookToken(id, me(req).id)
    const b = (req.body ?? {}) as Body
    const t = domain.createTaskFromEvent(id, { source: str(b.source, 40) || '测试事件', text: str(b.text, 4000), from: str(b.from, 40) })
    return { task: { id: t.id } }
  })

  app.post('/api/spaces/:id/plan', { preHandler: auth }, async (req) => {
    const id = space(req)
    if (domain.space(id).owner_id !== me(req).id) throw new DomainError('只有 owner 可以让空间助理重新拆解', 403)
    domain.requestPlan(id)
    return { ok: true }
  })

  app.post('/api/spaces/:id/members', { preHandler: auth }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return { user: domain.addMember(id, me(req).id, str(b.email, 200), str(b.name, 40), str(b.title, 40)) }
  })

  app.post('/api/spaces/:id/handover', { preHandler: auth }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return domain.handover(id, me(req).id, str(b.leavingUserId), str(b.successorId))
  })

  // ---------- tasks ----------

  app.get('/api/spaces/:id/tasks', { preHandler: auth }, async (req) => {
    const id = space(req)
    return {
      tasks: db.all(`SELECT t.*, o.name AS owner_name, a.name AS executor_name,
        (SELECT title FROM discussions d WHERE d.id = t.blocked_by_discussion) AS blocked_title
        FROM tasks t LEFT JOIN users o ON o.id = t.owner_id LEFT JOIN agents a ON a.id = t.executor_agent_id
        WHERE t.space_id = ? ORDER BY t.updated_at DESC`, id).map((t) => ({ ...t, acceptance: parseJson(t.acceptance, []) })),
    }
  })

  app.post('/api/spaces/:id/tasks', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { task: domain.createTask(id, me(req).id, str(((req.body ?? {}) as Body).text, 4000)) }
  })

  function task(req: FastifyRequest): ReturnType<Domain['task']> {
    const t = domain.task((req.params as { id: string }).id)
    domain.requireMember(t.space_id, me(req).id)
    return t
  }

  app.get('/api/tasks/:id', { preHandler: auth }, async (req) => {
    const t = task(req)
    return {
      task: { ...t, acceptance: parseJson(t.acceptance, []), owner_name: t.owner_id ? domain.user(t.owner_id).name : null, executor_name: t.executor_agent_id ? domain.agent(t.executor_agent_id).name : null },
      events: db.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at', t.id),
      artifacts: db.all('SELECT * FROM artifacts WHERE task_id = ? ORDER BY version DESC', t.id).map((a) => ({ ...a, self_check: parseJson(a.self_check, []) })),
      discussions: db.all('SELECT id, title, status, outcome FROM discussions WHERE task_id = ? ORDER BY created_at DESC', t.id),
      judgment: db.get("SELECT * FROM judgments WHERE kind = 'confirm' AND ref_id = ? AND status = 'open'", t.id) ?? null,
    }
  })

  app.post('/api/tasks/:id/claim', { preHandler: auth }, async (req) => {
    const t = task(req)
    return { task: domain.claimTask(t.id, me(req).id, str(((req.body ?? {}) as Body).executorAgentId)) }
  })

  // ---------- discussions ----------

  app.get('/api/spaces/:id/discussions', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { discussions: db.all(`SELECT d.id, d.title, d.status, d.outcome, d.task_id, d.created_at, a.name AS opened_by, t.title AS task_title
      FROM discussions d LEFT JOIN agents a ON a.id = d.opened_by_agent_id LEFT JOIN tasks t ON t.id = d.task_id WHERE d.space_id = ? ORDER BY d.status = 'resolved', d.created_at DESC`, id) }
  })

  app.get('/api/discussions/:id', { preHandler: auth }, async (req) => {
    const d = domain.discussion((req.params as { id: string }).id)
    domain.requireMember(d.space_id, me(req).id)
    return {
      discussion: { ...d, options: parseJson(d.options as string, []), writeback: parseJson(d.writeback as string, []) },
      messages: db.all('SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at', d.id),
      participants: db.all('SELECT a.id, a.name, a.kind FROM discussion_participants p JOIN agents a ON a.id = p.agent_id WHERE p.discussion_id = ?', d.id),
      task: d.task_id ? db.get('SELECT id, title FROM tasks WHERE id = ?', d.task_id) : null,
      judgment: db.get("SELECT * FROM judgments WHERE kind = 'decide' AND ref_id = ? AND status = 'open'", d.id) ?? null,
    }
  })

  // ---------- assets ----------

  app.get('/api/spaces/:id/artifacts', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { artifacts: db.all(`SELECT a.id, a.title, a.kind, a.version, a.status, a.created_at, a.task_id, t.title AS task_title, t.status AS task_status
      FROM artifacts a JOIN tasks t ON t.id = a.task_id WHERE a.space_id = ? AND a.version = (SELECT MAX(version) FROM artifacts b WHERE b.task_id = a.task_id) ORDER BY a.created_at DESC`, id) }
  })

  app.get('/api/spaces/:id/standards', { preHandler: auth }, async (req) => ({ standards: domain.standards(space(req)) }))

  app.post('/api/spaces/:id/standards', { preHandler: auth }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return { standard: domain.addStandard(id, me(req).id, str(b.text, 300), str(b.scope, 20) || '全部', `${me(req).name}手动添加`) }
  })

  app.put('/api/spaces/:id/standards/:sid', { preHandler: auth }, async (req) => {
    const id = space(req)
    domain.setStandardEnabled(id, me(req).id, (req.params as { sid: string }).sid, ((req.body ?? {}) as Body).enabled === true)
    return { ok: true }
  })

  app.get('/api/spaces/:id/memory', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { memory: db.all('SELECT * FROM memory WHERE space_id = ? ORDER BY created_at DESC LIMIT 300', id) }
  })

  app.post('/api/spaces/:id/memory/ask', { preHandler: auth }, async (req) => {
    const id = space(req)
    const question = str(((req.body ?? {}) as Body).question, 500).trim()
    if (!question) throw new DomainError('请输入问题')
    const assistant = domain.assistantOf(id)
    const result = await pool.run(assistant, buildMemoryQuestion(domain, id, question))
    return { answer: result.finalResponse }
  })

  app.get('/api/spaces/:id/skills', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { skills: db.all('SELECT s.*, u.name AS maintainer_name FROM skills s LEFT JOIN users u ON u.id = s.maintainer_id WHERE s.space_id = ? ORDER BY s.uses DESC, s.created_at DESC', id) }
  })

  app.post('/api/spaces/:id/skills', { preHandler: auth }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return { skill: domain.addSkill(id, me(req).id, { name: str(b.name, 60), description: str(b.description, 200), body: str(b.body, 20_000) }) }
  })

  app.get('/api/spaces/:id/files', { preHandler: auth }, async (req) => {
    const id = space(req)
    return { files: db.all('SELECT f.id, f.name, f.source, f.reads, f.created_at, length(f.content) AS size, u.name AS added_by_name FROM files f LEFT JOIN users u ON u.id = f.added_by WHERE f.space_id = ? ORDER BY f.created_at DESC', id) }
  })

  app.get('/api/spaces/:id/files/:fileId/download', { preHandler: auth }, async (req, reply) => {
    const id = space(req)
    const { fileId } = req.params as { fileId: string }
    const file = db.get<{ name: string; content: string }>('SELECT name, content FROM files WHERE id = ? AND space_id = ?', fileId, id)
    if (!file) return reply.code(404).send({ error: '文件不存在' })
    return reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).type('text/plain; charset=utf-8').send(file.content)
  })

  app.post('/api/spaces/:id/files', { preHandler: auth, bodyLimit: 1_048_576 }, async (req) => {
    const id = space(req)
    const b = (req.body ?? {}) as Body
    return { file: domain.addFile(id, me(req).id, { name: str(b.name, 120), content: str(b.content, 600_000) }) }
  })

  // ---------- live updates ----------

  function stream(req: FastifyRequest, reply: FastifyReply, keys: string[]): void {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write('retry: 3000\n\n')
    const send = (event: BusEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    const offs = keys.map((k) => domain.bus.subscribe(k, send))
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => {
      clearInterval(ping)
      for (const off of offs) off()
    })
  }

  app.get('/api/spaces/:id/stream', { preHandler: auth }, async (req, reply) => {
    stream(req, reply, [`space:${space(req)}`])
  })

  app.get('/api/me/stream', { preHandler: auth }, async (req, reply) => {
    stream(req, reply, [`user:${me(req).id}`])
  })
}
