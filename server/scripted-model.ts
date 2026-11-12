/**
 * Scripted model for tests and for demo mode. It speaks the Anthropic Messages
 * streaming format that the harness DeepSeek adapter uses, reads the job kind
 * and context from server/agents/prompts.ts, and answers with the tool calls a
 * careful teammate would make. The runtime, MCP and domain paths stay real.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

type Msg = { role: string; content: Array<{ type: string; text?: string; name?: string }> | string }
type ToolCall = { name: string; input: Record<string, unknown> }
type Ctx = Record<string, any>

function script(job: string, ctx: Ctx): ToolCall[] | string {
  switch (job) {
    case 'triage': {
      const t = ctx.task
      const dup = /重复/.test(t.raw_input) && ctx.open_tasks?.length ? ctx.open_tasks[0].id : null
      if (dup) return [{ name: 'triage_task', input: { task_id: t.id, title: t.raw_input, description: '和已有任务说的是同一件事，合并后沿用那边的负责人和验收。', acceptance: [], owner_user_id: t.creator_user_id, merge_into_task_id: dup, note: '和已有任务重复，合并进去，避免两套验收。' } }]
      const scheduled = /定时/.test(t.raw_input)
      return [{ name: 'triage_task', input: {
        task_id: t.id, title: String(t.raw_input).slice(0, 30),
        description: `把「${t.raw_input}」收成一件可交付的事：结论放在第一段，范围和验收都能逐条核对。`,
        acceptance: ['结论放在第一段', '覆盖原始要求里的每一点'], owner_user_id: t.creator_user_id,
        // Scheduled work: leave the executor empty so the space assigns the general agent instead of stalling.
        executor_agent_id: scheduled ? null : ctx.specialists[0].agent_id,
        note: scheduled ? '这是要按时执行的事，先安排执行，而不是停在方案。' : '负责人是发起人。执行按专长分配，成员看到的是结果。',
      } }]
    }
    case 'execute': {
      const t = ctx.task
      const history = (t.history as string[]) ?? []
      const decided = history.some((h) => h.includes('结论写回'))
      const calls: ToolCall[] = [{ name: 'post_progress', input: { task_id: t.id, text: '先对照验收和团队标准列提纲，再逐条写完。' } }]
      if (/取舍/.test(t.title) && !decided) {
        calls.push({ name: 'open_discussion', input: {
          task_id: t.id, title: '动效放几期',
          question: '入场动效要多 4 天，和已经排上的关键路径抢同一段工期。放一期还是二期？',
          participant_user_ids: ctx.members.map((m: Ctx) => m.user_id),
        } })
        return calls
      }
      // A finite scheduled task: register the wait, and (wrongly) try to deliver early — the space must refuse.
      const runsDone = history.some((h) => h.includes('交给 agent 交付'))
      if (/定时/.test(t.title) && !runsDone) {
        calls.push({ name: 'wait_for_scheduled_runs', input: { task_id: t.id, schedule_id: 'schedule-test', expected_runs: 2, ends_at: new Date(Date.now() + 120_000).toISOString() } })
        calls.push({ name: 'submit_artifact', input: { task_id: t.id, title: t.title, content: '定时还没跑完，这份交付不该现在提交。', self_check: [] } })
        return calls
      }
      const revised = history.some((h) => h.includes('打回'))
      calls.push({ name: 'submit_artifact', input: {
        task_id: t.id, title: t.title, kind: '文档',
        content: `# ${t.title}\n\n结论：已按要求完成，负责人可以直接核对下面的范围。\n\n## 做到了什么\n\n- 结论放在第一段\n- 原始要求里的每一点都有着落${revised ? '\n\n## 客服话术\n\n已按打回意见补上。客服可以这样说：这次变更的原因、用户能怎么做、什么时候恢复，我们都写在说明里。' : ''}`,
        self_check: [{ item: '结论放在第一段', ok: true }, { item: '覆盖原始要求', ok: true }],
      } })
      return calls
    }
    case 'review_suggest':
      return [{ name: 'suggest_review', input: { task_id: ctx.task.id, verdict: 'pass', reason: '验收标准都满足：结论在第一段，原始要求都覆盖到了。', basis: '验收清单' } }]
    case 'discussion_reply':
      return [{ name: 'post_discussion_message', input: { discussion_id: ctx.discussion.id, text: '建议放二期，保上线日期。体验可以争，但这 4 天不该从已经承诺的日期里扣。' } }]
    case 'discussion_moderate':
      if (/动效|取舍/.test(ctx.discussion.title)) return [{ name: 'escalate_discussion', input: { discussion_id: ctx.discussion.id, summary: '用 4 天研发换 3% 转化，日期和体验冲突，超出 agent 能定的范围', options: ['动效放一期', '动效放二期'] } }]
      return [{ name: 'resolve_discussion', input: { discussion_id: ctx.discussion.id, outcome: '按大多数意见执行' } }]
    case 'decide_suggest':
      return [{ name: 'suggest_decision', input: { discussion_id: ctx.discussion.id, choice: ctx.options?.[1] ?? '按计划执行', basis: '空间目标优先：保上线日期' } }]
    case 'plan':
      return [{ name: 'plan_tasks', input: {
        space_id: ctx.space.id,
        tasks: [
          { title: '梳理上线范围', description: '按目标列出这次做和不做的，结论放在第一段。', acceptance: ['结论放在第一段'], owner_user_id: ctx.space.owner_user_id, executor_agent_id: ctx.specialists[0].agent_id, due: ctx.space.goal?.due ?? null },
          { title: '设计验收清单', description: '把成功标准写成可以打勾的条目。', acceptance: ['覆盖成功标准'], owner_user_id: ctx.members.at(-1).user_id, executor_agent_id: ctx.specialists[2]?.agent_id ?? null },
        ],
        note: '先拆两周内要开始的两件：范围和验收。后面的等这批做完再拆。',
      } }]
    case 'memory_ask':
      return `根据记录：${(ctx.memory as Ctx[]).map((m) => m.text).slice(-1)[0] ?? '没有相关记录'}`
    default:
      return '好的。'
  }
}

export interface FakeModel {
  url: string
  requests: number
  close(): Promise<void>
}

export async function startFakeModel(port = 0): Promise<FakeModel> {
  const state = { requests: 0 }
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    state.requests++
    const j = JSON.parse(body || '{}') as { model: string; messages: Msg[] }
    const first = j.messages?.[0]
    const prompt = typeof first?.content === 'string' ? first.content : (first?.content ?? []).map((b) => b.text ?? '').join('\n')
    const job = /【job:(\w+)】/.exec(prompt)?.[1] ?? ''
    const ctxText = /<context>\n([\s\S]*?)\n<\/context>/.exec(prompt)?.[1]
    const ctx: Ctx = ctxText ? JSON.parse(ctxText) : {}
    const steps = j.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')).length
    const plan = job ? script(job, ctx) : '好的。'

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id: `msg_${state.requests}`, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    if (Array.isArray(plan) && steps < plan.length) {
      const call = plan[steps]!
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${state.requests}`, name: `mcp__space__${call.name}`, input: {} } })
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
    } else {
      const text = typeof plan === 'string' ? plan : '已按空间里的角色做完这一步。'
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    }
    ev('message_stop', {})
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const bound = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${bound}`,
    get requests() { return state.requests },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
