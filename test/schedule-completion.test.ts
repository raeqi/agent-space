import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Db } from '../server/db.ts'
import { Bus } from '../server/bus.ts'
import { Domain } from '../server/domain.ts'

for (const scenario of [
  { name: 'complete records and passing checks', seen: 2, ok: true, expected: 'done' },
  { name: 'missing execution record', seen: 1, ok: true, expected: 'review' },
  { name: 'failed self check', seen: 2, ok: false, expected: 'review' },
  { name: 'extra execution record', seen: 3, ok: true, expected: 'review' },
]) test(`finite schedule: ${scenario.name}`, () => {
  const db = new Db(':memory:')
  const queued: string[] = []
  const domain = new Domain(db, new Bus(), { enqueue(kind) { queued.push(kind) } })
  const user = domain.ensureUser('schedule@test.local', '测试')
  const space = domain.createSpace(user.id, { name: '定时测试' })
  const task = domain.createTask(space.id, user.id, '输出两次 hi')
  const executor = domain.spaceAgents(space.id).find(a => a.kind === 'specialist')!
  db.update('tasks', task.id, { status: 'in_progress', owner_id: user.id, executor_agent_id: executor.id, schedule_result: JSON.stringify({ expected: 2, seen: scenario.seen, endsAt: Date.now(), scheduleId: 'schedule-test' }) })
  for (let i = 1; i <= scenario.seen; i++) domain.reportScheduledRun(executor, { task_id: task.id, text: 'hi' })
  queued.length = 0
  const artifact = domain.submitArtifact(executor, { task_id: task.id, title: '执行结果', content: '执行记录', self_check: [{ item: '核验执行', ok: scenario.ok }] })
  assert.equal(domain.task(task.id).status, scenario.expected)
  assert.equal(artifact.status, scenario.expected === 'done' ? 'approved' : 'pending')
  assert.equal(queued.includes('review_suggest'), scenario.expected === 'review')
  db.sql.close()
})
