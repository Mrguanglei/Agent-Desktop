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

function buildUpstreamHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const h of HOP_HEADERS) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  if (!config.passthroughAuth) delete headers['authorization']
  return headers
}

/** 通用上游代理：支持 SSE 流式直通 */
export async function proxyToUpstream(
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string
): Promise<void> {
  const upstream = await fetch(`${config.upstreamBaseUrl}${upstreamPath}`, {
    method: req.method,
    headers: buildUpstreamHeaders(req),
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
  reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream))
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
