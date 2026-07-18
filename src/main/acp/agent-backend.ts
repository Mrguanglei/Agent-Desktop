import type {
  AskUserRequestView,
  AskUserResponse,
  BackendEvent,
  FileMention,
  PermissionRequestView,
  PlanApprovalRequestView
} from '../../shared/types'

/** 后端 → 管理器的事件出口（BackendManager 实现） */
export interface BackendSink {
  emit(ev: BackendEvent): void
  requestPermission(
    threadId: string,
    req: Omit<PermissionRequestView, 'requestId'>
  ): Promise<string | null>
  /** Plan 审批（_x.ai/exit_plan_mode）：返回 {outcome: approved|cancelled|abandoned, feedback?} */
  requestPlanApproval(
    threadId: string,
    req: Omit<PlanApprovalRequestView, 'requestId'>
  ): Promise<{ outcome: string; feedback?: string }>
  /** 结构化问答（_x.ai/ask_user_question）：直接返回 agent 期望的应答对象 */
  requestAskUser(
    threadId: string,
    req: Omit<AskUserRequestView, 'requestId'>
  ): Promise<AskUserResponse>
}

/** 一个 thread 对应一个后端会话（真实 grok ACP 进程或 mock） */
export interface AgentBackend {
  readonly kind: 'mock' | 'acp'
  /** 新建会话，返回 grok sessionId（作为 thread.id 统一标识） */
  startSession(threadId: string, cwd: string, opts?: { modelId?: string }): Promise<string>
  /** 加载已有会话并回放历史 */
  loadSession(threadId: string, sessionId: string, cwd: string): Promise<void>
  prompt(threadId: string, text: string, mentions?: FileMention[]): Promise<void>
  cancel(threadId: string): Promise<void>
  setSessionModel(threadId: string, modelId: string): Promise<void>
  setSessionMode(threadId: string, modeId: string): Promise<void>
  /** 切换 reasoning effort：session/set_model 带 _meta.reasoningEffort */
  setSessionEffort(threadId: string, modelId: string, effortId: string): Promise<void>
  disposeAll(): void
}
