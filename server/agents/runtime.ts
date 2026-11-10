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
  private readonly config: Config
  private readonly slots = new Map<string, Slot>()
  private running = 0
  private readonly waiters: Array<() => void> = []
  private readonly sweeper: NodeJS.Timeout

  constructor(config: Config) {
    this.config = config
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref()
  }

  private paths(agent: Agent): { home: string; workspace: string; patch: string } {
    const root = join(this.config.dataDir, 'agents', agent.id)
    return { home: join(root, 'dsh-home'), workspace: join(root, 'workspace'), patch: join(root, 'patch.yml') }
  }

  private writePatch(agent: Agent): string {
    const p = this.paths(agent)
    mkdirSync(p.home, { recursive: true })
    mkdirSync(p.workspace, { recursive: true })
    const lines: string[] = []
    if (this.config.modelBaseUrl) {
      lines.push('- id: llm-deepseek', '  config:', `    baseURL: ${yamlString(this.config.modelBaseUrl)}`)
    }
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

  private slotFor(agent: Agent): Slot {
    const existing = this.slots.get(agent.id)
    if (existing) return existing
    const p = this.paths(agent)
    const patch = this.writePatch(agent)
    const harness = new DeepSeekHarness({
      profile: 'sdk',
      dshHome: p.home,
      patches: [patch],
      cwd: p.workspace,
      provider: this.config.provider,
      model: this.config.model,
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: this.config.agentTimeoutMs,
    })
    const slot: Slot = { harness, lastUsed: Date.now(), busy: false }
    this.slots.set(agent.id, slot)
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
  async run(agent: Agent, prompt: string): Promise<AgentRunResult> {
    await this.acquire()
    const slot = this.slotFor(agent)
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
      if (this.slots.has(agent.id) || !this.hasActiveSchedules(agent.id)) continue
      try {
        await this.slotFor(agent).harness.start()
        resumed.push(agent.id)
      } catch {
        await this.close(agent.id)
      }
    }
    return resumed
  }

  async close(agentId: string): Promise<void> {
    const slot = this.slots.get(agentId)
    if (!slot) return
    this.slots.delete(agentId)
    await slot.harness.close().catch(() => undefined)
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.config.agentIdleMs
    for (const [id, slot] of this.slots) if (!slot.busy && slot.lastUsed < cutoff && !this.hasActiveSchedules(id)) await this.close(id)
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper)
    await Promise.all([...this.slots.keys()].map((id) => this.close(id)))
  }
}
