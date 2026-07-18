import { useState } from 'react'
import { api } from '../api'
import { useChatStore } from '../stores/chat-store'

/** Plan 审批弹窗（_x.ai/exit_plan_mode）：批准并执行 / 要求修改（带反馈）/ 放弃计划 */
export function PlanApprovalDialog(): JSX.Element | null {
  const req = useChatStore((s) => s.pendingPlanApproval)
  const clear = useChatStore((s) => s.clearPlanApproval)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  if (!req) return null

  const respond = (outcome: string, fb?: string): void => {
    void api.respondPlanApproval(req.requestId, outcome, fb)
    clear()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-surface-border bg-surface-0 p-5 shadow-2xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-accent">
          计划审批
        </div>
        <div className="mb-3 text-sm text-neutral-500">
          Grok 完成了计划制定，请审阅后决定是否执行
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-surface-border bg-surface-1 p-3">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-700">
            {req.planContent ?? '（未提供计划内容）'}
          </pre>
        </div>

        {showFeedback ? (
          <div className="mt-3">
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="告诉 Grok 计划需要怎么改…"
              rows={3}
              className="w-full resize-none rounded-lg border border-surface-border bg-surface-0 px-3 py-2 text-sm outline-none focus:border-neutral-400"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => respond('cancelled', feedback.trim() || undefined)}
                className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700"
              >
                提交反馈并要求修改
              </button>
              <button
                onClick={() => setShowFeedback(false)}
                className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-neutral-600"
              >
                返回
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => respond('approved')}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700"
            >
              批准并执行
            </button>
            <button
              onClick={() => setShowFeedback(true)}
              className="rounded-lg bg-surface-2 px-4 py-2 text-sm text-neutral-700 hover:bg-surface-3"
            >
              要求修改
            </button>
            <button
              onClick={() => respond('abandoned')}
              className="ml-auto text-xs text-neutral-400 hover:text-neutral-600"
            >
              放弃计划
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
