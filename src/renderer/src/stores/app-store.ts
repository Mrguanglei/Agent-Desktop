import { create } from 'zustand'
import type {
  AccountInfo,
  AppSettings,
  ApprovalMode,
  BackendEvent,
  BackendMode,
  ModelInfo,
  ThreadSummary
} from '../../../shared/types'
import { api } from '../api'
import { useChatStore } from './chat-store'

type EffortOption = { id: string; label: string; description?: string }

export function cwdBase(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

interface AppState {
  mode: BackendMode | null
  backendDetail: string
  defaultCwd: string
  username: string
  threads: ThreadSummary[]
  /** null = 主页（新任务）视图 */
  activeThreadId: string | null
  selectedProject: string | null
  /** 审批策略三档（请求批准 / 替我审批 / 完全访问） */
  approvalMode: ApprovalMode
  /** 变更面板开关 */
  changesPanelOpen: boolean
  /** 输入框草稿（主页建议卡片会写入它） */
  draft: string
  /** 真实模型列表（来自 grok session/new 响应 / models/update 通知） */
  availableModels: ModelInfo[]
  currentModelId: string | null
  /** 真实账号信息（来自 _x.ai/auth/info + _x.ai/billing） */
  account: AccountInfo | null
  /** reasoning effort 菜单与当前值（来自模型 _meta / model_changed 广播） */
  efforts: EffortOption[]
  currentEffort: string | null
  /** 应用设置（持久化） */
  settings: AppSettings | null
  settingsOpen: boolean
  grokVersion: string | null

  bootstrap: () => Promise<void>
  goHome: (project?: string) => void
  openThread: (id: string) => void
  adoptThread: (t: ThreadSummary) => void
  setDraft: (text: string) => void
  setApprovalMode: (mode: ApprovalMode) => void
  toggleChangesPanel: () => void
  openSettings: () => void
  closeSettings: () => void
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  setModel: (threadId: string | null, modelId: string) => void
  setEffort: (threadId: string, effortId: string) => void
  logout: () => void
  renameThread: (id: string, title: string) => void
  deleteThread: (id: string) => void
  handleEvent: (ev: BackendEvent) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: null,
  backendDetail: '',
  defaultCwd: '',
  username: '',
  threads: [],
  activeThreadId: null,
  selectedProject: null,
  approvalMode: 'ask',
  changesPanelOpen: false,
  draft: '',
  availableModels: [],
  currentModelId: null,
  account: null,
  efforts: [],
  currentEffort: null,
  settings: null,
  settingsOpen: false,
  grokVersion: null,

  bootstrap: async () => {
    const info = await api.getBootstrap()
    set({
      mode: info.mode,
      backendDetail: info.detail,
      defaultCwd: info.defaultCwd,
      username: info.username,
      threads: info.threads,
      selectedProject: info.threads[0]?.project ?? null,
      availableModels: info.availableModels,
      currentModelId: info.currentModelId,
      account: info.account,
      settings: info.settings,
      grokVersion: info.grokVersion,
      approvalMode: info.settings.approvalMode
    })
  },

  goHome: (project) =>
    set((s) => ({
      activeThreadId: null,
      selectedProject: project ?? s.selectedProject
    })),

  openThread: (id) => {
    const thread = get().threads.find((t) => t.id === id)
    set({ activeThreadId: id, selectedProject: thread?.project ?? get().selectedProject })
    // 历史会话：触发 session/load 回放（manager 幂等，已加载则无操作）
    useChatStore.getState().setLoading(id, true)
    void api.loadThread(id)
  },

  adoptThread: (t) =>
    set((s) => ({
      threads: [t, ...s.threads.filter((x) => x.id !== t.id)],
      activeThreadId: t.id,
      selectedProject: t.project
    })),

  setDraft: (text) => set({ draft: text }),

  setApprovalMode: (mode) => {
    set({ approvalMode: mode })
    void api.setApprovalMode(mode)
  },

  toggleChangesPanel: () => set((s) => ({ changesPanelOpen: !s.changesPanelOpen })),

  openSettings: () => set({ settingsOpen: true }),

  closeSettings: () => set({ settingsOpen: false }),

  updateSettings: async (patch) => {
    const s = await api.updateSettings(patch)
    set((st) => ({
      settings: s,
      approvalMode: s.approvalMode,
      currentModelId: patch.modelId ? patch.modelId : st.currentModelId
    }))
  },

  setModel: (threadId, modelId) => {
    set({ currentModelId: modelId })
    void api.setModel(threadId, modelId)
  },

  setEffort: (threadId, effortId) => {
    set({ currentEffort: effortId })
    void api.setEffort(threadId, effortId)
  },

  logout: () => {
    void api.logout()
  },

  renameThread: (id, title) => {
    void api.renameThread(id, title)
  },

  deleteThread: (id) => {
    void api.deleteThread(id)
  },

  handleEvent: (ev) => {
    if (ev.type === 'backend_status') {
      set({ mode: ev.mode, backendDetail: ev.detail })
    } else if (ev.type === 'thread_updated') {
      set((s) => {
        const rest = s.threads.filter((t) => t.id !== ev.thread.id)
        return { threads: [ev.thread, ...rest] }
      })
    } else if (ev.type === 'thread_removed') {
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== ev.threadId),
        activeThreadId: s.activeThreadId === ev.threadId ? null : s.activeThreadId
      }))
    } else if (ev.type === 'models') {
      set((s) => ({
        availableModels: ev.availableModels.length > 0 ? ev.availableModels : s.availableModels,
        currentModelId: ev.currentModelId ?? s.currentModelId
      }))
    } else if (ev.type === 'account') {
      set({ account: ev.account })
    } else if (ev.type === 'effort') {
      set((s) => ({
        efforts: ev.efforts.length > 0 ? ev.efforts : s.efforts,
        currentEffort: ev.currentEffort ?? s.currentEffort
      }))
    }
    // 其余事件由 chat store 处理
  }
}))
