import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Db } from '../server/db.ts'
import { Bus } from '../server/bus.ts'
import { Domain } from '../server/domain.ts'
import { loadConfig } from '../server/config.ts'
import { buildPrompt } from '../server/agents/prompts.ts'
import { runOptionsForJob } from '../server/agents/runtime.ts'

test('short jobs use the light model and space tools; execute keeps the main model', () => {
  const config = loadConfig({}, {
    MODEL_API_KEY: 'sk', MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-v4-pro', MODEL_LIGHT_NAME: 'deepseek-flash',
  })
  assert.equal(config.lightModel, 'deepseek-flash')
  assert.equal(config.lightMode, false)
  assert.deepEqual(runOptionsForJob(config, 'execute'), { model: 'deepseek-v4-pro', tools: 'full' })
  for (const kind of ['triage', 'plan', 'discussion_reply', 'discussion_moderate', 'review_suggest', 'decide_suggest']) {
    assert.deepEqual(runOptionsForJob(config, kind), { model: 'deepseek-flash', tools: 'space' })
  }
  const same = loadConfig({}, { MODEL_API_KEY: 'sk', MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-v4-pro' })
  assert.equal(same.lightModel, 'deepseek-v4-pro')
  assert.equal(loadConfig({}, { LIGHT_MODE: '1', MODEL_API_KEY: 'sk', MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-v4-pro' }).lightMode, true)
})

test('light mode allows one discussion, shortens the artifact, and skips pre-review', () => {
  const db = new Db(':memory:')
  const queued: string[] = []
  const domain = new Domain(db, new Bus(), { enqueue(kind) { queued.push(kind) } })
  domain.limits = { maxDiscussionsPerTask: 1, maxArtifactChars: 12, skipReviewSuggest: true }
  const user = domain.ensureUser('light@test.local', '林夏')
  const space = domain.createSpace(user.id, { name: '轻量' })
  const task = domain.createTask(space.id, user.id, '写一份说明')
  const executor = domain.spaceAgents(space.id).find((a) => a.kind === 'specialist')!
  db.update('tasks', task.id, { status: 'in_progress', owner_id: user.id, executor_agent_id: executor.id })
  const assistant = domain.assistantOf(space.id)
  const first = domain.openDiscussion(assistant, { task_id: task.id, title: '一次就够', question: '写多长？' })
  domain.resolveDiscussion(assistant, { discussion_id: first.id, outcome: '写短的' })
  assert.throws(() => domain.openDiscussion(assistant, { task_id: task.id, title: '再议一次', question: '还要吗？' }), /讨论次数已经用完/)
  queued.length = 0
  const artifact = domain.submitArtifact(executor, { task_id: task.id, title: '说明', content: '一二三四五六七八九十超长的正文', self_check: [{ item: '短', ok: true }] })
  assert.match(String(artifact.content), /轻量模式已截断/)
  assert.equal(String(artifact.content).startsWith('一二三四五六七八九十'), true)
  assert.equal(queued.includes('review_suggest'), false)
  const prompt = buildPrompt(domain, 'execute', executor.id, { taskId: task.id }, { lightMode: true })
  assert.match(prompt, /不要用 write/)
  assert.doesNotMatch(prompt, /先用 mcp__space__post_progress/)
  assert.match(prompt, /800 字/)
  db.close()
})
