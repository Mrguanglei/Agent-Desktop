import type { FastifyRequest } from 'fastify'
import { findKey, type ApiKeyRow } from './db.js'

/** 请求主体：wbk_ Key 解析成功时挂载 */
export interface Principal {
  apiKey: ApiKeyRow
  keyId: string
  userId: string
  workspaceId: string
  modelGrants: string[] // ["*"] = 全部模型
  quotaUsd: number
  usedUsd: number
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

/**
 * 双模认证：
 * - Authorization: Bearer wbk_... → 自家身份体系（查库验证 + 挂载 principal）
 * - 其他 Bearer / 无凭证 → 透传模式（principal 为空，维持 MVP 行为）
 */
export function resolvePrincipal(req: FastifyRequest): Principal | null {
  const auth = req.headers['authorization']
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token || !token.startsWith('wbk_')) return null
  const row = findKey(token)
  if (!row) return null
  return {
    apiKey: row,
    keyId: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    modelGrants: JSON.parse(row.model_grants) as string[],
    quotaUsd: row.quota_usd,
    usedUsd: row.used_usd
  }
}

export function modelAllowed(p: Principal, modelId: string): boolean {
  return p.modelGrants.includes('*') || p.modelGrants.includes(modelId)
}

/** 粗略 token→成本换算（美元）。上游若返回真实 cost 则以真实值为准 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  void model
  // 参考 grok-4.5 量级：input $2/M, output $10/M（占位费率，后续按模型条目配置）
  return (inputTokens * 2) / 1_000_000 + (outputTokens * 10) / 1_000_000
}
