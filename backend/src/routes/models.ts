import { readFileSync, watchFile } from 'node:fs'
import { join } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { listProviderModels } from '../db.js'
import { fetchUpstreamJson } from '../upstream.js'

interface LocalModelEntry {
  id: string
  name: string
  description?: string
  _meta?: Record<string, unknown>
}

/** 网关自有模型目录（models.json，热加载）——"后端加模型，前端立即可选"的载体 */
let localModels: LocalModelEntry[] = []
function loadLocalModels(): LocalModelEntry[] {
  try {
    const raw = readFileSync(join(process.cwd(), 'models.json'), 'utf8')
    return (JSON.parse(raw) as { models?: LocalModelEntry[] }).models ?? []
  } catch {
    return []
  }
}
localModels = loadLocalModels()
watchFile(join(process.cwd(), 'models.json'), () => {
  localModels = loadLocalModels()
})

interface UpstreamModels {
  data?: { id?: string }[]
}

/**
 * GET /v1/models —— 模型目录（OpenAI 兼容 { data: [...] } + ETag 直通）。
 * 合并策略：网关自有条目在前（同 id 覆盖上游），上游条目在后。
 * wbk_ 模式：按 Key 的 model_grants 过滤。
 */
export async function modelsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const upstream = await fetchUpstreamJson(req, '/models')
  const upstreamData = (upstream?.json as UpstreamModels | null)?.data ?? []
  const localIds = new Set(localModels.map((m) => m.id))
  // Provider 模型（DB 注册表）以 OpenAI 形状下发，声明 chat_completions 后端
  const providerEntries = listProviderModels(true).map((m) => ({
    id: m.display_id,
    object: 'model' as const,
    name: m.display_id,
    description: m.description || `${m.upstream_model} @ ${m.base_url}`,
    apiBackend: 'chat_completions',
    _meta: { totalContextTokens: m.context_window }
  }))
  const providerIds = new Set(providerEntries.map((m) => m.id))
  let merged = [
    ...providerEntries,
    ...localModels.filter((m) => !providerIds.has(m.id)),
    ...upstreamData.filter((m) => m.id && !localIds.has(m.id) && !providerIds.has(m.id))
  ]
  const grants = req.principal?.modelGrants
  if (grants && !grants.includes('*')) {
    merged = merged.filter((m) => m.id && grants.includes(m.id))
  }
  if (upstream?.etag) reply.header('etag', upstream.etag)
  reply.send({ data: merged })
}
