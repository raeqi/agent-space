/**
 * Scripted model for tests and CI. It speaks the Anthropic Messages streaming format that dsh's DeepSeek provider
 * uses, reads the job kind and context that server/agents/prompts.ts puts in every prompt, and answers with the
 * tool calls a well-behaved agent would make. It exercises the real runtime, MCP and domain paths; only the model
 * is replaced. Never used in production.
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
      if (dup) return [{ name: 'triage_task', input: { task_id: t.id, title: t.raw_input, description: '', acceptance: [], owner_user_id: t.creator_user_id, merge_into_task_id: dup, note: '和已有任务重复' } }]
      return [{ name: 'triage_task', input: {
        task_id: t.id, title: String(t.raw_input).slice(0, 30), description: `整理自：${t.raw_input}`,
        acceptance: ['结论放在第一段', '覆盖原始要求里的每一点'], owner_user_id: t.creator_user_id,
        executor_agent_id: ctx.specialists[0].agent_id, note: '按专长分配',
      } }]
    }
    case 'execute': {
      const t = ctx.task
      const decided = (t.history as string[]).some((h) => h.includes('结论写回'))
      const calls: ToolCall[] = [{ name: 'post_progress', input: { task_id: t.id, text: '先列提纲，再逐条写' } }]
      if (/取舍/.test(t.title) && !decided) {
        calls.push({ name: 'open_discussion', input: { task_id: t.id, title: '动效放几期', question: '入场动效要多 4 天，放一期还是二期？', participant_user_ids: ctx.members.map((m: Ctx) => m.user_id) } })
        return calls
      }
      const revised = (t.history as string[]).some((h) => h.includes('打回'))
      calls.push({ name: 'submit_artifact', input: {
        task_id: t.id, title: t.title, kind: '文档',
        content: `# ${t.title}\n\n结论：已按要求完成。${revised ? '\n\n## 客服话术\n\n已补充。' : ''}`,
        self_check: [{ item: '结论放在第一段', ok: true }, { item: '覆盖原始要求', ok: true }],
      } })
      return calls
    }
    case 'review_suggest':
      return [{ name: 'suggest_review', input: { task_id: ctx.task.id, verdict: 'pass', reason: '验收标准都满足', basis: '验收清单' } }]
    case 'discussion_reply':
      return [{ name: 'post_discussion_message', input: { discussion_id: ctx.discussion.id, text: '建议放二期，保上线日期。' } }]
    case 'discussion_moderate':
      if (/动效|取舍/.test(ctx.discussion.title)) return [{ name: 'escalate_discussion', input: { discussion_id: ctx.discussion.id, summary: '用 4 天研发换 3% 转化', options: ['动效放一期', '动效放二期'] } }]
      return [{ name: 'resolve_discussion', input: { discussion_id: ctx.discussion.id, outcome: '按大多数意见执行' } }]
    case 'decide_suggest':
      return [{ name: 'suggest_decision', input: { discussion_id: ctx.discussion.id, choice: ctx.options?.[1] ?? '按计划执行', basis: '空间目标优先：保上线日期' } }]
    case 'plan':
      return [{ name: 'plan_tasks', input: {
        space_id: ctx.space.id,
        tasks: [
          { title: '梳理上线范围', description: '按目标列出范围', acceptance: ['结论放在第一段'], owner_user_id: ctx.space.owner_user_id, executor_agent_id: ctx.specialists[0].agent_id, due: ctx.space.goal?.due ?? null },
          { title: '设计验收清单', acceptance: ['覆盖成功标准'], owner_user_id: ctx.members.at(-1).user_id, executor_agent_id: ctx.specialists[2]?.agent_id ?? null },
        ],
        note: '先拆两周内要开始的',
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
      const text = typeof plan === 'string' ? plan : '已完成。'
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startFakeModel(Number(process.env.PORT ?? 18080))
  console.log(`scripted model listening at ${m.url}; start the server with MODEL_BASE_URL=${m.url}`)
}
