import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AskUserRequestView, FileMention, PlanEntry, ToolCallView, UsageInfo } from '../../shared/types'
import type { PtyManager } from '../pty'
import type { AgentBackend, BackendSink } from './agent-backend'
import { JsonRpcConnection } from './connection'
import { extRequest, parseAccount, parseModels } from './ext'

interface AcpSession {
  proc: ChildProcessWithoutNullStreams
  conn: JsonRpcConnection
  sessionId: string
}

/**
 * 真实 grok ACP 后端：spawn `grok agent --no-leader stdio`。
 * 已对 grok 0.2.102 验证：initialize → authenticate → session/new|load → session/prompt。
 * 历史回放（session/load）事件带 `_meta.isReplay: true`，且每条的 chunk 是完整消息。
 */
export class GrokAcpBackend implements AgentBackend {
  readonly kind = 'acp' as const
  private sessions = new Map<string, AcpSession>()
  /** 事件路由用的当前 threadId：连接建立时是临时 id，session/new 返回后换成 grok sessionId */
  private currentThreadId: string | null = null

  constructor(
    private readonly sink: BackendSink,
    private readonly bin: string,
    private readonly pty: PtyManager | null
  ) {}

  async startSession(threadId: string, cwd: string, opts?: { modelId?: string }): Promise<string> {
    const conn = await this.connect(threadId, cwd)
    const created = (await conn.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: opts?.modelId ? { modelId: opts.modelId } : undefined
    })) as { sessionId: string; models?: unknown }

    // 用 grok sessionId 作为统一标识（替换连接期的临时 id）
    const s = this.sessions.get(threadId)!
    s.sessionId = created.sessionId
    this.sessions.delete(threadId)
    this.sessions.set(created.sessionId, s)
    this.currentThreadId = created.sessionId

    const models = parseModels(created.models)
    if (models.availableModels.length > 0) {
      this.sink.emit({
        type: 'models',
        availableModels: models.availableModels,
        currentModelId: models.currentModelId
      })
    }
    if (models.efforts.length > 0 || models.currentEffort) {
      this.sink.emit({ type: 'effort', efforts: models.efforts, currentEffort: models.currentEffort })
    }
    void this.fetchAccount().then((account) => {
      if (account) this.sink.emit({ type: 'account', account })
    })
    return created.sessionId
  }

  async loadSession(threadId: string, sessionId: string, cwd: string): Promise<void> {
    const conn = await this.connect(threadId, cwd)
    // session/load：grok 先把历史以 session/update + _x.ai/session/update（isReplay: true）
    // 重放推过来，然后才返回响应——响应到达即回放结束。
    const resp = (await conn.request('session/load', {
      sessionId,
      cwd,
      mcpServers: []
    })) as { models?: unknown }

    const s = this.sessions.get(threadId)!
    s.sessionId = sessionId

    const models = parseModels(resp?.models)
    if (models.availableModels.length > 0) {
      this.sink.emit({
        type: 'models',
        availableModels: models.availableModels,
        currentModelId: models.currentModelId
      })
    }
    if (models.efforts.length > 0 || models.currentEffort) {
      this.sink.emit({ type: 'effort', efforts: models.efforts, currentEffort: models.currentEffort })
    }
    this.sink.emit({ type: 'history_loaded', threadId })
  }

  /** spawn grok 进程并完成 initialize + authenticate 握手 */
  private async connect(threadId: string, cwd: string): Promise<JsonRpcConnection> {
    const proc = spawn(this.bin, ['agent', '--no-leader', 'stdio'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const conn = new JsonRpcConnection(proc)
    this.currentThreadId = threadId
    conn.onRequest = (method, params) =>
      this.handleAgentRequest(this.currentThreadId ?? threadId, method, params)
    conn.onNotification = (method, params) =>
      this.handleNotification(this.currentThreadId ?? threadId, method, params)
    conn.onExit = (code) =>
      this.sink.emit({
        type: 'error',
        threadId: this.currentThreadId ?? threadId,
        message: `grok 进程退出 (code=${code})`
      })

    try {
      const init = (await conn.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'grok-desktop', version: '0.1.0' },
        // 不声明 fs 能力：grok 在本地读写文件；
        // terminal 能力：agent 的 bash 命令经 terminal/* 协议在我们的 PTY 里执行（可见）
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: this.pty !== null
        },
        _meta: { clientType: 'desktop' }
      })) as { _meta?: { defaultAuthMethodId?: string } }

      const methodId = init?._meta?.defaultAuthMethodId ?? 'cached_token'
      await conn.request('authenticate', { methodId })

      this.sessions.set(threadId, { proc, conn, sessionId: '' })
      return conn
    } catch (err) {
      proc.kill()
      const message = err instanceof Error ? err.message : String(err)
      this.sink.emit({
        type: 'error',
        threadId,
        message: `ACP 会话建立失败：${message}（若提示鉴权，请先 grok login 或设置 XAI_API_KEY）`
      })
      throw err
    }
  }

  async prompt(threadId: string, text: string, mentions?: FileMention[]): Promise<void> {
    const s = this.sessions.get(threadId)
    if (!s) throw new Error(`session not found for thread ${threadId}`)
    try {
      const content: Record<string, unknown>[] = [{ type: 'text', text }]
      // @ 提及的文件 → ACP resource_link 内容块
      for (const m of mentions ?? []) {
        content.push({ type: 'resource_link', uri: `file://${m.path}`, name: m.name })
      }
      const resp = (await s.conn.request('session/prompt', {
        sessionId: s.sessionId,
        prompt: content
      })) as { stopReason?: string; _meta?: Record<string, unknown> }
      this.sink.emit({
        type: 'turn_end',
        threadId,
        stopReason: resp?.stopReason ?? 'unknown',
        usage: mapUsage(resp?._meta)
      })
    } catch (err) {
      this.sink.emit({
        type: 'error',
        threadId,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  async cancel(threadId: string): Promise<void> {
    const s = this.sessions.get(threadId)
    s?.conn.notify('session/cancel', { sessionId: s.sessionId })
  }

  /** 切换该线程会话的模型（ACP unstable session/set_model，0.2.102 已验证可用） */
  async setSessionModel(threadId: string, modelId: string): Promise<void> {
    const s = this.sessions.get(threadId)
    if (!s) return
    try {
      await s.conn.request('session/set_model', { sessionId: s.sessionId, modelId })
    } catch (err) {
      this.sink.emit({
        type: 'error',
        threadId,
        message: `切换模型失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  /** 切换会话模式（default / plan / ask） */
  async setSessionMode(threadId: string, modeId: string): Promise<void> {
    const s = this.sessions.get(threadId)
    if (!s) return
    try {
      await s.conn.request('session/set_mode', { sessionId: s.sessionId, modeId })
    } catch (err) {
      this.sink.emit({
        type: 'error',
        threadId,
        message: `切换模式失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  /** 切换 reasoning effort（唯一通道：set_model 带 _meta.reasoningEffort） */
  async setSessionEffort(threadId: string, modelId: string, effortId: string): Promise<void> {
    const s = this.sessions.get(threadId)
    if (!s) return
    try {
      await s.conn.request('session/set_model', {
        sessionId: s.sessionId,
        modelId,
        _meta: { reasoningEffort: effortId }
      })
    } catch (err) {
      this.sink.emit({
        type: 'error',
        threadId,
        message: `切换 effort 失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.proc.kill()
    this.sessions.clear()
  }

  private async fetchAccount(): Promise<ReturnType<typeof parseAccount>> {
    const s = [...this.sessions.values()][0]
    if (!s) return null
    try {
      const [info, billing] = await Promise.all([
        extRequest(s.conn, 'auth/info').catch(() => null),
        extRequest(s.conn, 'billing').catch(() => null)
      ])
      return parseAccount(info, billing)
    } catch {
      return null
    }
  }

  // ---- agent → client 反向请求 ----

  private async handleAgentRequest(
    threadId: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (method === 'session/request_permission') {
      const p = params as {
        toolCall?: { toolCallId?: string; title?: string; kind?: string }
        options?: { optionId: string; name: string; kind: string }[]
      }
      const optionId = await this.sink.requestPermission(threadId, {
        threadId,
        toolCallId: p.toolCall?.toolCallId ?? '',
        title: p.toolCall?.title ?? '权限请求',
        kind: p.toolCall?.kind,
        options: p.options ?? []
      })
      return optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
    // terminal/*：agent 的命令在 client 侧 PTY 执行（ACP 标准反向请求）
    if (method === 'terminal/create') {
      if (!this.pty) throw new Error('terminal capability unavailable')
      const p = unwrapParams<{ command?: string; args?: string[]; cwd?: string }>(params)
      const terminalId = this.pty.createAgent({
        command: p.command ?? '/bin/zsh',
        args: p.args ?? [],
        cwd: p.cwd,
        threadId
      })
      return { terminalId }
    }
    if (method === 'terminal/output') {
      if (!this.pty) throw new Error('terminal capability unavailable')
      const p = unwrapParams<{ terminalId?: string }>(params)
      return this.pty.output(p.terminalId ?? '')
    }
    if (method === 'terminal/wait_for_exit') {
      if (!this.pty) throw new Error('terminal capability unavailable')
      const p = unwrapParams<{ terminalId?: string }>(params)
      return await this.pty.waitForExit(p.terminalId ?? '')
    }
    if (method === 'terminal/release' || method === 'terminal/kill') {
      const p = unwrapParams<{ terminalId?: string }>(params)
      this.pty?.dispose(p.terminalId ?? '')
      return {}
    }
    // _x.ai/exit_plan_mode、_x.ai/ask_user_question 等（wire 带下划线前缀；leader 可能有包裹形态）
    const normalized = method.replace(/^_?x\.ai\//, '')
    if (normalized === 'exit_plan_mode') {
      const p = unwrapParams<{ toolCallId?: string; planContent?: string | null }>(params)
      return await this.sink.requestPlanApproval(threadId, {
        threadId,
        toolCallId: p.toolCallId ?? '',
        planContent: p.planContent ?? null
      })
    }
    if (normalized === 'ask_user_question') {
      const p = unwrapParams<{
        toolCallId?: string
        questions?: AskUserRequestView['questions']
        mode?: 'default' | 'plan'
      }>(params)
      return await this.sink.requestAskUser(threadId, {
        threadId,
        toolCallId: p.toolCallId ?? '',
        mode: p.mode ?? 'default',
        questions: p.questions ?? []
      })
    }
    throw new Error(`unsupported agent request: ${method}`)
  }

  // ---- agent → client 通知 ----

  private handleNotification(threadId: string, method: string, params: unknown): void {
    if (method === 'session/update') {
      const update = (params as { update?: Record<string, unknown> })?.update
      if (update) this.translateSessionUpdate(threadId, update)
      return
    }
    // grok 扩展通道：--no-leader 直连为 `_x.ai/*`；leader 桥接时改名为 `x.ai/*`。归一化识别。
    const normalized = method.replace(/^_?x\.ai\//, '')
    if (normalized === 'models/update') {
      const models = parseModels(params)
      if (models.availableModels.length > 0 || models.currentModelId) {
        this.sink.emit({
          type: 'models',
          availableModels: models.availableModels,
          currentModelId: models.currentModelId
        })
      }
      if (models.efforts.length > 0 || models.currentEffort) {
        this.sink.emit({
          type: 'effort',
          efforts: models.efforts,
          currentEffort: models.currentEffort
        })
      }
      return
    }
    if (normalized === 'session_notification' || normalized === 'session/update') {
      // 扩展会话更新：turn_completed / model_changed / retry_state / session_summary_generated 等
      const update = (params as { update?: Record<string, unknown> })?.update
      if (update?.['sessionUpdate'] === 'session_summary_generated') {
        const title = update['session_summary'] as string | undefined
        if (title) this.sink.emit({ type: 'thread_title', threadId, title })
      } else if (update?.['sessionUpdate'] === 'model_changed') {
        // effort/模型被切换的广播（可能来自其他客户端）
        const effort = update['reasoning_effort'] as string | undefined
        const modelId = update['model_id'] as string | undefined
        if (effort) this.sink.emit({ type: 'effort', efforts: [], currentEffort: effort })
        if (modelId) this.sink.emit({ type: 'models', availableModels: [], currentModelId: modelId })
      } else if (update?.['sessionUpdate'] === 'retry_state') {
        // API 错误退避重试（402 额度/限流/网络）：透传给 UI 展示，别让用户对着空白猜
        const retrying = update['type'] === 'retrying'
        this.sink.emit({
          type: 'retry_state',
          threadId,
          retrying,
          attempt: update['attempt'] as number | undefined,
          maxRetries: update['max_retries'] as number | undefined,
          reason: update['reason'] as string | undefined
        })
      }
      return
    }
    if (normalized === 'sessions/changed') {
      // 会话列表变更（标题生成、状态变化）：提取本 session 的标题
      const upserted = (params as { upserted?: { sessionId?: string; title?: string | null }[] })
        ?.upserted
      const self = [...this.sessions.values()][0]
      const mine = upserted?.find((u) => u.sessionId && u.sessionId === self?.sessionId)
      if (mine?.title) this.sink.emit({ type: 'thread_title', threadId, title: mine.title })
      return
    }
    // session/prompt_complete、settings/update、announcements 等：忽略
  }

  private translateSessionUpdate(threadId: string, update: Record<string, unknown>): void {
    const kind = update['sessionUpdate'] as string
    const meta = update['_meta'] as { isReplay?: boolean } | undefined
    const isReplay = meta?.isReplay === true
    switch (kind) {
      case 'agent_message_chunk': {
        const content = update['content'] as { text?: string } | undefined
        if (content?.text) this.sink.emit({ type: 'text_chunk', threadId, text: content.text })
        break
      }
      case 'agent_thought_chunk': {
        const content = update['content'] as { text?: string } | undefined
        if (content?.text) this.sink.emit({ type: 'thought_chunk', threadId, text: content.text })
        break
      }
      case 'user_message_chunk': {
        // 实时发送已在 UI optimistic 渲染，只有历史回放才需要转成 user item
        const content = update['content'] as { text?: string } | undefined
        if (isReplay && content?.text) {
          this.sink.emit({ type: 'user_message', threadId, text: content.text })
        }
        break
      }
      case 'tool_call': {
        this.sink.emit({ type: 'tool_call', threadId, tool: mapToolCall(update) })
        break
      }
      case 'tool_call_update': {
        const toolCallId = update['toolCallId'] as string
        const patch: Partial<ToolCallView> = {}
        if (update['status']) patch.status = update['status'] as ToolCallView['status']
        if (update['title']) patch.title = update['title'] as string
        Object.assign(patch, extractContent(update['content']))
        // 真实工具输出（如 "The file /tmp/x has been created."）→ 预览
        const rawOutput = update['rawOutput'] as
          | { tool_output_for_prompt_concise?: string; tool_output_for_prompt?: string }
          | undefined
        const outText = rawOutput?.tool_output_for_prompt_concise ?? rawOutput?.tool_output_for_prompt
        if (outText) patch.contentPreview = outText.slice(0, 2000)
        this.sink.emit({ type: 'tool_call_update', threadId, toolCallId, patch })
        break
      }
      case 'plan': {
        const entries = (update['entries'] as PlanEntry[] | undefined) ?? []
        this.sink.emit({ type: 'plan', threadId, entries })
        break
      }
      case 'current_mode_update': {
        this.sink.emit({
          type: 'mode_changed',
          threadId,
          mode: (update['currentModeId'] as string) ?? 'default'
        })
        break
      }
      default:
        break // available_commands_update 等忽略
    }
  }
}

function mapToolCall(u: Record<string, unknown>): ToolCallView {
  return {
    toolCallId: (u['toolCallId'] as string) ?? '',
    title: (u['title'] as string) ?? '工具调用',
    kind: u['kind'] as string | undefined,
    status: ((u['status'] as string) ?? 'pending') as ToolCallView['status'],
    locations: u['locations'] as { path: string }[] | undefined,
    ...extractContent(u['content'])
  }
}

/** leader 包裹形态防御：params.method + params.params → 取内层 */
function unwrapParams<T>(params: unknown): T {
  const p = params as { method?: unknown; params?: unknown }
  if (p && typeof p === 'object' && typeof p.method === 'string' && p.params !== undefined) {
    return p.params as T
  }
  return params as T
}

/** 从 ACP ToolCallContent[] 提取 diff / 文本预览 / 终端输出 */
function extractContent(content: unknown): Partial<ToolCallView> {
  const out: Partial<ToolCallView> = {}
  if (!Array.isArray(content)) return out
  const texts: string[] = []
  for (const block of content as Record<string, unknown>[]) {
    if (block['type'] === 'diff') {
      out.diff = {
        path: (block['path'] as string) ?? '',
        oldText: (block['oldText'] as string) ?? '',
        newText: (block['newText'] as string) ?? ''
      }
    } else if (block['type'] === 'content') {
      const inner = block['content'] as { type?: string; text?: string } | undefined
      if (inner?.text) texts.push(inner.text)
    } else if (block['type'] === 'terminal') {
      out.terminalOutput = (out.terminalOutput ?? '') + `[terminal ${block['terminalId']}]\n`
    }
  }
  if (texts.length > 0) out.contentPreview = texts.join('\n').slice(0, 2000)
  return out
}

function mapUsage(meta: Record<string, unknown> | undefined): UsageInfo | undefined {
  if (!meta) return undefined
  return {
    inputTokens: meta['inputTokens'] as number | undefined,
    outputTokens: meta['outputTokens'] as number | undefined,
    totalTokens: meta['totalTokens'] as number | undefined,
    modelId: meta['modelId'] as string | undefined
  }
}
