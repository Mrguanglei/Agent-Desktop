import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { estimateCostUsd, modelAllowed, resolvePrincipal } from './auth.js'
import { config } from './config.js'
import { recordUsage, seedIfEmpty, getConfig } from './db.js'
import { registerAdminRoutes } from './routes/admin.js'
import { billingRoute, settingsRoute, userRoute } from './routes/meta.js'
import { modelsRoute } from './routes/models.js'
import { extractUsage, proxyToUpstream } from './upstream.js'

const app = Fastify({ logger: { level: 'info' } })

const seed = seedIfEmpty()
if (seed.isNew) {
  app.log.info(`[seed] 默认组织/工作区/管理员已创建，演示 Key: ${seed.demoKey}`)
}

app.get('/health', () => ({ ok: true, service: 'workbuddy-backend', version: '0.2.0' }))
app.get('/v1/health', () => ({ ok: true, service: 'workbuddy-backend', version: '0.2.0' }))

// 管理页（静态 HTML，vanilla JS，无构建步骤）
app.get('/admin', (_req, reply) => {
  reply
    .type('text/html')
    .send(readFileSync(join(process.cwd(), 'public/admin.html'), 'utf8'))
})
registerAdminRoutes(app)

/** 推理端点的身份/权限/配额守门（wbk_ 模式生效；透传模式直接放行） */
function guardInference(req: FastifyRequest, reply: FastifyReply): boolean {
  const p = req.principal
  if (!p) return true // 透传模式
  const model = (req.body as { model?: string } | undefined)?.model ?? ''
  if (model && !modelAllowed(p, model)) {
    reply.status(403).send({
      error: { message: `workbuddy-blocked:model-not-granted: ${model}`, type: 'permission' }
    })
    return false
  }
  if (p.usedUsd >= p.quotaUsd) {
    reply.status(402).send({
      error: {
        message: `workbuddy-blocked:spending-limit: key quota exhausted ($${p.usedUsd.toFixed(4)}/$${p.quotaUsd.toFixed(2)})`,
        type: 'billing'
      }
    })
    return false
  }
  return true
}

interface FastifyRequestNamespace extends FastifyRequestClass {}
import type { FastifyRequest as FastifyRequestClass } from 'fastify'

// 双模认证：每个请求先解析 wbk_ principal
app.addHook('onRequest', async (req) => {
  req.principal = resolvePrincipal(req) ?? undefined
})

// ---- cli-chat-proxy 兼容契约 ----
app.get('/v1/models', modelsRoute)

app.post('/v1/responses', async (req, reply) => {
  if (!guardInference(req, reply)) return
  const p = req.principal
  const model = (req.body as { model?: string } | undefined)?.model ?? 'unknown'
  const upstreamToken = p ? getConfig('upstream_token') : null
  let captured = ''
  await proxyToUpstream(req, reply, '/responses', {
    authOverride: p && upstreamToken ? `Bearer ${upstreamToken}` : null,
    onChunk: (t) => {
      if (captured.length < 1_000_000) captured += t
    }
  })
  if (p) {
    const usage = extractUsage(captured)
    if (usage) {
      recordUsage(
        p.keyId,
        model,
        usage.inputTokens,
        usage.outputTokens,
        estimateCostUsd(model, usage.inputTokens, usage.outputTokens)
      )
    }
  }
})

app.post('/v1/chat/completions', async (req, reply) => {
  if (!guardInference(req, reply)) return
  const p = req.principal
  const model = (req.body as { model?: string } | undefined)?.model ?? 'unknown'
  const upstreamToken = p ? getConfig('upstream_token') : null
  let captured = ''
  await proxyToUpstream(req, reply, '/chat/completions', {
    authOverride: p && upstreamToken ? `Bearer ${upstreamToken}` : null,
    onChunk: (t) => {
      if (captured.length < 1_000_000) captured += t
    }
  })
  if (p) {
    const usage = extractUsage(captured)
    if (usage) {
      recordUsage(
        p.keyId,
        model,
        usage.inputTokens,
        usage.outputTokens,
        estimateCostUsd(model, usage.inputTokens, usage.outputTokens)
      )
    }
  }
})

app.get('/v1/user', userRoute)
app.get('/v1/billing', billingRoute)
app.get('/v1/settings', settingsRoute)

// 未显式实现的 /v1/* 端点一律透传上游
app.all('/v1/*', (req, reply) => proxyToUpstream(req, reply, req.url))

app.addHook('onRequest', async (req) => {
  req.log.info(
    { url: req.url, hasAuth: Boolean(req.headers.authorization), wbk: Boolean(req.principal) },
    'gateway request'
  )
})

try {
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`workbuddy-backend listening on http://${config.host}:${config.port}`)
  app.log.info(`upstream: ${config.upstreamBaseUrl}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
