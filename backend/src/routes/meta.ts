import type { FastifyReply, FastifyRequest } from 'fastify'
import { proxyToUpstream } from '../upstream.js'

/** GET /v1/user —— 用户/团队资料：透传上游；上游不可达时返回本地开发兜底 */
export async function userRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const qs = (req.query as Record<string, string>)['include']
    ? `?include=${(req.query as Record<string, string>)['include']}`
    : ''
  try {
    await proxyToUpstream(req, reply, `/user${qs}`)
  } catch {
    reply.send({
      userId: 'local-dev',
      email: 'dev@workbuddy.local',
      firstName: 'Dev',
      lastName: null,
      principalType: 'User',
      teamId: null,
      teamName: null,
      teamRole: null,
      organizationId: null,
      organizationName: null,
      organizationRole: null,
      userBlockedReason: null,
      teamBlockedReasons: [],
      codingDataRetentionOptOut: true
    })
  }
}

/** GET /v1/billing —— 额度：透传；兜底返回"超大额度"（开发环境不卡 402） */
export async function billingRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  try {
    await proxyToUpstream(req, reply, `/billing${qs}`)
  } catch {
    reply.send({
      config: {
        creditUsagePercent: 0,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-01-01T00:00:00+00:00',
          end: '2099-01-01T00:00:00+00:00'
        },
        monthlyLimit: { val: 10_000_000 },
        used: { val: 0 },
        onDemandCap: { val: 10_000_000 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 10_000_000 },
        isUnifiedBillingUser: true,
        billingPeriodStart: '2026-01-01T00:00:00+00:00',
        billingPeriodEnd: '2099-01-01T00:00:00+00:00'
      },
      onDemandEnabled: true,
      subscriptionTier: 'WorkBuddyDev'
    })
  }
}

/** GET /v1/settings —— 远端旗标/访问门：直接放行 */
export async function settingsRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send({ allowAccess: true })
}
