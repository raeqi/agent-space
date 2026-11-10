import { loadConfig } from './config.ts'
import { createApp } from './app.ts'

const config = loadConfig()

if (!process.env.DEEPSEEK_API_KEY && !config.modelBaseUrl) {
  console.warn('[agent-space] DEEPSEEK_API_KEY 未设置：agent 无法调用模型，任务会停在“整理中”。')
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
