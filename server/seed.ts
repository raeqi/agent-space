/**
 * Demo data: `npm run seed` fills an empty database with two spaces, six people and work in every state,
 * so the product can be explored before any agent has run. Log in as lin@demo.local (林夏).
 */
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { Db, newId, newToken } from './db.ts'
import { Bus } from './bus.ts'
import { Domain, type Agent } from './domain.ts'

const DAY = 86_400_000
const at = (daysAgo: number, hh: number, mm = 0): number => {
  const d = new Date(Date.now() - daysAgo * DAY)
  d.setHours(hh, mm, 0, 0)
  return Math.min(d.getTime(), Date.now() - 60_000)
}

/** Write the showcase space only when the database has no spaces yet. */
export function seedDemoIfEmpty(db: Db): boolean {
  if (db.get('SELECT 1 FROM spaces LIMIT 1')) return false
  seedDemo(db)
  return true
}

export function seedDemo(db: Db): { spaces: number } {
  if (db.get('SELECT 1 FROM spaces LIMIT 1')) throw new Error('数据库里已经有空间了，演示数据只写入空库。换一个 DATA_DIR 或删除 data/ 后再试。')
  const domain = new Domain(db, new Bus(), { enqueue: () => undefined })

  const people = {
    lin: domain.ensureUser('lin@demo.local', '林夏'),
    zhou: domain.ensureUser('zhou@demo.local', '周远'),
    su: domain.ensureUser('su@demo.local', '苏晴'),
    he: domain.ensureUser('he@demo.local', '何敏'),
    wang: domain.ensureUser('wang@demo.local', '王磊'),
    chen: domain.ensureUser('chen@demo.local', '陈一'),
  }
  // These profiles stand in for what a personal desktop agent would already have learned.
  const profile: Record<string, [string, string]> = {
    lin: [
      '产品经理，负责新支付上线和支付页体验。习惯先写能独立读懂的结论，再写范围、灰度和回滚。本月几乎全部精力在 12/3 全量替换旧通道，周四下午固定评审。对外口径、客服话术和上线日期由她拍板。',
      '工作方式：先看日期和结论，再看细节。一页读不完的材料，第一段必须能单独成立。\n会通过：结论在开头；范围、灰度和回滚写清；客服能照着说；没有改目标或改日期。\n会打回：对外文档没有客服话术；用体验优化换掉已经答应的上线日期；花钱超过 1000 元却没先问；灰度条件写成「看情况」。\n过往决定：分期付款推迟到风控规则就绪之后。入场动效如果要占用回调重试的工期，放二期，保 12/3。\n一定要本人：改目标、改日期、超预算、对外承诺。其余按「上线日期优先于体验增强」执行。',
    ],
    zhou: [
      '研发，支付网关、回调和重试最熟。本周要把回调重试提到可测，周四下午能评审。交接给陈一之前，关键路径上的技术风险由他先说清楚。',
      '工作方式：风险先写出来，再谈能不能赶上。不接受为了日期跳过压测或幂等。\n会通过：接口变更写进文档、测试同步过、重试有次数和幂等、排期拆到天并标出关键路径。\n会打回：字段名和已发布的接口文档不一致；没有失败码；用「先上线再补测」换工期。\n过往决定：回调字段用 retry_count，跟接口文档 v2 一致。超时的处理是调大连接池并加重试，而不是加长等待。\n一定要本人：改协议、跳过压测、动关键路径超过两天。',
    ],
    su: [
      '设计，负责新手引导和支付页交互。看重完成率和说得清的体验问题，A/B 结果优先于感觉。本周在做引导第 3 步，能参加体验和范围讨论。',
      '工作方式：体验问题要有数据或可复现的路径，不接受只有形容词的方案。\n会通过：两版对比放在一起；写清研发工作量；第 3 步的完成率有口径。\n会打回：只给一版终稿；用「更好看」代替完成率；动效方案不写要占多少研发时间。\n过往决定：绑卡不该塞进新手引导，竞品都放在首次支付。第 3 步流失高时，先查加载时间和文案，而不是加动画。\n立场：体验可以争，但不占用已经承诺的上线日期。动效若要 4 天，她会把数据摆出来，把日期留给负责人。',
    ],
    he: [
      '测试，做过 3 次支付压测，负责压测、灰度和失败码口径。本月大约 40% 时间在新支付。成功率不达标时她会拦住放量。',
      '工作方式：先看失败分布和是否达标，再看叙述。没有口径的结论一律退回。\n会通过：覆盖压测里出现的失败码；峰值和成功率写在第一段；放量条件是数字。\n会打回：成功率低于 99.5% 还写「可以全量」；FAQ 漏掉压测里的主要失败码；没有客服能直接用的话术。\n过往决定：第 2 轮压测达标，但回调超时仍是主要失败。FAQ 先写压测出现的 9 个失败码，其余放附录。\n一定要本人：放量、降低成功率门槛、跳过一轮压测。',
    ],
    wang: [
      '产品组组长。本季度的取舍标准是新支付按时上线，其他事项给它让路。周报要短，每个空间只留进展、风险和谁来拍板。',
      '工作方式：先问这件事会不会挡住 12/3。挡住了就升级，挡不住就让空间自己收掉。\n会通过：结论不超过三行；风险写清影响的日期；需要他拍板的事情单独列出。\n会打回：周报铺陈过程；用局部体验优化改掉季度目标；跨空间的冲突没有人汇总。\n过往决定：本季度优先保证新支付按时上线。分析报告结论放第一页，这条已经是团队标准。\n一定要本人：改季度优先级、加人、跨空间抢同一段工期。',
    ],
    chen: [
      '研发，下周起接替周远负责新支付的回调和网关。还在补上下文。评审时会先复述已经写下的决定，再提新方案。',
      '工作方式：先对齐已经发布的接口和标准，再改。交接期不发明第二套字段名。\n会通过：改动说明影响面；和接口文档 v2、retry_count 这些已有决定一致；测试在变更名单里。\n会打回：没读旧通道复盘就重做连接池；用新名字替换已经发布的字段；跳过幂等。\n过往决定：他还没在这个空间拍过板。周远留下的决定先延续，有冲突再交给周远或林夏。\n一定要本人：协议变更和跳过压测，在交接完成前仍要问周远或林夏。',
    ],
  }
  for (const [k, u] of Object.entries(people)) domain.updatePersonalAgent(u.id, { public_profile: profile[k]![0], handbook: profile[k]![1] })
  const pa = (u: { id: string }): Agent => domain.personalAgent(u.id)

  // ---------- 新支付上线 ----------
  const pay = domain.createSpace(people.lin.id, {
    name: '新支付上线', goalTitle: '新支付全量上线，替换旧通道', goalDue: dateIn(24),
    goalMetrics: ['支付成功率 ≥ 99.5%', '投诉不高于旧通道', '先 10% 灰度 3 天'],
    members: [
      { email: 'zhou@demo.local', name: '周远', title: '研发' },
      { email: 'su@demo.local', name: '苏晴', title: '设计' },
      { email: 'he@demo.local', name: '何敏', title: '测试，压测与灰度' },
      { email: 'chen@demo.local', name: '陈一', title: '研发，接替周远' },
    ],
  })
  for (const s of [{ name: '开发 agent', specialty: '写代码、修缺陷、评估研发工作量和技术风险' }, { name: '设计 agent', specialty: '交互方案、设计说明和体验走查' }]) {
    db.insert('agents', { id: newId('ag'), kind: 'specialist', space_id: pay.id, name: s.name, specialty: s.specialty, token: newToken(), created_at: at(9, 10) })
  }
  const ag = (name: string): Agent => domain.spaceAgents(pay.id).find((a) => a.name === name)!
  const assistant = ag('空间助理')

  const task = (spaceId: string, t: { title: string; raw?: string; status: string; owner: { id: string } | null; creator: { id: string }; exec: Agent | null; live?: string; acceptance?: string[]; due?: string; created: number; blocked?: string; merged?: string }): string => {
    const id = newId('t')
    db.insert('tasks', {
      id, space_id: spaceId, raw_input: t.raw ?? t.title, title: t.title, description: '', acceptance: t.acceptance ?? [],
      status: t.status, creator_id: t.creator.id, owner_id: t.owner?.id ?? null, executor_agent_id: t.exec?.id ?? null,
      due: t.due ?? null, merged_into: t.merged ?? null, blocked_by_discussion: t.blocked ?? null, live: t.live ?? '', created_at: t.created, updated_at: Date.now() - Math.floor(Math.random() * 3_600_000),
    })
    return id
  }
  const ev = (taskId: string, who: string, text: string, ts: number) => db.insert('task_events', { id: newId('te'), task_id: taskId, actor_kind: 'agent', actor_id: null, actor_name: who, text, created_at: ts })
  const art = (spaceId: string, taskId: string, a: { title: string; kind: string; content: string; status: string; version?: number; check?: Array<{ item: string; ok: boolean }>; ts: number }) =>
    db.insert('artifacts', { id: newId('ar'), space_id: spaceId, task_id: taskId, title: a.title, kind: a.kind, content: a.content, self_check: a.check ?? [], version: a.version ?? 1, status: a.status, created_at: a.ts })

  // done
  const plan = task(pay.id, { title: '新支付方案定稿', status: 'done', owner: people.lin, creator: people.lin, exec: ag('文档 agent'), acceptance: ['结论放第一页', '写清灰度和回滚策略'], created: at(8, 10), live: '已完成' })
  art(pay.id, plan, { title: '新支付方案（定稿）', kind: '文档', status: 'approved', ts: at(7, 16), content: '# 新支付方案\n\n结论：12/3 全量替换旧通道，先 10% 灰度 3 天，成功率达标再放量。\n\n## 范围\n- 收银台、回调、对账三条链路\n- 分期付款不在本期\n\n## 灰度与回滚\n- 灰度 10% 持续 3 天，成功率 ≥ 99.5% 才放量\n- 成功率低于 99% 时 5 分钟内切回旧通道' })
  ev(plan, '林夏', '通过', at(7, 17))
  const apiDoc = task(pay.id, { title: '接口文档 v2', status: 'done', owner: people.zhou, creator: people.zhou, exec: ag('文档 agent'), acceptance: ['覆盖全部回调字段', '标注变更点'], created: at(7, 11), live: '已完成' })
  art(pay.id, apiDoc, { title: '接口文档 v2', kind: '文档', status: 'approved', version: 2, ts: at(6, 15), content: '# 新支付接口文档 v2\n\n结论：相比 v1 新增 `retry_count` 和 `fail_code` 两个回调字段，其余兼容。\n\n## 回调字段\n- `order_id` 订单号\n- `status` 支付结果\n- `fail_code` 失败码（新增）\n- `retry_count` 重试次数（新增）' })
  const report = task(pay.id, { title: '第 2 轮压测报告', status: 'done', owner: people.he, creator: people.he, exec: ag('测试 agent'), created: at(4, 10), live: '已完成' })
  art(pay.id, report, { title: '压测报告（第 2 轮）', kind: '报告', status: 'approved', ts: at(3, 18), content: '# 第 2 轮压测\n\n结论：峰值 1200 TPS 下成功率 99.62%，达标；回调超时是主要失败原因。\n\n## 失败分布\n- 回调超时 61%\n- 余额不足 22%\n- 风控拦截 17%' })

  // review
  const notes = task(pay.id, { title: '发布说明 v1', raw: '上线前写一份发布说明，范围、灰度和回滚都要写清楚', status: 'review', owner: people.lin, creator: people.lin, exec: ag('文档 agent'), acceptance: ['结论在第一段', '含回滚步骤', '附客服话术'], due: dateIn(17), created: at(1, 10, 2), live: '已交付，等负责人确认' })
  ev(notes, '林夏', '发起任务', at(1, 10, 2)); ev(notes, '空间助理', '整理完成：负责人 林夏，交给文档 agent 执行', at(1, 10, 4)); ev(notes, '文档 agent', '先按方案定稿整理范围，再补回滚和客服部分', at(1, 10, 40)); ev(notes, '文档 agent', '交付「发布说明 v1」v1，自检后交给负责人确认', at(0, 9, 5))
  art(pay.id, notes, { title: '发布说明 v1', kind: '文档', status: 'pending', ts: at(0, 9, 5), check: [{ item: '结论在第一段', ok: true }, { item: '含回滚步骤', ok: true }, { item: '附客服话术', ok: false }],
    content: '# 新支付 12/3 上线说明\n\n结论：12/3 全量替换旧通道，先 10% 灰度 3 天。\n\n## 上线范围\n- 收银台、回调、对账\n\n## 回滚\n- 成功率低于 99% 时 5 分钟内切回旧通道\n- 切换由值班研发执行，测试同步验证' })
  db.insert('judgments', { id: newId('j'), space_id: pay.id, user_id: people.lin.id, kind: 'confirm', ref_id: notes, title: '发布说明 v1', suggestion: '打回：缺客服话术，客服上线当天会被问到', suggested_action: 'reject', basis: '验收标准第 3 条', created_at: at(0, 9, 8) })
  const estimate = task(pay.id, { title: '研发排期评估', status: 'review', owner: people.zhou, creator: people.lin, exec: ag('开发 agent'), acceptance: ['按里程碑拆到天', '标出关键路径'], created: at(2, 14), live: '已交付，等负责人确认' })
  art(pay.id, estimate, { title: '研发排期评估', kind: '文档', status: 'pending', ts: at(0, 8, 30), content: '# 研发排期\n\n结论：按当前人力 11/22 可以开发完成，回调重试是关键路径。\n\n- 回调重试：剩 3 天\n- 对账改造：剩 2 天，可并行' })
  db.insert('judgments', { id: newId('j'), space_id: pay.id, user_id: people.zhou.id, kind: 'confirm', ref_id: estimate, title: '研发排期评估', suggestion: '通过：拆分到天，关键路径清楚', suggested_action: 'pass', basis: '验收标准', created_at: at(0, 8, 40) })

  // discussion → blocked task → escalated decision
  const guide = task(pay.id, { title: '新手引导交互方案', status: 'in_progress', owner: people.su, creator: people.su, exec: ag('设计 agent'), acceptance: ['给出两版对比', '标注研发工作量'], created: at(3, 11), live: '卡在讨论「动效放一期还是二期」' })
  const d1 = newId('d')
  db.insert('discussions', { id: d1, space_id: pay.id, task_id: guide, title: '动效放一期还是二期', question: '交互方案里有入场动效，需要研发确认工作量，放一期还是二期？', opened_by_agent_id: ag('设计 agent').id, status: 'escalated', summary: '分歧在于用 4 天研发换 3% 转化，超出 agent 能定的范围', options: ['动效放一期，上线顺延', '动效放二期，交互主体一期上线'], created_at: at(0, 8, 10) })
  db.update('tasks', guide, { blocked_by_discussion: d1 })
  for (const a of [ag('设计 agent'), ag('开发 agent'), pa(people.zhou), pa(people.su), pa(people.lin)]) db.insert('discussion_participants', { discussion_id: d1, agent_id: a.id })
  const msg = (d: string, a: Agent | { id: string; name: string }, text: string, ts: number, kind = 'agent') => db.insert('discussion_messages', { id: newId('dm'), discussion_id: d, author_kind: kind, author_id: a.id, author_name: a.name, text, created_at: ts })
  msg(d1, ag('设计 agent'), '交互方案里有入场动效，需要研发确认工作量，放一期还是二期？', at(0, 8, 10))
  msg(d1, ag('开发 agent'), '动效要多 4 天，和回调重试占用同一段时间。', at(0, 8, 14))
  msg(d1, pa(people.zhou), '建议放二期，关键路径上已经有 2 天风险。', at(0, 8, 16))
  msg(d1, pa(people.su), '建议一期上，A/B 测试里第 3 步完成率高 3%。', at(0, 8, 18))
  const escalateWhy = '交给苏晴定夺，因为苏晴是任务「新手引导交互方案」的负责人。周远的个人 agent 在讨论里立场不同，周远也会看到并可以补充意见'
  msg(d1, assistant, `总结：分歧在于用 4 天研发换 3% 转化，超出 agent 能定的范围。${escalateWhy}`, at(0, 8, 22))
  msg(d1, pa(people.su), '以负责人名义建议：动效放二期，交互主体一期上线。依据：团队标准「上线日期优先于体验增强」', at(0, 8, 40))
  db.update('discussions', d1, { decider_user_id: people.su.id, audience: JSON.stringify([people.su.id, people.zhou.id]), escalate_why: escalateWhy })
  db.insert('judgments', { id: newId('j'), space_id: pay.id, user_id: people.su.id, kind: 'decide', role: 'decide', ref_id: d1, title: '动效放一期还是二期', suggestion: '动效放二期，交互主体一期上线', suggested_action: 'accept', basis: '团队标准「上线日期优先于体验增强」', created_at: at(0, 8, 40) })
  db.insert('judgments', { id: newId('j'), space_id: pay.id, user_id: people.zhou.id, kind: 'decide', role: 'watch', ref_id: d1, title: '动效放一期还是二期', suggestion: '建议放二期，关键路径上已经有风险。', suggested_action: 'watch', basis: escalateWhy, created_at: at(0, 8, 41) })

  // in progress
  const retry = task(pay.id, { title: '回调重试', status: 'in_progress', owner: people.zhou, creator: people.zhou, exec: ag('开发 agent'), acceptance: ['超时自动重试 3 次', '幂等'], created: at(5, 9), live: '写重试逻辑，62%' })
  const d3 = newId('d')
  db.insert('discussions', { id: d3, space_id: pay.id, task_id: retry, title: '回调字段命名', question: '重试次数字段叫 retry_count 还是 retries？', opened_by_agent_id: ag('开发 agent').id, status: 'resolved', outcome: '用 retry_count，与接口文档 v2 一致', decided_by: '空间助理', writeback: [retry], created_at: at(4, 15), resolved_at: at(4, 15, 20) })
  msg(d3, ag('开发 agent'), '重试次数字段叫 retry_count 还是 retries？', at(4, 15))
  msg(d3, ag('文档 agent'), '接口文档 v2 里已经写的是 retry_count。', at(4, 15, 5))
  msg(d3, assistant, '结论：用 retry_count，与接口文档 v2 一致', at(4, 15, 20))
  task(pay.id, { title: '压测脚本', status: 'in_progress', owner: people.he, creator: people.he, exec: ag('测试 agent'), acceptance: ['覆盖峰值 1.5 倍流量', '输出失败码分布'], created: at(4, 9), live: '第 3 轮压测，比计划慢，预计晚 2 天' })
  const faq = task(pay.id, { title: '新支付客服 FAQ', raw: '上线前写一份客服 FAQ，失败原因和处理办法都要有', status: 'in_progress', owner: people.he, creator: people.lin, exec: ag('文档 agent'), acceptance: ['覆盖压测中出现的全部失败码', '结论先行', '附客服话术'], due: dateIn(19), created: at(1, 15), live: '整理失败码，已并入「失败码梳理」' })
  task(pay.id, { title: '失败码梳理', status: 'merged', owner: null, creator: people.he, exec: null, created: at(1, 15, 30), merged: faq, live: '已并入「新支付客服 FAQ」' })
  const d2 = newId('d')
  db.insert('discussions', { id: d2, space_id: pay.id, task_id: faq, title: 'FAQ 覆盖哪些失败码', question: 'FAQ 只写压测出现的失败码，还是全部 23 个？', opened_by_agent_id: ag('文档 agent').id, status: 'resolved', outcome: '先写压测出现的 9 个，其余放附录', decided_by: '空间助理', writeback: [faq], created_at: at(1, 16), resolved_at: at(1, 16, 30) })
  msg(d2, ag('文档 agent'), 'FAQ 只写压测出现的失败码，还是全部 23 个？', at(1, 16))
  msg(d2, pa(people.he), '客服最常遇到的是压测里出现的那 9 个，其余很少见。', at(1, 16, 10))
  msg(d2, assistant, '结论：先写压测出现的 9 个，其余放附录', at(1, 16, 30))

  // unclaimed
  task(pay.id, { title: '新支付监控看板', status: 'unclaimed', owner: null, creator: people.lin, exec: null, created: at(0, 9, 20), live: '空间助理推荐周远' })

  db.run(`UPDATE tasks SET source = 'plan' WHERE space_id = ? AND title IN ('新支付方案定稿','研发排期评估','回调重试','压测脚本','第 2 轮压测报告')`, pay.id)
  db.run(`UPDATE tasks SET source = 'event:告警群' WHERE space_id = ? AND title = '新支付监控看板'`, pay.id)

  // standards, skills, files, memory
  const std = (spaceId: string, text: string, scope: string, source: string, uses: number, ts: number, enabled = 1, by: string | null = null) =>
    db.insert('standards', { id: newId('st'), space_id: spaceId, text, scope, source, created_by: by, enabled, uses, created_at: ts })
  std(pay.id, '上线日期优先于体验增强', '全部', '林夏手动添加', 4, at(9, 11), 1, people.lin.id)
  std(pay.id, '接口变更必须同步给测试 agent', '全部', '周远打回「接口文档 v1」时写的', 12, at(7, 10), 1, people.zhou.id)
  std(pay.id, '灰度期间每天汇报成功率', '测试', '林夏手动添加', 3, at(6, 9), 1, people.lin.id)
  std(pay.id, '分析报告结论放第一页', '数据', '林夏确认「第 1 轮压测报告」时写的', 31, at(8, 15), 1, people.lin.id)
  std(pay.id, '用户数据不出境', '全部', '林夏手动添加', 18, at(9, 10), 1, people.lin.id)
  std(pay.id, '周报不超过 10 行', '文档', '林夏手动添加', 9, at(9, 10, 30), 0, people.lin.id)

  const skill = (spaceId: string, name: string, description: string, body: string, by: { id: string }, uses: number, ts: number) =>
    db.insert('skills', { id: newId('sk'), space_id: spaceId, name, description, body, maintainer_id: by.id, uses, created_at: ts })
  skill(pay.id, '发布检查清单', '上线前 22 项检查，含回滚演练', '1. 确认灰度比例和放量条件\n2. 回滚演练至少一次\n3. 客服 FAQ 和话术就绪\n4. 监控和告警阈值确认', people.zhou, 9, at(8, 10))
  skill(pay.id, '客服 FAQ 模板', '按失败码整理，客服可以直接用', '每个失败码一节：现象、原因、处理办法、给用户的话术（不超过两句）。', people.he, 5, at(6, 10))
  skill(pay.id, '压测报告', '固定口径的压测结论和瓶颈分析', '结论先行：峰值 TPS、成功率、是否达标；然后失败分布、瓶颈、下一轮计划。', people.he, 3, at(5, 10))
  skill(pay.id, '数据分析报告', '漏斗分析，结论先行，附原始查询', '第一页写结论和建议；正文给漏斗和口径；附录放 SQL。', people.lin, 14, at(9, 12))

  const file = (spaceId: string, name: string, content: string, source: string, by: { id: string }, reads: number, ts: number) =>
    db.insert('files', { id: newId('f'), space_id: spaceId, name, content, source, added_by: by.id, reads, created_at: ts })
  file(pay.id, '支付网关接口文档.md', '# 支付网关接口\n\n## 下单\nPOST /pay/create\n\n## 回调\n网关在支付结束后回调商户地址，5 秒内未收到 200 视为超时，最多重试 3 次。\n\n## 失败码\n- E101 余额不足\n- E203 风控拦截\n- E301 回调超时\n- E302 签名错误', '上传', people.zhou, 14, at(9, 14))
  file(pay.id, '旧通道故障复盘 2025.md', '# 旧通道 2025 年故障复盘\n\n结论：三次故障都和回调超时有关，根因是连接池过小且没有重试。\n\n- 3 月：大促期间回调堆积 40 分钟\n- 7 月：证书过期导致签名失败\n- 11 月：连接池耗尽', '上传', people.zhou, 6, at(9, 15))
  file(pay.id, '客服常见投诉汇总 Q3.csv', '类别,数量,占比\n扣款未到账,412,38%\n重复扣款,198,18%\n支付失败无提示,176,16%\n退款慢,301,28%', '上传', people.he, 3, at(5, 11))
  file(pay.id, '合规要求：境内数据存储.md', '# 合规要求\n\n所有用户支付数据必须存储在境内机房，日志脱敏后才能用于分析。', '上传', people.lin, 2, at(8, 9))

  const mem = (spaceId: string, kind: string, text: string, ts: number) => db.insert('memory', { id: newId('m'), space_id: spaceId, kind, text, created_at: ts })
  db.run('DELETE FROM memory WHERE space_id = ?', pay.id)
  mem(pay.id, 'change', '创建空间，目标：新支付全量上线，替换旧通道', at(9, 10))
  mem(pay.id, 'decision', '分期付款推迟到新支付稳定后：风控规则还没就绪（林夏定夺）', at(9, 11, 30))
  mem(pay.id, 'decision', '方案定稿：先 10% 灰度 3 天，成功率达标再放量（林夏定夺）', at(7, 17))
  mem(pay.id, 'standard', '新增团队标准「接口变更必须同步给测试 agent」（周远打回「接口文档 v1」时写的）', at(7, 10))
  mem(pay.id, 'member', '何敏加入，负责压测与灰度', at(6, 9, 30))
  mem(pay.id, 'decision', '回调超时：调大连接池并加重试（agent 讨论达成）', at(5, 16))
  mem(pay.id, 'decision', '回调字段命名：用 retry_count，与接口文档 v2 一致（agent 讨论达成）', at(4, 15, 20))
  mem(pay.id, 'change', '压测预计晚 2 天，按当前速度 11/30 完成', at(1, 9))
  mem(pay.id, 'decision', 'FAQ 覆盖哪些失败码：先写压测出现的 9 个，其余放附录（agent 讨论达成）', at(1, 16, 30))
  mem(pay.id, 'member', '陈一加入，接替周远负责研发', at(0, 8))

  // ---------- 产品组 ----------
  const team = domain.createSpace(people.wang.id, {
    name: '产品组',
    members: [
      { email: 'lin@demo.local', name: '林夏', title: '产品' },
      { email: 'zhou@demo.local', name: '周远', title: '研发' },
      { email: 'su@demo.local', name: '苏晴', title: '设计' },
      { email: 'chen@demo.local', name: '陈一', title: '研发' },
    ],
  })
  const tag = (name: string): Agent => domain.spaceAgents(team.id).find((a) => a.name === name)!
  const funnel = task(team.id, { title: '新手引导流失分析', raw: '新手引导第 3 步流失很高，分析一下原因', status: 'review', owner: people.lin, creator: people.lin, exec: tag('数据 agent'), acceptance: ['结论放第一页', '附查询口径'], created: at(2, 10), live: '已交付，等负责人确认' })
  art(team.id, funnel, { title: '新手引导流失分析 v1', kind: '报告', status: 'pending', ts: at(0, 7, 50), check: [{ item: '结论放第一页', ok: true }, { item: '附查询口径', ok: true }],
    content: '# 新手引导流失分析\n\n结论：第 3 步流失 42%，主要因为绑卡页加载慢（P90 4.2 秒）和文案不清楚。\n\n## 建议\n- 绑卡页预加载，目标 P90 < 1.5 秒\n- 改写第 3 步说明文案\n\n## 口径\n- 时间：近 30 天\n- 人群：新注册用户' })
  db.insert('judgments', { id: newId('j'), space_id: team.id, user_id: people.lin.id, kind: 'confirm', ref_id: funnel, title: '新手引导流失分析', suggestion: '通过：结论在第一页，查询可复现', suggested_action: 'pass', basis: '团队标准「分析报告结论放第一页」', created_at: at(0, 8) })
  task(team.id, { title: '本周周报', status: 'in_progress', owner: people.wang, creator: people.wang, exec: tag('文档 agent'), created: at(0, 9), live: '汇总各空间进展' })
  const comp = task(team.id, { title: '竞品支付流程对比', status: 'done', owner: people.su, creator: people.su, exec: tag('数据 agent'), created: at(6, 10), live: '已完成' })
  art(team.id, comp, { title: '竞品支付流程对比', kind: '报告', status: 'approved', ts: at(5, 15), content: '# 竞品支付流程对比\n\n结论：三家竞品都把绑卡放在首次支付时，而不是新手引导里。' })
  std(team.id, '分析报告结论放第一页', '数据', '林夏确认时写的', 31, at(20, 10), 1, people.lin.id)
  std(team.id, '用户数据不出境', '全部', '王磊手动添加', 18, at(20, 11), 1, people.wang.id)
  skill(team.id, '周报生成', '汇总空间进展，按王磊的格式', '每个空间三行：进展、风险、需要谁拍板。', people.wang, 21, at(20, 9))
  skill(team.id, '竞品速览', '三家竞品同一功能对比', '同一功能，三家竞品，一张表：入口、步骤数、亮点、问题。', people.su, 7, at(15, 9))
  db.run('DELETE FROM memory WHERE space_id = ?', team.id)
  mem(team.id, 'change', '创建空间', at(20, 9))
  mem(team.id, 'decision', '本季度优先保证新支付按时上线（王磊定夺）', at(10, 10))

  // Isolated mock spaces; no real agent jobs are scheduled.
  for (const name of ['用户研究', '秋季发布准备']) {
    const demo = domain.createSpace(people.lin.id, { name })
    const executor = domain.spaceAgents(demo.id).find(a => a.name === '通用 agent')!
    const cases = [
      ['整理访谈问题', 'triage', '空间助理正在补全验收标准'],
      ['联系外部顾问', 'unclaimed', '等待负责人认领'],
      ['汇总用户反馈', 'in_progress', '已整理 18/30 条反馈'],
      ['修订研究总结', 'in_progress', '根据打回意见补充样本量和证据'],
      ['检查资料链接', 'in_progress', '来源无法访问，需要补充资料'],
      ['确认访谈提纲', 'review', '已交付，等负责人确认'],
      ['检查发布清单', 'review', '自检发现遗漏，建议打回'],
      ['整理历史问题', 'done', '已完成'],
    ]
    for (const [title, status, live] of cases) {
      const id = task(demo.id, { title: title!, status: status!, live, owner: status === 'triage' || status === 'unclaimed' ? null : people.lin, creator: people.lin, exec: status === 'triage' || status === 'unclaimed' ? null : executor, acceptance: ['附来源', '明确行动负责人'], created: at(1, 10) })
      ev(id, '空间助理', live!, at(0, 9))
      if (status === 'review' || status === 'done') {
        const pass = title !== '检查发布清单'
        art(demo.id, id, { title: title!, kind: '文档', status: status === 'done' ? 'approved' : 'pending', ts: at(0, 9), content: '# '+title+'\n\n演示产物：已完成主要整理。来源为团队共享资料，下一步由林夏确认。', check: [{ item: '附来源', ok: true }, { item: '明确行动负责人', ok: pass }] })
        if (status === 'review') db.insert('judgments', { id: newId('j'), space_id: demo.id, user_id: people.lin.id, kind: 'confirm', ref_id: id, title: title!, suggestion: pass ? '通过：内容完整' : '打回：需要补充负责人', suggested_action: pass ? 'pass' : 'reject', basis: '验收标准', created_at: at(0, 9) })
      }
    }
    mem(demo.id, 'change', '演示空间，内容均为模拟数据', at(1, 9))
  }

  const helpTask = task(team.id, { title: '确认反馈标签口径', status: 'in_progress', owner: people.lin, creator: people.lin, exec: tag('数据 agent'), created: at(0, 9), live: '正在讨论标签是否允许多选' })
  const openDiscussion = newId('d')
  db.insert('discussions', { id: openDiscussion, space_id: team.id, task_id: helpTask, title: '反馈标签是否允许多选', question: '同一条反馈同时涉及性能与体验时，使用主标签还是多个标签？', status: 'open', opened_by_agent_id: tag('数据 agent').id, created_at: at(0, 9) })
  db.update('tasks', helpTask, { blocked_by_discussion: openDiscussion })
  for (const agent of [pa(people.lin), pa(people.su), tag('数据 agent')]) db.insert('discussion_participants', { discussion_id: openDiscussion, agent_id: agent.id })
  msg(openDiscussion, tag('数据 agent'), '建议保留多个标签，汇总时按反馈去重。', at(0, 9))
  msg(openDiscussion, pa(people.su), '同意多选，但需要保留原始反馈，便于复核分类。', at(0, 9, 2))

  // ---------- work log for 林夏 ----------
  const log = (text: string, spaceId: string, basis: string, link: string, ts: number) =>
    db.insert('work_log', { id: newId('wl'), user_id: people.lin.id, agent_id: pa(people.lin).id, space_id: spaceId, text, basis, link, created_at: ts })
  db.insert('work_log', { id: newId('wl'), user_id: people.su.id, agent_id: pa(people.su).id, space_id: pay.id, text: '在讨论「动效放一期还是二期」里以负责人名义给出建议', basis: '团队标准「上线日期优先于体验增强」', link: `/spaces/${pay.id}/discussions/${d1}`, created_at: at(0, 8, 40) })
  log('看了「发布说明 v1」的交付，建议打回', pay.id, '验收标准第 3 条', `/spaces/${pay.id}/tasks/${notes}`, at(0, 9, 8))
  log('看了「新手引导流失分析」的交付，建议通过', team.id, '团队标准「分析报告结论放第一页」', `/spaces/${team.id}/tasks/${funnel}`, at(0, 8))
  log('在讨论「FAQ 覆盖哪些失败码」里替你陈述立场', pay.id, '', `/spaces/${pay.id}/discussions/${d2}`, at(1, 16, 12))

  return { spaces: 4 }
}

function dateIn(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const db = new Db(join(config.dataDir, 'agent-space.db'))
  try {
    seedDemo(db)
    console.log(`演示数据已写入 ${config.dataDir}`)
    console.log('登录邮箱：lin@demo.local（林夏，新支付上线的 owner）')
    console.log('其他成员：zhou@ su@ he@ wang@ chen@ demo.local')
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
