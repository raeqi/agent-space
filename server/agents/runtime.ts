import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { Config } from '../config.ts'
import type { Agent } from '../domain.ts'

export interface AgentRunResult {
  sessionId: string
  finalResponse: string
  finishReason: string | null
  toolCalls: string[]
}

interface Slot {
  harness: DeepSeekHarness
  lastUsed: number
  busy: boolean
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Cordis patch rows that select the model route. A custom base URL is declared as
 * OpenAI Chat Completions: the harness treats an unrecognized URL as OpenAI itself,
 * and the two compat switches below are the ones typical compatible gateways reject.
 */
/** Local tools a one-shot space job never needs. Execute jobs keep them. */
const SPACE_ONLY_DISABLED = [
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule',
  'tool-ask-user', 'tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control',
  'tool-todo', 'tool-goal', 'tool-workflow', 'tool-skill', 'present',
]

export type ToolProfile = 'full' | 'space'

/** Execute keeps the configured model and local tools. Every other job uses the light model and space MCP tools only. */
export function runOptionsForJob(config: Config, kind: string): { model: string; tools: ToolProfile } {
  if (kind === 'execute') return { model: config.model, tools: 'full' }
  return { model: config.lightModel || config.model, tools: 'space' }
}

export function modelPluginPatch(config: Config, model = config.model): string[] {
  if (config.modelRoute === 'deepseek') {
    if (!config.modelBaseUrl) return []
    return ['- id: llm-deepseek', '  config:', `    baseURL: ${yamlString(config.modelBaseUrl)}`]
  }
  const lines = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${config.provider}:`,
    `        apiKeyEnv: ${yamlString(config.apiKeyEnv)}`,
  ]
  if (config.modelRoute === 'catalog') {
    if (config.modelBaseUrl) lines.push(`        baseURL: ${yamlString(config.modelBaseUrl)}`)
    return lines
  }
  lines.push(
    '        api: openai-completions',
    `        baseURL: ${yamlString(config.modelBaseUrl)}`,
    '        compat:',
    '          supportsDeveloperRole: false',
    '          maxTokensField: max_tokens',
    '        models:',
    `          - id: ${yamlString(model)}`,
  )
  return lines
}

function persona(agent: Agent): string {
  switch (agent.kind) {
    case 'assistant':
      return `你是「空间助理」，负责一个团队协作空间：整理和分配任务、组织 agent 讨论、在超出 agent 权限时把分歧交给人。你用 {{model}} 模型工作，说中文，简洁、准确，不编造事实。`
    case 'specialist':
      return `你是空间里的「${agent.name}」，专长：${agent.specialty}。你用 {{model}} 模型工作，说中文。你能用本地工具真正动手（命令、文件、网页、定时任务），不只写方案。你的工作产物要遵守团队标准，结论先行，不编造数据。`
    default:
      return `你是「${agent.name}」，代表你的主人参与团队空间：按主人的标准和判断给出建议和立场，但最终决定权在主人。你用 {{model}} 模型工作，说中文，简洁。`
  }
}

/**
 * Owns one dsh runtime subprocess per agent. Each runtime gets its own DSH_HOME, workspace and patch:
 * the patch wires the agent's MCP connection (with its bearer token) and persona into the dsh profile.
 */
export class AgentRuntimePool {
  readonly config: Config
  private readonly slots = new Map<string, Slot>()
  private running = 0
  private readonly waiters: Array<() => void> = []
  private readonly sweeper: NodeJS.Timeout

  constructor(config: Config) {
    this.config = config
    // The official DeepSeek adapter reads DEEPSEEK_API_KEY. Mirror the generic key so a
    // legacy route keeps working, including the harness web-search credential.
    if (config.modelRoute === 'deepseek' && config.apiKeyEnv === 'MODEL_API_KEY' && process.env.MODEL_API_KEY) {
      process.env.DEEPSEEK_API_KEY = process.env.MODEL_API_KEY
    }
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref()
  }

  private paths(agent: Agent, model: string, tools: ToolProfile): { home: string; workspace: string; patch: string } {
    const root = join(this.config.dataDir, 'agents', agent.id)
    const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_')
    return { home: join(root, tools === 'full' ? 'dsh-home' : 'dsh-home-space'), workspace: join(root, 'workspace'), patch: join(root, `patch-${tools}-${safeModel}.yml`) }
  }

  private writePatch(agent: Agent, model: string, tools: ToolProfile): string {
    const p = this.paths(agent, model, tools)
    mkdirSync(p.home, { recursive: true })
    mkdirSync(p.workspace, { recursive: true })
    const lines = modelPluginPatch(this.config, model)
    if (tools === 'space') for (const id of SPACE_ONLY_DISABLED) lines.push(`- id: ${id}`, '  disabled: true')
    lines.push('- id: system-prompt', '  config:', `    personaPrefix: ${yamlString(persona(agent))}`)
    lines.push(
      '- insert:',
      '    - id: mcp-space',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: space',
      '        transport: streamable-http',
      `        url: ${yamlString(`${this.config.internalUrl}/mcp`)}`,
      '        headers:',
      `          Authorization: ${yamlString(`Bearer ${agent.token}`)}`,
      '        toolCallTimeoutMs: 60000',
      '        failOnStartupError: true',
    )
    writeFileSync(p.patch, `${lines.join('\n')}\n`, { mode: 0o600 })
    return p.patch
  }

  private slotFor(agent: Agent, model = this.config.model, tools: ToolProfile = 'full'): Slot {
    const key = `${agent.id}:${tools}:${model}`
    const existing = this.slots.get(key)
    if (existing) return existing
    const p = this.paths(agent, model, tools)
    const patch = this.writePatch(agent, model, tools)
    const harness = new DeepSeekHarness({
      profile: 'sdk',
      dshHome: p.home,
      patches: [patch],
      cwd: p.workspace,
      provider: this.config.provider,
      model,
      ...(this.config.lightMode && tools === 'full' ? { maxTokens: 2500 } : {}),
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: this.config.agentTimeoutMs,
    })
    const slot: Slot = { harness, lastUsed: Date.now(), busy: false }
    this.slots.set(key, slot)
    return slot
  }

  private async acquire(): Promise<void> {
    if (this.running < this.config.maxConcurrentAgents) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.running++
  }

  private release(): void {
    this.running--
    this.waiters.shift()?.()
  }

  /** Run one prompt as a fresh dsh session of this agent. Calls for the same agent must be serialized by the caller. */
  async run(agent: Agent, prompt: string, route: { model?: string; tools?: ToolProfile } = {}): Promise<AgentRunResult> {
    await this.acquire()
    const slot = this.slotFor(agent, route.model || this.config.model, route.tools ?? 'full')
    slot.busy = true
    let timer: NodeJS.Timeout | undefined
    try {
      const session = slot.harness.session()
      const run = session.run(prompt)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`agent turn timed out after ${this.config.agentTimeoutMs}ms`)), this.config.agentTimeoutMs)
      })
      const result = await Promise.race([run, timeout])
      const toolCalls: string[] = []
      for (const event of result.events as Array<{ type: string; data?: { message?: { content?: Array<{ type: string; name?: string }> } } }>) {
        if (event.type !== 'assistant/message') continue
        for (const block of event.data?.message?.content ?? []) if (block.type === 'tool-call' || block.type === 'tool_use') toolCalls.push(block.name ?? '')
      }
      return { sessionId: result.sessionId, finalResponse: result.finalResponse, finishReason: result.finishReason, toolCalls }
    } catch (error) {
      // A timed-out or broken runtime may still be working; reap it so the next turn starts clean.
      await this.close(agent.id)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      slot.busy = false
      slot.lastUsed = Date.now()
      this.release()
    }
  }

  /**
   * dsh only delivers scheduled tasks while the agent's runtime is running, so the pool must not reap it.
   * The SDK exposes no schedule RPC; read dsh's JSON store (<DSH_HOME>/storages/schedule.json) instead.
   */
  hasActiveSchedules(agentId: string): boolean {
    try {
      const store = JSON.parse(readFileSync(join(this.config.dataDir, 'agents', agentId, 'dsh-home', 'storages', 'schedule.json'), 'utf8')) as { tables?: { tasks?: Record<string, { status?: string }> } }
      return Object.values(store.tables?.tasks ?? {}).some((t) => t.status === 'active')
    } catch {
      return false
    }
  }

  /** Startup: bring up the runtimes of agents that still have active scheduled tasks. */
  async resumeScheduled(agents: Agent[]): Promise<string[]> {
    const resumed: string[] = []
    for (const agent of agents) {
      if ([...this.slots.keys()].some((key) => key.startsWith(`${agent.id}:`)) || !this.hasActiveSchedules(agent.id)) continue
      try {
        await this.slotFor(agent, this.config.model, 'full').harness.start()
        resumed.push(agent.id)
      } catch {
        await this.close(agent.id)
      }
    }
    return resumed
  }

  async close(agentId: string): Promise<void> {
    const keys = [...this.slots.keys()].filter((key) => key.startsWith(`${agentId}:`) || key === agentId)
    await Promise.all(keys.map(async (key) => {
      const slot = this.slots.get(key)
      this.slots.delete(key)
      await slot?.harness.close().catch(() => undefined)
    }))
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.config.agentIdleMs
    const idle = new Set<string>()
    for (const [key, slot] of this.slots) {
      const agentId = key.split(':')[0]!
      if (!slot.busy && slot.lastUsed < cutoff && !this.hasActiveSchedules(agentId)) idle.add(agentId)
    }
    for (const agentId of idle) await this.close(agentId)
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper)
    const agentIds = new Set([...this.slots.keys()].map((key) => key.split(':')[0]!))
    await Promise.all([...agentIds].map((id) => this.close(id)))
  }
}
