import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.js'

/** 需要透传的凭证/客户端标识头（对齐 cli-chat-proxy 契约） */
const HOP_HEADERS = [
  'authorization',
  'x-xai-token-auth',
  'x-userid',
  'x-grok-user-id',
  'x-email',
  'x-grok-client-version',
  'x-grok-client-identifier',
  'x-grok-deployment-id',
  'user-agent',
  'content-type',
  'accept'
] as const

/** 需要回传给客户端的上游响应头（SSE / ETag / 退避 / 模型元数据） */
const RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'retry-after',
  'x-should-retry',
  'x-models-etag',
  'x-grok-context-window',
  'x-grok-max-completion-tokens'
] as const

export interface ProxyOptions {
  /** 覆盖发往上游的 Authorization（wbk_ 模式：换成网关持有的上游凭证） */
  authOverride?: string | null
  /** 流式正文的旁路监听（用于用量计量；可能很大，按 chunk 增量给） */
  onChunk?: (text: string) => void
}

function buildUpstreamHeaders(req: FastifyRequest, opts?: ProxyOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const h of HOP_HEADERS) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  if (!config.passthroughAuth) delete headers['authorization']
  if (opts?.authOverride) headers['authorization'] = opts.authOverride
  return headers
}

/** 通用上游代理：支持 SSE 流式直通 + 可选正文旁路监听 */
export async function proxyToUpstream(
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string,
  opts?: ProxyOptions
): Promise<void> {
  const upstream = await fetch(`${config.upstreamBaseUrl}${upstreamPath}`, {
    method: req.method,
    headers: buildUpstreamHeaders(req, opts),
    body:
      req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {})
  })
  reply.status(upstream.status)
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }
  if (!upstream.body) {
    reply.send()
    return
  }
  const source = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
  if (opts?.onChunk) {
    const decoder = new TextDecoder()
    source.on('data', (chunk: Buffer) => {
      try {
        opts.onChunk?.(decoder.decode(chunk, { stream: true }))
      } catch {
        /* 解码失败忽略 */
      }
    })
  }
  reply.send(source)
}

/** 仅取 JSON（用于目录合并等需要读上游正文的场景；失败返回 null 降级） */
export async function fetchUpstreamJson(
  req: FastifyRequest,
  upstreamPath: string
): Promise<{ status: number; json: unknown; etag: string | null } | null> {
  try {
    const upstream = await fetch(`${config.upstreamBaseUrl}${upstreamPath}`, {
      headers: buildUpstreamHeaders(req)
    })
    const json = upstream.ok ? await upstream.json() : null
    return { status: upstream.status, json, etag: upstream.headers.get('etag') }
  } catch {
    return null
  }
}

/** 从响应正文（SSE 或 JSON）提取最后一个 usage 块（兼容 responses / chat.completions 两种形状） */
export function extractUsage(text: string): { inputTokens: number; outputTokens: number } | null {
  const matches = text.match(/"usage"\s*:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)
  if (!matches || matches.length === 0) return null
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const u = JSON.parse(matches[i].replace(/^"usage"\s*:\s*/, '')) as Record<string, number>
      const input = u['input_tokens'] ?? u['prompt_tokens'] ?? u['inputTokens']
      const output = u['output_tokens'] ?? u['completion_tokens'] ?? u['outputTokens']
      if (typeof input === 'number' || typeof output === 'number') {
        return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
      }
    } catch {
      /* 继续找前一个 */
    }
  }
  return null
}
