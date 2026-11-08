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

const TOOL_RULE = '只通过 mcp__space__ 开头的工具修改空间；不要只在回复里写结论。工具报错时按提示修正后重试。完成后用一句话说明你做了什么。'

export function buildPrompt(domain: Domain, kind: JobKind, agentId: string, payload: Record<string, unknown>): string {
  const agent = domain.agent(agentId)
  switch (kind) {
    case 'triage': {
      const t = domain.task(String(payload.taskId))
      const open = domain.db.all('SELECT id, title, status, owner_id FROM tasks WHERE space_id = ? AND id != ? AND status NOT IN (\'done\',\'merged\') ORDER BY created_at DESC LIMIT 30', t.space_id, t.id)
      return frame(kind, `
有成员刚发起了一个任务，请你整理它，然后调用 mcp__space__triage_task 一次。
- 把原话改写成清楚的标题和说明，写 2 到 5 条可检查的验收标准（要体现相关的团队标准）。
- 负责人从成员里选：优先选发起人，除非成员档案显示别人明显更合适。负责人必须是 members 里的 user_id。
- 执行者从 specialists 里选最合适的 agent_id；如果没有合适的专项 agent，executor_agent_id 传 null，任务进入待认领。
- 如果和 open_tasks 里的任务实质重复，用 merge_into_task_id 合并，并在 note 说明原因。
${TOOL_RULE}`, { ...domain.spaceContext(t.space_id), task: { id: t.id, raw_input: t.raw_input, creator_user_id: t.creator_id }, open_tasks: open })
    }
    case 'execute': {
      const t = domain.task(String(payload.taskId))
      return frame(kind, `
你是这个任务的执行者。请完成它并调用 mcp__space__submit_artifact 提交 Markdown 产物，附上按验收标准和团队标准逐条做的自检。
- 开始时先用 mcp__space__post_progress 说一句你要怎么做。需要背景时用 mcp__space__read_file 读资料，用 mcp__space__use_skill 读相关 skill。
- 如果有必须由别人拍板的问题（例如范围、日期、体验和工期的取舍），不要自己猜：调用 mcp__space__open_discussion 发起讨论，然后结束本轮。
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
${TOOL_RULE}`, { ...domain.spaceContext(t.space_id), task: domain.taskView(t.id), owner_handbook: agent.handbook || '（主人没有写判断手册）' })
    }
    case 'discussion_reply': {
      const d = domain.discussion(String(payload.discussionId))
      const ownerName = agent.owner_user_id ? domain.user(agent.owner_user_id).name : ''
      return frame(kind, `
你被邀请参加一个讨论。${agent.kind === 'personal' ? `你代表${ownerName}发言：按他的判断手册、公开档案和团队目标表明立场。` : ''}
请调用 mcp__space__post_discussion_message 发言一次：先给立场，再给一两句理由。不要替别人做最终决定。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id), discussion: domain.discussionView(d.id), task: d.task_id ? domain.taskView(d.task_id) : null, your_owner_handbook: agent.kind === 'personal' ? agent.handbook || '（没有写判断手册）' : undefined })
    }
    case 'discussion_moderate': {
      const d = domain.discussion(String(payload.discussionId))
      return frame(kind, `
你是讨论的组织者。读完所有发言后二选一：
- 分歧在 agent 能定的范围内（纯技术、措辞、格式等，且有团队标准或明显更优解）：调用 mcp__space__resolve_discussion 写下结论，结论会写回任务。
- 涉及目标、截止日期、资源投入、体验和工期取舍，或者发言方立场冲突且没有标准可依：调用 mcp__space__escalate_discussion，用一句话提炼分歧点并列出 2 到 3 个方案，交给 owner 定夺。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id), discussion: domain.discussionView(d.id), task: d.task_id ? domain.taskView(d.task_id) : null })
    }
    case 'decide_suggest': {
      const d = domain.discussion(String(payload.discussionId))
      return frame(kind, `
一个分歧被交给你的主人（空间 owner）定夺。请以 owner 的名义给出建议结论，调用 mcp__space__suggest_decision 一次。
- 依据优先级：空间目标 > 团队标准 > 主人的判断手册 > 讨论里的理由。basis 里写清楚你依据的是哪一条。
- choice 写成可以直接执行的结论。主人可以按建议定，也可以改判。
${TOOL_RULE}`, { ...domain.spaceContext(d.space_id), discussion: domain.discussionView(d.id), options: parseJson(d.options as string, []), owner_handbook: agent.handbook || '（主人没有写判断手册）' })
    }
  }
}

export function buildMemoryQuestion(domain: Domain, spaceId: string, question: string): string {
  const memory = domain.db.all<{ kind: string; text: string; created_at: number }>('SELECT kind, text, created_at FROM memory WHERE space_id = ? ORDER BY created_at', spaceId)
  return `【job:memory_ask】\n根据空间记忆回答成员的问题。只依据下面的记录回答，并注明日期；记录里没有就直接说没有记录。不要调用任何工具。\n\n问题：${question}\n\n<context>\n${JSON.stringify({ memory: memory.map((m) => ({ date: new Date(m.created_at).toISOString().slice(0, 10), kind: m.kind, text: m.text })) }, null, 1)}\n</context>`
}
