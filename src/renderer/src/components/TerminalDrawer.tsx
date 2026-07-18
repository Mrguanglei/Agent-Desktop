import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { useAppStore } from '../stores/app-store'
import { useTerminalStore } from '../stores/terminal-store'

/** 内嵌终端抽屉（⌘J 开关）：用户 shell 标签 + agent 命令会话标签（只读） */
export function TerminalDrawer(): JSX.Element | null {
  const { open, tabs, activeTab, exited, toggle, closeTab, setActive, openUserShell } =
    useTerminalStore()
  const defaultCwd = useAppStore((s) => s.defaultCwd)
  if (!open) return null

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-surface-border bg-surface-0">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-surface-border px-2">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`group flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
              t.id === activeTab ? 'bg-surface-3 text-neutral-800' : 'text-neutral-500 hover:bg-surface-2'
            }`}
          >
            <button onClick={() => setActive(t.id)} className="max-w-[180px] truncate">
              {t.kind === 'agent' ? '🤖 ' : '💻 '}
              {t.title}
              {exited[t.id] && ' (已退出)'}
            </button>
            <button
              onClick={() => closeTab(t.id)}
              className="hidden text-neutral-400 hover:text-neutral-600 group-hover:block"
            >
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={() => void openUserShell(defaultCwd)}
          className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-surface-2"
          title="新建终端"
        >
          ＋
        </button>
        <button
          onClick={toggle}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-surface-2"
          title="关闭面板 (⌘J)"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-400">
            点击 ＋ 打开终端；Grok 执行命令时也会在这里出现对应的会话标签
          </div>
        ) : (
          tabs.map((t) => (
            <div key={t.id} className={t.id === activeTab ? 'h-full' : 'hidden'}>
              <TerminalView id={t.id} readOnly={t.kind === 'agent'} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function TerminalView({ id, readOnly }: { id: string; readOnly: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      theme: {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#1f2328',
        selectionBackground: '#b6d7ff'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const offEvent = api.onPtyEvent((ev) => {
      if (ev.kind === 'data' && ev.id === id) term.write(ev.data)
    })
    const disposers: { dispose: () => void }[] = []
    if (!readOnly) {
      disposers.push(term.onData((data) => void api.ptyWrite(id, data)))
    }
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void api.ptyResize(id, term.cols, term.rows)
      } catch {
        /* 忽略 */
      }
    })
    ro.observe(ref.current)

    return () => {
      offEvent()
      for (const d of disposers) d.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [id, readOnly])

  return <div ref={ref} className="h-full w-full px-1 py-0.5" />
}
