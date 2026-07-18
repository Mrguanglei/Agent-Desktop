import { cwdBase, useAppStore } from '../stores/app-store'
import { Composer } from './Composer'

const SUGGESTIONS: { icon: string; label: string; prompt: string }[] = [
  { icon: '🔭', label: '探索并理解代码', prompt: '探索并理解这个项目的代码结构，给我一份概览。' },
  { icon: '🔨', label: '构建新功能、应用或工具', prompt: '我想构建一个新功能：' },
  { icon: '♻️', label: '审查代码并提出修改建议', prompt: '审查这个项目的代码并提出修改建议。' },
  { icon: '🐞', label: '修复问题和失败', prompt: '帮我修复这个项目中的问题和失败：' }
]

/** 主页（新任务）空态：Logo + 动态标题 + 建议卡片 + 大输入框 */
export function HomeView(): JSX.Element {
  const { selectedProject, defaultCwd, setDraft } = useAppStore()
  const projectLabel = selectedProject ?? (defaultCwd ? cwdBase(defaultCwd) : null)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-10 px-6">
        <div className="flex flex-col items-center gap-6">
          <span className="text-5xl">☁️</span>
          <h1 className="text-[26px] font-medium tracking-tight text-neutral-800">
            我们应该在{' '}
            <span className="underline decoration-neutral-300">{projectLabel ?? '项目'}</span>{' '}
            中构建什么？
          </h1>
        </div>
        <div className="grid w-full max-w-3xl grid-cols-4 gap-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => setDraft(s.prompt)}
              className="flex h-28 flex-col justify-between rounded-2xl border border-surface-border bg-surface-0 p-4 text-left shadow-sm transition hover:border-neutral-300 hover:shadow"
            >
              <span className="text-xl">{s.icon}</span>
              <span className="text-[13px] leading-snug text-neutral-700">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <Composer threadId={null} project={projectLabel} cwd={defaultCwd || null} />
    </div>
  )
}
