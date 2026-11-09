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
  const profile: Record<string, [string, string]> = {
    lin: ['产品经理，负责新支付上线和新手引导。本月主要精力在新支付。', '上线日期优先于体验增强。对外文档必须有客服话术。花钱超过 1000 元、改目标或改日期一定先问我。'],
    zhou: ['研发，支付网关和回调链路最熟。本周回调重试要提测，周四下午有空。', '技术风险先暴露，不要为赶工跳过压测。'],
    su: ['设计，负责新手引导和支付页交互。', '体验问题要有数据支撑，A/B 结果优先。'],
    he: ['测试，做过 3 次支付压测，负责压测与灰度放量。本月 40% 可用。', '成功率不达标绝不放量。'],
    wang: ['产品组组长。', '本季度优先保证新支付按时上线。'],
    chen: ['研发，下周起接替周远负责新支付研发。', ''],
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
  msg(d1, assistant, '总结：分歧在于用 4 天研发换 3% 转化，超出 agent 能定的范围，交给 owner 定夺。', at(0, 8, 22))
  msg(d1, pa(people.lin), '以 owner 名义建议：动效放二期，交互主体一期上线。依据：团队标准「上线日期优先于体验增强」', at(0, 8, 40))
  db.insert('judgments', { id: newId('j'), space_id: pay.id, user_id: people.lin.id, kind: 'decide', ref_id: d1, title: '动效放一期还是二期', suggestion: '动效放二期，交互主体一期上线', suggested_action: 'accept', basis: '团队标准「上线日期优先于体验增强」', created_at: at(0, 8, 40) })

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

  // ---------- work log for 林夏 ----------
  const log = (text: string, spaceId: string, basis: string, link: string, ts: number) =>
    db.insert('work_log', { id: newId('wl'), user_id: people.lin.id, agent_id: pa(people.lin).id, space_id: spaceId, text, basis, link, created_at: ts })
  log('在讨论「动效放一期还是二期」里以 owner 名义给出建议', pay.id, '团队标准「上线日期优先于体验增强」', `/spaces/${pay.id}/discussions/${d1}`, at(0, 8, 40))
  log('看了「发布说明 v1」的交付，建议打回', pay.id, '验收标准第 3 条', `/spaces/${pay.id}/tasks/${notes}`, at(0, 9, 8))
  log('看了「新手引导流失分析」的交付，建议通过', team.id, '团队标准「分析报告结论放第一页」', `/spaces/${team.id}/tasks/${funnel}`, at(0, 8))
  log('在讨论「FAQ 覆盖哪些失败码」里替你陈述立场', pay.id, '', `/spaces/${pay.id}/discussions/${d2}`, at(1, 16, 12))

  return { spaces: 2 }
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
