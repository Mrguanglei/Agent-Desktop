import { api } from '../api'
import { useChatStore } from '../stores/chat-store'

export function PermissionDialog(): JSX.Element | null {
  const req = useChatStore((s) => s.pendingPermission)
  const clearPermission = useChatStore((s) => s.clearPermission)
  if (!req) return null

  const respond = (optionId: string | null): void => {
    void api.respondPermission(req.requestId, optionId)
    clearPermission()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[420px] rounded-xl border border-surface-border bg-surface-0 p-5 shadow-2xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-amber-600">
          权限请求
        </div>
        <div className="mb-4 font-mono text-sm text-neutral-800">{req.title}</div>
        <div className="flex flex-col gap-2">
          {req.options.map((o) => (
            <button
              key={o.optionId}
              onClick={() => respond(o.optionId)}
              className={`rounded-lg px-3 py-2 text-left text-sm ${
                o.kind.startsWith('allow')
                  ? 'bg-neutral-900 text-white hover:bg-neutral-700'
                  : 'bg-surface-2 text-neutral-700 hover:bg-surface-3'
              }`}
            >
              {o.name}
              <span className="ml-2 text-[10px] opacity-60">{o.kind}</span>
            </button>
          ))}
          <button
            onClick={() => respond(null)}
            className="mt-1 text-center text-xs text-neutral-400 hover:text-neutral-600"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
