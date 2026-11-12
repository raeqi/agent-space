import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyModelConfigWarning, loadConfig, modelConfigProblem } from '../server/config.ts'
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

test('an empty key tells the operator to set the generic variables', () => {
  const config = loadConfig({}, {})
  const problem = modelConfigProblem(config, {})
  assert.ok(problem)
  assert.match(problem, /MODEL_API_KEY/)
  assert.match(problem, /MODEL_BASE_URL/)
  assert.match(problem, /MODEL_NAME/)
  assert.doesNotMatch(problem, /DEEPSEEK/)
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
  for (const name of ['MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_PROVIDER', 'DEEPSEEK_API_KEY', 'DSH_MODEL', 'DSH_PROVIDER', 'DEEPSEEK_BASE_URL']) {
    if (extra[name] === undefined) delete env[name]
  }
  return env
}

test('the server boots on the generic variables and rejects an empty key', async () => {
  const empty = spawn(process.execPath, ['server/index.ts'], { env: childEnv({}), stdio: ['ignore', 'pipe', 'pipe'] })
  let emptyOut = ''
  empty.stdout!.setEncoding('utf8')
  empty.stderr!.setEncoding('utf8')
  empty.stdout!.on('data', (chunk) => { emptyOut += chunk })
  empty.stderr!.on('data', (chunk) => { emptyOut += chunk })
  const emptyCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`empty-key process did not exit\n${emptyOut}`)), 30_000)
    empty.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(emptyCode, 1)
  assert.match(emptyOut, /MODEL_API_KEY/)
  assert.match(emptyOut, /MODEL_BASE_URL/)
  assert.match(emptyOut, /MODEL_NAME/)
  assert.doesNotMatch(emptyOut, /DEEPSEEK_API_KEY/)

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
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 10_000)
      child.on('exit', () => { clearTimeout(timer); resolve(undefined) })
    })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
