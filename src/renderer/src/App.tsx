import { useEffect, useMemo } from 'react'
import { api } from './api'
import { AskUserDialog } from './components/AskUserDialog'
import { ChatView } from './components/ChatView'
import { HomeView } from './components/HomeView'
import { PermissionDialog } from './components/PermissionDialog'
import { PlanApprovalDialog } from './components/PlanApprovalDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TerminalDrawer } from './components/TerminalDrawer'
import { useAppStore } from './stores/app-store'
import { useChatStore } from './stores/chat-store'
import { useTerminalStore } from './stores/terminal-store'

export default function App(): JSX.Element {
  const {
    mode,
    backendDetail,
    activeThreadId,
    threads,
    bootstrap,
    handleEvent,
    changesPanelOpen,
    toggleChangesPanel
  } = useAppStore()
  const applyEvent = useChatStore((s) => s.applyEvent)
  const items = useChatStore((s) => (activeThreadId ? s.chats[activeThreadId]?.items : undefined))
  const activeThread = threads.find((t) => t.id === activeThreadId)
  const changeCount = useMemo(() => {
    const paths = new Set<string>()
    for (const it of items ?? []) {
      if (it.kind === 'tool' && it.tool.diff) paths.add(it.tool.diff.path)
    }
    return paths.size
  }, [items])

  useEffect(() => {
    void bootstrap()
    const off = api.onEvent((ev) => {
      if (
        ev.type === 'backend_status' ||
        ev.type === 'thread_updated' ||
        ev.type === 'thread_removed' ||
        ev.type === 'models' ||
        ev.type === 'account' ||
        ev.type === 'effort'
      ) {
        handleEvent(ev)
      } else {
        applyEvent(ev)
      }
    })
    // ⌘, 打开设置；⌘J 开关终端面板
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === ',') {
        e.preventDefault()
        useAppStore.getState().openSettings()
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        useTerminalStore.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    const offPty = api.onPtyEvent((ev) => useTerminalStore.getState().applyPtyEvent(ev))
    return () => {
      off()
      offPty()
      window.removeEventListener('keydown', onKey)
    }
  }, [bootstrap, handleEvent, applyEvent])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-0">
      {/* 顶部条：左段盖在侧栏上方（红绿灯区），右段盖主区 */}
      <header className="flex h-11 shrink-0 items-stretch border-b border-surface-border">
        <div className="drag-region flex w-[280px] items-center justify-between border-r border-surface-border bg-surface-1 pl-20 pr-3">
          <span className="text-sm font-semibold">Grok Desktop</span>
          <button className="no-drag text-neutral-400 hover:text-neutral-600" title="搜索（即将上线）">
            🔍
          </button>
        </div>
        <div className="drag-region flex flex-1 items-center gap-3 bg-surface-0 px-4">
          {activeThread && (
            <span className="truncate text-[13px] font-medium text-neutral-700">
              {activeThread.title}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={() => useTerminalStore.getState().toggle()}
              className="no-drag rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-surface-2"
              title="内嵌终端 (⌘J)"
            >
              ⌄ 终端
            </button>
            {changeCount > 0 && (
              <button
                onClick={toggleChangesPanel}
                className={`no-drag rounded px-2 py-1 text-[11px] ${
                  changesPanelOpen
                    ? 'bg-surface-3 text-neutral-800'
                    : 'text-neutral-500 hover:bg-surface-2'
                }`}
              >
                变更 {changeCount}
              </button>
            )}
            <button
              onClick={() => void api.openExternal('https://grok.com/')}
              className="no-drag rounded-full bg-purple-100 px-2.5 py-1 text-xs font-medium text-purple-600 hover:bg-purple-200"
            >
              ✦ 获取 Plus
            </button>
            <span
              className={`no-drag rounded px-1.5 py-0.5 text-[10px] font-medium ${
                mode === 'acp'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
              title={backendDetail}
            >
              {mode === 'acp' ? 'ACP · grok' : 'Mock 后端'}
            </span>
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[280px] shrink-0 border-r border-surface-border bg-surface-1">
          <Sidebar />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-surface-0">
          {activeThreadId ? <ChatView threadId={activeThreadId} /> : <HomeView />}
          <TerminalDrawer />
        </main>
      </div>

      <PermissionDialog />
      <PlanApprovalDialog />
      <AskUserDialog />
      <SettingsDialog />
    </div>
  )
}
