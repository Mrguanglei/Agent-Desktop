/** 网关配置（环境变量驱动） */
export const config = {
  port: Number(process.env.PORT ?? 8399),
  host: process.env.HOST ?? '127.0.0.1',
  /** 上游模型服务（MVP：透传到真实 cli-chat-proxy；生产可替换为自有路由层） */
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL ?? 'https://cli-chat-proxy.grok.com/v1').replace(
    /\/$/,
    ''
  ),
  /** 是否把客户端 Authorization 等凭证头透传给上游（MVP 模式：网关暂不自行验签） */
  passthroughAuth: (process.env.PASSTHROUGH_AUTH ?? '1') !== '0'
} as const
