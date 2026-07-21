import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, PlanEntry, ToolCallView } from '../../../shared/types'
import { useAppStore } from '../stores/app-store'
import { useChatStore, type ThreadChat } from '../stores/chat-store'
import { Composer } from './Composer'
import { DiffView } from './DiffView'
import { MarkdownView } from './MarkdownView'

export function ChatView({ threadId }: { threadId: string }): JSX.Element {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === threadId))
  const chat = useChatStore((s) => s.chats[threadId])
  const loading = useChatStore((s) => s.loadingThreads[threadId] ?? false)
  const changesPanelOpen = useAppStore((s) => s.changesPanelOpen)
  const items = chat?.items ?? []
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const changes = useMemo(() => aggregateDiffs(items), [items])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat?.plan && <PlanPanel entries={chat.plan} />}
      {chat?.retry && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700">
          ⚠ API 暂时不可用，正在自动重试
          {chat.retry.attempt != null &&
            `（第 ${chat.retry.attempt}${chat.retry.maxRetries ? `/${chat.retry.maxRetries}` : ''} 次）`}
          {chat.retry.reason && (
            <span className="ml-1 text-amber-500" title={chat.retry.reason}>
              — 可能是免费额度用尽或限流，详见悬停提示
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {loading && items.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
              加载历史会话…
            </div>
          ) : (
            <MessageList items={items} chat={chat} />
          )}
          <Composer
            threadId={threadId}
            project={thread?.project ?? null}
            branch={thread?.branch}
            cwd={thread?.cwd ?? null}
          />
        </div>
        {changesPanelOpen && changes.length > 0 && (
          <ChangesPanel changes={changes} selectedPath={selectedPath} onSelect={setSelectedPath} />
        )}
      </div>
    </div>
  )
}

/** 回合状态行（对标 Codex「已处理 Xs」）：发送后立即可见，不再面对空白 */
function TurnStatus({ chat }: { chat: ThreadChat }): JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const turnStart = useMemo(() => {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      if (chat.items[i].kind === 'user') return chat.items[i].ts
    }
    return Date.now()
  }, [chat.items])
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - turnStart) / 1000)), 1000)
    return () => clearInterval(t)
  }, [turnStart])

  const last = chat.items[chat.items.length - 1]
  let status = 'Grok 正在思考…'
  if (chat.retry) {
    status = `API 重试中${chat.retry.attempt != null ? `（第 ${chat.retry.attempt} 次）` : ''}…`
  } else if (last?.kind === 'tool' && (last.tool.status === 'in_progress' || last.tool.status === 'pending')) {
    status = `正在执行：${last.tool.title}`
  } else if (last?.kind === 'thought') {
    status = '正在思考…'
  } else if (last?.kind === 'assistant' && last.streaming) {
    status = '正在回复…'
  }
  const mm = Math.floor(elapsed / 60)
  const ss = String(elapsed % 60).padStart(2, '0')
  return (
    <div className="mb-3 flex items-center gap-2 text-xs text-neutral-400">
      <span className="h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-transparent" />
      <span>{status}</span>
      <span className="text-neutral-300">已处理 {mm}:{ss}</span>
    </div>
  )
}

interface FileChange {
  path: string
  oldText: string
  newText: string
}

/** 客户端聚合：按文件收集本会话所有 diff（同文件取最近一次编辑）——grok 无可靠聚合推送，自力更生 */
function aggregateDiffs(items: ChatItem[]): FileChange[] {
  const map = new Map<string, FileChange>()
  for (const it of items) {
    if (it.kind === 'tool' && it.tool.diff) {
      map.set(it.tool.diff.path, it.tool.diff)
    }
  }
  return [...map.values()]
}

function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
}

/** 变更面板（对标 Codex 右侧「环境信息 · 变更」）：按文件列出 diff 统计，点开看 Monaco diff */
function ChangesPanel({
  changes,
  selectedPath,
  onSelect
}: {
  changes: FileChange[]
  selectedPath: string | null
  onSelect: (path: string) => void
}): JSX.Element {
  const totals = changes.reduce(
    (acc, c) => ({ added: acc.added + countLines(c.newText), removed: acc.removed + countLines(c.oldText) }),
    { added: 0, removed: 0 }
  )
  const selected = changes.find((c) => c.path === selectedPath) ?? changes[0]
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-surface-border bg-surface-1">
      <div className="border-b border-surface-border px-3 py-2 text-xs text-neutral-500">
        变更{' '}
        <span className="font-mono">
          <span className="text-emerald-600">+{totals.added}</span>{' '}
          <span className="text-red-500">-{totals.removed}</span>
        </span>
      </div>
      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-surface-border py-1">
        {changes.map((c) => (
          <button
            key={c.path}
            onClick={() => onSelect(c.path)}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${
              selected.path === c.path ? 'bg-surface-3' : 'hover:bg-surface-2'
            }`}
          >
            <span className="truncate font-mono text-[11px] text-neutral-700">
              {c.path.split('/').pop()}
            </span>
            <span className="ml-2 shrink-0 font-mono text-[10px]">
              <span className="text-emerald-600">+{countLines(c.newText)}</span>{' '}
              <span className="text-red-500">-{countLines(c.oldText)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="mb-1 truncate font-mono text-[10px] text-neutral-400">{selected.path}</div>
        <DiffView diff={selected} />
      </div>
    </aside>
  )
}

function PlanPanel({ entries }: { entries: PlanEntry[] }): JSX.Element {
  const [open, setOpen] = useState(true)
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <div className="border-b border-surface-border bg-surface-1 px-5 py-2">
      <button
        className="flex w-full items-center gap-2 text-xs text-neutral-500"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>
          计划（{done}/{entries.length}）
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 pl-5">
          {entries.map((e, i) => (
            <li key={i} className="flex items-center gap-2 text-[13px]">
              <PlanIcon status={e.status} />
              <span
                className={
                  e.status === 'completed' ? 'text-neutral-400 line-through' : 'text-neutral-700'
                }
              >
                {e.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlanIcon({ status }: { status: PlanEntry['status'] }): JSX.Element {
  if (status === 'completed') return <span className="text-emerald-500">✓</span>
  if (status === 'in_progress') return <span className="animate-pulse text-accent">◐</span>
  return <span className="text-neutral-300">○</span>
}

function MessageList({
  items,
  chat
}: {
  items: ChatItem[]
  chat: ThreadChat | undefined
}): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items])
  return (
    <div className="min-h-0 flex-1 select-text overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-3xl">
        {items.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-400">输入任务描述，开始对话</p>
        ) : (
          items.map((it) => <MessageItem key={it.id} item={it} />)
        )}
        {/* 回合状态行内联在消息流末尾（对标 Codex 的「已处理 Xs」位置） */}
        {chat?.running && <TurnStatus chat={chat} />}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function MessageItem({ item }: { item: ChatItem }): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="mb-3 flex justify-end">
          <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-neutral-800">
            {item.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="mb-3 max-w-[90%]">
          <MarkdownView text={item.text} streaming={item.streaming} />
        </div>
      )
    case 'thought':
      return <ThoughtBlock text={item.text} streaming={item.streaming} />
    case 'tool':
      return <ToolCallCard tool={item.tool} />
    case 'error':
      return (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {item.message}
        </div>
      )
    default:
      return null
  }
}

function ThoughtBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  // 流式期间默认展开（能看到思考在推进），结束后记住用户折叠偏好
  const [open, setOpen] = useState(streaming)
  return (
    <div className="mb-3 max-w-[90%]">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs italic text-neutral-400 hover:text-neutral-500"
      >
        {open ? '▾' : '▸'} 思考过程{streaming && '…'}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-surface-border pl-3 text-xs italic leading-relaxed text-neutral-400">
          {text}
        </div>
      )}
    </div>
  )
}

const KIND_ICON: Record<string, string> = {
  read: '📄',
  edit: '✏️',
  delete: '🗑',
  move: '📦',
  search: '🔍',
  execute: '💻',
  think: '🧠',
  fetch: '🌐'
}

function ToolCallCard({ tool }: { tool: ToolCallView }): JSX.Element {
  const [open, setOpen] = useState(Boolean(tool.diff))
  const hasBody = Boolean(tool.diff ?? tool.terminalOutput ?? tool.contentPreview)
  return (
    <div className="mb-3 max-w-[90%] rounded-lg border border-surface-border bg-surface-0 shadow-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => hasBody && setOpen(!open)}
      >
        <span>{KIND_ICON[tool.kind ?? ''] ?? '🔧'}</span>
        <span className="flex-1 truncate font-mono text-xs text-neutral-600">
          <ToolTitle title={tool.title} />
        </span>
        {tool.diff && <DiffStat diff={tool.diff} />}
        <ToolStatus status={tool.status} />
        {hasBody && <span className="text-neutral-400">{open ? '▾' : '▸'}</span>}
      </button>
      {open && tool.diff && (
        <div className="border-t border-surface-border p-2">
          <DiffView diff={tool.diff} />
        </div>
      )}
      {open && tool.terminalOutput && (
        <pre className="overflow-x-auto rounded-b-lg border-t border-surface-border bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-200">
          {tool.terminalOutput}
        </pre>
      )}
      {open && !tool.diff && !tool.terminalOutput && tool.contentPreview && (
        <pre className="max-h-48 overflow-auto border-t border-surface-border bg-surface-1 p-3 font-mono text-[11px] leading-relaxed text-neutral-500">
          {tool.contentPreview}
        </pre>
      )}
    </div>
  )
}

function ToolStatus({ status }: { status: ToolCallView['status'] }): JSX.Element {
  switch (status) {
    case 'completed':
      return <span className="text-xs text-emerald-500">✓</span>
    case 'failed':
      return <span className="text-xs text-red-500">✗</span>
    case 'in_progress':
      return (
        <span className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent" />
      )
    default:
      return <span className="text-xs text-neutral-400">…</span>
  }
}

/** 把 grok 标题里的反引号路径渲染成 code 样式（如 Write `/tmp/x.txt`） */
function ToolTitle({ title }: { title: string }): JSX.Element {
  const parts = title.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
          <code key={i} className="rounded bg-surface-2 px-1 py-0.5 text-[11px] text-neutral-700">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

/** 真实 diff 行数统计（对标 Codex 卡片上的 +N -N） */
function DiffStat({ diff }: { diff: { oldText: string; newText: string } }): JSX.Element {
  const lines = (s: string): number =>
    s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
  const added = lines(diff.newText)
  const removed = lines(diff.oldText)
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-emerald-600">+{added}</span>{' '}
      <span className="text-red-500">-{removed}</span>
    </span>
  )
}
