import type { AccountInfo, ModelInfo } from '../../shared/types'
import type { JsonRpcConnection } from './connection'

/**
 * grok 扩展方法调用：0.2.102 二进制的 ext 方法带 `_x.ai/` 前缀（与通知一致），
 * 源码/leader 模式下为 `x.ai/`。先试探下划线前缀，method_not_found 时回退。
 */
export async function extRequest<T = unknown>(
  conn: JsonRpcConnection,
  name: string, // 不带前缀，如 'auth/info'
  params?: unknown
): Promise<T> {
  try {
    return await conn.request<T>(`_x.ai/${name}`, params)
  } catch (err) {
    if (err instanceof Error && err.message.includes('Method not found')) {
      return await conn.request<T>(`x.ai/${name}`, params)
    }
    throw err
  }
}

/** 解析 session/new 响应或 _x.ai/models/update 通知里的 SessionModelState */
export function parseModels(raw: unknown): {
  availableModels: ModelInfo[]
  currentModelId: string | null
  efforts: { id: string; label: string; description?: string }[]
  currentEffort: string | null
} {
  const state = raw as {
    availableModels?: {
      modelId?: string
      name?: string
      description?: string
      _meta?: {
        reasoningEffort?: string
        reasoningEfforts?: { id?: string; value?: string; label?: string; description?: string }[]
      }
    }[]
    currentModelId?: string
  } | null
  const availableModels = (state?.availableModels ?? [])
    .filter((m) => m.modelId)
    .map((m) => ({
      id: m.modelId as string,
      name: m.name ?? (m.modelId as string),
      description: m.description
    }))
  const currentModelId = state?.currentModelId ?? availableModels[0]?.id ?? null
  // effort 菜单与当前值：取 currentModel 的 _meta（支持 effort 的模型才有）
  const currentRaw = (state?.availableModels ?? []).find((m) => m.modelId === currentModelId)
  const efforts = (currentRaw?._meta?.reasoningEfforts ?? [])
    .filter((e) => e.id ?? e.value)
    .map((e) => ({ id: (e.id ?? e.value) as string, label: e.label ?? (e.id as string), description: e.description }))
  return {
    availableModels,
    currentModelId,
    efforts,
    currentEffort: currentRaw?._meta?.reasoningEffort ?? null
  }
}

/** 把 _x.ai/auth/info + _x.ai/billing 的原始返回归一化为 AccountInfo；info 缺失时返回 null */
export function parseAccount(infoRaw: unknown, billingRaw: unknown): AccountInfo | null {
  if (!infoRaw) return null
  const info = infoRaw as {
    email?: string | null
    firstName?: string | null
    lastName?: string | null
  } | null
  const billing = billingRaw as {
    config?: {
      currentPeriod?: { type?: string; start?: string; end?: string }
      onDemandCap?: { val?: number }
      prepaidBalance?: { val?: number }
    }
  } | null
  const name = `${info?.lastName ?? ''}${info?.firstName ?? ''}`.trim() || null
  const cfg = billing?.config
  const paid = (cfg?.onDemandCap?.val ?? 0) > 0 || (cfg?.prepaidBalance?.val ?? 0) > 0
  let billingPeriod: string | null = null
  if (cfg?.currentPeriod?.start && cfg.currentPeriod.end) {
    const weekly = cfg.currentPeriod.type?.includes('WEEKLY')
    billingPeriod = `${cfg.currentPeriod.start.slice(0, 10)} ~ ${cfg.currentPeriod.end.slice(0, 10)}${weekly ? '（每周）' : ''}`
  }
  return {
    email: info?.email ?? null,
    displayName: name,
    planLabel: paid ? '订阅版' : '免费版',
    billingPeriod
  }
}
