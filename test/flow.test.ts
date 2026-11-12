import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { loadConfig } from '../server/config.ts'
import { createApp, type App } from '../server/app.ts'
import { startFakeModel, type FakeModel } from './fake-model.ts'

let app: App
let model: FakeModel
let base = ''
let dataDir = ''

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

class Client {
  cookie = ''
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0]!
    const json = (await res.json()) as T & { error?: string }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error}`)
    return json
  }
}

before(async () => {
  model = await startFakeModel()
  dataDir = mkdtempSync(join(tmpdir(), 'agent-space-test-'))
  const port = await freePort()
  process.env.DEEPSEEK_API_KEY = 'sk-test'
  // The scripted model speaks the DeepSeek adapter's Messages format. Pin that route so a
  // generic MODEL_* in the environment cannot switch the test onto Chat Completions.
  const config = loadConfig({
    port, host: '127.0.0.1', internalUrl: `http://127.0.0.1:${port}`, dataDir, modelBaseUrl: model.url,
    provider: 'deepseek-official', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', modelRoute: 'deepseek',
    agentTimeoutMs: 120_000, maxConcurrentAgents: 4, webDist: join(dataDir, 'no-web'),
  })
  app = await createApp(config, { logger: false })
  await app.server.listen({ port, host: '127.0.0.1' })
  app.jobs.start()
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await app?.close()
  await model?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('task flow: organise, execute, suggest, reject with a standard, re-execute, pass', { timeout: 600_000 }, async () => {
  const lin = new Client()
  const zhou = new Client()
  const { user: linUser } = await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  await zhou.call('POST', '/api/login', { email: 'zhou@example.com', name: '周远' })

  const { space } = await lin.call('POST', '/api/spaces', { name: '新支付上线', goalTitle: '新支付全量上线', goalDue: '2026-12-03', members: [{ email: 'zhou@example.com', name: '周远', title: '研发' }] })
  const { spaces } = await zhou.call('GET', '/api/spaces')
  assert.equal(spaces.length, 1, 'member sees the space')

  const { task } = await lin.call('POST', `/api/spaces/${space.id}/tasks`, { text: '上线前写一份客服 FAQ' })
  await app.jobs.idle(300_000)

  let detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'review', 'organised, executed and delivered')
  assert.equal(detail.task.owner_id, linUser.id)
  assert.ok(detail.task.acceptance.length >= 1, 'assistant wrote acceptance criteria')
  assert.equal(detail.artifacts.length, 1)

  let { judgments } = await lin.call('GET', '/api/judgments')
  const confirm = judgments.find((j: any) => j.ref_id === task.id)
  assert.ok(confirm, 'owner got a confirmation item')
  assert.equal(confirm.suggested_action, 'pass', 'personal agent suggested')

  await lin.call('POST', `/api/judgments/${confirm.id}`, { action: 'reject', reason: '对外文档都要附客服话术', saveAsStandard: true })
  const { standards } = await lin.call('GET', `/api/spaces/${space.id}/standards`)
  assert.equal(standards[0].text, '对外文档都要附客服话术', 'reason became a team standard')

  await app.jobs.idle(300_000)
  detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'review', 're-executed after rejection')
  assert.equal(detail.artifacts.length, 2)
  assert.match(detail.artifacts[0].content, /客服话术/)

  ;({ judgments } = await lin.call('GET', '/api/judgments'))
  const second = judgments.find((j: any) => j.ref_id === task.id)
  await lin.call('POST', `/api/judgments/${second.id}`, { action: 'pass' })
  detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'done')

  const { memory } = await lin.call('GET', `/api/spaces/${space.id}/memory`)
  assert.ok(memory.some((m: any) => m.kind === 'standard'), 'standard recorded in memory')
  const { items } = await lin.call('GET', '/api/worklog')
  assert.ok(items.length >= 2, 'personal agent actions appear in the work log')
})

test('a task without a matching specialist goes to the general agent instead of stalling', { timeout: 600_000 }, async () => {
  const lin = new Client()
  await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  const { space } = await lin.call('POST', '/api/spaces', { name: '杂事' })
  const { task } = await lin.call('POST', `/api/spaces/${space.id}/tasks`, { text: '建一个定时任务，每分钟说一次 hi' })
  await app.jobs.idle(300_000)

  // A finite scheduled task holds delivery until its runs report back.
  let detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'in_progress', 'assigned instead of left unclaimed, and not delivered before the runs')
  assert.equal(detail.task.executor_name, '通用 agent')
  assert.equal(detail.artifacts.length, 0, 'early delivery was refused')
  assert.equal(detail.task.live, '等定时任务跑完（0/2）')

  const executor = app.domain.agent(detail.task.executor_agent_id)
  app.domain.reportScheduledRun(executor, { task_id: task.id, text: 'hi' })
  detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.live, '等定时任务跑完（1/2）')
  app.domain.reportScheduledRun(executor, { task_id: task.id, text: 'hi' })
  await app.jobs.idle(300_000)

  detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'done', 'complete scheduled runs do not require human approval')
  assert.equal(detail.artifacts[0].status, 'approved')
  assert.equal(app.domain.db.all("SELECT id FROM judgments WHERE ref_id = ? AND status = 'open'", task.id).length, 0)
  assert.equal(detail.artifacts.length, 1)
  const history = detail.events.map((e: any) => e.text)
  assert.ok(history.includes('第 1 次执行：hi') && history.includes('第 2 次执行：hi'), 'each run is on the task')
})

test('a scheduled task that stops reporting is delivered after its expected end', { timeout: 600_000 }, async () => {
  const lin = new Client()
  await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  const { space } = await lin.call('POST', '/api/spaces', { name: '杂事二' })
  const { task } = await lin.call('POST', `/api/spaces/${space.id}/tasks`, { text: '定时提醒两次喝水' })
  await app.jobs.idle(300_000)
  const t = app.domain.task(task.id)
  const wait = app.domain.scheduleWait(t)!
  app.domain.db.update('tasks', t.id, { schedule_wait: JSON.stringify({ ...wait, endsAt: Date.now() - 10 * 60_000 }) })
  app.domain.finishOverdueScheduleWaits()
  await app.jobs.idle(300_000)
  const detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'review')
  assert.ok(detail.events.some((e: any) => /过预计结束时间，收到 0\/2 次/.test(e.text)))
})

test('discussion flow: agent opens, participants reply, escalates, owner decides, task resumes', { timeout: 600_000 }, async () => {
  const lin = new Client()
  await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  const { spaces } = await lin.call('GET', '/api/spaces')
  const spaceId = spaces[0].id

  const { task } = await lin.call('POST', `/api/spaces/${spaceId}/tasks`, { text: '新手引导交互的范围取舍' })
  await app.jobs.idle(300_000)

  const { discussions } = await lin.call('GET', `/api/spaces/${spaceId}/discussions`)
  const disc = discussions.find((d: any) => d.task_id === task.id)
  assert.ok(disc, 'executor opened a discussion')
  assert.equal(disc.status, 'escalated')
  const view = await lin.call('GET', `/api/discussions/${disc.id}`)
  assert.ok(view.messages.length >= 3, 'question, replies and summary recorded')

  const { judgments } = await lin.call('GET', '/api/judgments')
  const decide = judgments.find((j: any) => j.kind === 'decide' && j.ref_id === disc.id)
  assert.ok(decide, 'owner got a decision item')
  assert.equal(decide.suggestion, '动效放二期')

  await lin.call('POST', `/api/judgments/${decide.id}`, { action: 'accept' })
  await app.jobs.idle(300_000)
  const detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.status, 'review', 'task resumed and delivered after the decision')
  assert.ok(detail.events.some((e: any) => e.text.includes('结论写回')))
  const { memory } = await lin.call('GET', `/api/spaces/${spaceId}/memory`)
  assert.ok(memory.some((m: any) => m.kind === 'decision' && m.text.includes('动效放二期')))
})

test('duplicate tasks are merged and handover moves ownership', { timeout: 600_000 }, async () => {
  const lin = new Client()
  const { user: linUser } = await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  const chen = new Client()
  const { user: chenUser } = await chen.call('POST', '/api/login', { email: 'chen@example.com', name: '陈一' })
  const { space } = await lin.call('POST', '/api/spaces', { name: '产品组', members: [{ email: 'chen@example.com', name: '陈一', title: '研发' }] })

  await lin.call('POST', `/api/spaces/${space.id}/tasks`, { text: '整理失败码' })
  await app.jobs.idle(300_000)
  const { task: dup } = await lin.call('POST', `/api/spaces/${space.id}/tasks`, { text: '重复：失败码梳理' })
  await app.jobs.idle(300_000)
  const d = await lin.call('GET', `/api/tasks/${dup.id}`)
  assert.equal(d.task.status, 'merged')

  const zhou = new Client()
  const { user: zhouUser } = await zhou.call('POST', '/api/login', { email: 'zhou@example.com', name: '周远' })
  await lin.call('POST', `/api/spaces/${space.id}/members`, { email: 'zhou@example.com', name: '周远', title: '研发' })
  const result = await lin.call('POST', `/api/spaces/${space.id}/handover`, { leavingUserId: zhouUser.id, successorId: chenUser.id })
  assert.equal(result.tasks, 0)
  const info = await lin.call('GET', `/api/spaces/${space.id}`)
  assert.ok(info.members.find((m: any) => m.id === zhouUser.id).left_at, 'leaver marked')
  assert.equal(info.space.owner_id, linUser.id)
})

test('a goal is broken into tasks automatically, and external events become tasks', { timeout: 600_000 }, async () => {
  const lin = new Client()
  await lin.call('POST', '/api/login', { email: 'lin@example.com', name: '林夏' })
  const { space } = await lin.call('POST', '/api/spaces', { name: '目标空间', goalTitle: '月底前上线退款入口', goalDue: '2026-12-31', members: [{ email: 'he@example.com', name: '何敏', title: '测试' }] })
  await app.jobs.idle(300_000)

  const { tasks } = await lin.call('GET', `/api/spaces/${space.id}/tasks`)
  const planned = tasks.filter((t: any) => t.source === 'plan')
  assert.equal(planned.length, 2, 'assistant planned tasks from the goal')
  assert.ok(planned.every((t: any) => t.status === 'review'), 'planned tasks were executed and delivered')
  const { memory } = await lin.call('GET', `/api/spaces/${space.id}/memory`)
  assert.ok(memory.some((m: any) => m.text.includes('按目标拆出 2 个任务')))

  const hook = await lin.call('GET', `/api/spaces/${space.id}/hook`)
  const bad = await fetch(`${base}${hook.url}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify({ text: 'x' }) })
  assert.equal(bad.status, 401)
  const res = await fetch(`${base}${hook.url}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` }, body: JSON.stringify({ source: '客服群', from: '客户 A', text: '退款按钮在安卓上点不动' }) })
  assert.equal(res.status, 200)
  const { task } = (await res.json()) as { task: { id: string } }
  await app.jobs.idle(300_000)
  const detail = await lin.call('GET', `/api/tasks/${task.id}`)
  assert.equal(detail.task.source, 'event:客服群')
  assert.equal(detail.task.status, 'review', 'event task was organised, executed and delivered')
  assert.match(detail.task.raw_input, /客户 A/)
})
