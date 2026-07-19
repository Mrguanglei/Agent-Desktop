import Fastify from 'fastify'
import { config } from './config.js'
import { billingRoute, settingsRoute, userRoute } from './routes/meta.js'
import { modelsRoute } from './routes/models.js'
import { proxyToUpstream } from './upstream.js'

const app = Fastify({
  logger: { level: 'info' },
  disableRequestLogging: false
})

app.get('/health', () => ({ ok: true, service: 'workbuddy-backend', version: '0.1.0' }))
// grok 自身的健康探测路径是 {proxy}/v1/health
app.get('/v1/health', () => ({ ok: true, service: 'workbuddy-backend', version: '0.1.0' }))

// ---- cli-chat-proxy 兼容契约（grok 客户端零改动接入） ----
app.get('/v1/models', modelsRoute)
app.post('/v1/responses', (req, reply) => proxyToUpstream(req, reply, '/responses'))
app.post('/v1/chat/completions', (req, reply) => proxyToUpstream(req, reply, '/chat/completions'))
app.get('/v1/user', userRoute)
app.get('/v1/billing', billingRoute)
app.get('/v1/settings', settingsRoute)

// 未显式实现的 /v1/* 端点（subagents/bundle、mcp/configs、feedback 等可选功能）
// 一律透传上游，保证网关对 grok 全量透明
app.all('/v1/*', (req, reply) => {
  const upstreamPath = req.url // 含 query string
  return proxyToUpstream(req, reply, upstreamPath)
})

// TODO(V1): /v1/deployment/config（Ed25519 签名策略下发）、/v1/traces（审计 OTLP）、
//           身份中心（OIDC 验签）、配额计量（metering 流水 + 层级限额）

app.addHook('onRequest', async (req) => {
  req.log.info({ url: req.url, hasAuth: Boolean(req.headers.authorization) }, 'gateway request')
})

try {
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`workbuddy-backend listening on http://${config.host}:${config.port}`)
  app.log.info(`upstream: ${config.upstreamBaseUrl}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
