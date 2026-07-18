import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, FileMatch, FileMention } from '../../../shared/types'
import { api } from '../api'
import { useAppStore } from '../stores/app-store'
import { useChatStore } from '../stores/chat-store'

/**
 * 输入框（主页 + 对话页共用）。
 * 模型选择器为真实数据：列表来自 grok session/new 返回的 availableModels，
 * 切换真实调用 session/set_model（新会话则记为偏好）。
 */
export function Composer({
  threadId,
  project,
  branch,
  cwd
}: {
  threadId: string | null
  project: string | null
  branch?: string
  cwd: string | null
}): JSX.Element {
  const { draft, setDraft, setModel } = useAppStore()
  const running = useChatStore((s) => (threadId ? (s.chats[threadId]?.running ?? false) : false))
  // 发送锁：握手期间（newThread 1~2s）防 Enter 连按/长按重复创建会话
  const [sending, setSending] = useState(false)
  // @ 提及
  const [mentions, setMentions] = useState<FileMention[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionResults, setMentionResults] = useState<FileMatch[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionResults([])
      return
    }
    const seq = ++searchSeq.current
    const t = setTimeout(() => {
      void api.searchFiles(cwd, mentionQuery).then((r) => {
        if (searchSeq.current === seq) setMentionResults(r)
      })
    }, 200)
    return () => clearTimeout(t)
  }, [mentionQuery, cwd])

  const pickMention = (f: FileMatch): void => {
    const caret = textareaRef.current?.selectionStart ?? draft.length
    const next = draft.slice(0, caret).replace(/@[^\s@]*$/, `@${f.name} `) + draft.slice(caret)
    setDraft(next)
    setMentions((ms) => (ms.some((m) => m.path === f.path) ? ms : [...ms, { path: f.path, name: f.name }]))
    setMentionQuery(null)
    setMentionResults([])
    textareaRef.current?.focus()
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || running || sending) return
    setSending(true)
    // 先清空草稿：后续重复触发会因 text 为空直接返回
    setDraft('')
    const attach = mentions
    setMentions([])
    try {
      if (threadId) {
        useChatStore.getState().addUserMessage(threadId, text)
        void api.sendPrompt(threadId, text, attach)
      } else {
        // 主页：先建线程再发首条消息
        const thread = await api.newThread(project ?? undefined)
        useAppStore.getState().adoptThread(thread)
        useChatStore.getState().addUserMessage(thread.id, text)
        void api.sendPrompt(thread.id, text, attach)
      }
    } catch (err) {
      // 失败恢复草稿，允许重试
      setDraft(text)
      setMentions(attach)
      console.error('send failed', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 px-6 pb-5 pt-2">
      <div className="mx-auto w-full max-w-3xl">
        {/* 上下文 chips */}
        <div className="mb-2 flex items-center gap-2">
          {project && <Chip icon="▣" label={project} />}
          <Chip icon="💻" label="本地" />
          {branch && <Chip icon="⑂" label={branch} />}
        </div>

        {mentions.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {mentions.map((m) => (
              <span
                key={m.path}
                className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
                title={m.path}
              >
                📄 {m.name}
                <button
                  onClick={() => setMentions((ms) => ms.filter((x) => x.path !== m.path))}
                  className="text-accent/60 hover:text-accent"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative rounded-2xl border border-surface-border bg-surface-0 shadow-sm focus-within:border-neutral-300">
          {mentionQuery !== null && mentionResults.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-56 overflow-y-auto rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
              {mentionResults.map((f) => (
                <button
                  key={f.path}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(f)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-1"
                >
                  <span>{f.type === 'dir' ? '📁' : '📄'}</span>
                  <span className="shrink-0 text-[13px] text-neutral-800">{f.name}</span>
                  <span className="truncate text-[10px] text-neutral-400">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              const caret = e.target.selectionStart ?? e.target.value.length
              const m = e.target.value.slice(0, caret).match(/@([^\s@]*)$/)
              setMentionQuery(m ? m[1] : null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setMentionQuery(null)
                setMentionResults([])
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={
              sending ? '创建会话中…' : running ? '任务进行中…' : '随心输入，@ 提及文件'
            }
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="max-h-52 w-full resize-none rounded-t-2xl bg-transparent px-4 pb-1 pt-3 text-sm outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <ApprovalDropdown />
            <ModeChip threadId={threadId} />

            <span className="ml-auto" />
            <EffortSelector threadId={threadId} />
            <ModelSelector threadId={threadId} onSelect={setModel} />
            {running && threadId ? (
              <button
                onClick={() => void api.cancel(threadId)}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-sm text-white hover:bg-red-600"
                title="停止"
              >
                ■
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-900 text-sm text-white hover:bg-neutral-700 disabled:opacity-30"
                title="发送"
              >
                {sending ? '…' : '↑'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const APPROVAL_OPTIONS: { id: ApprovalMode; label: string; desc: string }[] = [
  { id: 'ask', label: '请求批准', desc: '编辑外部文件和执行命令时始终询问' },
  { id: 'auto', label: '替我审批', desc: '仅对检测到的风险操作请求批准' },
  { id: 'full', label: '完全访问权限', desc: '可不受限制地执行命令和访问文件' }
]

/** 审批策略三档下拉（对标 Codex：请求批准 / 替我审批 / 完全访问权限） */
function ApprovalDropdown(): JSX.Element {
  const [open, setOpen] = useState(false)
  const { approvalMode, setApprovalMode } = useAppStore()
  const current = APPROVAL_OPTIONS.find((o) => o.id === approvalMode) ?? APPROVAL_OPTIONS[0]
  return (
    <span className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-neutral-500 hover:bg-surface-2"
        title={current.desc}
      >
        🛡 {current.label} {open ? '▴' : '▾'}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {APPROVAL_OPTIONS.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  setApprovalMode(o.id)
                  setOpen(false)
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-1"
              >
                <span className="mt-0.5 w-4 text-center text-xs">
                  {o.id === approvalMode ? '✓' : ''}
                </span>
                <span className="flex-1">
                  <span className="block text-[13px] text-neutral-800">{o.label}</span>
                  <span className="block text-[11px] text-neutral-400">{o.desc}</span>
                </span>
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

const MODES = [
  { id: 'default', label: '默认' },
  { id: 'plan', label: '计划' },
  { id: 'ask', label: '问答' }
]

/** 会话模式切换（session/set_mode）：plan 模式下先出计划、经审批后执行 */
function ModeChip({ threadId }: { threadId: string | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const mode = useChatStore((s) => (threadId ? (s.chats[threadId]?.mode ?? 'default') : 'default'))
  const setMode = useChatStore((s) => s.setMode)
  if (!threadId) return null
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  return (
    <span className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`rounded-full px-2 py-1 text-xs ${
          mode === 'default' ? 'text-neutral-500 hover:bg-surface-2' : 'bg-accent-soft text-accent'
        }`}
        title="会话模式（session/set_mode）"
      >
        {current.label}模式 {open ? '▴' : '▾'}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span className="absolute bottom-full left-0 z-50 mb-1 w-28 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setMode(threadId, m.id)
                  void api.setMode(threadId, m.id)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-surface-1"
              >
                <span className="text-neutral-700">{m.label}</span>
                {m.id === mode && <span className="text-accent">✓</span>}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

/** 真实模型下拉：数据来自 grok ACP（session/new 响应 + _x.ai/models/update 通知） */
function ModelSelector({
  threadId,
  onSelect
}: {
  threadId: string | null
  onSelect: (threadId: string | null, modelId: string) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { availableModels, currentModelId } = useAppStore()
  if (availableModels.length === 0) return null

  const current = availableModels.find((m) => m.id === currentModelId)
  return (
    <span className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-full px-2 py-1 text-xs text-neutral-500 hover:bg-surface-2"
        title={current?.description ?? '选择模型'}
      >
        {current?.name ?? currentModelId ?? '选择模型'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {availableModels.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onSelect(threadId, m.id)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-1"
              >
                <span className="flex flex-col">
                  <span className="text-[13px] text-neutral-800">{m.name}</span>
                  {m.description && (
                    <span className="line-clamp-1 text-[11px] text-neutral-400">
                      {m.description}
                    </span>
                  )}
                </span>
                {m.id === currentModelId && <span className="text-accent">✓</span>}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

/** 真实 reasoning effort 下拉（session/set_model 带 _meta.reasoningEffort） */
function EffortSelector({ threadId }: { threadId: string | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { efforts, currentEffort, setEffort } = useAppStore()
  if (!threadId || efforts.length === 0) return null

  const current = efforts.find((e) => e.id === currentEffort)
  return (
    <span className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-full px-2 py-1 text-xs text-neutral-500 hover:bg-surface-2"
        title={current?.description ?? 'Reasoning effort'}
      >
        {current?.label ?? currentEffort ?? 'Effort'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-lg border border-surface-border bg-surface-0 py-1 shadow-lg">
            {efforts.map((e) => (
              <button
                key={e.id}
                onClick={() => {
                  setEffort(threadId, e.id)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-1"
              >
                <span className="flex flex-col">
                  <span className="text-[13px] text-neutral-800">{e.label}</span>
                  {e.description && (
                    <span className="line-clamp-1 text-[11px] text-neutral-400">{e.description}</span>
                  )}
                </span>
                {e.id === currentEffort && <span className="text-accent">✓</span>}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

function Chip({ icon, label }: { icon: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[11px] text-neutral-600">
      <span className="text-[10px]">{icon}</span>
      {label}
    </span>
  )
}
