import { resolve } from 'node:path'

function readEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]
  return value === undefined || value === '' ? fallback : value
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * How the harness should reach the configured model.
 * `deepseek` is the legacy official adapter. `openai-compatible` is a hand-declared
 * Chat Completions route for whatever base URL the operator supplied. `catalog`
 * is a built-in harness provider selected by name, using that provider's own endpoint.
 */
export type ModelRoute = 'deepseek' | 'openai-compatible' | 'catalog'

export interface ModelSettings {
  provider: string
  model: string
  modelBaseUrl: string
  /** Environment variable name the harness reads. Never the key itself. */
  apiKeyEnv: string
  modelRoute: ModelRoute
}

const DEEPSEEK_PROVIDER = 'deepseek-official'
const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/

/**
 * Resolve the model route from the environment.
 *
 * The public setup is MODEL_API_KEY + MODEL_BASE_URL + MODEL_NAME. A custom base URL
 * is OpenAI Chat Completions, so operators do not pick a vendor. DEEPSEEK_API_KEY and
 * DSH_* remain a legacy DeepSeek setup: MODEL_BASE_URL then still overrides that
 * adapter's endpoint, which is what the scripted test model relies on.
 */
export function resolveModelSettings(env: NodeJS.ProcessEnv): ModelSettings {
  const modelApiKey = nonEmpty(env, 'MODEL_API_KEY')
  const modelName = nonEmpty(env, 'MODEL_NAME')
  const legacyModel = nonEmpty(env, 'DSH_MODEL')
  const modelBaseUrl = nonEmpty(env, 'MODEL_BASE_URL') ?? ''
  const providerFromNew = nonEmpty(env, 'MODEL_PROVIDER')
  const providerFromLegacy = nonEmpty(env, 'DSH_PROVIDER')
  // New key, model, or provider means the operator is on the generic setup.
  // A leftover DSH_PROVIDER must not drag that setup back onto the DeepSeek adapter.
  const legacyOnly = !modelApiKey && !modelName && !providerFromNew
  const namedProvider = providerFromNew ?? (legacyOnly ? providerFromLegacy : undefined)

  let modelRoute: ModelRoute
  let provider: string
  if (namedProvider === DEEPSEEK_PROVIDER || namedProvider === 'deepseek') {
    modelRoute = 'deepseek'
    provider = DEEPSEEK_PROVIDER
  } else if (namedProvider && modelBaseUrl) {
    modelRoute = 'openai-compatible'
    provider = namedProvider
  } else if (namedProvider) {
    modelRoute = 'catalog'
    provider = namedProvider
  } else if (!legacyOnly) {
    modelRoute = 'openai-compatible'
    provider = OPENAI_COMPATIBLE_PROVIDER
  } else {
    modelRoute = 'deepseek'
    provider = DEEPSEEK_PROVIDER
  }

  const model = modelName ?? legacyModel ?? (modelRoute === 'deepseek' ? 'deepseek-flash' : '')
  const apiKeyEnv = modelApiKey ? 'MODEL_API_KEY' : 'DEEPSEEK_API_KEY'
  return { provider, model, modelBaseUrl, apiKeyEnv, modelRoute }
}

/** Boot-time message when the process cannot call a model. Null when configuration is usable. */
export function modelConfigProblem(settings: ModelSettings, env: NodeJS.ProcessEnv): string | null {
  if (!PROVIDER_ID.test(settings.provider)) {
    return `[agent-space] 供应商 id「${settings.provider}」无法使用。设置 MODEL_API_KEY、MODEL_BASE_URL 和 MODEL_NAME 即可连接任意 OpenAI 兼容服务，MODEL_PROVIDER 可以留空。`
  }
  const key = nonEmpty(env, 'MODEL_API_KEY') ?? nonEmpty(env, 'DEEPSEEK_API_KEY')
  if (!key && !settings.modelBaseUrl) {
    return '[agent-space] 请复制 .env.example 为 .env，填写 MODEL_API_KEY、MODEL_BASE_URL 和 MODEL_NAME。任何 OpenAI 兼容的模型服务都可以，项目不提供共享密钥。'
  }
  if (settings.modelRoute === 'openai-compatible') {
    const missing: string[] = []
    if (!settings.modelBaseUrl) missing.push('MODEL_BASE_URL')
    if (!settings.model) missing.push('MODEL_NAME')
    if (missing.length === 2) return '[agent-space] 请设置 MODEL_BASE_URL 和 MODEL_NAME。前者是 OpenAI 兼容接口地址（一般以 /v1 结尾），后者是模型名。'
    if (missing[0] === 'MODEL_BASE_URL') return '[agent-space] 请设置 MODEL_BASE_URL，指向服务商的 OpenAI 兼容接口（一般以 /v1 结尾）。'
    if (missing[0] === 'MODEL_NAME') return '[agent-space] 请设置 MODEL_NAME，填入服务商要求的模型名。'
  }
  if (settings.modelRoute === 'catalog' && !settings.model) return '[agent-space] 请设置 MODEL_NAME，填入该供应商的模型名。'
  return null
}

/** One-line notice when an old variable is still what the process actually reads. */
export function legacyModelConfigWarning(env: NodeJS.ProcessEnv): string | null {
  const parts: string[] = []
  if (!nonEmpty(env, 'MODEL_API_KEY') && nonEmpty(env, 'DEEPSEEK_API_KEY')) parts.push('DEEPSEEK_API_KEY 请改用 MODEL_API_KEY')
  if (!nonEmpty(env, 'MODEL_NAME') && nonEmpty(env, 'DSH_MODEL')) parts.push('DSH_MODEL 请改用 MODEL_NAME')
  if (!nonEmpty(env, 'MODEL_PROVIDER') && nonEmpty(env, 'DSH_PROVIDER')) parts.push('DSH_PROVIDER 一般可以删掉，自定义地址会按 OpenAI 兼容接口连接')
  if (!parts.length) return null
  return `[agent-space] 仍在使用旧的模型配置（${parts.join('；')}）。旧变量暂时还能用。`
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
  /** Harness provider id for every agent. */
  provider: string
  model: string
  /** OpenAI-compatible base URL, or the legacy DeepSeek endpoint override. */
  modelBaseUrl: string
  apiKeyEnv: string
  modelRoute: ModelRoute
  /** Per agent turn timeout. */
  agentTimeoutMs: number
  /** Close an idle agent runtime after this long. */
  agentIdleMs: number
  /** Max agent runtimes running turns at once. */
  maxConcurrentAgents: number
  webDist: string
}

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(readEnv(env, 'PORT', '8787'))
  const model = resolveModelSettings(env)
  const base: Config = {
    port,
    host: readEnv(env, 'HOST', '0.0.0.0'),
    internalUrl: readEnv(env, 'INTERNAL_URL', `http://127.0.0.1:${port}`),
    dataDir: resolve(readEnv(env, 'DATA_DIR', './data')),
    accessCode: readEnv(env, 'ACCESS_CODE', ''),
    cookieSecret: readEnv(env, 'COOKIE_SECRET', 'dev-only-change-me-dev-only-change-me'),
    provider: model.provider,
    model: model.model,
    modelBaseUrl: model.modelBaseUrl,
    apiKeyEnv: model.apiKeyEnv,
    modelRoute: model.modelRoute,
    agentTimeoutMs: Number(readEnv(env, 'AGENT_TIMEOUT_MS', String(8 * 60_000))),
    agentIdleMs: Number(readEnv(env, 'AGENT_IDLE_MS', String(10 * 60_000))),
    maxConcurrentAgents: Number(readEnv(env, 'MAX_CONCURRENT_AGENTS', '4')),
    webDist: resolve(readEnv(env, 'WEB_DIST', './dist')),
  }
  return { ...base, ...overrides }
}
