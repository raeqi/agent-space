import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { legacyModelConfigWarning, loadConfig, modelConfigProblem } from './config.ts'
import { createApp } from './app.ts'
import { startFakeModel, type FakeModel } from './scripted-model.ts'
import { seedDemoIfEmpty } from './seed.ts'

function ensureDemoCookieSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, '.cookie-secret')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // first demo boot
  }
  const secret = randomBytes(32).toString('hex')
  writeFileSync(file, secret, { mode: 0o600 })
  console.log('[agent-space] 未设置 COOKIE_SECRET，已在数据目录生成一把，演示登录可以保持。')
  return secret
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor! < 24 || (nodeMajor === 24 && nodeMinor! < 9)) {
  console.error('[agent-space] Node.js 24.9+ is required. Current: ' + process.version + ' (' + process.arch + '). Use a supported Node matching your installed native dependencies.')
  process.exit(1)
}

try {
  await import('node-addon-require-builtin')
} catch {
  console.error('[agent-space] Native runtime dependency could not load for ' + process.platform + '/' + process.arch + '. Use a matching Node architecture and reinstall dependencies with that Node before starting.')
  process.exit(1)
}

const config = loadConfig()
let scripted: FakeModel | undefined

if (config.demoMode) {
  if (!process.env.COOKIE_SECRET) config.cookieSecret = ensureDemoCookieSecret(config.dataDir)
  scripted = await startFakeModel()
  config.modelRoute = 'deepseek'
  config.provider = 'deepseek-official'
  config.model = 'demo'
  config.lightModel = 'demo'
  config.modelBaseUrl = scripted.url
  config.apiKeyEnv = 'DEEPSEEK_API_KEY'
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-demo'
  console.log('[agent-space] 演示模式：没有可用的模型 API key，回复由脚本生成。要换成真实模型，在 .env 填写 MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME 后重启。')
} else {
  const modelProblem = modelConfigProblem(config, process.env)
  if (modelProblem) {
    console.error(modelProblem)
    process.exit(1)
  }
  const legacyModels = legacyModelConfigWarning(process.env)
  if (legacyModels) console.warn(legacyModels)
  if (config.cookieSecret.startsWith('dev-only')) {
    console.warn('[agent-space] COOKIE_SECRET 使用的是开发默认值，生产环境请设置。')
  }
}

const app = await createApp(config)
if (config.demoMode && seedDemoIfEmpty(app.domain.db)) {
  app.server.log.info('已写入演示空间。用 lin@demo.local 登录，名字填林夏。')
}
await app.server.listen({ port: config.port, host: config.host })
app.jobs.start()
// Scheduled tasks only fire while the owning agent's runtime runs; the MCP endpoint is up now, so restart them.
void app.pool.resumeScheduled(app.domain.db.all("SELECT * FROM agents WHERE kind = 'specialist'")).then((ids) => {
  if (ids.length) app.server.log.info(`resumed ${ids.length} agent runtime(s) with active scheduled tasks`)
})

let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    app.server.log.info(`received ${signal}, shutting down`)
    void app.close().then(async () => {
      await scripted?.close()
      process.exit(0)
    })
  })
}
