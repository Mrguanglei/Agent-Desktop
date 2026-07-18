import { create } from 'zustand'
import type {
  AskUserRequestView,
  BackendEvent,
  ChatItem,
  PermissionRequestView,
  PlanApprovalRequestView,
  PlanEntry,
  UsageInfo
} from '../../../shared/types'

let counter = 0
const uid = (): string => `item-${Date.now()}-${counter++}`

export interface ThreadChat {
  items: ChatItem[]
  plan: PlanEntry[] | null
  running: boolean
  mode: string
  lastUsage: UsageInfo | null
  /** API 重试状态（402/限流退避中），null = 正常 */
  retry: { attempt?: number; maxRetries?: number; reason?: string } | null
}

const emptyChat = (): ThreadChat => ({
  items: [],
  plan: null,
  running: false,
  mode: 'default',
  lastUsage: null,
  retry: null
})

interface ChatState {
  chats: Record<string, ThreadChat>
  loadingThreads: Record<string, boolean>
  pendingPermission: PermissionRequestView | null
  pendingPlanApproval: PlanApprovalRequestView | null
  pendingAskUser: AskUserRequestView | null
  applyEvent: (ev: BackendEvent) => void
  addUserMessage: (threadId: string, text: string) => void
  setLoading: (threadId: string, on: boolean) => void
  setMode: (threadId: string, mode: string) => void
  clearPermission: () => void
  clearPlanApproval: () => void
  clearAskUser: () => void
}

export const useChatStore = create<ChatState>((set) => {
  const updateChat = (threadId: string, fn: (c: ThreadChat) => ThreadChat): void =>
    set((s) => ({ chats: { ...s.chats, [threadId]: fn(s.chats[threadId] ?? emptyChat()) } }))

  /** 流式 chunk：拼接到最后一条同类 streaming item，否则新开一条 */
  const appendStream = (c: ThreadChat, kind: 'assistant' | 'thought', text: string): ThreadChat => {
    const items = [...c.items]
    const last = items[items.length - 1]
    if (last && last.kind === kind && last.streaming) {
      items[items.length - 1] = { ...last, text: last.text + text }
    } else {
      items.push({ kind, id: uid(), text, streaming: true, ts: Date.now() })
    }
    return { ...c, items, running: true }
  }

  const closeStreams = (c: ThreadChat): ThreadChat => ({
    ...c,
    running: false,
    retry: null,
    items: c.items.map((it) =>
      it.kind === 'assistant' || it.kind === 'thought' ? { ...it, streaming: false } : it
    )
  })

  return {
    chats: {},
    loadingThreads: {},
    pendingPermission: null,
    pendingPlanApproval: null,
    pendingAskUser: null,

    applyEvent: (ev) => {
      switch (ev.type) {
        case 'text_chunk':
          updateChat(ev.threadId, (c) => appendStream(c, 'assistant', ev.text))
          break
        case 'thought_chunk':
          updateChat(ev.threadId, (c) => appendStream(c, 'thought', ev.text))
          break
        case 'tool_call':
          updateChat(ev.threadId, (c) => {
            const items = [...c.items]
            const idx = items.findIndex(
              (it) => it.kind === 'tool' && it.tool.toolCallId === ev.tool.toolCallId
            )
            if (idx >= 0) {
              const prev = items[idx] as Extract<ChatItem, { kind: 'tool' }>
              items[idx] = { ...prev, tool: ev.tool }
            } else {
              items.push({ kind: 'tool', id: uid(), tool: ev.tool, ts: Date.now() })
            }
            return { ...c, items, running: true }
          })
          break
        case 'tool_call_update':
          updateChat(ev.threadId, (c) => ({
            ...c,
            items: c.items.map((it) =>
              it.kind === 'tool' && it.tool.toolCallId === ev.toolCallId
                ? { ...it, tool: { ...it.tool, ...ev.patch } }
                : it
            )
          }))
          break
        case 'plan':
          updateChat(ev.threadId, (c) => ({ ...c, plan: ev.entries }))
          break
        case 'mode_changed':
          updateChat(ev.threadId, (c) => ({ ...c, mode: ev.mode }))
          break
        case 'permission_request':
          set({ pendingPermission: ev.request })
          break
        case 'plan_approval_request':
          set({ pendingPlanApproval: ev.request })
          break
        case 'ask_user_request':
          set({ pendingAskUser: ev.request })
          break
        case 'retry_state':
          updateChat(ev.threadId, (c) => ({
            ...c,
            retry: ev.retrying
              ? { attempt: ev.attempt, maxRetries: ev.maxRetries, reason: ev.reason }
              : null
          }))
          break
        case 'turn_end':
          updateChat(ev.threadId, (c) => ({
            ...closeStreams(c),
            lastUsage: ev.usage ?? c.lastUsage
          }))
          break
        case 'user_message':
          // 历史回放的用户消息（实时发送已 optimistic 渲染，不会收到）
          updateChat(ev.threadId, (c) => ({
            ...c,
            items: [...c.items, { kind: 'user', id: uid(), text: ev.text, ts: Date.now() }]
          }))
          break
        case 'history_loaded':
          set((s) => ({ loadingThreads: { ...s.loadingThreads, [ev.threadId]: false } }))
          updateChat(ev.threadId, (c) => closeStreams(c))
          break
        case 'error':
          updateChat(ev.threadId, (c) => ({
            ...closeStreams(c),
            items: [...c.items, { kind: 'error', id: uid(), message: ev.message, ts: Date.now() }]
          }))
          break
        default:
          break
      }
    },

    addUserMessage: (threadId, text) =>
      updateChat(threadId, (c) => ({
        ...c,
        running: true,
        items: [...c.items, { kind: 'user', id: uid(), text, ts: Date.now() }]
      })),

    setLoading: (threadId, on) =>
      set((s) => ({ loadingThreads: { ...s.loadingThreads, [threadId]: on } })),

    setMode: (threadId, mode) => updateChat(threadId, (c) => ({ ...c, mode })),

    clearPermission: () => set({ pendingPermission: null }),
    clearPlanApproval: () => set({ pendingPlanApproval: null }),
    clearAskUser: () => set({ pendingAskUser: null })
  }
})
