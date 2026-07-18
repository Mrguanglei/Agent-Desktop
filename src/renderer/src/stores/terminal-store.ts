import { create } from 'zustand'
import type { PtyEvent, PtyTabInfo } from '../../../shared/types'
import { api } from '../api'

interface TerminalState {
  open: boolean
  tabs: PtyTabInfo[]
  activeTab: string | null
  exited: Record<string, boolean>
  toggle: () => void
  openUserShell: (cwd: string) => Promise<void>
  closeTab: (id: string) => void
  setActive: (id: string) => void
  applyPtyEvent: (ev: PtyEvent) => void
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  open: false,
  tabs: [],
  activeTab: null,
  exited: {},

  toggle: () => set((s) => ({ open: !s.open })),

  openUserShell: async (cwd) => {
    await api.ptyCreate(cwd, 100, 28)
    // 标签页经 pty:event meta 事件添加
    set({ open: true })
  },

  closeTab: (id) => {
    void api.ptyDispose(id)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      return {
        tabs,
        activeTab: s.activeTab === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTab
      }
    })
  },

  setActive: (id) => set({ activeTab: id }),

  applyPtyEvent: (ev) => {
    if (ev.kind === 'meta') {
      set((s) => ({
        tabs: [...s.tabs, ev.tab],
        activeTab: ev.tab.id,
        open: ev.tab.kind === 'agent' ? s.open : true
      }))
    } else if (ev.kind === 'exit') {
      set((s) => ({ exited: { ...s.exited, [ev.id]: true } }))
    }
    // data 事件由各 TerminalView 自行订阅
  }
}))
