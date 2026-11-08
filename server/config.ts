import { resolve } from 'node:path'

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export interface Config {
  port: number
  host: string
  /** URL agents use to reach this server's MCP endpoint. */
  internalUrl: string
  dataDir: string
  /** Optional shared code required at login. Empty means open login. */
  accessCode: string
  cookieSecret: string
  /** dsh provider/model route for every agent. */
  provider: string
  model: string
  /** Override of the DeepSeek API base URL (tests point this at a scripted model). */
  modelBaseUrl: string
  /** Per agent turn timeout. */
  agentTimeoutMs: number
  /** Close an idle agent runtime after this long. */
  agentIdleMs: number
  /** Max agent runtimes running turns at once. */
  maxConcurrentAgents: number
  webDist: string
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = Number(env('PORT', '8787'))
  const base: Config = {
    port,
    host: env('HOST', '0.0.0.0'),
    internalUrl: env('INTERNAL_URL', `http://127.0.0.1:${port}`),
    dataDir: resolve(env('DATA_DIR', './data')),
    accessCode: env('ACCESS_CODE', ''),
    cookieSecret: env('COOKIE_SECRET', 'dev-only-change-me-dev-only-change-me'),
    provider: env('DSH_PROVIDER', 'deepseek-official'),
    model: env('DSH_MODEL', 'deepseek-flash'),
    modelBaseUrl: env('MODEL_BASE_URL', ''),
    agentTimeoutMs: Number(env('AGENT_TIMEOUT_MS', String(8 * 60_000))),
    agentIdleMs: Number(env('AGENT_IDLE_MS', String(10 * 60_000))),
    maxConcurrentAgents: Number(env('MAX_CONCURRENT_AGENTS', '4')),
    webDist: resolve(env('WEB_DIST', './dist')),
  }
  return { ...base, ...overrides }
}
