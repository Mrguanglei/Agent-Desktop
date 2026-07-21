import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  createUser,
  createWorkspace,
  dashboardStats,
  db,
  deleteProviderModel,
  deleteUser,
  getConfig,
  listProviderModels,
  listUsers,
  listWorkspaces,
  setConfig,
  setProviderModelEnabled,
  updateKey,
  updateUserRole,
  upsertProviderModel
} from '../db.js'

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token'

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    reply.status(401).send({ error: 'invalid admin token' })
    return false
  }
  return true
}

/**
 * 管理 API（V1 简化鉴权：x-admin-token 头；Web 管理页同机制）。
 * 生产换 SSO 会话（见 enterprise-backend-design.md §4.1）。
 */
export function registerAdminRoutes(app: import('fastify').FastifyInstance): void {
  app.get('/admin/api/keys', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const keys = db
      .prepare(
        `SELECT k.id, k.key, k.label, k.model_grants, k.quota_usd, k.used_usd, k.created_at, k.revoked,
                u.email AS user_email, w.name AS workspace_name
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         JOIN workspaces w ON w.id = k.workspace_id
         ORDER BY k.created_at DESC`
      )
      .all()
    reply.send({ keys })
  })

  app.post('/admin/api/keys', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as {
      label?: string
      quotaUsd?: number
      modelGrants?: string[]
      userEmail?: string
    }
    const user = db
      .prepare('SELECT id, workspace_id FROM users WHERE email = ?')
      .get(body.userEmail ?? 'admin@workbuddy.local') as
      | { id: string; workspace_id: string }
      | undefined
    if (!user) {
      reply.status(400).send({ error: `user not found: ${body.userEmail}` })
      return
    }
    const key = `wbk_${randomUUID().replace(/-/g, '')}`
    db.prepare(
      'INSERT INTO api_keys (id, key, user_id, workspace_id, label, model_grants, quota_usd, used_usd, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0)'
    ).run(
      randomUUID(),
      key,
      user.id,
      user.workspace_id,
      body.label ?? '',
      JSON.stringify(body.modelGrants ?? ['*']),
      body.quotaUsd ?? 10,
      Date.now()
    )
    reply.send({ key })
  })

  app.post('/admin/api/keys/:id/revoke', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id)
    reply.send({ ok: true })
  })

  app.get('/admin/api/usage', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const events = db
      .prepare(
        `SELECT e.id, e.model, e.input_tokens, e.output_tokens, e.cost_usd, e.created_at, k.label AS key_label
         FROM usage_events e JOIN api_keys k ON k.id = e.key_id
         ORDER BY e.created_at DESC LIMIT 100`
      )
      .all()
    reply.send({ events })
  })

  app.get('/admin/api/config', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const token = getConfig('upstream_token')
    reply.send({
      upstreamTokenSet: Boolean(token),
      upstreamTokenPreview: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null
    })
  })

  app.put('/admin/api/config', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as { upstreamToken?: string }
    if (typeof body.upstreamToken === 'string') {
      setConfig('upstream_token', body.upstreamToken.trim())
    }
    reply.send({ ok: true })
  })

  // ---- Provider 模型管理（豆包/Kimi/GLM/DeepSeek 等 OpenAI 兼容模型） ----

  /** 厂商预设：选中即自动填端点 */
  const PROVIDER_PRESETS = [
    { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'ark', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'zhipu', name: 'GLM（智谱）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '' }
  ]

  app.get('/admin/api/providers/presets', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    reply.send({ presets: PROVIDER_PRESETS })
  })

  /** 测试连接 + 拉取厂商模型列表（One-API 式「获取模型」） */
  app.post('/admin/api/providers/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as { baseUrl?: string; apiKey?: string }
    if (!body.baseUrl || !body.apiKey) {
      reply.status(400).send({ error: 'baseUrl / apiKey 必填' })
      return
    }
    try {
      const r = await fetch(`${body.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${body.apiKey}` },
        signal: AbortSignal.timeout(8000)
      })
      if (!r.ok) {
        reply.send({ ok: false, error: `厂商返回 HTTP ${r.status}（连接正常，Key 可能无效）`, models: [] })
        return
      }
      const data = (await r.json()) as { data?: { id?: string }[] }
      const models = (data.data ?? [])
        .filter((m) => m.id)
        .map((m) => ({ id: m.id as string }))
        .slice(0, 100)
      reply.send({ ok: true, models })
    } catch (err) {
      reply.send({
        ok: false,
        error: `连接失败：${err instanceof Error ? err.message : String(err)}`,
        models: []
      })
    }
  })

  /** 批量接入（向导勾选后一次入库） */
  app.post('/admin/api/models/bulk', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as {
      baseUrl?: string
      apiKey?: string
      models?: { displayId: string; upstreamModel: string; contextWindow?: number }[]
    }
    if (!body.baseUrl || !body.apiKey || !Array.isArray(body.models) || body.models.length === 0) {
      reply.status(400).send({ error: 'baseUrl / apiKey / models 必填' })
      return
    }
    for (const m of body.models) {
      upsertProviderModel({
        displayId: m.displayId.trim(),
        upstreamModel: m.upstreamModel.trim(),
        baseUrl: body.baseUrl.trim(),
        apiKey: body.apiKey.trim(),
        contextWindow: m.contextWindow
      })
    }
    reply.send({ ok: true, count: body.models.length })
  })

  app.get('/admin/api/models', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const models = listProviderModels().map((m) => ({
      ...m,
      api_key: `${m.api_key.slice(0, 6)}…${m.api_key.slice(-4)}`
    }))
    reply.send({ models })
  })

  app.post('/admin/api/models', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as {
      displayId?: string
      upstreamModel?: string
      baseUrl?: string
      apiKey?: string
      description?: string
      contextWindow?: number
    }
    if (!body.displayId || !body.upstreamModel || !body.baseUrl || !body.apiKey) {
      reply.status(400).send({
        error: 'displayId / upstreamModel / baseUrl / apiKey 均为必填'
      })
      return
    }
    upsertProviderModel({
      displayId: body.displayId.trim(),
      upstreamModel: body.upstreamModel.trim(),
      baseUrl: body.baseUrl.trim(),
      apiKey: body.apiKey.trim(),
      description: body.description?.trim() ?? '',
      contextWindow: body.contextWindow
    })
    reply.send({ ok: true })
  })

  app.post('/admin/api/models/:id/delete', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    deleteProviderModel((req.params as { id: string }).id)
    reply.send({ ok: true })
  })

  app.post('/admin/api/models/:id/toggle', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    const { enabled } = (req.body ?? {}) as { enabled?: boolean }
    setProviderModelEnabled(id, enabled !== false)
    reply.send({ ok: true })
  })

  // ---- 用户管理 ----

  app.get('/admin/api/users', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    reply.send({ users: listUsers() })
  })

  app.post('/admin/api/users', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as {
      email?: string
      displayName?: string
      role?: string
      workspaceId?: string
    }
    if (!body.email) {
      reply.status(400).send({ error: 'email 必填' })
      return
    }
    const ws = body.workspaceId
      ? { id: body.workspaceId }
      : (db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string })
    createUser({
      email: body.email.trim(),
      displayName: body.displayName?.trim() ?? '',
      role: body.role === 'admin' ? 'admin' : 'member',
      workspaceId: ws.id
    })
    reply.send({ ok: true })
  })

  app.post('/admin/api/users/:id/role', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    const { role } = (req.body ?? {}) as { role?: string }
    if (role !== 'admin' && role !== 'member') {
      reply.status(400).send({ error: 'role 仅支持 admin / member' })
      return
    }
    updateUserRole(id, role)
    reply.send({ ok: true })
  })

  app.post('/admin/api/users/:id/delete', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    deleteUser((req.params as { id: string }).id)
    reply.send({ ok: true })
  })

  // ---- 工作区 ----

  app.get('/admin/api/workspaces', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    reply.send({ workspaces: listWorkspaces() })
  })

  app.post('/admin/api/workspaces', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name?.trim()) {
      reply.status(400).send({ error: 'name 必填' })
      return
    }
    createWorkspace(name.trim())
    reply.send({ ok: true })
  })

  // ---- Key 编辑 ----

  app.post('/admin/api/keys/:id/update', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      label?: string
      quotaUsd?: number
      modelGrants?: string[]
    }
    updateKey(id, body)
    reply.send({ ok: true })
  })

  // ---- 仪表盘统计 ----

  app.get('/admin/api/stats', (req, reply) => {
    if (!requireAdmin(req, reply)) return
    reply.send(dashboardStats())
  })
}
