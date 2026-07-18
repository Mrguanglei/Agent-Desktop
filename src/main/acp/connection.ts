import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * ACP 传输层：JSON-RPC 2.0 over stdio，NDJSON（每行一条消息）。
 * 与 grok 端 xai-acp-lib 的 LineBufferedRead/按行写入对应。
 * 不依赖 @agentclientprotocol/sdk——grok 大量 x.ai/* 扩展方法需要逃生门，
 * 自研 150 行传输层更直接，也规避了 ESM/CJS 与 schema 版本风险。
 */
export class JsonRpcConnection {
  /** agent → client 的通知（session/update、x.ai/* 等） */
  onNotification: ((method: string, params: unknown) => void) | null = null
  /** agent → client 的请求（session/request_permission 等）；返回值作为 result 回包，抛错回 error */
  onRequest: ((method: string, params: unknown) => Promise<unknown>) | null = null
  /** agent 进程 stderr（日志） */
  onStderr: ((line: string) => void) | null = null
  /** 进程退出 */
  onExit: ((code: number | null, signal: string | null) => void) | null = null

  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage
      } catch {
        return // 非 JSON 行（理论上 stdout 纯净），忽略
      }
      this.handleMessage(msg)
    })
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) this.onStderr?.(line)
      }
    })
    proc.on('exit', (code, signal) => {
      const err = new Error(`grok agent process exited (code=${code}, signal=${signal})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.onExit?.(code, signal)
    })
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(msg: JsonRpcMessage): void {
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private respond(id: number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result: result ?? null })
  }

  private respondError(id: number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // 响应（有 id 且带 result/error，无 method）
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      }
      return
    }
    // agent → client 请求（有 id 有 method）
    if (msg.id !== undefined && msg.method !== undefined) {
      const { id, method, params } = msg
      if (!this.onRequest) {
        this.respondError(id, -32601, `Method not found: ${method}`)
        return
      }
      this.onRequest(method, params).then(
        (result) => this.respond(id, result),
        (err: Error) => this.respondError(id, -32603, err.message)
      )
      return
    }
    // 通知（无 id 有 method）
    if (msg.method !== undefined) {
      this.onNotification?.(msg.method, msg.params)
    }
  }
}
