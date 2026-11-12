import type { Db, Row } from './db.ts'
import { newId, newToken, now, parseJson } from './db.ts'
import type { Bus } from './bus.ts'

/** Thrown for rule violations; surfaced to agents as tool errors and to the web as 4xx. */
export class DomainError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export type JobKind =
  | 'triage'
  | 'execute'
  | 'review_suggest'
  | 'discussion_reply'
  | 'discussion_moderate'
  | 'decide_suggest'
  | 'plan'

export interface JobSink {
  enqueue(kind: JobKind, agentId: string, payload: Record<string, unknown>): void
}

export interface Agent {
  id: string
  kind: 'personal' | 'assistant' | 'specialist'
  space_id: string | null
  owner_user_id: string | null
  name: string
  specialty: string
  token: string
  public_profile: string
  handbook: string
  activity: string
}

export interface User {
  id: string
  email: string
  name: string
}

export interface Task {
  id: string
  space_id: string
  raw_input: string
  title: string
  description: string
  acceptance: string
  status: 'triage' | 'unclaimed' | 'in_progress' | 'review' | 'done' | 'merged'
  creator_id: string
  owner_id: string | null
  executor_agent_id: string | null
  due: string | null
  merged_into: string | null
  blocked_by_discussion: string | null
  live: string
  source: string
  /** JSON ScheduleWait while the task waits for its scheduled runs before delivery. */
  schedule_result?: string | null
  schedule_wait?: string | null
  created_at: number
  updated_at: number
}

export interface ScheduleWait { expected: number; seen: number; endsAt: number; scheduleId: string }

export interface Space {
  id: string
  name: string
  owner_id: string
  goal_title: string | null
  goal_due: string | null
  goal_metrics: string
  source: string
  webhook_token: string | null
  created_at: number
}

/** Every space has one general agent; any task without a better-suited specialist goes to it. */
export const GENERAL_AGENT = {
  name: '通用 agent',
  specialty: '什么任务都能接：写文档、查资料和网页、跑命令、写和运行脚本、创建定时任务等。没有更合适的专项 agent 时由它执行',
}

export const DEFAULT_SPECIALISTS: Array<{ name: string; specialty: string }> = [
  GENERAL_AGENT,
  { name: '文档 agent', specialty: '撰写方案、说明、FAQ、发布说明等文档，结论先行，结构清晰' },
  { name: '数据 agent', specialty: '整理数据、做分析报告和对比，给出可复现的口径和结论' },
  { name: '测试 agent', specialty: '设计测试用例、验收清单和风险检查，指出遗漏和边界情况' },
]

export class Domain {
  readonly db: Db
  readonly bus: Bus
  jobs: JobSink

  constructor(db: Db, bus: Bus, jobs: JobSink) {
    this.db = db
    this.bus = bus
    this.jobs = jobs
  }

  // ---------- users & personal agents ----------

  ensureUser(email: string, name: string): User {
    const normalized = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) throw new DomainError('邮箱格式不对')
    const existing = this.db.get<User>('SELECT id, email, name FROM users WHERE email = ?', normalized)
    if (existing) {
      if (name.trim() && existing.name !== name.trim()) {
        this.db.update('users', existing.id, { name: name.trim() })
        this.db.run("UPDATE agents SET name = ? WHERE kind = 'personal' AND owner_user_id = ?", `${name.trim()}的 agent`, existing.id)
        existing.name = name.trim()
      }
      return existing
    }
    const displayName = name.trim() || normalized.split('@')[0]!
    const user: User = { id: newId('u'), email: normalized, name: displayName }
    this.db.tx(() => {
      this.db.insert('users', { ...user, created_at: now() })
      this.db.insert('agents', {
        id: newId('ag'), kind: 'personal', space_id: null, owner_user_id: user.id,
        name: `${displayName}的 agent`, specialty: '代表主人的标准和判断', token: newToken(), created_at: now(),
      })
    })
    return user
  }

  user(id: string): User {
    const u = this.db.get<User>('SELECT id, email, name FROM users WHERE id = ?', id)
    if (!u) throw new DomainError('用户不存在', 404)
    return u
  }

  personalAgent(userId: string): Agent {
    const a = this.db.get<Agent>("SELECT * FROM agents WHERE kind = 'personal' AND owner_user_id = ?", userId)
    if (!a) throw new DomainError('个人 agent 不存在', 404)
    return a
  }

  agent(id: string): Agent {
    const a = this.db.get<Agent>('SELECT * FROM agents WHERE id = ?', id)
    if (!a) throw new DomainError('agent 不存在', 404)
    return a
  }

  agentByToken(token: string): Agent | undefined {
    return this.db.get<Agent>('SELECT * FROM agents WHERE token = ?', token)
  }

  updatePersonalAgent(userId: string, patch: { public_profile?: string; handbook?: string }): Agent {
    const a = this.personalAgent(userId)
    this.db.update('agents', a.id, {
      ...(patch.public_profile !== undefined ? { public_profile: patch.public_profile.slice(0, 4000) } : {}),
      ...(patch.handbook !== undefined ? { handbook: patch.handbook.slice(0, 8000) } : {}),
    })
    return this.personalAgent(userId)
  }

  setActivity(agentId: string, activity: string): void {
    this.db.update('agents', agentId, { activity, activity_at: now() })
    const a = this.agent(agentId)
    for (const spaceId of this.spacesOfAgent(a)) this.bus.publish(`space:${spaceId}`, { type: 'agent', agentId })
  }

  spacesOfAgent(a: Agent): string[] {
    if (a.space_id) return [a.space_id]
    if (!a.owner_user_id) return []
    return this.db.all<{ space_id: string }>('SELECT space_id FROM members WHERE user_id = ? AND left_at IS NULL', a.owner_user_id).map((r) => r.space_id)
  }

  // ---------- spaces & members ----------

  createSpace(ownerId: string, input: { name: string; goalTitle?: string; goalDue?: string; goalMetrics?: string[]; members?: Array<{ email: string; name?: string; title?: string }>; ownerTitle?: string }): Space {
    const name = input.name.trim()
    if (!name) throw new DomainError('空间名称不能为空')
    const space: Space = {
      id: newId('sp'), name, owner_id: ownerId,
      goal_title: input.goalTitle?.trim() || null, goal_due: input.goalDue?.trim() || null,
      goal_metrics: JSON.stringify((input.goalMetrics ?? []).map((m) => m.trim()).filter(Boolean)), source: 'manual', webhook_token: newToken(), created_at: now(),
    }
    this.db.tx(() => {
      this.db.insert('spaces', space as unknown as Record<string, unknown>)
      this.db.insert('members', { space_id: space.id, user_id: ownerId, title: input.ownerTitle ?? 'owner', joined_at: now() })
      this.db.insert('agents', { id: newId('ag'), kind: 'assistant', space_id: space.id, name: '空间助理', specialty: '整理和分配任务、组织讨论、沉淀标准', token: newToken(), created_at: now() })
      for (const s of DEFAULT_SPECIALISTS) {
        this.db.insert('agents', { id: newId('ag'), kind: 'specialist', space_id: space.id, name: s.name, specialty: s.specialty, token: newToken(), created_at: now() })
      }
    })
    for (const m of input.members ?? []) {
      if (m.email.trim()) this.addMember(space.id, ownerId, m.email, m.name ?? '', m.title ?? '')
    }
    this.remember(space.id, 'change', space.goal_title ? `创建空间，目标：${space.goal_title}${space.goal_due ? `（${space.goal_due}）` : ''}` : '创建空间')
    if (space.goal_title) this.requestPlan(space.id)
    return space
  }

  /** Ask the space assistant to break the goal into the next batch of tasks. */
  requestPlan(spaceId: string): void {
    const s = this.space(spaceId)
    if (!s.goal_title) return
    const pending = this.db.get("SELECT 1 FROM jobs WHERE kind = 'plan' AND status IN ('queued','running') AND json_extract(payload, '$.spaceId') = ?", spaceId)
    if (pending) return
    this.jobs.enqueue('plan', this.assistantOf(spaceId).id, { spaceId, since: now() })
  }

  planTasks(agent: Agent, input: { space_id: string; tasks: Array<{ title: string; description?: string; acceptance?: string[]; owner_user_id: string; executor_agent_id?: string | null; due?: string | null }>; note?: string }): Task[] {
    const s = this.space(input.space_id)
    this.requireAgentInSpace(agent, s.id, 'assistant')
    if (!s.goal_title) throw new DomainError('空间没有目标，不需要拆解')
    if (!input.tasks?.length) throw new DomainError('至少拆出一个任务')
    if (input.tasks.length > 6) throw new DomainError('一次最多拆 6 个任务，先拆近期要做的')
    const open = new Set(this.db.all<{ title: string }>("SELECT title FROM tasks WHERE space_id = ? AND status NOT IN ('done','merged')", s.id).map((t) => t.title))
    const created: Task[] = []
    for (const spec of input.tasks) {
      const title = spec.title.trim().slice(0, 80)
      if (!title || open.has(title)) continue
      if (!this.isMember(s.id, spec.owner_user_id)) throw new DomainError(`「${title}」的负责人必须是空间成员`)
      let executor: Agent | null = this.generalAgent(s.id)
      if (spec.executor_agent_id) {
        executor = this.agent(spec.executor_agent_id)
        if (executor.kind !== 'specialist' || executor.space_id !== s.id) throw new DomainError(`「${title}」的执行者必须是本空间的专项 agent`)
      }
      const t: Task = {
        id: newId('t'), space_id: s.id, raw_input: `按目标拆解：${title}`, title, description: spec.description?.trim() ?? '',
        acceptance: JSON.stringify((spec.acceptance ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 10)),
        status: executor ? 'in_progress' : 'unclaimed', creator_id: s.owner_id, owner_id: spec.owner_user_id, executor_agent_id: executor?.id ?? null,
        due: spec.due || null, merged_into: null, blocked_by_discussion: null, live: executor ? 'agent 准备开始' : '等待认领',
        source: 'plan', created_at: now(), updated_at: now(),
      }
      this.db.insert('tasks', t as unknown as Record<string, unknown>)
      this.event(t.id, 'agent', agent.id, agent.name, `按目标「${s.goal_title}」拆出这个任务，负责人 ${this.user(spec.owner_user_id).name}${executor ? '，交给 agent 执行' : ''}`)
      if (executor) this.jobs.enqueue('execute', executor.id, { taskId: t.id })
      open.add(title)
      created.push(t)
    }
    if (created.length === 0) throw new DomainError('拆出的任务都和已有任务重复')
    this.remember(s.id, 'change', `空间助理按目标拆出 ${created.length} 个任务：${created.map((t) => t.title).join('、')}${input.note ? `。${input.note}` : ''}`)
    this.touch(s.id)
    return created
  }

  /** An external event (webhook, IM message) becomes a task and goes through the normal organise step. */
  createTaskFromEvent(spaceId: string, input: { source: string; text: string; from?: string }): Task {
    const s = this.space(spaceId)
    const text = input.text.trim()
    if (!text) throw new DomainError('事件内容不能为空')
    const source = (input.source.trim() || '外部事件').slice(0, 40)
    const t: Task = {
      id: newId('t'), space_id: s.id, raw_input: `${input.from ? `${input.from.slice(0, 40)}：` : ''}${text.slice(0, 4000)}`, title: text.slice(0, 60), description: '', acceptance: '[]',
      status: 'triage', creator_id: s.owner_id, owner_id: null, executor_agent_id: null, due: null, merged_into: null,
      blocked_by_discussion: null, live: '空间助理在整理', source: `event:${source}`, created_at: now(), updated_at: now(),
    }
    this.db.insert('tasks', t as unknown as Record<string, unknown>)
    this.event(t.id, 'system', null, source, `事件触发${input.from ? `，来自${input.from.slice(0, 40)}` : ''}`)
    this.jobs.enqueue('triage', this.assistantOf(s.id).id, { taskId: t.id })
    this.touch(s.id)
    return t
  }

  webhookToken(spaceId: string, userId: string, rotate = false): string {
    const s = this.space(spaceId)
    if (s.owner_id !== userId) throw new DomainError('只有 owner 可以查看事件入口', 403)
    if (s.webhook_token && !rotate) return s.webhook_token
    const token = newToken()
    this.db.update('spaces', spaceId, { webhook_token: token })
    return token
  }

  spaceByWebhookToken(spaceId: string, token: string): Space {
    const s = this.space(spaceId)
    if (!s.webhook_token || !token || s.webhook_token !== token) throw new DomainError('事件入口的 token 不对', 401)
    return s
  }

  space(id: string): Space {
    const s = this.db.get<Space>('SELECT * FROM spaces WHERE id = ?', id)
    if (!s) throw new DomainError('空间不存在', 404)
    return s
  }

  updateGoal(spaceId: string, userId: string, input: { goalTitle?: string; goalDue?: string; goalMetrics?: string[] }): Space {
    const s = this.space(spaceId)
    if (s.owner_id !== userId) throw new DomainError('只有 owner 可以修改目标', 403)
    this.db.update('spaces', spaceId, {
      goal_title: input.goalTitle?.trim() || null,
      goal_due: input.goalDue?.trim() || null,
      goal_metrics: JSON.stringify((input.goalMetrics ?? []).filter(Boolean)),
    })
    this.remember(spaceId, 'change', `目标更新为：${input.goalTitle || '（无目标）'}${input.goalDue ? `，截止 ${input.goalDue}` : ''}`)
    if (input.goalTitle?.trim() && input.goalTitle.trim() !== s.goal_title) this.requestPlan(spaceId)
    this.touch(spaceId)
    return this.space(spaceId)
  }

  isMember(spaceId: string, userId: string): boolean {
    return !!this.db.get('SELECT 1 FROM members WHERE space_id = ? AND user_id = ? AND left_at IS NULL', spaceId, userId)
  }

  requireMember(spaceId: string, userId: string): Space {
    const s = this.space(spaceId)
    if (!this.isMember(spaceId, userId)) throw new DomainError('你不是这个空间的成员', 403)
    return s
  }

  addMember(spaceId: string, byUserId: string, email: string, name: string, title: string): User {
    this.requireMember(spaceId, byUserId)
    const u = this.ensureUser(email, name)
    const existing = this.db.get<{ left_at: number | null }>('SELECT left_at FROM members WHERE space_id = ? AND user_id = ?', spaceId, u.id)
    if (existing && existing.left_at === null) return u
    if (existing) this.db.run('UPDATE members SET left_at = NULL, title = ?, joined_at = ? WHERE space_id = ? AND user_id = ?', title, now(), spaceId, u.id)
    else this.db.insert('members', { space_id: spaceId, user_id: u.id, title, joined_at: now() })
    this.remember(spaceId, 'member', `${u.name}加入${title ? `，负责${title}` : ''}`)
    this.touch(spaceId)
    return u
  }

  handover(spaceId: string, byUserId: string, leavingUserId: string, successorId: string): { tasks: number } {
    const s = this.space(spaceId)
    if (s.owner_id !== byUserId) throw new DomainError('只有 owner 可以确认交接', 403)
    if (!this.isMember(spaceId, leavingUserId) || !this.isMember(spaceId, successorId)) throw new DomainError('交接双方都必须是成员')
    if (leavingUserId === s.owner_id) throw new DomainError('owner 交接请先转移 owner')
    const leaving = this.user(leavingUserId)
    const successor = this.user(successorId)
    const open = this.db.all<Task>("SELECT * FROM tasks WHERE space_id = ? AND owner_id = ? AND status NOT IN ('done','merged')", spaceId, leavingUserId)
    this.db.tx(() => {
      for (const t of open) {
        this.db.update('tasks', t.id, { owner_id: successorId, updated_at: now() })
        this.event(t.id, 'system', null, '空间', `负责人由${leaving.name}交接给${successor.name}`)
      }
      this.db.run('UPDATE judgments SET user_id = ? WHERE space_id = ? AND user_id = ? AND status = ?', successorId, spaceId, leavingUserId, 'open')
      this.db.run('UPDATE members SET left_at = ?, successor_id = ? WHERE space_id = ? AND user_id = ?', now(), successorId, spaceId, leavingUserId)
    })
    this.remember(spaceId, 'member', `${leaving.name}离开空间，${open.length} 个任务交接给${successor.name}；空间里的标准、决策和产物都保留`)
    this.touch(spaceId)
    this.bus.publish(`user:${successorId}`, { type: 'judgments' })
    return { tasks: open.length }
  }

  members(spaceId: string): Array<Row> {
    return this.db.all(`SELECT u.id, u.name, u.email, m.title, m.joined_at, m.left_at, m.successor_id,
      a.id AS agent_id, a.activity AS agent_activity, a.public_profile
      FROM members m JOIN users u ON u.id = m.user_id
      LEFT JOIN agents a ON a.kind = 'personal' AND a.owner_user_id = u.id
      WHERE m.space_id = ? ORDER BY m.left_at IS NOT NULL, m.joined_at`, spaceId)
  }

  spaceAgents(spaceId: string): Agent[] {
    return this.db.all<Agent>("SELECT * FROM agents WHERE space_id = ? ORDER BY kind = 'assistant' DESC, created_at", spaceId)
  }

  /** The space's general agent, created on demand for spaces made before it existed. */
  generalAgent(spaceId: string): Agent {
    const found = this.db.get<Agent>("SELECT * FROM agents WHERE space_id = ? AND kind = 'specialist' AND name = ?", spaceId, GENERAL_AGENT.name)
    if (found) return found
    const id = newId('ag')
    this.db.insert('agents', { id, kind: 'specialist', space_id: spaceId, name: GENERAL_AGENT.name, specialty: GENERAL_AGENT.specialty, token: newToken(), created_at: now() })
    return this.agent(id)
  }

  /** Hand a task nobody picked up to the general agent so it does not stall. */
  assignToGeneral(taskId: string, reason: string): Task {
    const t = this.task(taskId)
    const ex = this.generalAgent(t.space_id)
    this.db.update('tasks', t.id, { executor_agent_id: ex.id, owner_id: t.owner_id ?? t.creator_id, status: 'in_progress', live: 'agent 准备开始', updated_at: now() })
    this.event(t.id, 'system', null, '空间', reason)
    this.jobs.enqueue('execute', ex.id, { taskId: t.id })
    this.touch(t.space_id)
    return this.task(t.id)
  }

  /** Startup: every space gets a general agent, and tasks left unclaimed by older versions are handed to it. */
  ensureGeneralAgents(): void {
    for (const s of this.db.all<{ id: string }>('SELECT id FROM spaces')) this.generalAgent(s.id)
    for (const t of this.db.all<{ id: string }>("SELECT id FROM tasks WHERE status = 'unclaimed'")) this.assignToGeneral(t.id, '交给 agent 执行')
  }

  assistantOf(spaceId: string): Agent {
    const a = this.db.get<Agent>("SELECT * FROM agents WHERE space_id = ? AND kind = 'assistant'", spaceId)
    if (!a) throw new DomainError('空间助理不存在', 500)
    return a
  }

  // ---------- tasks ----------

  task(id: string): Task {
    const t = this.db.get<Task>('SELECT * FROM tasks WHERE id = ?', id)
    if (!t) throw new DomainError('任务不存在', 404)
    return t
  }

  createTask(spaceId: string, userId: string, text: string): Task {
    this.requireMember(spaceId, userId)
    const raw = text.trim()
    if (!raw) throw new DomainError('任务内容不能为空')
    const t: Task = {
      id: newId('t'), space_id: spaceId, raw_input: raw, title: raw.slice(0, 60), description: '', acceptance: '[]',
      status: 'triage', creator_id: userId, owner_id: null, executor_agent_id: null, due: null, merged_into: null,
      blocked_by_discussion: null, live: '空间助理在整理', source: 'manual', created_at: now(), updated_at: now(),
    }
    this.db.insert('tasks', t as unknown as Record<string, unknown>)
    this.event(t.id, 'user', userId, this.user(userId).name, '发起任务')
    this.jobs.enqueue('triage', this.assistantOf(spaceId).id, { taskId: t.id })
    this.touch(spaceId)
    return t
  }

  applyTriage(agent: Agent, input: { task_id: string; title: string; description: string; acceptance: string[]; owner_user_id: string; executor_agent_id?: string | null; due?: string | null; merge_into_task_id?: string | null; note?: string }): Task {
    const t = this.task(input.task_id)
    this.requireAgentInSpace(agent, t.space_id, 'assistant')
    if (t.status !== 'triage') throw new DomainError(`任务当前状态是 ${t.status}，不需要整理`)
    if (input.merge_into_task_id) {
      const target = this.task(input.merge_into_task_id)
      if (target.space_id !== t.space_id || target.id === t.id) throw new DomainError('合并目标无效')
      if (target.status === 'done' || target.status === 'merged') throw new DomainError('不能合并到已完成的任务')
      this.db.update('tasks', t.id, { status: 'merged', merged_into: target.id, live: `已并入「${target.title}」`, updated_at: now() })
      this.event(t.id, 'agent', agent.id, agent.name, `并入任务「${target.title}」${input.note ? `：${input.note}` : ''}`)
      this.event(target.id, 'agent', agent.id, agent.name, `合并了重复任务「${t.title}」：${t.raw_input}`)
      const extra = `${target.description}\n\n（合并自「${t.title}」）${t.raw_input}`.trim()
      this.db.update('tasks', target.id, { description: extra, updated_at: now() })
      this.touch(t.space_id)
      return this.task(t.id)
    }
    if (!this.isMember(t.space_id, input.owner_user_id)) throw new DomainError('负责人必须是空间成员')
    let executor: Agent | null = this.generalAgent(t.space_id)
    if (input.executor_agent_id) {
      executor = this.agent(input.executor_agent_id)
      if (executor.kind !== 'specialist' || executor.space_id !== t.space_id) throw new DomainError('执行者必须是本空间的专项 agent')
    }
    const acceptance = (input.acceptance ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 10)
    this.db.update('tasks', t.id, {
      title: input.title.trim().slice(0, 80) || t.title, description: input.description?.trim() ?? '', acceptance,
      owner_id: input.owner_user_id, executor_agent_id: executor?.id ?? null, due: input.due || null,
      status: executor ? 'in_progress' : 'unclaimed', live: executor ? 'agent 准备开始' : '等待认领', updated_at: now(),
    })
    const owner = this.user(input.owner_user_id)
    this.event(t.id, 'agent', agent.id, agent.name, `整理完成：负责人 ${owner.name}${executor ? '，交给 agent 执行' : '，等待认领'}${input.note ? `。${input.note}` : ''}`)
    if (executor) this.jobs.enqueue('execute', executor.id, { taskId: t.id })
    this.touch(t.space_id)
    return this.task(t.id)
  }

  claimTask(taskId: string, userId: string, executorAgentId?: string): Task {
    const t = this.task(taskId)
    this.requireMember(t.space_id, userId)
    if (t.status !== 'unclaimed') throw new DomainError('只有待认领的任务可以认领')
    const ex = executorAgentId ? this.agent(executorAgentId) : this.generalAgent(t.space_id)
    if (ex.kind !== 'specialist' || ex.space_id !== t.space_id) throw new DomainError('请选择本空间的专项 agent')
    this.db.update('tasks', t.id, { owner_id: userId, executor_agent_id: ex.id, status: 'in_progress', live: 'agent 准备开始', updated_at: now() })
    this.event(t.id, 'user', userId, this.user(userId).name, '认领任务，交给 agent 执行')
    this.jobs.enqueue('execute', ex.id, { taskId: t.id })
    this.touch(t.space_id)
    return this.task(t.id)
  }

  postProgress(agent: Agent, taskId: string, text: string): void {
    const t = this.task(taskId)
    this.requireAgentInSpace(agent, t.space_id)
    // Progress goes to the task history only; the status line (live) stays a short, state-based summary.
    this.db.update('tasks', t.id, { updated_at: now() })
    this.event(t.id, 'agent', agent.id, agent.name, text.slice(0, 500))
    this.touch(t.space_id)
  }

  scheduleWait(t: Task): ScheduleWait | null {
    return t.schedule_wait ? parseJson<ScheduleWait | null>(t.schedule_wait, null) : null
  }

  /**
   * The executor created a finite scheduled task whose runs the acceptance depends on: hold delivery until
   * the runs have reported back (or the expected end time has passed), then wake the executor to deliver.
   */
  waitForScheduledRuns(agent: Agent, input: { task_id: string; schedule_id: string; expected_runs: number; ends_at: string }): void {
    const t = this.task(input.task_id)
    if (t.executor_agent_id !== agent.id) throw new DomainError('只有这个任务的执行 agent 可以设置等待')
    if (t.status !== 'in_progress') throw new DomainError('任务不在执行中')
    const expected = Math.floor(input.expected_runs)
    if (!(expected >= 1 && expected <= 100)) throw new DomainError('expected_runs 要在 1 到 100 之间；不限次数的定时任务不需要等，直接提交产物')
    const endsAt = Date.parse(input.ends_at)
    if (Number.isNaN(endsAt)) throw new DomainError('ends_at 要是带时区的 ISO 时间，例如 2026-11-10T14:12:00+08:00')
    if (endsAt < Date.now() - 60_000) throw new DomainError('ends_at 已经过去了')
    if (endsAt > Date.now() + 7 * 86_400_000) throw new DomainError('最后一次执行超过 7 天后的，不需要等，直接提交产物并写清楚时间安排')
    const wait: ScheduleWait = { expected, seen: 0, endsAt, scheduleId: input.schedule_id }
    this.db.update('tasks', t.id, { schedule_result: null, schedule_wait: JSON.stringify(wait), live: `等定时任务跑完（0/${expected}）`, updated_at: now() })
    const end = new Date(endsAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    this.event(t.id, 'agent', agent.id, agent.name, `创建定时任务，共执行 ${expected} 次，预计 ${end} 结束；跑完后再交付`)
    this.touch(t.space_id)
  }

  /** Called by each scheduled run: records the run on the task and, after the last one, wakes the executor to deliver. */
  reportScheduledRun(agent: Agent, input: { task_id: string; text: string }): void {
    const t = this.task(input.task_id)
    if (t.executor_agent_id !== agent.id) throw new DomainError('只有这个任务的执行 agent 可以记录定时执行结果')
    const wait = this.scheduleWait(t)
    const n = wait ? wait.seen + 1 : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND text LIKE '第 % 次执行：%'", t.id)!.n + 1
    this.event(t.id, 'agent', agent.id, agent.name, `第 ${n} 次执行：${input.text.trim().slice(0, 400)}`)
    if (wait) {
      const next = { ...wait, seen: n }
      this.db.update('tasks', t.id, { schedule_wait: JSON.stringify(next), live: `等定时任务跑完（${Math.min(n, wait.expected)}/${wait.expected}）`, updated_at: now() })
      if (n >= wait.expected) this.finishScheduleWait(t.id, `定时任务 ${wait.expected} 次已全部执行`)
    }
    this.touch(t.space_id)
  }

  /** Stop waiting and ask the executor to deliver against the recorded runs. */
  finishScheduleWait(taskId: string, reason: string): void {
    const t = this.task(taskId)
    const wait = this.scheduleWait(t)
    if (!wait || !t.executor_agent_id) return
    this.db.update('tasks', t.id, { schedule_result: JSON.stringify(wait), schedule_wait: null, live: 'agent 在整理执行结果', updated_at: now() })
    this.event(t.id, 'system', null, '空间', `${reason}，交给 agent 交付`)
    this.jobs.enqueue('execute', t.executor_agent_id, { taskId: t.id, afterSchedule: true, runsSeen: wait.seen, runsExpected: wait.expected })
    this.touch(t.space_id)
  }

  /** Safety net: if runs stop reporting (runtime down, schedule edited), deliver anyway a little after the expected end. */
  finishOverdueScheduleWaits(graceMs = 3 * 60_000): void {
    for (const t of this.db.all<Task>("SELECT * FROM tasks WHERE schedule_wait IS NOT NULL AND status = 'in_progress'")) {
      const wait = this.scheduleWait(t)
      if (wait && Date.now() > wait.endsAt + graceMs) this.finishScheduleWait(t.id, `定时任务已过预计结束时间，收到 ${wait.seen}/${wait.expected} 次执行记录`)
    }
  }

  submitArtifact(agent: Agent, input: { task_id: string; title: string; kind?: string; content: string; self_check?: Array<{ item: string; ok: boolean; note?: string }> }): Row {
    const t = this.task(input.task_id)
    this.requireAgentInSpace(agent, t.space_id, 'specialist')
    if (t.executor_agent_id !== agent.id) throw new DomainError('只有这个任务的执行 agent 可以提交产物')
    if (t.status !== 'in_progress') throw new DomainError('任务不在进行中，不能提交')
    if (t.blocked_by_discussion) throw new DomainError('任务卡在讨论里，等讨论有结论后再提交')
    const wait = this.scheduleWait(t)
    if (wait) throw new DomainError(`定时任务还没跑完（${wait.seen}/${wait.expected}），现在不要提交；全部执行后系统会叫你交付，请结束本轮`)
    if (!input.content.trim()) throw new DomainError('产物内容不能为空')
    const prev = this.db.get<{ v: number }>('SELECT MAX(version) AS v FROM artifacts WHERE task_id = ?', t.id)
    const artifact = {
      id: newId('ar'), space_id: t.space_id, task_id: t.id, title: input.title.trim() || t.title, kind: input.kind || '文档',
      content: input.content, self_check: input.self_check ?? [], version: (prev?.v ?? 0) + 1, status: 'pending', created_at: now(),
    }
    const result = parseJson<ScheduleWait | null>(t.schedule_result, null)
    const checks = input.self_check ?? []
    const recorded = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND text LIKE '第 % 次执行：%'", t.id)?.n ?? 0
    // Only finite schedules with all reported runs and no failed checks can bypass human review.
    const autoComplete = !!result && result.seen === result.expected && recorded === result.expected && checks.length > 0 && checks.every((check) => check.ok === true)
    if (autoComplete) {
      artifact.status = 'approved'
      this.db.tx(() => {
        this.db.insert('artifacts', artifact)
        this.db.update('tasks', t.id, { status: 'done', live: '定时执行已完成', updated_at: now() })
        this.event(t.id, 'system', null, '空间', `定时执行记录 ${recorded}/${result.expected} 齐全，交付自检全部通过，自动完成`)
      })
      const left = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status NOT IN ('done','merged')", t.space_id)
      if (!left?.n) this.requestPlan(t.space_id)
      this.touch(t.space_id)
      return artifact
    }
    this.db.insert('artifacts', artifact)
    this.db.update('tasks', t.id, { status: 'review' , live: '已交付，等负责人确认', updated_at: now() })
    this.event(t.id, 'agent', agent.id, agent.name, `交付「${artifact.title}」v${artifact.version}，自检后交给负责人确认`)
    if (t.owner_id) this.jobs.enqueue('review_suggest', this.personalAgent(t.owner_id).id, { taskId: t.id, artifactId: artifact.id })
    this.touch(t.space_id)
    return artifact
  }

  // ---------- discussions ----------

  discussion(id: string): Row & { id: string; space_id: string; task_id: string | null; status: string; title: string; question: string; opened_by_agent_id: string | null; summary: string; outcome: string; decided_by: string | null; writeback: string; decider_user_id: string | null; audience: string; escalate_why: string; revoked_outcome: string; revoke_reason: string; revoked_by: string | null } {
    const d = this.db.get<Row & { id: string; space_id: string; task_id: string | null; status: string; title: string; question: string; opened_by_agent_id: string | null; summary: string; outcome: string; decided_by: string | null; writeback: string; decider_user_id: string | null; audience: string; escalate_why: string; revoked_outcome: string; revoke_reason: string; revoked_by: string | null }>('SELECT * FROM discussions WHERE id = ?', id)
    if (!d) throw new DomainError('讨论不存在', 404)
    return d
  }

  openDiscussion(agent: Agent, input: { task_id: string; title: string; question: string; participant_user_ids?: string[] }): Row & { id: string } {
    const t = this.task(input.task_id)
    this.requireAgentInSpace(agent, t.space_id)
    const openCount = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discussions WHERE task_id = ? AND status != 'resolved'", t.id)
    if ((openCount?.n ?? 0) > 0) throw new DomainError('这个任务已经有一个进行中的讨论')
    const userIds = new Set(input.participant_user_ids ?? [])
    if (t.owner_id) userIds.add(t.owner_id)
    const participants = new Set<string>([agent.id])
    for (const uid of userIds) {
      if (!this.isMember(t.space_id, uid)) continue
      participants.add(this.personalAgent(uid).id)
    }
    const d = { id: newId('d'), space_id: t.space_id, task_id: t.id, title: input.title.trim().slice(0, 80), question: input.question.trim(), opened_by_agent_id: agent.id, status: 'open', created_at: now() }
    this.db.tx(() => {
      this.db.insert('discussions', d)
      for (const p of participants) this.db.insert('discussion_participants', { discussion_id: d.id, agent_id: p })
      this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'agent', author_id: agent.id, author_name: agent.name, text: d.question, created_at: now() })
      if (t.executor_agent_id === agent.id && t.status === 'in_progress') {
        this.db.update('tasks', t.id, { blocked_by_discussion: d.id, live: `卡在讨论「${d.title}」`, updated_at: now() })
      }
    })
    this.event(t.id, 'agent', agent.id, agent.name, `发起讨论「${d.title}」`)
    const others = [...participants].filter((p) => p !== agent.id)
    for (const p of others) this.jobs.enqueue('discussion_reply', p, { discussionId: d.id })
    if (others.length === 0) this.jobs.enqueue('discussion_moderate', this.assistantOf(t.space_id).id, { discussionId: d.id })
    this.touch(t.space_id)
    return d
  }

  postDiscussionMessage(agent: Agent, discussionId: string, text: string): void {
    const d = this.discussion(discussionId)
    this.requireAgentInSpace(agent, d.space_id)
    if (d.status !== 'open') throw new DomainError('讨论已经不在进行中')
    const isParticipant = this.db.get('SELECT 1 FROM discussion_participants WHERE discussion_id = ? AND agent_id = ?', d.id, agent.id)
    if (!isParticipant && agent.kind !== 'assistant') throw new DomainError('你不是这个讨论的参与者')
    this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'agent', author_id: agent.id, author_name: agent.name, text: text.trim().slice(0, 2000), created_at: now() })
    if (agent.kind === 'personal' && agent.owner_user_id) {
      this.log(agent.owner_user_id, agent.id, d.space_id, `在讨论「${d.title}」里替你陈述立场`, '', `/spaces/${d.space_id}/discussions/${d.id}`)
    }
    this.touch(d.space_id)
  }

  /** Called by the job runner after each reply job settles. */
  maybeModerate(discussionId: string): void {
    const d = this.discussion(discussionId)
    if (d.status !== 'open') return
    const pending = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind IN ('discussion_reply','discussion_moderate') AND status IN ('queued','running') AND json_extract(payload, '$.discussionId') = ?", d.id)
    if ((pending?.n ?? 0) > 0) return
    this.jobs.enqueue('discussion_moderate', this.assistantOf(d.space_id).id, { discussionId: d.id })
  }

  resolveDiscussion(agent: Agent, input: { discussion_id: string; outcome: string; writeback_task_ids?: string[] }): void {
    const d = this.discussion(input.discussion_id)
    this.requireAgentInSpace(agent, d.space_id, 'assistant')
    if (d.status !== 'open') throw new DomainError('讨论已经结束或已交给人定夺')
    this.finishDiscussion(d.id, input.outcome, agent.name, null, input.writeback_task_ids)
  }

  escalateDiscussion(agent: Agent, input: { discussion_id: string; summary: string; options: string[] }): void {
    const d = this.discussion(input.discussion_id)
    this.requireAgentInSpace(agent, d.space_id, 'assistant')
    if (d.status !== 'open') throw new DomainError('讨论已经结束或已交给人定夺')
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 4)
    const audience = this.escalationAudience(d)
    this.db.update('discussions', d.id, { status: 'escalated', summary: input.summary.trim(), options, decider_user_id: audience.deciderId, audience: [audience.deciderId, ...audience.watcherIds], escalate_why: audience.why })
    this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'agent', author_id: agent.id, author_name: agent.name, text: `总结：${input.summary.trim()}（超出 agent 能定的范围。${audience.why}）`, created_at: now() })
    this.openEscalationJudgments(d.id, audience)
    this.touch(d.space_id)
  }

  /**
   * The task owner decides. If they have left, the space owner decides.
   * Members whose personal agents took a different stance are told, and can comment, but do not decide.
   */
  private escalationAudience(d: { id: string; space_id: string; task_id: string | null }): { deciderId: string; watcherIds: string[]; why: string } {
    const space = this.space(d.space_id)
    const task = d.task_id ? this.task(d.task_id) : null
    const deciderId = task?.owner_id && this.isMember(d.space_id, task.owner_id) ? task.owner_id : space.owner_id
    const lastByUser = new Map<string, string>()
    const msgs = this.db.all<{ author_id: string | null; text: string }>('SELECT author_id, text FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at', d.id)
    for (const m of msgs) {
      if (!m.author_id) continue
      const speaker = this.db.get<Agent>('SELECT * FROM agents WHERE id = ?', m.author_id)
      if (!speaker || speaker.kind !== 'personal' || !speaker.owner_user_id || !this.isMember(d.space_id, speaker.owner_user_id)) continue
      lastByUser.set(speaker.owner_user_id, m.text)
    }
    const stance = (text: string) => text.trim().toLowerCase().replace(/[\s，。！？、,.!?:：；;「」"'“”]/g, '')
    const stances = new Map([...lastByUser].map(([id, text]) => [id, stance(text)]))
    const distinct = new Set(stances.values())
    const deciderStance = stances.get(deciderId)
    const watcherIds = distinct.size <= 1
      ? []
      : [...stances.keys()].filter((id) => id !== deciderId && (deciderStance === undefined || stances.get(id) !== deciderStance))
    const deciderName = this.user(deciderId).name
    const whyTask = task?.owner_id === deciderId
      ? `交给${deciderName}定夺，因为${deciderName}是任务「${task.title}」的负责人`
      : `任务没有仍在空间里的负责人，交给空间 owner ${deciderName}定夺`
    const whyWatch = watcherIds.length
      ? `${watcherIds.map((id) => this.user(id).name).join('、')}的个人 agent 在讨论里立场不同，他们会看到并可以补充意见`
      : '讨论里的个人 agent 没有互相冲突的立场'
    return { deciderId, watcherIds, why: `${whyTask}。${whyWatch}` }
  }

  private openEscalationJudgments(discussionId: string, audience: { deciderId: string; watcherIds: string[]; why: string }): void {
    const d = this.discussion(discussionId)
    const rows: Array<{ userId: string; role: 'decide' | 'watch' }> = [
      { userId: audience.deciderId, role: 'decide' },
      ...audience.watcherIds.map((userId) => ({ userId, role: 'watch' as const })),
    ]
    for (const row of rows) {
      const open = this.db.get('SELECT id FROM judgments WHERE kind = ? AND ref_id = ? AND user_id = ? AND status = ?', 'decide', d.id, row.userId, 'open')
      if (open) continue
      this.db.insert('judgments', {
        id: newId('j'), space_id: d.space_id, user_id: row.userId, kind: 'decide', ref_id: d.id, title: d.title,
        suggestion: '', suggested_action: row.role === 'watch' ? 'watch' : '', basis: audience.why, role: row.role, created_at: now(),
      })
      this.bus.publish(`user:${row.userId}`, { type: 'judgments' })
      this.jobs.enqueue('decide_suggest', this.personalAgent(row.userId).id, { discussionId: d.id, userId: row.userId, decides: row.role === 'decide' })
    }
  }

  private finishDiscussion(discussionId: string, outcome: string, decidedByName: string, decidedByUserId: string | null, writeback?: string[]): void {
    const d = this.discussion(discussionId)
    const targets = new Set<string>((writeback ?? []).filter((id) => {
      const t = this.db.get<Task>('SELECT * FROM tasks WHERE id = ?', id)
      return t && t.space_id === d.space_id
    }))
    if (d.task_id) targets.add(d.task_id)
    this.db.update('discussions', d.id, { status: 'resolved', outcome: outcome.trim(), decided_by: decidedByUserId ?? decidedByName, writeback: [...targets], resolved_at: now() })
    this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: decidedByUserId ? 'user' : 'agent', author_id: decidedByUserId, author_name: decidedByName, text: `结论：${outcome.trim()}`, created_at: now() })
    this.remember(d.space_id, 'decision', `${d.title}：${outcome.trim()}（${decidedByUserId ? `${decidedByName}定夺` : 'agent 讨论达成'}）`, d.id)
    for (const taskId of targets) {
      const t = this.task(taskId)
      this.event(t.id, decidedByUserId ? 'user' : 'agent', decidedByUserId, decidedByName, `讨论「${d.title}」的结论写回：${outcome.trim()}`)
      if (t.blocked_by_discussion === d.id) {
        this.db.update('tasks', t.id, { blocked_by_discussion: null, live: '讨论有结论，继续执行', updated_at: now() })
        if (t.executor_agent_id && t.status === 'in_progress') this.jobs.enqueue('execute', t.executor_agent_id, { taskId: t.id, discussionOutcome: `${d.title}：${outcome.trim()}` })
      }
    }
    this.touch(d.space_id)
  }

  // ---------- judgments (things people decide) ----------

  suggestReview(agent: Agent, input: { task_id: string; verdict: 'pass' | 'reject'; reason: string; basis?: string }): void {
    const t = this.task(input.task_id)
    if (agent.kind !== 'personal' || agent.owner_user_id !== t.owner_id) throw new DomainError('只有负责人的个人 agent 可以给确认建议', 403)
    if (t.status !== 'review') throw new DomainError('任务不在待确认状态')
    const open = this.db.get("SELECT 1 FROM judgments WHERE kind = 'confirm' AND ref_id = ? AND status = 'open'", t.id)
    if (open) throw new DomainError('已经给过建议了')
    const action = input.verdict === 'reject' ? 'reject' : 'pass'
    this.db.insert('judgments', {
      id: newId('j'), space_id: t.space_id, user_id: t.owner_id, kind: 'confirm', ref_id: t.id, title: t.title,
      suggestion: `${action === 'pass' ? '通过' : '打回'}：${input.reason.trim()}`, suggested_action: action, basis: input.basis?.trim() ?? '', created_at: now(),
    })
    this.log(t.owner_id!, agent.id, t.space_id, `看了「${t.title}」的交付，建议${action === 'pass' ? '通过' : '打回'}`, input.basis ?? '', `/spaces/${t.space_id}/tasks/${t.id}`)
    this.bus.publish(`user:${t.owner_id}`, { type: 'judgments' })
    this.touch(t.space_id)
  }

  suggestDecision(agent: Agent, input: { discussion_id: string; choice: string; basis: string }): void {
    const d = this.discussion(input.discussion_id)
    if (agent.kind !== 'personal' || !agent.owner_user_id) throw new DomainError('只有被问到的个人 agent 可以给定夺建议', 403)
    if (d.status !== 'escalated') throw new DomainError('讨论不在等人定夺的状态')
    const open = this.db.get<{ id: string; role: string; suggestion: string }>('SELECT id, role, suggestion FROM judgments WHERE kind = ? AND ref_id = ? AND user_id = ? AND status = ?', 'decide', d.id, agent.owner_user_id, 'open')
    if (!open) throw new DomainError('这件事没有交给你的主人')
    if (open.suggestion.trim()) throw new DomainError('已经给过建议了')
    const decides = open.role !== 'watch'
    const choice = input.choice.trim()
    const basis = input.basis.trim()
    this.db.update('judgments', open.id, { suggestion: choice, suggested_action: decides ? 'accept' : 'watch', basis })
    const line = decides ? `以负责人名义建议：${choice}。依据：${basis}` : `供参考：${choice}。依据：${basis}`
    this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'agent', author_id: agent.id, author_name: agent.name, text: line, created_at: now() })
    this.log(agent.owner_user_id, agent.id, d.space_id, decides ? `在讨论「${d.title}」里以负责人名义给出建议` : `在讨论「${d.title}」里给出供参考的建议`, basis, `/spaces/${d.space_id}/discussions/${d.id}`)
    this.bus.publish(`user:${agent.owner_user_id}`, { type: 'judgments' })
    this.touch(d.space_id)
  }

  resolveJudgment(userId: string, judgmentId: string, input: { action: 'pass' | 'reject' | 'accept' | 'override' | 'comment'; reason?: string; choice?: string; saveAsStandard?: boolean; standardScope?: string }): void {
    const j = this.db.get<{ id: string; space_id: string; user_id: string; kind: string; ref_id: string; title: string; suggestion: string; status: string }>('SELECT * FROM judgments WHERE id = ?', judgmentId)
    if (!j) throw new DomainError('待处理事项不存在', 404)
    if (j.user_id !== userId) throw new DomainError('这件事不归你处理', 403)
    if (j.status !== 'open') throw new DomainError('这件事已经处理过了')
    const me = this.user(userId)
    const reason = input.reason?.trim() ?? ''
    if (input.action === 'comment') {
      if (j.kind !== 'decide') throw new DomainError('这里不能补充意见')
      if (!reason) throw new DomainError('请写下要补充的意见')
      const d = this.discussion(j.ref_id)
      if (d.status !== 'escalated') throw new DomainError('讨论已经不在等人定夺的状态')
      this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'user', author_id: userId, author_name: me.name, text: reason.slice(0, 2000), created_at: now() })
      this.touch(d.space_id)
      this.bus.publish(`user:${userId}`, { type: 'judgments' })
      return
    }
    if (j.kind === 'confirm') {
      if (input.action !== 'pass' && input.action !== 'reject') throw new DomainError('确认只能选择通过或打回')
      if (input.action === 'reject' && !reason) throw new DomainError('打回需要写理由')
      const t = this.task(j.ref_id)
      if (t.status !== 'review') throw new DomainError('任务已经不在待确认状态')
      const artifact = this.db.get<{ id: string }>('SELECT id FROM artifacts WHERE task_id = ? ORDER BY version DESC LIMIT 1', t.id)
      this.db.tx(() => {
        this.db.update('judgments', j.id, { status: 'resolved', resolution: input.action, reason, resolved_at: now() })
        if (artifact) this.db.update('artifacts', artifact.id, { status: input.action === 'pass' ? 'approved' : 'rejected' })
        if (input.action === 'pass') {
          this.db.update('tasks', t.id, { status: 'done', live: '已完成', updated_at: now() })
          this.event(t.id, 'user', userId, me.name, `通过${reason ? `：${reason}` : ''}`)
          const left = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status NOT IN ('done','merged')", t.space_id)
          if ((left?.n ?? 0) === 0) this.requestPlan(t.space_id)
        } else {
          this.db.update('tasks', t.id, { status: 'in_progress', live: '根据打回意见修改', updated_at: now() })
          this.event(t.id, 'user', userId, me.name, `打回：${reason}`)
        }
      })
      if (input.action === 'reject' && t.executor_agent_id) this.jobs.enqueue('execute', t.executor_agent_id, { taskId: t.id, feedback: reason })
      if (input.saveAsStandard && reason) {
        this.addStandard(t.space_id, userId, reason, input.standardScope || '全部', `${me.name}${input.action === 'pass' ? '确认' : '打回'}「${t.title}」时写的`, t.id)
      }
    } else {
      const row = this.db.get<{ role: string }>('SELECT role FROM judgments WHERE id = ?', j.id)
      if (row?.role === 'watch') throw new DomainError('这件事由任务负责人定夺，你可以补充意见')
      if (input.action !== 'accept' && input.action !== 'override') throw new DomainError('定夺只能选择按建议定或改判')
      const outcome = input.action === 'accept' ? j.suggestion : (input.choice?.trim() ?? '')
      if (!outcome) throw new DomainError('改判需要写清楚你的结论')
      this.db.update('judgments', j.id, { status: 'resolved', resolution: input.action, reason: reason || null, resolved_at: now() })
      this.db.run("UPDATE judgments SET status = 'resolved', resolution = 'noted', resolved_at = ? WHERE ref_id = ? AND kind = 'decide' AND status = 'open' AND id != ?", now(), j.ref_id, j.id)
      this.finishDiscussion(j.ref_id, outcome, me.name, userId)
      if (input.saveAsStandard && reason) this.addStandard(j.space_id, userId, reason, input.standardScope || '全部', `${me.name}定夺「${j.title}」时写的`, j.ref_id)
    }
    this.bus.publish(`user:${userId}`, { type: 'judgments' })
    this.touch(j.space_id)
  }

  canRevokeDecision(userId: string, discussionId: string): boolean {
    const d = this.discussion(discussionId)
    if (d.status !== 'resolved' || !String(d.outcome ?? '').trim()) return false
    if (!this.isMember(d.space_id, userId)) return false
    if (userId === this.space(d.space_id).owner_id) return true
    if (d.task_id && this.task(d.task_id).owner_id === userId) return true
    return d.decided_by === userId
  }

  /** Keep the old conclusion in memory and on the task, but stop treating it as the current one. */
  revokeDecision(userId: string, discussionId: string, input: { reason: string; disableStandards?: boolean }): { disabledStandards: string[] } {
    if (!this.canRevokeDecision(userId, discussionId)) throw new DomainError('你不能撤销这个结论', 403)
    const reason = input.reason.trim()
    if (!reason) throw new DomainError('撤销需要写原因')
    const d = this.discussion(discussionId)
    const outcome = String(d.outcome ?? '').trim()
    const me = this.user(userId)
    const disabledStandards: string[] = []
    const targets = parseJson<string[]>(d.writeback, [])
    this.db.tx(() => {
      this.db.update('discussions', d.id, { status: 'escalated', outcome: '', revoked_outcome: outcome, revoke_reason: reason.slice(0, 500), revoked_by: userId, revoked_at: now() })
      this.db.insert('discussion_messages', { id: newId('dm'), discussion_id: d.id, author_kind: 'user', author_id: userId, author_name: me.name, text: `撤销结论：${reason}。原结论「${outcome}」不再有效。`, created_at: now() })
      this.remember(d.space_id, 'decision', `撤销结论「${d.title}」：原结论「${outcome}」不再有效。原因：${reason}`, d.id)
      for (const taskId of targets) {
        const t = this.db.get<Task>('SELECT * FROM tasks WHERE id = ?', taskId)
        if (!t || t.space_id !== d.space_id || t.status === 'merged') continue
        this.event(t.id, 'user', userId, me.name, `撤销讨论「${d.title}」的结论。原结论：${outcome}。原因：${reason}`)
        this.db.update('tasks', t.id, { status: 'in_progress', blocked_by_discussion: d.id, live: '结论已撤销，等重新定夺', updated_at: now() })
      }
      if (input.disableStandards) {
        const standards = this.db.all<{ id: string; text: string }>('SELECT id, text FROM standards WHERE space_id = ? AND source_ref = ? AND enabled = 1', d.space_id, d.id)
        for (const st of standards) {
          this.db.update('standards', st.id, { enabled: 0 })
          this.remember(d.space_id, 'standard', `停用团队标准「${st.text}」（随结论「${d.title}」一并撤销）`, st.id)
          disabledStandards.push(st.id)
        }
      }
    })
    const audience = this.escalationAudience(d)
    this.db.update('discussions', d.id, { decider_user_id: audience.deciderId, audience: [audience.deciderId, ...audience.watcherIds], escalate_why: audience.why })
    this.openEscalationJudgments(d.id, audience)
    this.touch(d.space_id)
    return { disabledStandards }
  }

  judgmentsFor(userId: string): Row[] {
    return this.db.all(`SELECT j.*, s.name AS space_name FROM judgments j JOIN spaces s ON s.id = j.space_id
      WHERE j.user_id = ? AND j.status = 'open' ORDER BY j.kind = 'decide' DESC, j.created_at`, userId)
  }

  // ---------- standards, memory, skills, files ----------

  addStandard(spaceId: string, userId: string | null, text: string, scope: string, source: string, sourceRef: string | null = null): Row {
    const clean = text.trim()
    if (!clean) throw new DomainError('规则不能为空')
    const dup = this.db.get('SELECT id FROM standards WHERE space_id = ? AND text = ?', spaceId, clean)
    if (dup) throw new DomainError('已经有这条规则了')
    const row = { id: newId('st'), space_id: spaceId, text: clean.slice(0, 300), scope: scope || '全部', source, source_ref: sourceRef, created_by: userId, enabled: 1, created_at: now() }
    this.db.insert('standards', row)
    this.remember(spaceId, 'standard', `新增团队标准「${row.text}」（${source}）`, row.id)
    this.touch(spaceId)
    return row
  }

  setStandardEnabled(spaceId: string, userId: string, standardId: string, enabled: boolean): void {
    this.requireMember(spaceId, userId)
    const st = this.db.get<{ space_id: string; text: string }>('SELECT space_id, text FROM standards WHERE id = ?', standardId)
    if (!st || st.space_id !== spaceId) throw new DomainError('规则不存在', 404)
    this.db.update('standards', standardId, { enabled })
    this.remember(spaceId, 'standard', `${enabled ? '启用' : '停用'}团队标准「${st.text}」`, standardId)
    this.touch(spaceId)
  }

  standards(spaceId: string, onlyEnabled = false): Row[] {
    return this.db.all(`SELECT * FROM standards WHERE space_id = ? ${onlyEnabled ? 'AND enabled = 1' : ''} ORDER BY enabled DESC, created_at DESC`, spaceId)
  }

  remember(spaceId: string, kind: 'decision' | 'standard' | 'change' | 'member', text: string, refId: string | null = null): void {
    this.db.insert('memory', { id: newId('m'), space_id: spaceId, kind, text, ref_id: refId, created_at: now() })
  }

  addSkill(spaceId: string, userId: string, input: { name: string; description: string; body: string }): Row {
    this.requireMember(spaceId, userId)
    if (!input.name.trim() || !input.body.trim()) throw new DomainError('skill 需要名称和做法')
    const row = { id: newId('sk'), space_id: spaceId, name: input.name.trim().slice(0, 60), description: input.description.trim().slice(0, 200), body: input.body.slice(0, 20000), maintainer_id: userId, created_at: now() }
    this.db.insert('skills', row)
    this.touch(spaceId)
    return row
  }

  addFile(spaceId: string, userId: string, input: { name: string; content: string; source?: string }): Row {
    this.requireMember(spaceId, userId)
    if (!input.name.trim() || !input.content.trim()) throw new DomainError('资料需要名称和内容')
    if (input.content.length > 500_000) throw new DomainError('资料太大，单个文本资料上限 500KB')
    const row = { id: newId('f'), space_id: spaceId, name: input.name.trim().slice(0, 120), content: input.content, source: input.source || '上传', added_by: userId, created_at: now() }
    this.db.insert('files', row)
    this.touch(spaceId)
    return row
  }

  // ---------- helpers ----------

  event(taskId: string, actorKind: string, actorId: string | null, actorName: string, text: string): void {
    this.db.insert('task_events', { id: newId('te'), task_id: taskId, actor_kind: actorKind, actor_id: actorId, actor_name: actorName, text, created_at: now() })
  }

  log(userId: string, agentId: string, spaceId: string | null, text: string, basis: string, link: string): void {
    this.db.insert('work_log', { id: newId('wl'), user_id: userId, agent_id: agentId, space_id: spaceId, text, basis, link, created_at: now() })
    this.bus.publish(`user:${userId}`, { type: 'worklog' })
  }

  touch(spaceId: string): void {
    this.bus.publish(`space:${spaceId}`, { type: 'changed' })
  }

  requireAgentInSpace(agent: Agent, spaceId: string, kind?: Agent['kind']): void {
    if (kind && agent.kind !== kind) throw new DomainError(`这个操作只允许${kind === 'assistant' ? '空间助理' : kind === 'specialist' ? '专项 agent' : '个人 agent'}执行`, 403)
    if (agent.space_id) {
      if (agent.space_id !== spaceId) throw new DomainError('不能操作其他空间的内容', 403)
      return
    }
    if (!agent.owner_user_id || !this.isMember(spaceId, agent.owner_user_id)) throw new DomainError('你的主人不是这个空间的成员', 403)
  }

  /** Shared space context given to every agent turn. */
  spaceContext(spaceId: string): Record<string, unknown> {
    const s = this.space(spaceId)
    return {
      space: { id: s.id, name: s.name, owner_user_id: s.owner_id, goal: s.goal_title ? { title: s.goal_title, due: s.goal_due, metrics: parseJson(s.goal_metrics, []) } : null },
      members: this.members(spaceId).filter((m) => m.left_at === null).map((m) => ({ user_id: m.id, name: m.name, title: m.title, public_profile: m.public_profile || '' })),
      specialists: this.spaceAgents(spaceId).filter((a) => a.kind === 'specialist').map((a) => ({ agent_id: a.id, name: a.name, specialty: a.specialty })),
      standards: this.standards(spaceId, true).map((st) => ({ id: st.id, text: st.text, scope: st.scope })),
      recent_memory: this.db.all<{ text: string; created_at: number }>('SELECT text, created_at FROM memory WHERE space_id = ? ORDER BY created_at DESC LIMIT 20', spaceId).map((m) => ({ text: m.text, date: new Date(m.created_at).toISOString().slice(0, 10) })),
      files: this.db.all('SELECT id, name, source FROM files WHERE space_id = ? ORDER BY created_at DESC', spaceId),
      skills: this.db.all('SELECT id, name, description FROM skills WHERE space_id = ? ORDER BY uses DESC', spaceId),
    }
  }

  taskView(taskId: string): Record<string, unknown> {
    const t = this.task(taskId)
    return {
      id: t.id, title: t.title, raw_input: t.raw_input, description: t.description, acceptance: parseJson(t.acceptance, []), status: t.status,
      owner_user_id: t.owner_id, executor_agent_id: t.executor_agent_id, due: t.due,
      history: this.db.all<{ actor_name: string; text: string }>('SELECT actor_name, text FROM task_events WHERE task_id = ? ORDER BY created_at', t.id).map((e) => `${e.actor_name}：${e.text}`),
      latest_artifact: this.db.get('SELECT id, title, kind, version, content, status FROM artifacts WHERE task_id = ? ORDER BY version DESC LIMIT 1', t.id) ?? null,
    }
  }

  discussionView(discussionId: string): Record<string, unknown> {
    const d = this.discussion(discussionId)
    return {
      id: d.id, title: d.title, question: d.question, status: d.status, task_id: d.task_id, summary: d.summary, options: parseJson(d.options as string, []),
      outcome: d.status === 'resolved' ? d.outcome : '',
      revoked_outcome: d.revoked_outcome || '',
      escalate_why: d.escalate_why || '',
      participants: this.db.all('SELECT a.id AS agent_id, a.name, a.kind FROM discussion_participants p JOIN agents a ON a.id = p.agent_id WHERE p.discussion_id = ?', d.id),
      messages: this.db.all<{ author_name: string; text: string }>('SELECT author_name, text FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at', d.id).map((m) => `${m.author_name}：${m.text}`),
    }
  }

  readFile(agent: Agent, fileId: string): string {
    const f = this.db.get<{ space_id: string; name: string; content: string }>('SELECT space_id, name, content FROM files WHERE id = ?', fileId)
    if (!f) throw new DomainError('资料不存在', 404)
    this.requireAgentInSpace(agent, f.space_id)
    this.db.run('UPDATE files SET reads = reads + 1 WHERE id = ?', fileId)
    return `# ${f.name}\n\n${f.content.slice(0, 60_000)}`
  }

  useSkill(agent: Agent, skillId: string): string {
    const sk = this.db.get<{ space_id: string; name: string; body: string }>('SELECT space_id, name, body FROM skills WHERE id = ?', skillId)
    if (!sk) throw new DomainError('skill 不存在', 404)
    this.requireAgentInSpace(agent, sk.space_id)
    this.db.run('UPDATE skills SET uses = uses + 1 WHERE id = ?', skillId)
    return `# ${sk.name}\n\n${sk.body}`
  }

  countStandardUse(spaceId: string): void {
    this.db.run('UPDATE standards SET uses = uses + 1 WHERE space_id = ? AND enabled = 1', spaceId)
  }
}
