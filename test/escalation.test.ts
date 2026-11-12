import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Db } from '../server/db.ts'
import { Bus } from '../server/bus.ts'
import { Domain } from '../server/domain.ts'

function setup() {
  const db = new Db(':memory:')
  const queued: string[] = []
  const domain = new Domain(db, new Bus(), { enqueue(kind) { queued.push(kind) } })
  const owner = domain.ensureUser('lin@escalation.test', '林夏')
  const lead = domain.ensureUser('su@escalation.test', '苏晴')
  const dev = domain.ensureUser('zhou@escalation.test', '周远')
  const bystander = domain.ensureUser('he@escalation.test', '何敏')
  const space = domain.createSpace(owner.id, { name: '新支付', members: [
    { email: lead.email, name: '苏晴', title: '设计' },
    { email: dev.email, name: '周远', title: '研发' },
    { email: bystander.email, name: '何敏', title: '测试' },
  ] })
  const task = domain.createTask(space.id, lead.id, '新手引导交互的范围取舍')
  const executor = domain.spaceAgents(space.id).find((a) => a.kind === 'specialist')!
  db.update('tasks', task.id, { status: 'in_progress', owner_id: lead.id, executor_agent_id: executor.id })
  const assistant = domain.assistantOf(space.id)
  const discussion = domain.openDiscussion(assistant, { task_id: task.id, title: '动效放几期', question: '放一期还是二期？', participant_user_ids: [lead.id, dev.id, bystander.id] })
  domain.postDiscussionMessage(domain.personalAgent(lead.id), discussion.id, '建议放一期，完成率更高。')
  domain.postDiscussionMessage(domain.personalAgent(dev.id), discussion.id, '建议放二期，保上线日期。')
  domain.postDiscussionMessage(domain.personalAgent(bystander.id), discussion.id, '建议放一期，完成率更高。')
  return { db, domain, owner, lead, dev, bystander, space, task, assistant, discussion }
}

test('escalation reaches the task owner and the people whose agents disagreed', () => {
  const { db, domain, owner, lead, dev, bystander, task, assistant, discussion } = setup()
  domain.escalateDiscussion(assistant, { discussion_id: discussion.id, summary: '用 4 天研发换 3% 转化', options: ['动效放一期', '动效放二期'] })
  const open = db.all<{ user_id: string; role: string; basis: string }>('SELECT user_id, role, basis FROM judgments WHERE ref_id = ? AND status = ?', discussion.id, 'open')
  assert.deepEqual(open.map((j) => j.user_id).sort(), [lead.id, dev.id].sort())
  assert.equal(open.find((j) => j.user_id === lead.id)?.role, 'decide')
  assert.equal(open.find((j) => j.user_id === dev.id)?.role, 'watch')
  assert.equal(open.some((j) => j.user_id === owner.id), false)
  assert.equal(open.some((j) => j.user_id === bystander.id), false, 'same stance as the decider is not a disagreement')
  assert.match(open[0]!.basis, /苏晴/)
  assert.match(open[0]!.basis, /负责人/)
  assert.match(open[0]!.basis, /周远/)
  const disc = domain.discussion(discussion.id)
  assert.equal(disc.decider_user_id, lead.id)
  assert.match(disc.escalate_why, /交给苏晴定夺/)

  const watch = db.get<{ id: string }>('SELECT id FROM judgments WHERE user_id = ? AND ref_id = ?', dev.id, discussion.id)!
  assert.throws(() => domain.resolveJudgment(dev.id, watch.id, { action: 'accept' }), /负责人/)
  domain.resolveJudgment(dev.id, watch.id, { action: 'comment', reason: '关键路径上已经有两天风险。' })
  assert.match(db.get<{ text: string }>('SELECT text FROM discussion_messages ORDER BY created_at DESC LIMIT 1')!.text, /两天风险/)

  domain.suggestDecision(domain.personalAgent(lead.id), { discussion_id: discussion.id, choice: '动效放二期', basis: '上线日期优先' })
  const deciderItem = db.get<{ id: string; suggestion: string }>('SELECT id, suggestion FROM judgments WHERE user_id = ? AND ref_id = ? AND role = ?', lead.id, discussion.id, 'decide')!
  assert.equal(deciderItem.suggestion, '动效放二期')
  domain.resolveJudgment(lead.id, deciderItem.id, { action: 'accept', reason: '日期不能动', saveAsStandard: true })
  assert.equal(domain.discussion(discussion.id).status, 'resolved')
  assert.equal(domain.task(task.id).blocked_by_discussion, null)
  assert.equal(db.get<{ status: string }>('SELECT status FROM judgments WHERE user_id = ? AND ref_id = ?', dev.id, discussion.id)!.status, 'resolved')
  db.close()
})

test('a task without an owner falls back to the space owner', () => {
  const { db, domain, owner, assistant, discussion, task } = setup()
  db.update('tasks', task.id, { owner_id: null })
  domain.escalateDiscussion(assistant, { discussion_id: discussion.id, summary: '没有负责人', options: ['继续', '停下'] })
  const decider = db.get<{ user_id: string; role: string }>('SELECT user_id, role FROM judgments WHERE ref_id = ? AND role = ?', discussion.id, 'decide')
  assert.equal(decider?.user_id, owner.id)
  assert.match(domain.discussion(discussion.id).escalate_why, /空间 owner/)
  db.close()
})

test('a decided conclusion can be revoked without deleting it, and a linked standard can be disabled', () => {
  const { db, domain, lead, dev, bystander, space, task, assistant, discussion } = setup()
  domain.escalateDiscussion(assistant, { discussion_id: discussion.id, summary: '用 4 天研发换 3% 转化', options: ['动效放一期', '动效放二期'] })
  domain.suggestDecision(domain.personalAgent(lead.id), { discussion_id: discussion.id, choice: '动效放二期', basis: '上线日期优先' })
  const item = db.get<{ id: string }>('SELECT id FROM judgments WHERE user_id = ? AND ref_id = ? AND role = ?', lead.id, discussion.id, 'decide')!
  domain.resolveJudgment(lead.id, item.id, { action: 'accept', reason: '日期不能动', saveAsStandard: true })
  const before = db.all<{ text: string }>('SELECT text FROM memory WHERE kind = ?', 'decision').map((m) => m.text)
  assert.ok(before.some((text) => text.includes('动效放二期') && !text.startsWith('撤销')))

  assert.throws(() => domain.revokeDecision(bystander.id, discussion.id, { reason: '我想改' }), /不能撤销/)
  assert.throws(() => domain.revokeDecision(lead.id, discussion.id, { reason: '  ' }), /原因/)

  const result = domain.revokeDecision(lead.id, discussion.id, { reason: '灰度数据变了，要重开', disableStandards: true })
  assert.equal(result.disabledStandards.length, 1)
  const disc = domain.discussion(discussion.id)
  assert.equal(disc.status, 'escalated')
  assert.equal(disc.outcome, '')
  assert.equal(disc.revoked_outcome, '动效放二期')
  assert.match(disc.revoke_reason, /灰度数据/)
  const memory = db.all<{ text: string }>('SELECT text FROM memory WHERE kind = ? ORDER BY created_at', 'decision').map((m) => m.text)
  assert.ok(memory.some((text) => text.includes('动效放二期') && !text.includes('撤销')))
  assert.ok(memory.some((text) => text.includes('撤销结论') && text.includes('不再有效')))
  const updated = domain.task(task.id)
  assert.equal(updated.status, 'in_progress')
  assert.equal(updated.blocked_by_discussion, discussion.id)
  assert.ok(db.all<{ text: string }>('SELECT text FROM task_events WHERE task_id = ?', task.id).some((e) => /撤销/.test(e.text)))
  assert.equal(db.get<{ enabled: number }>('SELECT enabled FROM standards WHERE source_ref = ?', discussion.id)!.enabled, 0)
  const again = db.get<{ status: string; suggestion: string }>('SELECT status, suggestion FROM judgments WHERE user_id = ? AND ref_id = ? ORDER BY created_at DESC LIMIT 1', lead.id, discussion.id)!
  assert.equal(again.status, 'open')
  assert.equal(again.suggestion, '')
  assert.equal(domain.canRevokeDecision(dev.id, discussion.id), false)
  db.close()
  void space
})
