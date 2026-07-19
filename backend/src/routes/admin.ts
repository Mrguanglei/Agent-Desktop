import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, getConfig, setConfig } from '../db.js'

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
}
