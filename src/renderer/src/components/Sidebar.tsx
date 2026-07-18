import { useMemo, useState } from 'react'
import type { ThreadSummary } from '../../../shared/types'
import { api } from '../api'
import { useAppStore } from '../stores/app-store'

export function Sidebar(): JSX.Element {
  const {
    threads,
    activeThreadId,
    selectedProject,
    projects,
    goHome,
    openThread,
    addProject,
    removeProject,
    deleteThread
  } = useAppStore()
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null)

  /** 项目列表 = 用户打开的工作区（settings.projects）+ 会话所在目录的隐式分组 */
  const merged = useMemo(() => {
    const groups = new Map<string, ThreadSummary[]>()
    for (const t of threads) {
      const list = groups.get(t.project) ?? []
      list.push(t)
      groups.set(t.project, list)
    }
    const out: { name: string; threads: ThreadSummary[]; pinned: boolean }[] = []
    for (const p of projects) {
      out.push({ name: p.name, threads: groups.get(p.name) ?? [], pinned: true })
    }
    for (const [name, list] of groups) {
      if (!projects.some((p) => p.name === name)) {
        out.push({ name, threads: list, pinned: false })
      }
    }
    return out
  }, [threads, projects])

  const handleAddProject = async (): Promise<void> => {
    const dir = await api.pickDirectory()
    if (dir) await addProject(dir)
  }

  return (
    <div className="flex h-full flex-col">
      <nav className="space-y-0.5 px-2 py-2">
        <NavRow icon="✏️" label="新建任务" onClick={() => goHome()} />
        <NavRow icon="💬" label="聊天" active={activeThreadId === null} onClick={() => goHome()} />
      </nav>

      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[11px] font-medium text-neutral-400">项目</span>
        <button
          onClick={() => void handleAddProject()}
          className="rounded px-1 text-neutral-400 hover:bg-surface-2 hover:text-neutral-600"
          title="打开项目文件夹"
        >
          ＋
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {merged.map((g) => (
          <ProjectGroup
            key={g.name}
            name={g.name}
            threads={g.threads}
            pinned={g.pinned}
            selected={g.name === selectedProject}
            activeThreadId={activeThreadId}
            onSelect={() => goHome(g.name)}
            onOpenThread={openThread}
            onRemove={g.pinned ? () => void removeProject(g.name) : undefined}
            onDeleteThread={setDeleting}
          />
        ))}
        {merged.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            点击上方 ＋ 打开项目文件夹开始
          </p>
        )}
      </div>

      <AccountMenu />

      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[380px] rounded-xl border border-surface-border bg-surface-0 p-5 shadow-2xl">
            <div className="text-sm font-semibold text-neutral-800">删除会话</div>
            <p className="mt-2 text-[13px] leading-relaxed text-neutral-500">
              将永久删除「{deleting.title}」，此操作不可撤销。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleting(null)}
                className="rounded-lg bg-surface-2 px-3.5 py-1.5 text-[13px] text-neutral-700 hover:bg-surface-3"
              >
                取消
              </button>
              <button
                onClick={() => {
                  deleteThread(deleting.id)
                  setDeleting(null)
                }}
                className="rounded-lg bg-red-600 px-3.5 py-1.5 text-[13px] text-white hover:bg-red-500"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 真实账号菜单：数据来自 grok `_x.ai/auth/info` + `_x.ai/billing`，退出登录真实调 `_x.ai/auth/logout` */
function AccountMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const { username, account, logout, openSettings } = useAppStore()
  const label = account?.displayName ?? username ?? '本地用户'
  return (
    <div className="relative border-t border-surface-border">
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-2 right-2 z-50 mb-1 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {account ? (
              <>
                <div className="border-b border-surface-border px-3 py-2">
                  <div className="text-[13px] font-medium text-neutral-800">
                    {account.displayName ?? account.email}
                  </div>
                  {account.email && (
                    <div className="truncate text-[11px] text-neutral-400">{account.email}</div>
                  )}
                  <div className="mt-1 text-[11px] text-neutral-500">
                    {account.planLabel}
                    {account.billingPeriod && ` · ${account.billingPeriod}`}
                  </div>
                </div>
                <button
                  onClick={() => {
                    openSettings()
                    setOpen(false)
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] text-neutral-700 hover:bg-surface-1"
                >
                  设置
                  <span className="text-[11px] text-neutral-300">⌘,</span>
                </button>
                <button
                  onClick={() => {
                    logout()
                    setOpen(false)
                  }}
                  className="w-full px-3 py-2 text-left text-[13px] text-red-600 hover:bg-surface-1"
                >
                  退出登录
                </button>
              </>
            ) : (
              <div className="px-3 py-2 text-[12px] text-neutral-400">
                未读取到登录态
                <br />
                请在终端运行 grok login
              </div>
            )}
          </div>
        </>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 hover:bg-surface-2"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-[11px] font-semibold text-white">
          {(label[0] ?? '?').toUpperCase()}
        </span>
        <span className="truncate text-[13px] text-neutral-700">{label}</span>
        {account && <span className="ml-auto text-[10px] text-neutral-400">{account.planLabel}</span>}
      </button>
    </div>
  )
}

function NavRow({
  icon,
  label,
  active = false,
  onClick
}: {
  icon: string
  label: string
  active?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
        active ? 'bg-surface-3 text-neutral-900' : 'text-neutral-700 hover:bg-surface-2'
      }`}
    >
      <span className="w-4 text-center text-xs">{icon}</span>
      {label}
    </button>
  )
}

function ProjectGroup({
  name,
  threads,
  pinned,
  selected,
  activeThreadId,
  onSelect,
  onOpenThread,
  onRemove,
  onDeleteThread
}: {
  name: string
  threads: ThreadSummary[]
  pinned: boolean
  selected: boolean
  activeThreadId: string | null
  onSelect: () => void
  onOpenThread: (id: string) => void
  onRemove?: () => void
  onDeleteThread: (t: ThreadSummary) => void
}): JSX.Element {
  return (
    <div className="group/proj mb-1">
      <div
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 ${
          selected ? 'bg-surface-3' : 'hover:bg-surface-2'
        }`}
      >
        <button
          onClick={onSelect}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium ${
            selected ? 'text-neutral-900' : 'text-neutral-800'
          }`}
        >
          <span className="text-xs">📁</span>
          <span className="truncate">{name}</span>
        </button>
        {onRemove && (
          <button
            onClick={onRemove}
            className="hidden shrink-0 rounded px-1 text-neutral-400 hover:text-red-500 group-hover/proj:block"
            title="从列表移除该项目（不删除会话）"
          >
            ✕
          </button>
        )}
      </div>
      <div className="ml-4 mt-0.5 space-y-0.5">
        {threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeThreadId}
            onClick={() => onOpenThread(t.id)}
            onDelete={() => onDeleteThread(t)}
          />
        ))}
      </div>
    </div>
  )
}

/** 会话行：hover 显示 ⋯ 菜单（重命名 / 删除） */
function ThreadRow({
  thread,
  active,
  onClick,
  onDelete
}: {
  thread: ThreadSummary
  active: boolean
  onClick: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div
      className={`group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 ${
        active ? 'bg-surface-3' : 'hover:bg-surface-2'
      }`}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <StatusDot status={thread.status} />
        <span className="truncate text-[13px] text-neutral-600">{thread.title}</span>
      </button>
      <ThreadActions thread={thread} onDelete={onDelete} />
    </div>
  )
}

function ThreadActions({
  thread,
  onDelete
}: {
  thread: ThreadSummary
  onDelete: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)
  const { renameThread } = useAppStore()

  const close = (): void => {
    setOpen(false)
    setRenaming(false)
    setTitle(thread.title)
  }

  return (
    <span className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className={`rounded px-1 text-neutral-400 hover:bg-surface-3 hover:text-neutral-600 ${
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        title="会话操作"
      >
        ⋯
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={close} />
          <span className="absolute right-0 top-full z-50 mt-0.5 w-40 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {!renaming ? (
              <>
                <button
                  onClick={() => setRenaming(true)}
                  className="w-full px-3 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-surface-1"
                >
                  重命名
                </button>
                <button
                  onClick={() => {
                    onDelete()
                    close()
                  }}
                  className="w-full px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-surface-1"
                >
                  删除
                </button>
              </>
            ) : (
              <span className="flex items-center gap-1 px-2 py-1.5">
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && title.trim()) {
                      renameThread(thread.id, title.trim())
                      close()
                    } else if (e.key === 'Escape') close()
                  }}
                  className="w-full rounded border border-surface-border bg-surface-0 px-1.5 py-1 text-[12px] outline-none focus:border-neutral-400"
                />
                <button
                  onClick={() => {
                    if (title.trim()) {
                      renameThread(thread.id, title.trim())
                      close()
                    }
                  }}
                  className="text-accent"
                >
                  ✓
                </button>
              </span>
            )}
          </span>
        </>
      )}
    </span>
  )
}

function StatusDot({ status }: { status: ThreadSummary['status'] }): JSX.Element {
  const cls =
    status === 'running'
      ? 'animate-pulse bg-accent'
      : status === 'waiting_permission'
        ? 'bg-amber-400'
        : 'bg-neutral-300'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />
}
