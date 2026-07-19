import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  AccountInfo,
  AppSettings,
  ApprovalMode,
  AskUserRequestView,
  AskUserResponse,
  BackendEvent,
  BackendMode,
  BootstrapInfo,
  FileMatch,
  FileMention,
  ModelInfo,
  PermissionRequestView,
  PlanApprovalRequestView,
  PtyEvent,
  PtyTabInfo,
  ThreadSummary
} from '../shared/types'
import type { AgentBackend, BackendSink } from './acp/agent-backend'
import { GrokAcpBackend } from './acp/grok-backend'
import { MetaAcpClient } from './acp/meta-client'
import { MockBackend } from './acp/mock-backend'
import { PtyManager } from './pty'

/**
 * 后端管理器：每个 thread 一个独立后端实例（一个 grok 进程 / 一个 mock）。
 * 另维护一个 MetaAcpClient（元数据会话）提供启动即用的模型列表/账号信息/logout。
 */
export class BackendManager implements BackendSink {
  private mode: BackendMode = 'mock'
  private detail = ''
  private threads = new Map<string, ThreadSummary>()
  private backends = new Map<string, AgentBackend>()
  private permissionResolvers = new Map<
    string,
    { threadId: string; resolve: (optionId: string | null) => void }
  >()
  private planResolvers = new Map<
    string,
    { threadId: string; resolve: (r: { outcome: string; feedback?: string }) => void }
  >()
  private askResolvers = new Map<
    string,
    { threadId: string; resolve: (r: AskUserResponse) => void }
  >()
  private approvalMode: ApprovalMode = 'ask'
  private grokBin: string | null = null
  private meta: MetaAcpClient | null = null
  private availableModels: ModelInfo[] = []
  private currentModelId: string | null = null
  private account: AccountInfo | null = null
  private grokVersion: string | null = null
  private defaultCwd = homedir()
  private settings: AppSettings = {
    defaultCwd: homedir(),
    approvalMode: 'ask',
    modelId: null,
    effortId: null,
    projects: [],
    backendUrl: null
  }
  private readonly pty: PtyManager
  /** 预热会话：home 输入框聚焦时后台建好的待用一个（未采用前不进列表，退出时清理） */
  private prewarmed: { backend: AgentBackend; sessionId: string; cwd: string } | null = null

  constructor(
    private readonly send: (ev: BackendEvent) => void,
    sendPty: (ev: PtyEvent) => void
  ) {
    this.pty = new PtyManager(sendPty)
  }

  async init(): Promise<void> {
    this.loadSettings()
    const forced = process.env['GROK_DESKTOP_BACKEND'] as BackendMode | undefined
    this.grokBin = process.env['GROK_BIN'] ?? this.detectGrok()
    if (forced === 'mock') {
      this.mode = 'mock'
      this.detail = '已通过 GROK_DESKTOP_BACKEND=mock 强制使用模拟后端'
    } else if (this.grokBin) {
      this.mode = 'acp'
      this.detail = `已发现 grok: ${this.grokBin}（真实 ACP 后端）`
    } else {
      this.mode = 'mock'
      this.detail = '未在 PATH 发现 grok，使用模拟后端；安装 grok 后重启即自动切换真实 ACP'
    }
    this.emit({ type: 'backend_status', mode: this.mode, detail: this.detail })

    if (this.mode === 'acp' && this.grokBin) {
      // 前后端是一家：本地 workbuddy-backend 在跑且用户未手动配置时，静默自动接入
      await this.applyLocalBackendIfAny()
      // 预热元数据会话：模型列表 + 账号信息（失败不阻塞，线程建立时再补）
      this.meta = await MetaAcpClient.start(this.grokBin, this.defaultCwd, this.spawnEnv())
      if (this.meta) {
        this.availableModels = this.meta.models.availableModels
        this.currentModelId = this.settings.modelId ?? this.meta.models.currentModelId
        this.account = this.meta.account
        this.grokVersion = this.meta.agentVersion
        if (!this.meta.account) {
          this.detail = 'grok 已安装但未能读取登录态；若对话失败请运行 grok login 后重启'
          this.emit({ type: 'backend_status', mode: this.mode, detail: this.detail })
        }
        // 真实历史会话列表（R2）
        const sessions = await this.meta.listSessions()
        for (const t of sessions) this.threads.set(t.id, t)
      }
      return
    }

    // mock 模式：种子演示数据
    const seeds: Array<Pick<ThreadSummary, 'project' | 'title' | 'branch' | 'preview'>> = [
      {
        project: 'grok-desktop',
        title: '设计桌面前端布局',
        branch: 'main',
        preview: '侧边栏 + 对话主区 + 计划面板…'
      },
      { project: 'grok-desktop', title: '修复侧边栏默认展开', branch: 'feature_ui' },
      { project: 'my-api-server', title: '梳理项目框架与部署', branch: 'dev' },
      { project: 'openhuman', title: '检查这个项目', branch: 'main' }
    ]
    let t = Date.now()
    for (const s of seeds) {
      const thread: ThreadSummary = {
        id: randomUUID(),
        cwd: this.defaultCwd,
        updatedAt: (t -= 60_000),
        status: 'idle',
        ...s
      }
      this.threads.set(thread.id, thread)
    }
  }

  bootstrap(): BootstrapInfo {
    return {
      mode: this.mode,
      detail: this.detail,
      threads: [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      defaultCwd: this.defaultCwd,
      username: userInfo().username,
      availableModels: this.availableModels,
      currentModelId: this.currentModelId,
      account: this.account,
      grokVersion: this.grokVersion,
      settings: this.settings
    }
  }

  getSettings(): AppSettings {
    return this.settings
  }

  /** grok 子进程环境：自定义后端时注入 GROK_CLI_CHAT_PROXY_BASE_URL */
  private spawnEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (this.settings.backendUrl) {
      env['GROK_CLI_CHAT_PROXY_BASE_URL'] = this.settings.backendUrl
    }
    return env
  }

  /** 前后端一家亲：本地 workbuddy-backend 在跑且用户未手动配置时，静默自动接入 */
  private async applyLocalBackendIfAny(): Promise<boolean> {
    if (this.settings.backendManual || this.settings.backendUrl) return false
    const url = await this.probeLocalBackend()
    if (!url) return false
    this.settings.backendUrl = url
    try {
      writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      /* 持久化失败不影响使用 */
    }
    this.detail = `已自动连接本地后端 ${url}（workbuddy-backend）`
    this.emit({ type: 'backend_status', mode: this.mode, detail: this.detail })
    return true
  }

  /** 探测本机运行的 workbuddy-backend（/health 标识），返回 /v1 地址或 null */
  private async probeLocalBackend(): Promise<string | null> {
    for (const base of ['http://127.0.0.1:8399']) {
      try {
        const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
        if (!resp.ok) continue
        const body = (await resp.json()) as { service?: string }
        if (body.service === 'workbuddy-backend') return `${base}/v1`
      } catch {
        /* 未运行则忽略 */
      }
    }
    return null
  }
  /** 测试后端连通性：依次探测 {base}/models（契约端点）与 {去v1}/health，任一 2xx 即通过 */
  async testBackend(url: string): Promise<{ ok: boolean; detail: string }> {
    const base = url.replace(/\/$/, '')
    const noV1 = base.replace(/\/v1$/, '')
    const candidates = [`${base}/models`, `${base}/health`, `${noV1}/health`]
    let lastDetail = ''
    for (const u of candidates) {
      try {
        const resp = await fetch(u, { signal: AbortSignal.timeout(4000) })
        if (resp.ok) return { ok: true, detail: `${u} → HTTP ${resp.status}` }
        lastDetail = `${u} → HTTP ${resp.status}`
      } catch {
        lastDetail = `${u} → 连接失败`
      }
    }
    return { ok: false, detail: lastDetail || '连接失败（地址不可达或服务未启动）' }
  }

  /** 输入框聚焦时预热：后台建好会话备用，发送时零等待 */
  async prewarm(cwd: string): Promise<void> {
    if (this.prewarmed && this.prewarmed.cwd === cwd) return
    await this.discardPrewarmed()
    const backend = this.createBackend()
    try {
      const sessionId = await backend.startSession(randomUUID(), cwd, {
        modelId: this.currentModelId ?? undefined
      })
      this.prewarmed = { backend, sessionId, cwd }
    } catch {
      /* 预热失败静默：发送时走正常创建流程 */
    }
  }

  /** 丢弃未采用的预热会话（grok 侧同步删除，不污染列表） */
  private async discardPrewarmed(): Promise<void> {
    if (!this.prewarmed) return
    const { backend, sessionId } = this.prewarmed
    this.prewarmed = null
    backend.disposeAll()
    await this.meta?.deleteSession(sessionId).catch(() => false)
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const backendChanged =
      patch.backendUrl !== undefined && patch.backendUrl !== this.settings.backendUrl
    // 用户在设置页显式保存后端地址 → 标记为手动选择（自动探测让位）
    if (patch.backendUrl !== undefined && patch.backendManual === undefined) {
      patch.backendManual = true
    }
    this.settings = { ...this.settings, ...patch }
    if (patch.approvalMode) this.approvalMode = patch.approvalMode
    if (patch.defaultCwd) this.defaultCwd = patch.defaultCwd
    if (patch.modelId !== undefined && patch.modelId) this.currentModelId = patch.modelId
    try {
      writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      /* 持久化失败不阻塞使用 */
    }
    if (backendChanged) {
      // 后端切换：预热会话作废；恢复自动探测时先尝试重连本地后端；meta 带新环境重连
      void (async () => {
        await this.discardPrewarmed()
        if (!this.settings.backendUrl && !this.settings.backendManual) {
          await this.applyLocalBackendIfAny()
        }
        await this.restartMeta()
      })()
    }
    return this.settings
  }

  /** 后端地址变更后重连 meta（会话列表/账号/模型/搜索都走新后端） */
  private async restartMeta(): Promise<void> {
    if (this.mode !== 'acp' || !this.grokBin) return
    this.meta?.dispose()
    this.meta = await MetaAcpClient.start(this.grokBin, this.defaultCwd, this.spawnEnv())
    if (this.meta) {
      this.availableModels = this.meta.models.availableModels
      this.currentModelId = this.settings.modelId ?? this.meta.models.currentModelId
      this.account = this.meta.account
      this.grokVersion = this.meta.agentVersion
      this.emit({
        type: 'models',
        availableModels: this.availableModels,
        currentModelId: this.currentModelId
      })
      this.emit({ type: 'account', account: this.account })
      const sessions = await this.meta.listSessions()
      for (const t of sessions) this.threads.set(t.id, t)
      for (const t of sessions) this.emit({ type: 'thread_updated', thread: t })
    }
  }

  private loadSettings(): void {
    try {
      const raw = readFileSync(this.settingsPath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = { ...this.settings, ...parsed }
      this.approvalMode = this.settings.approvalMode
      if (this.settings.defaultCwd && existsSync(this.settings.defaultCwd)) {
        this.defaultCwd = this.settings.defaultCwd
      }
    } catch {
      /* 无设置文件：用默认值 */
    }
  }

  private settingsPath(): string {
    return join(app.getPath('userData'), 'settings.json')
  }

  async newThread(project?: string, cwd?: string): Promise<ThreadSummary> {
    const workdir = cwd ?? this.defaultCwd
    // 命中预热会话：直接采用，发送零握手等待
    if (this.prewarmed && this.prewarmed.cwd === workdir) {
      const { backend, sessionId } = this.prewarmed
      this.prewarmed = null
      const thread: ThreadSummary = {
        id: sessionId,
        project: project ?? this.projectLabel(workdir),
        title: '新任务',
        cwd: workdir,
        updatedAt: Date.now(),
        status: 'idle'
      }
      this.threads.set(thread.id, thread)
      this.backends.set(thread.id, backend)
      if (this.settings.effortId && this.currentModelId) {
        void backend.setSessionEffort(thread.id, this.currentModelId, this.settings.effortId)
      }
      this.emit({ type: 'thread_updated', thread })
      return thread
    }
    const backend = this.createBackend()
    const sessionId = await backend.startSession(randomUUID(), workdir, {
      modelId: this.currentModelId ?? undefined
    })
    // thread.id 统一使用 grok sessionId，与 sessions/list、sessions/changed 天然对齐
    const thread: ThreadSummary = {
      id: sessionId,
      project: project ?? this.projectLabel(workdir),
      title: '新任务',
      cwd: workdir,
      updatedAt: Date.now(),
      status: 'idle'
    }
    this.threads.set(thread.id, thread)
    this.backends.set(thread.id, backend)
    // 新会话应用偏好 effort（set_model 是唯一通道，握手后追加调用）
    if (this.settings.effortId && this.currentModelId) {
      void backend.setSessionEffort(thread.id, this.currentModelId, this.settings.effortId)
    }
    this.emit({ type: 'thread_updated', thread })
    return thread
  }

  /** 加载历史会话（幂等）：spawn 新 grok 进程 → session/load 回放历史 */
  async loadThread(threadId: string): Promise<void> {
    if (this.backends.has(threadId)) return
    const thread = this.threads.get(threadId)
    if (!thread) return
    const backend = this.createBackend()
    this.backends.set(threadId, backend)
    try {
      await backend.loadSession(threadId, threadId, thread.cwd)
    } catch (err) {
      this.backends.delete(threadId)
      this.emit({
        type: 'error',
        threadId,
        message: `加载会话失败：${err instanceof Error ? err.message : String(err)}`
      })
      this.emit({ type: 'history_loaded', threadId })
    }
  }

  /** 重命名（R2.5）：走 meta 连接的 _x.ai/session/rename */
  async renameThread(threadId: string, title: string): Promise<void> {
    const ok = (await this.meta?.renameSession(threadId, title)) ?? false
    if (ok) {
      const thread = this.threads.get(threadId)
      if (thread) {
        const next = { ...thread, title }
        this.threads.set(threadId, next)
        this.emit({ type: 'thread_updated', thread: next })
      }
    } else {
      this.emit({ type: 'error', threadId, message: '重命名失败' })
    }
  }

  /** 删除（R2.5）：杀掉对应后端进程 + _x.ai/session/delete + 移除列表项 */
  async deleteThread(threadId: string): Promise<void> {
    console.log(`[manager] deleteThread ${threadId} meta=${this.meta ? 'ok' : 'null'}`)
    this.backends.get(threadId)?.disposeAll()
    this.backends.delete(threadId)
    const ok = (await this.meta?.deleteSession(threadId)) ?? false
    console.log(`[manager] deleteSession result=${ok}`)
    if (ok || this.mode === 'mock') {
      this.threads.delete(threadId)
      this.emit({ type: 'thread_removed', threadId })
    } else {
      this.emit({ type: 'error', threadId, message: '删除会话失败' })
    }
  }

  async sendPrompt(threadId: string, text: string, mentions?: FileMention[]): Promise<void> {
    const backend = await this.ensureBackend(threadId)
    const thread = this.threads.get(threadId)
    if (thread) {
      const next: ThreadSummary = {
        ...thread,
        status: 'running',
        updatedAt: Date.now(),
        title: thread.title === '新任务' ? text.slice(0, 24) : thread.title,
        preview: text.slice(0, 60)
      }
      this.threads.set(threadId, next)
      this.emit({ type: 'thread_updated', thread: next })
    }
    await backend.prompt(threadId, text, mentions)
  }

  async cancel(threadId: string): Promise<void> {
    await this.backends.get(threadId)?.cancel(threadId)
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode
  }

  /** 只读类工具 kind：「替我审批」档下自动放行（对标 Codex「仅对风险操作请求批准」） */
  private static readonly LOW_RISK_KINDS = new Set(['read', 'search', 'think', 'fetch'])

  /** 切换模型：有线程则真实调用 session/set_model；同时记为后续新会话的偏好 */
  async setModel(threadId: string | null, modelId: string): Promise<void> {
    this.currentModelId = modelId
    this.emit({
      type: 'models',
      availableModels: this.availableModels,
      currentModelId: modelId
    })
    if (threadId) {
      await this.backends.get(threadId)?.setSessionModel(threadId, modelId)
    }
  }

  async logout(): Promise<void> {
    await this.meta?.logout()
    this.account = null
    this.emit({ type: 'account', account: null })
    this.detail = '已退出登录。请在终端运行 grok login 重新登录后重启应用'
    this.emit({ type: 'backend_status', mode: this.mode, detail: this.detail })
  }

  /** BackendSink: 后端请求权限 → 按审批策略处理；ask 档全部弹窗 */
  requestPermission(
    threadId: string,
    req: Omit<PermissionRequestView, 'requestId'>
  ): Promise<string | null> {
    const firstAllow = req.options.find((o) => o.kind.startsWith('allow'))
    if (
      this.approvalMode === 'full' ||
      (this.approvalMode === 'auto' && BackendManager.LOW_RISK_KINDS.has(req.kind ?? ''))
    ) {
      return Promise.resolve(firstAllow?.optionId ?? null)
    }
    const requestId = randomUUID()
    this.emit({ type: 'permission_request', threadId, request: { ...req, requestId } })
    const thread = this.threads.get(threadId)
    if (thread) {
      const next = { ...thread, status: 'waiting_permission' as const }
      this.threads.set(threadId, next)
      this.emit({ type: 'thread_updated', thread: next })
    }
    return new Promise((resolve) =>
      this.permissionResolvers.set(requestId, { threadId, resolve })
    )
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const entry = this.permissionResolvers.get(requestId)
    if (entry) {
      this.permissionResolvers.delete(requestId)
      // 权限已答复：线程状态从 waiting_permission 恢复 running
      const thread = this.threads.get(entry.threadId)
      if (thread && thread.status === 'waiting_permission') {
        const next = { ...thread, status: 'running' as const }
        this.threads.set(entry.threadId, next)
        this.send({ type: 'thread_updated', thread: next })
      }
      entry.resolve(optionId)
    }
  }

  /** BackendSink: Plan 审批（_x.ai/exit_plan_mode）→ 转发 renderer */
  requestPlanApproval(
    threadId: string,
    req: Omit<PlanApprovalRequestView, 'requestId'>
  ): Promise<{ outcome: string; feedback?: string }> {
    const requestId = randomUUID()
    this.emit({ type: 'plan_approval_request', threadId, request: { ...req, requestId } })
    this.markWaiting(threadId)
    return new Promise((resolve) => this.planResolvers.set(requestId, { threadId, resolve }))
  }

  respondPlanApproval(requestId: string, outcome: string, feedback?: string): void {
    const entry = this.planResolvers.get(requestId)
    if (entry) {
      this.planResolvers.delete(requestId)
      this.restoreRunning(entry.threadId)
      entry.resolve(feedback ? { outcome, feedback } : { outcome })
    }
  }

  /** BackendSink: 结构化问答（_x.ai/ask_user_question）→ 转发 renderer */
  requestAskUser(
    threadId: string,
    req: Omit<AskUserRequestView, 'requestId'>
  ): Promise<AskUserResponse> {
    const requestId = randomUUID()
    this.emit({ type: 'ask_user_request', threadId, request: { ...req, requestId } })
    this.markWaiting(threadId)
    return new Promise((resolve) => this.askResolvers.set(requestId, { threadId, resolve }))
  }

  respondAskUser(requestId: string, response: AskUserResponse): void {
    const entry = this.askResolvers.get(requestId)
    if (entry) {
      this.askResolvers.delete(requestId)
      this.restoreRunning(entry.threadId)
      entry.resolve(response)
    }
  }

  /** 切换会话模式（default / plan / ask） */
  async setMode(threadId: string, modeId: string): Promise<void> {
    await this.backends.get(threadId)?.setSessionMode(threadId, modeId)
  }

  /** 切换 reasoning effort */
  async setEffort(threadId: string, effortId: string): Promise<void> {
    const modelId = this.currentModelId
    if (!modelId) return
    await this.backends.get(threadId)?.setSessionEffort(threadId, modelId, effortId)
  }

  private markWaiting(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (thread) {
      const next = { ...thread, status: 'waiting_permission' as const }
      this.threads.set(threadId, next)
      this.emit({ type: 'thread_updated', thread: next })
    }
  }

  private restoreRunning(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (thread && thread.status === 'waiting_permission') {
      const next = { ...thread, status: 'running' as const }
      this.threads.set(threadId, next)
      this.send({ type: 'thread_updated', thread: next })
    }
  }

  emit(ev: BackendEvent): void {
    if (ev.type === 'thread_title') {
      // grok 侧标题生成/变更 → 更新列表后转发为 thread_updated
      const thread = this.threads.get(ev.threadId)
      if (thread) {
        const next = { ...thread, title: ev.title, updatedAt: Date.now() }
        this.threads.set(ev.threadId, next)
        this.send({ type: 'thread_updated', thread: next })
      }
      return
    }
    if (ev.type === 'models') {
      if (ev.availableModels.length > 0) this.availableModels = ev.availableModels
      this.currentModelId = ev.currentModelId ?? this.currentModelId
    } else if (ev.type === 'account') {
      this.account = ev.account
      // 账号信息到达后清除可能残留的鉴权告警
      if (ev.account && this.detail.includes('未能读取登录态')) {
        this.detail = `已发现 grok: ${this.grokBin ?? ''}（真实 ACP 后端）`
        this.send({ type: 'backend_status', mode: this.mode, detail: this.detail })
      }
    } else if (ev.type === 'turn_end' || ev.type === 'error') {
      const thread = this.threads.get(ev.threadId)
      if (thread && thread.status !== 'idle') {
        const next = { ...thread, status: 'idle' as const, updatedAt: Date.now() }
        this.threads.set(ev.threadId, next)
        this.send({ type: 'thread_updated', thread: next })
      }
    }
    this.send(ev)
  }

  dispose(): void {
    for (const b of this.backends.values()) b.disposeAll()
    this.backends.clear()
    this.meta?.dispose()
    this.pty.disposeAll()
    if (this.prewarmed) {
      const { backend, sessionId } = this.prewarmed
      this.prewarmed = null
      backend.disposeAll()
      void this.meta?.deleteSession(sessionId).catch(() => false)
    }
  }

  private async ensureBackend(threadId: string): Promise<AgentBackend> {
    let backend = this.backends.get(threadId)
    if (!backend) {
      backend = this.createBackend()
      this.backends.set(threadId, backend)
      const thread = this.threads.get(threadId)
      await backend.startSession(threadId, thread?.cwd ?? this.defaultCwd, {
        modelId: this.currentModelId ?? undefined
      })
    }
    return backend
  }

  private createBackend(): AgentBackend {
    return this.mode === 'acp'
      ? new GrokAcpBackend(this, this.grokBin ?? 'grok', this.pty, this.spawnEnv())
      : new MockBackend(this)
  }

  // ---- 内嵌终端（用户 shell） ----

  ptyCreateUser(cwd: string, cols: number, rows: number): PtyTabInfo {
    return this.pty.createUser(cwd, cols, rows)
  }

  ptyWrite(id: string, data: string): void {
    this.pty.write(id, data)
  }

  ptyResize(id: string, cols: number, rows: number): void {
    this.pty.resize(id, cols, rows)
  }

  ptyDispose(id: string): void {
    this.pty.dispose(id)
  }

  /** @ 提及：模糊文件搜索（经 meta 连接的 _x.ai/search/fuzzy） */
  async searchFiles(cwd: string, query: string): Promise<FileMatch[]> {
    if (!this.meta) return []
    return this.meta.fuzzySearch(cwd, query)
  }

  private projectLabel(cwd: string): string {
    if (cwd === homedir()) return '主目录'
    return cwd.split('/').filter(Boolean).pop() ?? cwd
  }

  private detectGrok(): string | null {
    // 优先级：GROK_BIN 环境变量 → 应用包内捆绑二进制（Codex 模式，打包分发时用）
    //   → which（系统已装 CLI，开发期主路径）→ 常见安装路径
    const bundled = process.resourcesPath ? join(process.resourcesPath, 'grok-bin/grok') : null
    if (bundled && existsSync(bundled)) return bundled
    try {
      const r = spawnSync('which', ['grok'], { encoding: 'utf8' })
      const p = r.stdout?.trim()
      if (r.status === 0 && p) return p
    } catch {
      /* fallthrough */
    }
    const home = homedir()
    for (const p of [
      join(home, '.grok/bin/grok'),
      join(home, '.local/bin/grok'),
      '/usr/local/bin/grok',
      '/opt/homebrew/bin/grok'
    ]) {
      if (existsSync(p)) return p
    }
    return null
  }
}
