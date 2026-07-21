import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * 本地 SQLite 存储（V1：零依赖单文件，后续可平迁 PostgreSQL）。
 * 域模型：Org → Workspace → User → ApiKey（模型授权 + 配额）+ UsageEvent（计量流水）
 */
export interface ApiKeyRow {
  id: string
  key: string
  user_id: string
  workspace_id: string
  label: string
  model_grants: string // JSON 数组；["*"] = 全部
  quota_usd: number // 硬上限（美元）
  used_usd: number
  created_at: number
  revoked: number
}

export interface UsageEventRow {
  id: string
  key_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: number
}

/** Provider 模型条目：第三方 OpenAI 兼容模型（豆包/Kimi/GLM/DeepSeek…），网关按此路由 */
export interface ProviderModelRow {
  id: string
  display_id: string // 客户端可见的模型 id
  upstream_model: string // 厂商侧真实模型名
  base_url: string // 厂商 OpenAI 兼容端点（如 https://api.moonshot.cn/v1）
  api_key: string // 厂商 key（V1 明文 SQLite，V2 加密）
  description: string
  context_window: number
  enabled: number
  created_at: number
}

const DB_PATH = join(process.cwd(), 'workbuddy.db')
export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  model_grants TEXT NOT NULL DEFAULT '["*"]',
  quota_usd REAL NOT NULL DEFAULT 10,
  used_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_events(key_id, created_at);
CREATE TABLE IF NOT EXISTS gateway_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_models (
  id TEXT PRIMARY KEY,
  display_id TEXT UNIQUE NOT NULL,
  upstream_model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  context_window INTEGER NOT NULL DEFAULT 128000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`)

/** 种子数据：默认组织/工作区/管理员 + 一张演示 Key（幂等） */
export function seedIfEmpty(): { demoKey: string; isNew: boolean } {
  const org = db.prepare('SELECT id FROM orgs LIMIT 1').get() as { id: string } | undefined
  if (org) {
    const k = db.prepare('SELECT key FROM api_keys LIMIT 1').get() as { key: string } | undefined
    return { demoKey: k?.key ?? '', isNew: false }
  }
  const now = Date.now()
  const orgId = randomUUID()
  const wsId = randomUUID()
  const userId = randomUUID()
  const demoKey = `wbk_${randomUUID().replace(/-/g, '')}`
  db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(
    orgId,
    'WorkBuddy 默认组织',
    now
  )
  db.prepare('INSERT INTO workspaces (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    wsId,
    orgId,
    '默认工作区',
    now
  )
  db.prepare(
    'INSERT INTO users (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, wsId, 'admin@workbuddy.local', '管理员', 'admin', now)
  db.prepare(
    'INSERT INTO api_keys (id, key, user_id, workspace_id, label, model_grants, quota_usd, used_usd, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).run(randomUUID(), demoKey, userId, wsId, '演示 Key（管理页可改）', '["*"]', 10, 0, now)
  return { demoKey, isNew: true }
}

export function getConfig(k: string): string | null {
  const row = db.prepare('SELECT v FROM gateway_config WHERE k = ?').get(k) as
    | { v: string }
    | undefined
  return row?.v ?? null
}

export function setConfig(k: string, v: string): void {
  db.prepare('INSERT INTO gateway_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?').run(k, v, v)
}

export function findKey(key: string): ApiKeyRow | undefined {
  return db
    .prepare('SELECT * FROM api_keys WHERE key = ? AND revoked = 0')
    .get(key) as ApiKeyRow | undefined
}

export function recordUsage(
  keyId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): void {
  db.prepare(
    'INSERT INTO usage_events (id, key_id, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), keyId, model, inputTokens, outputTokens, costUsd, Date.now())
  db.prepare('UPDATE api_keys SET used_usd = used_usd + ? WHERE id = ?').run(costUsd, keyId)
}

export function listProviderModels(onlyEnabled = false): ProviderModelRow[] {
  return db
    .prepare(
      `SELECT * FROM provider_models ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY created_at DESC`
    )
    .all() as ProviderModelRow[]
}

export function findProviderModel(displayId: string): ProviderModelRow | undefined {
  return db
    .prepare('SELECT * FROM provider_models WHERE display_id = ? AND enabled = 1')
    .get(displayId) as ProviderModelRow | undefined
}

export function upsertProviderModel(m: {
  displayId: string
  upstreamModel: string
  baseUrl: string
  apiKey: string
  description?: string
  contextWindow?: number
}): void {
  db.prepare(
    `INSERT INTO provider_models (id, display_id, upstream_model, base_url, api_key, description, context_window, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(display_id) DO UPDATE SET
       upstream_model = excluded.upstream_model,
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       description = excluded.description,
       context_window = excluded.context_window,
       enabled = 1`
  ).run(
    randomUUID(),
    m.displayId,
    m.upstreamModel,
    m.baseUrl.replace(/\/$/, ''),
    m.apiKey,
    m.description ?? '',
    m.contextWindow ?? 128000,
    Date.now()
  )
}

export function deleteProviderModel(id: string): void {
  db.prepare('DELETE FROM provider_models WHERE id = ?').run(id)
}

export function setProviderModelEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE provider_models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}
