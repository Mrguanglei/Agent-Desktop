// IPC 契约与领域模型：main / preload / renderer 三端共享。
// 事件面以 grok ACP（grok agent stdio）实际发出的事件为准做归一化，
// headless streaming-json 只是子集（text/thought/end/error），可无缝复用同一套事件。

export type BackendMode = 'mock' | 'acp'

/** 审批策略（对标 Codex 三档）：ask=请求批准 / auto=替我审批(只读类自动放行) / full=完全访问 */
export type ApprovalMode = 'ask' | 'auto' | 'full'

export interface ModelInfo {
  id: string
  name: string
  description?: string
}

export interface AccountInfo {
  email: string | null
  displayName: string | null
  planLabel: string
  billingPeriod: string | null
}

export interface ThreadSummary {
  id: string
  /** 所属项目（对标 Codex 侧栏的项目分组；真实模式下对应 cwd 工作区） */
  project: string
  title: string
  cwd: string
  branch?: string
  updatedAt: number
  status: 'idle' | 'running' | 'waiting_permission'
  preview?: string
}

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUSD?: number
  modelId?: string
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

export interface ToolCallView {
  toolCallId: string
  title: string
  kind?: string // read / edit / delete / move / search / execute / think / fetch / switch_mode / other
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  locations?: { path: string }[]
  diff?: { path: string; oldText: string; newText: string }
  terminalOutput?: string
  contentPreview?: string
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; ts: number }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; ts: number }
  | { kind: 'thought'; id: string; text: string; streaming: boolean; ts: number }
  | { kind: 'tool'; id: string; tool: ToolCallView; ts: number }
  | { kind: 'error'; id: string; message: string; ts: number }

export interface PermissionRequestView {
  requestId: string
  threadId: string
  title: string
  toolCallId: string
  kind?: string
  options: { optionId: string; name: string; kind: string }[]
}

/** Plan 审批请求（_x.ai/exit_plan_mode，0.2.102 已验证） */
export interface PlanApprovalRequestView {
  requestId: string
  threadId: string
  toolCallId: string
  planContent: string | null
}

/** 结构化问答请求（_x.ai/ask_user_question） */
export interface AskUserRequestView {
  requestId: string
  threadId: string
  toolCallId: string
  mode: 'default' | 'plan'
  questions: {
    question: string
    multiSelect?: boolean | null
    options: { label: string; description?: string; preview?: string }[]
  }[]
}

/** 问答应答（对齐 agent 端 serde：tag=outcome，snake_case） */
export type AskUserResponse =
  | { outcome: 'accepted'; answers: Record<string, string[]> }
  | { outcome: 'chat_about_this'; partial_answers?: Record<string, string[]> }
  | { outcome: 'skip_interview'; partial_answers?: Record<string, string[]> }
  | { outcome: 'cancelled' }

/** main → renderer 的归一化事件 */
export type BackendEvent =
  | { type: 'text_chunk'; threadId: string; text: string }
  | { type: 'thought_chunk'; threadId: string; text: string }
  | { type: 'tool_call'; threadId: string; tool: ToolCallView }
  | { type: 'tool_call_update'; threadId: string; toolCallId: string; patch: Partial<ToolCallView> }
  | { type: 'plan'; threadId: string; entries: PlanEntry[] }
  | { type: 'mode_changed'; threadId: string; mode: string }
  | { type: 'permission_request'; threadId: string; request: PermissionRequestView }
  | { type: 'turn_end'; threadId: string; stopReason: string; usage?: UsageInfo }
  | { type: 'error'; threadId: string; message: string }
  | { type: 'thread_updated'; thread: ThreadSummary }
  | { type: 'backend_status'; mode: BackendMode; detail: string }
  | { type: 'models'; availableModels: ModelInfo[]; currentModelId: string | null }
  | { type: 'account'; account: AccountInfo | null }
  /** reasoning effort 状态（来自模型 _meta / model_changed 广播） */
  | {
      type: 'effort'
      efforts: { id: string; label: string; description?: string }[]
      currentEffort: string | null
    }
  | { type: 'plan_approval_request'; threadId: string; request: PlanApprovalRequestView }
  | { type: 'ask_user_request'; threadId: string; request: AskUserRequestView }
  /** API 错误重试状态（grok retry_state：402/限流/网络错误时的静默退避重试） */
  | {
      type: 'retry_state'
      threadId: string
      retrying: boolean
      attempt?: number
      maxRetries?: number
      reason?: string
    }
  /** 历史回放中的用户消息（实时发送走 optimistic，不会收到） */
  | { type: 'user_message'; threadId: string; text: string }
  /** session/load 的历史回放结束 */
  | { type: 'history_loaded'; threadId: string }
  /** 内部事件：grok 侧会话标题生成/变更（manager 消化后转为 thread_updated，不进 renderer） */
  | { type: 'thread_title'; threadId: string; title: string }
  /** 会话被删除 */
  | { type: 'thread_removed'; threadId: string }

export interface BootstrapInfo {
  mode: BackendMode
  detail: string
  threads: ThreadSummary[]
  defaultCwd: string
  username: string
  availableModels: ModelInfo[]
  currentModelId: string | null
  account: AccountInfo | null
  grokVersion: string | null
  settings: AppSettings
}

/** 内嵌终端标签页（用户 shell 或 agent 命令会话） */
export interface PtyTabInfo {
  id: string
  title: string
  kind: 'user' | 'agent'
  threadId?: string
}

/** 独立通道：main → renderer 的 PTY 事件 */
export type PtyEvent =
  | { kind: 'meta'; tab: PtyTabInfo }
  | { kind: 'data'; id: string; data: string }
  | { kind: 'exit'; id: string; exitCode: number | null }

/** _x.ai/search/fuzzy 匹配项 */
export interface FileMatch {
  name: string
  type: string
  path: string
  score?: number
}

/** 输入框 @ 提及的文件 */
export interface FileMention {
  path: string
  name: string
}

/** 应用级设置（持久化在 userData/settings.json） */
export interface AppSettings {
  /** 新会话的默认工作目录 */
  defaultCwd: string
  /** 默认审批策略 */
  approvalMode: ApprovalMode
  /** 新会话偏好模型（null = grok 默认） */
  modelId: string | null
  /** 新会话偏好 reasoning effort（null = grok 当前值） */
  effortId: string | null
  /** 用户打开的项目工作区（对标 Codex 侧栏项目列表） */
  projects: { name: string; path: string }[]
  /** 自定义后端地址（GROK_CLI_CHAT_PROXY_BASE_URL；null = xAI 官方） */
  backendUrl: string | null
  /** 用户是否手动配置过后端（true = 自动探测让位；缺省 false = 自动接入本地后端） */
  backendManual?: boolean
  /** WorkBuddy 后端 API Key（wbk_…；设置后以隔离 GROK_HOME + XAI_API_KEY 启动 grok） */
  backendApiKey?: string | null
}

/** preload 暴露到 window.grok 的 API */
export interface GrokApi {
  getBootstrap(): Promise<BootstrapInfo>
  newThread(project?: string, cwd?: string): Promise<ThreadSummary>
  /** 输入框聚焦时预热：后台建好会话备用，发送时零等待 */
  prewarm(cwd: string): Promise<void>
  /** 加载历史会话（session/load 回放）；幂等 */
  loadThread(threadId: string): Promise<void>
  /** 重命名会话（_x.ai/session/rename） */
  renameThread(threadId: string, title: string): Promise<void>
  /** 删除会话（_x.ai/session/delete） */
  deleteThread(threadId: string): Promise<void>
  sendPrompt(threadId: string, text: string, mentions?: FileMention[]): Promise<void>
  cancel(threadId: string): Promise<void>
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  /** 审批策略三档（请求批准 / 替我审批 / 完全访问权限） */
  setApprovalMode(mode: ApprovalMode): Promise<void>
  /** 切换模型：threadId 为 null 时仅设置后续新会话的偏好模型 */
  setModel(threadId: string | null, modelId: string): Promise<void>
  /** 切换会话模式（default / plan / ask，ACP session/set_mode） */
  setMode(threadId: string, modeId: string): Promise<void>
  /** 切换 reasoning effort（session/set_model 带 _meta.reasoningEffort） */
  setEffort(threadId: string, effortId: string): Promise<void>
  /** Plan 审批应答：approved / cancelled(可带 feedback) / abandoned */
  respondPlanApproval(requestId: string, outcome: string, feedback?: string): Promise<void>
  /** 结构化问答应答 */
  respondAskUser(requestId: string, response: AskUserResponse): Promise<void>
  /** 退出登录（调用 grok `_x.ai/auth/logout`） */
  logout(): Promise<void>
  /** 用系统浏览器打开外链 */
  openExternal(url: string): Promise<void>
  /** 读取应用设置 */
  getSettings(): Promise<AppSettings>
  /** 更新应用设置（部分字段），返回完整设置 */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 系统目录选择器，返回选中路径或 null */
  pickDirectory(): Promise<string | null>
  /** 测试后端地址连通性 */
  testBackend(url: string): Promise<{ ok: boolean; detail: string }>
  /** 打开一个用户 shell 终端 */
  ptyCreate(cwd: string, cols: number, rows: number): Promise<PtyTabInfo>
  ptyWrite(id: string, data: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptyDispose(id: string): Promise<void>
  onPtyEvent(cb: (ev: PtyEvent) => void): () => void
  /** @ 提及：模糊文件搜索（_x.ai/search/fuzzy） */
  searchFiles(cwd: string, query: string): Promise<FileMatch[]>
  onEvent(cb: (ev: BackendEvent) => void): () => void
}
