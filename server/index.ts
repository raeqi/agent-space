import { loadConfig } from './config.ts'
import { createApp } from './app.ts'

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

if (!process.env.DEEPSEEK_API_KEY && !config.modelBaseUrl) {
  console.error('[agent-space] 请复制 .env.example 为 .env，填写你自己的 DEEPSEEK_API_KEY。项目不提供共享密钥。')
  process.exit(1)
}
if (config.cookieSecret.startsWith('dev-only')) {
  console.warn('[agent-space] COOKIE_SECRET 使用的是开发默认值，生产环境请设置。')
}

const app = await createApp(config)
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
    void app.close().then(() => process.exit(0))
  })
}
