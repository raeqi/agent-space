import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import type { Config } from './config.ts'
import { Db } from './db.ts'
import { Bus } from './bus.ts'
import { Domain } from './domain.ts'
import { JobRunner } from './jobs.ts'
import { AgentRuntimePool } from './agents/runtime.ts'
import { registerApi } from './api.ts'
import { handleMcpRequest } from './mcp.ts'

export interface App {
  server: FastifyInstance
  domain: Domain
  jobs: JobRunner
  pool: AgentRuntimePool
  close(): Promise<void>
}

export async function createApp(config: Config, options: { logger?: boolean } = {}): Promise<App> {
  const db = new Db(join(config.dataDir, 'agent-space.db'))
  const bus = new Bus()
  const pool = new AgentRuntimePool(config)
  const jobs = new JobRunner(db, pool)
  const domain = new Domain(db, bus, jobs)
  if (config.lightMode) domain.limits = { maxDiscussionsPerTask: 1, maxArtifactChars: 2000, skipReviewSuggest: true }
  jobs.attach(domain)
  domain.ensureGeneralAgents()

  const server = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 })
  await server.register(cookie, { secret: config.cookieSecret })

  // MCP endpoint for agents (stateless Streamable HTTP, bearer token per agent).
  server.post('/mcp', async (req, reply) => {
    reply.hijack()
    await handleMcpRequest(domain, req.raw, reply.raw, req.body)
  })
  server.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'stateless MCP endpoint: use POST' }))
  server.delete('/mcp', async (_req, reply) => reply.status(405).send({ error: 'stateless MCP endpoint: use POST' }))

  registerApi(server, config, domain, pool)

  if (existsSync(join(config.webDist, 'index.html'))) {
    // wildcard: true looks files up per request, so a rebuilt web/ is served without restarting.
    await server.register(fastifyStatic, { root: config.webDist, wildcard: true })
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp') || req.url.startsWith('/assets/')) return reply.status(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  }

  return {
    server, domain, jobs, pool,
    async close() {
      await jobs.stop()
      await server.close()
      await pool.closeAll()
      db.close()
    },
  }
}
