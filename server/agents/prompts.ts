import type { Domain, JobKind } from '../domain.ts'
import { parseJson } from '../db.ts'

/**
 * Every agent turn starts a fresh dsh session. The shared context lives in the space (database), so each prompt
 * carries the job kind, instructions and a JSON context block. The first line is machine-readable on purpose:
 * it keeps prompts uniform and lets the scripted test model recognise the job.
 */
function frame(kind: JobKind, instructions: string, context: Record<string, unknown>): string {
  return `【job:${kind}】\n${instructions.trim()}\n\n<context>\n${JSON.stringify(context, null, 1)}\n</context>`
}

const TOOL_RULE = '只通过 mcp__space__ 开头的工具修改空间；不要只在回复里写结论。任务和讨论的全文已经在 context 里，不要再读取它们，也不要调用 get_task。工具报错时按提示修正后重试。完成后用一句话说明你做了什么。'

export function buildPrompt(domain: Domain, kind: JobKind, agentId: string, payload: Record<string, unknown>, options: { lightMode?: boolean } = {}): string {
  const agent = domain.agent(agentId)
  switch (kind) {
    case 'triage': {
      const t = domain.task(String(payload.taskId))
      const open = domain.db.all('SELECT id, title, status, owner_id FROM tasks WHERE space_id = ? AND id != ? AND status NOT IN (\'done\',\'merged\') ORDER BY created_at DESC LIMIT 30', t.space_id, t.id)
      return frame(kind, `
有成员刚发起了一个任务，请你整理它，然后调用 mcp__space__triage_task 一次。
- 把原话改写成清楚的标题和说明，写 2 到 5 条可检查的验收标准（要体现相关的团队标准）。
- 负责人从成员里选：优先选发起人，除非成员档案显示别人明显更合适。负责人必须是 members 里的 user_id。
- 执行者从 specialists 里选最合适的 agent_id。所有执行 agent 都能写文档、查资料和网页、跑命令、写和运行脚本、创建定时任务；明显属于某个专项的交给它，其余（包括要动手操作、定时执行的任务）交给「通用 agent」。不要因为"没有对应专项"就不分配。执行 agent 是内部分工，成员看不到：note 里不要提具体是哪个 agent。
- 如果和 open_tasks 里的任务实质重复，用 merge_into_task_id 合并，并在 note 说明原因。
- 只整理这一条任务。不要另起一批计划，也不要把任务再读一遍。
${TOOL_RULE}`, { ...domain.spaceContext(t.space_id, { brief: true }), task: { id: t.id, raw_input: t.raw_input, creator_user_id: t.creator_id }, open_tasks: open })
    }
    case 'execute': {
      const t = domain.task(String(payload.taskId))
      return frame(kind, `
你是这个任务的执行者。请完成它，并只调用一次 mcp__space__submit_artifact 提交 Markdown 产物，附上按验收标准和团队标准逐条做的自检。
- 交付方式：文档正文只放在 submit_artifact 的 content 里。不要用 write、edit 或 bash 先把全文写到本地文件，再把同一份内容贴进 submit_artifact。不要为了交付反复改写同一份文档。
- 不必先调用 post_progress。任务全文已经在 context 里，不要再读一遍。需要背景时用 mcp__space__read_file 读资料，用 mcp__space__use_skill 读相关 skill。
${options.lightMode ? '- 轻量模式：产物控制在 800 字以内，只保留结论和验收需要的要点。这个任务最多发起一次讨论；如果已经讨论过，就按已有结论自己做决定并交付。' : ''}
- 如果有必须由别人拍板的问题（例如范围、日期、体验和工期的取舍），不要自己猜：调用 mcp__space__open_discussion 发起讨论，然后结束本轮。
- 除了空间工具，你还有完整的本地能力，任务需要动手时直接做，不要只写方案：bash 跑命令、read/write/edit 读写你工作目录里的文件、web_search/web_fetch 查网页、schedule_create/schedule_list/schedule_edit 创建和管理定时任务。
- 任务要求定时或重复执行时，用 schedule_create 真的创建它（按要求设好时间规则、次数和 Asia/Shanghai 时区，结束条件用 RRULE 的 COUNT 或 UNTIL）。target 优先用 new_once（投到当前会话会排队到本轮结束才执行）；如果报错再用 this_session。定时任务的 prompt 必须写成可以独立执行的完整指令，并要求每次执行后调用 mcp__space__report_scheduled_run（task_id: ${t.id}）用一句话记下这次的结果，否则成员在空间里看不到执行结果。创建后用 schedule_view 回读确认。
- 定时任务是有限次数的（COUNT 或 7 天内的 UNTIL），并且验收要看到执行结果时：回读后调用 mcp__space__wait_for_scheduled_runs（expected_runs 填总次数，ends_at 填最后一次执行时间），然后直接结束本轮，不要提交产物——全部执行后系统会再叫你交付。不限次数或很久以后才结束的定时任务，回读后直接提交产物。
- 产物里写清楚：定时任务 id、时间规则、各次触发时间、结束时间、怎么暂停或删除。
${payload.afterSchedule ? `- 定时任务已经执行完（收到 ${Number(payload.runsSeen)}/${Number(payload.runsExpected)} 次执行记录，见 task.history 里「第 N 次执行」）。现在不要再创建定时任务，用 schedule_view 确认它已结束，然后提交产物：把每次执行的时间和结果列出来，再按验收标准逐条自检；没收到的执行要如实写明。` : ''}
${payload.feedback ? `- 负责人打回了上一版，意见是：「${String(payload.feedback)}」。请据此修改后重新提交。` : ''}
${payload.discussionOutcome ? `- 之前的讨论已有结论：「${String(payload.discussionOutcome)}」。按结论继续完成任务。` : ''}
${TOOL_RULE}`, { ...domain.spaceContext(t.space_id), task: domain.taskView(t.id), you: { agent_id: agent.id, name: agent.name } })
    }
    case 'review_suggest': {
      const t = domain.task(String(payload.taskId))
      return frame(kind, `
你代表主人（任务负责人）先看一遍交付，给出建议，调用 mcp__space__suggest_review 一次。
- 按验收标准、团队标准和主人的判断手册逐条检查 latest_artifact。
- 全部满足就建议通过（pass）；有明确缺失就建议打回（reject），reason 写成主人可以直接用的一句话。
- basis 写你的依据，例如“验收清单第 2 条”或“团队标准：结论放第一页”。
${TOOL_RULE}`, { ...domain.spaceContext(t.space_id, { brief: true }), task: reviewTask(domain, t.id), owner_handbook: agent.handbook || '（主人没有写判断手册）' })
    }
    case 'discussion_reply': {
      const d = domain.discussion(String(payload.discussionId))
      const ownerName = agent.owner_user_id ? domain.user(agent.owner_user_id).name : ''
      return frame(kind, `
你被邀请参加一个讨论。${agent.kind === 'personal' ? `你代表${ownerName}发言：按他的判断手册、公开档案和团队目标表明立场。` : ''}
请调用 mcp__space__post_discussion_message 发言一次：先给立场，再给一两句理由。不要替别人做最终决定。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id, { brief: true }), discussion: domain.discussionView(d.id), task: d.task_id ? taskBrief(domain, d.task_id) : null, your_owner_handbook: agent.kind === 'personal' ? agent.handbook || '（没有写判断手册）' : undefined })
    }
    case 'discussion_moderate': {
      const d = domain.discussion(String(payload.discussionId))
      return frame(kind, `
你是讨论的组织者。读完所有发言后二选一：
- 分歧在 agent 能定的范围内（纯技术、措辞、格式等，且有团队标准或明显更优解）：调用 mcp__space__resolve_discussion 写下结论，结论会写回任务。
- 涉及目标、截止日期、资源投入、体验和工期取舍，或者发言方立场冲突且没有标准可依：调用 mcp__space__escalate_discussion，用一句话提炼分歧点并列出 2 到 3 个方案。定夺会交给任务负责人；没有负责人时交给空间 owner。立场不同的成员会看到。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id, { brief: true }), discussion: domain.discussionView(d.id), task: d.task_id ? taskBrief(domain, d.task_id) : null })
    }
    case 'plan': {
      const s = domain.space(String(payload.spaceId))
      const tasks = domain.db.all('SELECT title, status, owner_id, due FROM tasks WHERE space_id = ? AND status != \'merged\' ORDER BY created_at', s.id)
      return frame(kind, `
空间有一个目标。请把它拆成接下来要做的一批任务，调用 mcp__space__plan_tasks 一次。
- 只拆近期（两周内）要开始的 2 到 6 个任务，后面的等这批完成后再拆。已有任务（existing_tasks）不要重复。
- 每个任务写清楚标题、说明、2 到 4 条验收标准；负责人从 members 里按档案和分工选，执行者从 specialists 里选，没有明显对应的专项就交给「通用 agent」。
- 有截止日期的目标，按倒推给每个任务一个 due（YYYY-MM-DD）。
${TOOL_RULE}`, { ...domain.spaceContext(s.id, { brief: true }), existing_tasks: tasks, today: new Date().toISOString().slice(0, 10) })
    }
    case 'decide_suggest': {
      const d = domain.discussion(String(payload.discussionId))
      const decides = payload.decides !== false
      return frame(kind, `
${decides
    ? '一个分歧被交给你的主人定夺（任务负责人；没有负责人时是空间 owner）。请给出建议结论，调用 mcp__space__suggest_decision 一次。主人可以按建议定，也可以改判。'
    : '一个分歧里，你的主人和别人立场不同。定夺的是任务负责人，不是你的主人。请仍给出建议，调用 mcp__space__suggest_decision 一次，供负责人参考。'}
- 依据优先级：空间目标 > 团队标准 > 主人的判断手册 > 讨论里的理由。basis 里写清楚你依据的是哪一条。
- choice 写成可以直接执行的结论。如果讨论记录里有「撤销结论」，那条旧结论已经作废，不要再沿用。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id, { brief: true }), discussion: domain.discussionView(d.id), options: parseJson(d.options as string, []), owner_handbook: agent.handbook || '（主人没有写判断手册）' })
    }
  }
}

function taskBrief(domain: Domain, taskId: string): Record<string, unknown> {
  const t = domain.task(taskId)
  return { id: t.id, title: t.title, status: t.status, acceptance: parseJson(t.acceptance, []), owner_user_id: t.owner_id }
}

function reviewTask(domain: Domain, taskId: string): Record<string, unknown> {
  const view = domain.taskView(taskId)
  const artifact = view.latest_artifact
  if (artifact && typeof artifact === 'object' && 'content' in artifact && typeof artifact.content === 'string' && artifact.content.length > 4000) {
    view.latest_artifact = { ...artifact, content: `${artifact.content.slice(0, 4000)}\n\n（产物较长，这里只给出开头）` }
  }
  return view
}

export function buildMemoryQuestion(domain: Domain, spaceId: string, question: string): string {
  const memory = domain.db.all<{ kind: string; text: string; created_at: number }>('SELECT kind, text, created_at FROM memory WHERE space_id = ? ORDER BY created_at', spaceId)
  return `【job:memory_ask】\n根据空间记忆回答成员的问题。只依据下面的记录回答，并注明日期；记录里没有就直接说没有记录。不要调用任何工具。\n\n问题：${question}\n\n<context>\n${JSON.stringify({ memory: memory.map((m) => ({ date: new Date(m.created_at).toISOString().slice(0, 10), kind: m.kind, text: m.text })) }, null, 1)}\n</context>`
}
