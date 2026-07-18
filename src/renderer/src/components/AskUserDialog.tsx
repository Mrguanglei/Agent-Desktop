import { useState } from 'react'
import type { AskUserResponse } from '../../../shared/types'
import { api } from '../api'
import { useChatStore } from '../stores/chat-store'

/** 结构化问答弹窗（_x.ai/ask_user_question）：单选/多选卡片，plan 模式可跳过访谈 */
export function AskUserDialog(): JSX.Element | null {
  const req = useChatStore((s) => s.pendingAskUser)
  const clear = useChatStore((s) => s.clearAskUser)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  if (!req) return null

  const respond = (response: AskUserResponse): void => {
    void api.respondAskUser(req.requestId, response)
    clear()
  }

  const toggle = (question: string, label: string, multi: boolean): void => {
    setAnswers((prev) => {
      const cur = prev[question] ?? []
      if (multi) {
        return {
          ...prev,
          [question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
        }
      }
      return { ...prev, [question]: [label] }
    })
  }

  const answeredCount = req.questions.filter((q) => (answers[q.question]?.length ?? 0) > 0).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex max-h-[80vh] w-[520px] flex-col rounded-xl border border-surface-border bg-surface-0 p-5 shadow-2xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-accent">
          Grok 想了解你的偏好
        </div>
        <div className="mb-3 text-sm text-neutral-500">
          回答 {req.questions.length} 个问题（已答 {answeredCount}/{req.questions.length}）
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {req.questions.map((q, qi) => {
            const multi = q.multiSelect === true
            const selected = answers[q.question] ?? []
            return (
              <div key={qi}>
                <div className="mb-1.5 text-[13px] font-medium text-neutral-800">
                  {q.question}
                  <span className="ml-1.5 text-[10px] font-normal text-neutral-400">
                    {multi ? '多选' : '单选'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {q.options.map((o) => {
                    const on = selected.includes(o.label)
                    return (
                      <button
                        key={o.label}
                        onClick={() => toggle(q.question, o.label, multi)}
                        className={`rounded-lg border px-3 py-2 text-left ${
                          on
                            ? 'border-accent bg-accent-soft'
                            : 'border-surface-border bg-surface-0 hover:border-neutral-300'
                        }`}
                      >
                        <span className="block text-[13px] text-neutral-800">{o.label}</span>
                        {o.description && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                            {o.description}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => respond({ outcome: 'accepted', answers })}
            disabled={answeredCount === 0}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            提交回答
          </button>
          {req.mode === 'plan' && (
            <button
              onClick={() => respond({ outcome: 'skip_interview' })}
              className="rounded-lg bg-surface-2 px-4 py-2 text-sm text-neutral-700 hover:bg-surface-3"
            >
              跳过访谈
            </button>
          )}
          <button
            onClick={() => respond({ outcome: 'cancelled' })}
            className="ml-auto text-xs text-neutral-400 hover:text-neutral-600"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
