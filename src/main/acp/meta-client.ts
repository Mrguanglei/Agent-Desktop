import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AccountInfo, FileMatch, ModelInfo, ThreadSummary } from '../../shared/types'
import { JsonRpcConnection } from './connection'
import { extRequest, parseAccount, parseModels } from './ext'

/**
 * 轻量元数据会话：app 启动时预热一个 grok ACP 进程，
 * 用于在任何用户线程建立前拿到真实模型列表与账号信息；也承担 logout。
 * 只建 session 不发 prompt，开销 ≈ 一次握手。
 */
export class MetaAcpClient {
  models: { availableModels: ModelInfo[]; currentModelId: string | null } = {
    availableModels: [],
    currentModelId: null
  }
  account: AccountInfo | null = null
  agentVersion: string | null = null

  private proc: ChildProcessWithoutNullStreams | null = null
  private conn: JsonRpcConnection | null = null
  private searchSessions = new Map<string, string>()
  private fuzzyWaiters = new Map<string, (matches: FileMatch[]) => void>()

  private constructor(
    private readonly bin: string,
    private readonly cwd: string
  ) {}

  static async start(bin: string, cwd: string): Promise<MetaAcpClient | null> {
    const client = new MetaAcpClient(bin, cwd)
    try {
      await client.handshake()
      return client
    } catch (err) {
      console.error('[meta] handshake failed:', err)
      client.dispose()
      return null
    }
  }

  private async handshake(): Promise<void> {
    this.proc = spawn(this.bin, ['agent', '--no-leader', 'stdio'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.conn = new JsonRpcConnection(this.proc)
    this.conn.onRequest = (method) => {
      throw new Error(`meta client: unsupported agent request ${method}`)
    }
    // 模糊搜索结果经 `_x.ai/search/fuzzy/status` 通知回流（done:true 时结算）
    this.conn.onNotification = (method, params) => {
      const normalized = method.replace(/^_?x\.ai\//, '')
      if (normalized === 'search/fuzzy/status') {
        const p = params as { searchId?: string; matches?: FileMatch[]; done?: boolean }
        if (p?.searchId && p.done) {
          const resolve = this.fuzzyWaiters.get(p.searchId)
          if (resolve) {
            this.fuzzyWaiters.delete(p.searchId)
            resolve(p.matches ?? [])
          }
        }
      }
    }

    const init = (await this.conn.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'grok-desktop-meta', version: '0.1.0' },
      clientCapabilities: {},
      _meta: { clientType: 'desktop' }
    })) as { _meta?: { defaultAuthMethodId?: string; agentVersion?: string } }

    this.agentVersion = init?._meta?.agentVersion ?? null

    await this.conn.request('authenticate', {
      methodId: init?._meta?.defaultAuthMethodId ?? 'cached_token'
    })

    const created = (await this.conn.request('session/new', {
      cwd: this.cwd,
      mcpServers: []
    })) as { models?: unknown }
    this.models = parseModels(created?.models)

    const [info, billing] = await Promise.all([
      extRequest(this.conn, 'auth/info').catch((err) => {
        console.error('[meta] auth/info failed:', err instanceof Error ? err.message : err)
        return null
      }),
      extRequest(this.conn, 'billing').catch((err) => {
        console.error('[meta] billing failed:', err instanceof Error ? err.message : err)
        return null
      })
    ])
    this.account = parseAccount(info, billing)
  }

  async logout(): Promise<void> {
    if (this.conn) {
      await extRequest(this.conn, 'auth/logout').catch(() => {
        /* 即使失败也按已退出处理（凭证可能已失效） */
      })
    }
  }

  /** 拉取 grok 历史会话列表（`_x.ai/sessions/list`，0.2.102 已验证） */
  async listSessions(): Promise<ThreadSummary[]> {
    if (!this.conn) return []
    try {
      const resp = (await extRequest(this.conn, 'sessions/list', {})) as {
        result?: { sessions?: RawSession[] }
        sessions?: RawSession[]
      }
      const sessions = resp?.result?.sessions ?? resp?.sessions ?? []
      return sessions.map((s) => ({
        id: s.sessionId,
        project: cwdBase(s.cwd),
        title: s.title ?? '未命名会话',
        cwd: s.cwd,
        updatedAt: s.lastChangeUnixMs ?? Date.now(),
        status: 'idle' as const
      }))
    } catch {
      return []
    }
  }

  /** 重命名会话（`_x.ai/session/rename`，已验证） */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    if (!this.conn) return false
    try {
      const resp = (await extRequest(this.conn, 'session/rename', { sessionId, title })) as {
        success?: boolean
      }
      return resp?.success === true
    } catch {
      return false
    }
  }

  /** 删除会话（`_x.ai/session/delete`，已验证） */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.conn) return false
    try {
      const resp = (await extRequest(this.conn, 'session/delete', { sessionId })) as {
        success?: boolean
      }
      return resp?.success === true
    } catch {
      return false
    }
  }

  /**
   * 模糊文件搜索（`_x.ai/search/fuzzy/*` 会话式 API，0.2.102 已验证）：
   * open（每 cwd 复用一个 searchId）→ change → 等 done:true 的 status 通知。
   */
  async fuzzySearch(cwd: string, query: string, limit = 20): Promise<FileMatch[]> {
    if (!this.conn) return []
    try {
      let searchId = this.searchSessions.get(cwd)
      if (!searchId) {
        const opened = (await extRequest(this.conn, 'search/fuzzy/open', { cwd })) as {
          result?: { searchId?: string }
          searchId?: string
        }
        searchId = opened?.result?.searchId ?? opened?.searchId
        if (!searchId) return []
        this.searchSessions.set(cwd, searchId)
      }
      const id = searchId
      const result = new Promise<FileMatch[]>((resolve) => {
        this.fuzzyWaiters.set(id, resolve)
        setTimeout(() => {
          if (this.fuzzyWaiters.delete(id)) resolve([])
        }, 3000)
      })
      await extRequest(this.conn, 'search/fuzzy/change', { searchId: id, query, limit })
      return await result
    } catch {
      return []
    }
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = null
    this.conn = null
  }
}

interface RawSession {
  sessionId: string
  title: string | null
  cwd: string
  isWorktree?: boolean
  modelId?: string
  activity?: string
  lastChangeUnixMs?: number
}

function cwdBase(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}
