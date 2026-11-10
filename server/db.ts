import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export type Row = Record<string, unknown>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  goal_title TEXT,
  goal_due TEXT,
  goal_metrics TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  successor_id TEXT,
  PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal','assistant','specialist')),
  space_id TEXT REFERENCES spaces(id),
  owner_user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  public_profile TEXT NOT NULL DEFAULT '',
  handbook TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL DEFAULT '',
  activity_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  raw_input TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('triage','unclaimed','in_progress','review','done','merged')),
  creator_id TEXT NOT NULL REFERENCES users(id),
  owner_id TEXT REFERENCES users(id),
  executor_agent_id TEXT REFERENCES agents(id),
  due TEXT,
  merged_into TEXT,
  blocked_by_discussion TEXT,
  live TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '文档',
  content TEXT NOT NULL,
  self_check TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  opened_by_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('open','escalated','resolved')),
  summary TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  writeback TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS discussion_participants (
  discussion_id TEXT NOT NULL REFERENCES discussions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (discussion_id, agent_id)
);
CREATE TABLE IF NOT EXISTS discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id),
  author_kind TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('confirm','decide')),
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS standards (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  text TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '全部',
  source TEXT NOT NULL,
  source_ref TEXT,
  created_by TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('decision','standard','change','member')),
  text TEXT NOT NULL,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  maintainer_id TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '上传',
  added_by TEXT,
  reads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  space_id TEXT,
  text TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  dsh_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id, status);
CREATE INDEX IF NOT EXISTS idx_judgments_user ON judgments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
`

export class Db {
  readonly sql: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.sql = new DatabaseSync(path)
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.sql.exec(SCHEMA)
    this.ensureColumn('tasks', 'source', "TEXT NOT NULL DEFAULT 'manual'")
    this.ensureColumn('spaces', 'webhook_token', 'TEXT')
    // JSON { expected, seen, endsAt, scheduleId } while a task waits for its scheduled runs before delivery.
    this.ensureColumn('tasks', 'schedule_wait', 'TEXT')
    this.ensureColumn('tasks', 'schedule_result', 'TEXT')
  }

  /** Additive migration for databases created by earlier versions. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  all<T = Row>(query: string, ...params: unknown[]): T[] {
    return this.sql.prepare(query).all(...(params as never[])) as T[]
  }

  get<T = Row>(query: string, ...params: unknown[]): T | undefined {
    return this.sql.prepare(query).get(...(params as never[])) as T | undefined
  }

  run(query: string, ...params: unknown[]): void {
    this.sql.prepare(query).run(...(params as never[]))
  }

  insert(table: string, row: Record<string, unknown>): void {
    const keys = Object.keys(row)
    const values = keys.map((k) => normalize(row[k]))
    this.sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(values as never[]))
  }

  update(table: string, id: string, patch: Record<string, unknown>, idColumn = 'id'): void {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const values = keys.map((k) => normalize(patch[k]))
    this.sql.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idColumn} = ?`).run(...(values as never[]), id as never)
  }

  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.sql.exec('COMMIT')
      return out
    } catch (error) {
      this.sql.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.sql.close()
  }
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v) || (v !== null && typeof v === 'object')) return JSON.stringify(v)
  return v
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export function now(): number {
  return Date.now()
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
