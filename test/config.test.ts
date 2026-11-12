import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { demoModeFromEnv, legacyModelConfigWarning, loadConfig, modelConfigProblem } from '../server/config.ts'
import { modelPluginPatch } from '../server/agents/runtime.ts'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

test('generic key, base URL and model name select an OpenAI-compatible route', () => {
  const env = {
    MODEL_API_KEY: 'sk-generic',
    MODEL_BASE_URL: 'https://api.moonshot.cn/v1',
    MODEL_NAME: 'kimi-k2',
    DEEPSEEK_API_KEY: 'should-not-win',
    DSH_MODEL: 'deepseek-flash',
    DSH_PROVIDER: 'deepseek-official',
  }
  const config = loadConfig({}, env)
  assert.equal(config.modelRoute, 'openai-compatible')
  assert.equal(config.provider, 'openai-compatible')
  assert.equal(config.model, 'kimi-k2')
  assert.equal(config.modelBaseUrl, 'https://api.moonshot.cn/v1')
  assert.equal(config.apiKeyEnv, 'MODEL_API_KEY')
  assert.equal(modelConfigProblem(config, env), null)
  const patch = modelPluginPatch(config).join('\n')
  assert.match(patch, /id: llm-pi-ai/)
  assert.match(patch, /api: openai-completions/)
  assert.match(patch, /apiKeyEnv: "MODEL_API_KEY"/)
  assert.match(patch, /baseURL: "https:\/\/api\.moonshot\.cn\/v1"/)
  assert.match(patch, /supportsDeveloperRole: false/)
  assert.match(patch, /maxTokensField: max_tokens/)
  assert.match(patch, /id: "kimi-k2"/)
  assert.doesNotMatch(patch, /llm-deepseek/)
})

test('a legacy DeepSeek key keeps the official adapter, including a base URL override', () => {
  const config = loadConfig({ modelBaseUrl: 'http://127.0.0.1:9' }, { DEEPSEEK_API_KEY: 'sk-test' })
  assert.equal(config.modelRoute, 'deepseek')
  assert.equal(config.provider, 'deepseek-official')
  assert.equal(config.model, 'deepseek-flash')
  assert.equal(config.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(config.modelBaseUrl, 'http://127.0.0.1:9')
  assert.equal(modelPluginPatch(config).join('\n'), ['- id: llm-deepseek', '  config:', '    baseURL: "http://127.0.0.1:9"'].join('\n'))
  assert.match(legacyModelConfigWarning({ DEEPSEEK_API_KEY: 'sk-test' }) ?? '', /DEEPSEEK_API_KEY/)
  assert.equal(legacyModelConfigWarning({ MODEL_API_KEY: 'sk-generic', MODEL_NAME: 'kimi-k2' }), null)
})

test('no key selects demo mode instead of refusing to boot', () => {
  const config = loadConfig({}, {})
  assert.equal(config.demoMode, true)
  assert.equal(demoModeFromEnv({}), true)
  assert.equal(modelConfigProblem(config, {}), null)
})

test('DEMO_MODE=0 without a key still names the generic variables', () => {
  const env = { DEMO_MODE: '0' }
  const config = loadConfig({}, env)
  assert.equal(config.demoMode, false)
  const problem = modelConfigProblem(config, env)
  assert.ok(problem)
  assert.match(problem, /MODEL_API_KEY/)
  assert.match(problem, /MODEL_BASE_URL/)
  assert.match(problem, /MODEL_NAME/)
  assert.doesNotMatch(problem, /DEEPSEEK/)
})

test('DEMO_MODE=1 forces demo mode even when a key is set', () => {
  const env = { DEMO_MODE: '1', MODEL_API_KEY: 'sk-generic', MODEL_BASE_URL: 'https://api.openai.com/v1', MODEL_NAME: 'gpt-4.1' }
  const config = loadConfig({}, env)
  assert.equal(config.demoMode, true)
  assert.equal(modelConfigProblem(config, env), null)
})

test('a generic key without a base URL or model name names both missing variables', () => {
  const env = { MODEL_API_KEY: 'sk-generic' }
  const problem = modelConfigProblem(loadConfig({}, env), env)
  assert.match(problem ?? '', /MODEL_BASE_URL/)
  assert.match(problem ?? '', /MODEL_NAME/)
})

test('MODEL_PROVIDER without a base URL uses the harness catalog', () => {
  const env = { MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-generic', MODEL_NAME: 'gpt-4.1' }
  const config = loadConfig({}, env)
  assert.equal(config.modelRoute, 'catalog')
  assert.equal(config.provider, 'openai')
  assert.equal(config.model, 'gpt-4.1')
  const patch = modelPluginPatch(config).join('\n')
  assert.match(patch, /openai:/)
  assert.match(patch, /apiKeyEnv: "MODEL_API_KEY"/)
  assert.doesNotMatch(patch, /openai-completions/)
  assert.doesNotMatch(patch, /baseURL/)
})

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of ['MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_PROVIDER', 'DEEPSEEK_API_KEY', 'DSH_MODEL', 'DSH_PROVIDER', 'DEEPSEEK_BASE_URL', 'DEMO_MODE', 'COOKIE_SECRET']) {
    if (extra[name] === undefined) delete env[name]
  }
  return env
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 10_000)
    child.on('exit', () => { clearTimeout(timer); resolve(undefined) })
  })
}

test('the server boots without a key in demo mode, and with the generic variables for a real model', async () => {
  const demoDir = mkdtempSync(join(tmpdir(), 'agent-space-demo-'))
  const demoPort = await freePort()
  const demo = spawn(process.execPath, ['server/index.ts'], {
    env: childEnv({ PORT: String(demoPort), HOST: '127.0.0.1', DATA_DIR: demoDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let demoOut = ''
  demo.stdout!.setEncoding('utf8')
  demo.stderr!.setEncoding('utf8')
  demo.stdout!.on('data', (chunk) => { demoOut += chunk })
  demo.stderr!.on('data', (chunk) => { demoOut += chunk })
  try {
    const deadline = Date.now() + 30_000
    let body: { demoMode?: boolean; model?: string } | undefined
    while (Date.now() < deadline) {
      if (demo.exitCode !== null) throw new Error(`demo server exited ${demo.exitCode}\n${demoOut}`)
      try {
        const response = await fetch(`http://127.0.0.1:${demoPort}/api/config`)
        if (response.ok) {
          body = await response.json() as { demoMode?: boolean; model?: string }
          break
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(body?.demoMode, true, demoOut)
    assert.equal(body?.model, 'demo', demoOut)
    assert.match(demoOut, /演示模式/)
    const login = await fetch(`http://127.0.0.1:${demoPort}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@demo.local', name: '林夏' }) })
    assert.equal(login.status, 200, demoOut)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const spaces = await fetch(`http://127.0.0.1:${demoPort}/api/spaces`, { headers: { cookie } })
    const listed = await spaces.json() as { spaces: Array<{ name: string }> }
    assert.ok(listed.spaces.some((s) => s.name === '新支付上线'), demoOut)
    const me = await fetch(`http://127.0.0.1:${demoPort}/api/me`, { headers: { cookie } })
    const profile = await me.json() as { agent: { handbook: string } }
    assert.match(profile.agent.handbook, /会打回/)
  } finally {
    await stop(demo)
    rmSync(demoDir, { recursive: true, force: true })
  }

  const port = await freePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-space-config-'))
  const child = spawn(process.execPath, ['server/index.ts'], {
    env: childEnv({
      MODEL_API_KEY: 'sk-generic',
      MODEL_BASE_URL: 'https://example.invalid/v1',
      MODEL_NAME: 'generic-model',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      COOKIE_SECRET: 'config-test-cookie-secret-value',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  try {
    const deadline = Date.now() + 30_000
    let body: { model?: string } | undefined
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${output}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`)
        if (response.ok) {
          body = await response.json() as { model?: string }
          break
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(body?.model, 'generic-model', output)
    assert.equal((body as { demoMode?: boolean }).demoMode, false, output)
  } finally {
    await stop(child)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
