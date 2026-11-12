import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MODEL_API_KEY && !process.env.DEEPSEEK_API_KEY) throw new Error('请在 .env 配置 MODEL_API_KEY（只填 DEEPSEEK_API_KEY 的旧配置仍可用）')
const config = loadConfig({ port: 8798, host: '127.0.0.1', internalUrl: 'http://127.0.0.1:8798', dataDir: join(process.cwd(), 'data-live-verification'), accessCode: '' })
const app = await createApp(config, { logger: false })
await app.server.listen({ port: config.port, host: config.host })
app.jobs.start()
let cookie = ''
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(config.internalUrl + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined })
  cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
  const data = await response.json() as any
  if (!response.ok) throw new Error(JSON.stringify(data))
  return data
}
try {
  await call('POST', '/api/login', { email: 'live-verification@local.test', name: '真实链路验证' })
  const { space } = await call('POST', '/api/spaces', { name: '真实 Agent 链路验证' })
  const { task } = await call('POST', `/api/spaces/${space.id}/tasks`, { text: '请实际使用本地命令创建 live-proof.txt，内容为整数 1 到 100 的平方和。用脚本计算，不能凭记忆回答。然后用另一条命令回读验证文件，交付计算结果、文件名、验证方法。验收：文件真实存在，内容为 338350，交付附实际命令和回读结果。不要创建定时任务。' })
  console.log(JSON.stringify({ stage: 'created', space: space.id, task: task.id, model: config.model }))
  const deadline = Date.now() + 600_000
  let previous = ''
  while (Date.now() < deadline) {
    const detail = await call('GET', `/api/tasks/${task.id}`)
    const state = JSON.stringify({ status: detail.task.status, live: detail.task.live })
    if (state !== previous) { console.log(state); previous = state }
    const failed = app.domain.db.all<{ error: string }>("SELECT error FROM jobs WHERE status = 'failed' AND json_extract(payload, '$.taskId') = ?", task.id)
    if (failed.length) throw new Error(failed.map(j => j.error).join('\n'))
    if (detail.task.status === 'review') {
      const { judgments } = await call('GET', '/api/judgments')
      const judgment = judgments.find((j: any) => j.ref_id === task.id)
      if (judgment) {
        const path = join(config.dataDir, 'agents', detail.task.executor_agent_id, 'workspace', 'live-proof.txt')
        if (!existsSync(path) || readFileSync(path, 'utf8').trim() !== '338350') throw new Error('真实文件验证失败')
        if (!detail.artifacts.length) throw new Error('没有交付产物')
        console.log(JSON.stringify({ stage: 'delivered', path, content: readFileSync(path, 'utf8'), artifactCount: detail.artifacts.length, suggestion: judgment.suggestion }))
        await call('POST', `/api/judgments/${judgment.id}`, { action: 'pass', reason: '独立读取实际文件，计算结果正确' })
        const final = await call('GET', `/api/tasks/${task.id}`)
        if (final.task.status !== 'done') throw new Error('确认后未完成')
        await app.jobs.idle(30_000)
        console.log(JSON.stringify({ stage: 'verified', status: final.task.status, eventCount: final.events.length, jobs: app.domain.db.all("SELECT kind,status,dsh_session_id FROM jobs WHERE json_extract(payload, '$.taskId') = ?", task.id) }))
        break
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (app.domain.task(task.id).status !== 'done') throw new Error('真实链路未在期限内完成')
} finally { await app.close() }
