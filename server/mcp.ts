import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Agent, Domain } from './domain.ts'
import { DomainError } from './domain.ts'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] }
}

function guard<A>(fn: (args: A) => unknown): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (error) {
      const message = error instanceof DomainError ? error.message : `内部错误：${(error as Error).message}`
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  }
}

/** Build the tool set an agent may use. Tools are scoped by agent kind and re-checked in the domain layer. */
export function buildMcpServer(domain: Domain, agent: Agent): McpServer {
  const server = new McpServer({ name: 'space', version: '0.1.0' }, {
    instructions: 'Agent 空间的工具。所有对空间的修改都必须通过这些工具完成；工具返回错误时，按错误信息调整后重试或说明原因。',
  })

  server.registerTool('get_task', {
    description: '读取一个任务的完整信息：要求、验收标准、过程记录、最新产物。',
    inputSchema: { task_id: z.string() },
  }, guard(({ task_id }: { task_id: string }) => {
    const t = domain.task(task_id)
    domain.requireAgentInSpace(agent, t.space_id)
    return domain.taskView(task_id)
  }))

  server.registerTool('get_discussion', {
    description: '读取一个讨论的问题、参与者和全部发言。',
    inputSchema: { discussion_id: z.string() },
  }, guard(({ discussion_id }: { discussion_id: string }) => {
    const d = domain.discussion(discussion_id)
    domain.requireAgentInSpace(agent, d.space_id)
    return domain.discussionView(discussion_id)
  }))

  server.registerTool('read_file', {
    description: '读取空间资料（人放进来的背景材料）的全文。用到资料时在产物里注明出处。',
    inputSchema: { file_id: z.string() },
  }, guard(({ file_id }: { file_id: string }) => domain.readFile(agent, file_id)))

  server.registerTool('post_discussion_message', {
    description: '在讨论里发言，陈述你的立场和理由。',
    inputSchema: { discussion_id: z.string(), text: z.string().min(1) },
  }, guard(({ discussion_id, text }: { discussion_id: string; text: string }) => {
    domain.postDiscussionMessage(agent, discussion_id, text)
    return '已发言'
  }))

  if (agent.kind === 'assistant') {
    server.registerTool('triage_task', {
      description: '整理一个刚发起的任务：改写标题和说明、写验收标准、指定负责人（空间成员）和执行的专项 agent；如果和已有任务重复，用 merge_into_task_id 合并。',
      inputSchema: {
        task_id: z.string(),
        title: z.string().min(1),
        description: z.string(),
        acceptance: z.array(z.string()).max(10),
        owner_user_id: z.string(),
        executor_agent_id: z.string().nullable().optional(),
        due: z.string().nullable().optional(),
        merge_into_task_id: z.string().nullable().optional(),
        note: z.string().optional(),
      },
    }, guard((args: Parameters<Domain['applyTriage']>[1]) => {
      const t = domain.applyTriage(agent, args)
      return { ok: true, status: t.status }
    }))

    server.registerTool('resolve_discussion', {
      description: '讨论在 agent 能定的范围内达成结论时使用：写下结论，结论会写回相关任务，被卡住的任务继续执行。',
      inputSchema: { discussion_id: z.string(), outcome: z.string().min(1), writeback_task_ids: z.array(z.string()).optional() },
    }, guard((args: { discussion_id: string; outcome: string; writeback_task_ids?: string[] }) => {
      domain.resolveDiscussion(agent, args)
      return '讨论已结束，结论已写回'
    }))

    server.registerTool('escalate_discussion', {
      description: '分歧超出 agent 能定的范围（涉及目标、日期、资源或体验取舍）时使用：提炼分歧点和可选方案，交给 owner 定夺。',
      inputSchema: { discussion_id: z.string(), summary: z.string().min(1), options: z.array(z.string()).min(1).max(4) },
    }, guard((args: { discussion_id: string; summary: string; options: string[] }) => {
      domain.escalateDiscussion(agent, args)
      return '已交给 owner 定夺'
    }))
  }

  if (agent.kind === 'specialist') {
    server.registerTool('post_progress', {
      description: '汇报进展（一句话），会显示在任务上，让人知道你此刻在做什么。',
      inputSchema: { task_id: z.string(), text: z.string().min(1) },
    }, guard(({ task_id, text }: { task_id: string; text: string }) => {
      domain.postProgress(agent, task_id, text)
      return '已更新'
    }))

    server.registerTool('submit_artifact', {
      description: '提交任务产物（Markdown 全文）并附上按验收标准和团队标准逐条做的自检。提交后任务进入待确认。',
      inputSchema: {
        task_id: z.string(),
        title: z.string().min(1),
        kind: z.string().optional(),
        content: z.string().min(1),
        self_check: z.array(z.object({ item: z.string(), ok: z.boolean(), note: z.string().optional() })).optional(),
      },
    }, guard((args: Parameters<Domain['submitArtifact']>[1]) => {
      const a = domain.submitArtifact(agent, args)
      return { ok: true, artifact_id: a.id, version: a.version }
    }))

    server.registerTool('open_discussion', {
      description: '执行中遇到需要别人拍板或协调的问题时发起讨论（会暂停这个任务）。participant_user_ids 是需要表态的成员，他们的个人 agent 会代表他们发言。',
      inputSchema: { task_id: z.string(), title: z.string().min(1), question: z.string().min(1), participant_user_ids: z.array(z.string()).optional() },
    }, guard((args: { task_id: string; title: string; question: string; participant_user_ids?: string[] }) => {
      const d = domain.openDiscussion(agent, args)
      return { ok: true, discussion_id: d.id, note: '讨论已发起，任务暂停，结论出来后你会被重新唤起' }
    }))

    server.registerTool('use_skill', {
      description: '读取团队 skill 的完整做法，执行时按它来做。',
      inputSchema: { skill_id: z.string() },
    }, guard(({ skill_id }: { skill_id: string }) => domain.useSkill(agent, skill_id)))
  }

  if (agent.kind === 'personal') {
    server.registerTool('suggest_review', {
      description: '代表主人看完交付后，给出“通过”或“打回”的建议和理由。主人最终拍板。',
      inputSchema: { task_id: z.string(), verdict: z.enum(['pass', 'reject']), reason: z.string().min(1), basis: z.string().optional() },
    }, guard((args: { task_id: string; verdict: 'pass' | 'reject'; reason: string; basis?: string }) => {
      domain.suggestReview(agent, args)
      return '建议已放进主人的待处理'
    }))

    server.registerTool('suggest_decision', {
      description: '以 owner 名义对升级的分歧给出建议结论和依据（引用团队标准、目标或主人的判断手册）。owner 可以按建议定或改判。',
      inputSchema: { discussion_id: z.string(), choice: z.string().min(1), basis: z.string().min(1) },
    }, guard((args: { discussion_id: string; choice: string; basis: string }) => {
      domain.suggestDecision(agent, args)
      return '建议已放进 owner 的待处理'
    }))
  }

  return server
}

/** Stateless Streamable HTTP handling: one MCP server per request, authenticated by the agent's bearer token. */
export async function handleMcpRequest(domain: Domain, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const agent = token ? domain.agentByToken(token) : undefined
  if (!agent) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }))
    return
  }
  const server = buildMcpServer(domain, agent)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
