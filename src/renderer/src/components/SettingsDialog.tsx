import { useState } from 'react'
import type { ApprovalMode } from '../../../shared/types'
import { api } from '../api'
import { useAppStore } from '../stores/app-store'

type Tab = 'general' | 'model' | 'backend' | 'account' | 'about'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'model', label: '模型' },
  { id: 'backend', label: '后端' },
  { id: 'account', label: '账号' },
  { id: 'about', label: '关于' }
]

/** 设置中心（头像菜单 / ⌘, 打开）：所有项均为真实生效、真实持久化 */
export function SettingsDialog(): JSX.Element | null {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [tab, setTab] = useState<Tab>('general')
  if (!settingsOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex h-[460px] w-[620px] overflow-hidden rounded-xl border border-surface-border bg-surface-0 shadow-2xl">
        <nav className="flex w-32 shrink-0 flex-col gap-0.5 border-r border-surface-border bg-surface-1 p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-2 text-left text-[13px] ${
                tab === t.id
                  ? 'bg-surface-3 font-medium text-neutral-900'
                  : 'text-neutral-600 hover:bg-surface-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto p-5">
          <button
            onClick={closeSettings}
            className="absolute right-4 top-4 text-neutral-400 hover:text-neutral-600"
            title="关闭"
          >
            ✕
          </button>
          {tab === 'general' && <GeneralTab />}
          {tab === 'model' && <ModelTab />}
          {tab === 'backend' && <BackendTab />}
          {tab === 'account' && <AccountTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: string }): JSX.Element {
  return <h3 className="mb-3 text-sm font-semibold text-neutral-800">{children}</h3>
}

function GeneralTab(): JSX.Element {
  const { settings, updateSettings } = useAppStore()
  if (!settings) return <></>
  return (
    <div>
      <SectionTitle>通用</SectionTitle>

      <div className="mb-1 text-[13px] font-medium text-neutral-700">默认工作目录</div>
      <div className="mb-4 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-surface-1 px-2.5 py-1.5 font-mono text-[12px] text-neutral-600">
          {settings.defaultCwd}
        </code>
        <button
          onClick={() =>
            void api.pickDirectory().then((dir) => {
              if (dir) void updateSettings({ defaultCwd: dir })
            })
          }
          className="shrink-0 rounded-md border border-surface-border px-3 py-1.5 text-[12px] text-neutral-700 hover:bg-surface-2"
        >
          更改…
        </button>
      </div>
      <p className="mb-5 text-[11px] text-neutral-400">新任务会话将在此目录下运行（按目录分组到侧栏项目）</p>

      <div className="mb-1 text-[13px] font-medium text-neutral-700">默认审批策略</div>
      <div className="space-y-1.5">
        {(
          [
            { id: 'ask', label: '请求批准', desc: '编辑文件和执行命令时始终询问' },
            { id: 'auto', label: '替我审批', desc: '仅对检测到的风险操作请求批准' },
            { id: 'full', label: '完全访问权限', desc: '可不受限制地执行命令和访问文件' }
          ] as { id: ApprovalMode; label: string; desc: string }[]
        ).map((o) => (
          <button
            key={o.id}
            onClick={() => void updateSettings({ approvalMode: o.id })}
            className="flex w-full items-center gap-2.5 rounded-lg border border-surface-border px-3 py-2 text-left hover:bg-surface-1"
          >
            <span
              className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                settings.approvalMode === o.id
                  ? 'border-accent bg-accent text-white'
                  : 'border-neutral-300'
              }`}
            >
              {settings.approvalMode === o.id && <span className="text-[9px]">✓</span>}
            </span>
            <span className="flex-1">
              <span className="block text-[13px] text-neutral-800">{o.label}</span>
              <span className="block text-[11px] text-neutral-400">{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ModelTab(): JSX.Element {
  const { settings, updateSettings, availableModels, efforts } = useAppStore()
  if (!settings) return <></>
  return (
    <div>
      <SectionTitle>模型</SectionTitle>

      <div className="mb-1 text-[13px] font-medium text-neutral-700">默认模型</div>
      <div className="mb-4 space-y-1.5">
        <OptionRow
          label="跟随 grok 默认"
          selected={settings.modelId === null}
          onClick={() => void updateSettings({ modelId: null })}
        />
        {availableModels.map((m) => (
          <OptionRow
            key={m.id}
            label={m.name}
            desc={m.description}
            selected={settings.modelId === m.id}
            onClick={() => void updateSettings({ modelId: m.id })}
          />
        ))}
      </div>

      <div className="mb-1 text-[13px] font-medium text-neutral-700">默认 Reasoning Effort</div>
      <div className="space-y-1.5">
        <OptionRow
          label="跟随 grok 当前值"
          selected={settings.effortId === null}
          onClick={() => void updateSettings({ effortId: null })}
        />
        {efforts.map((e) => (
          <OptionRow
            key={e.id}
            label={e.label}
            desc={e.description}
            selected={settings.effortId === e.id}
            onClick={() => void updateSettings({ effortId: e.id })}
          />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-neutral-400">对新会话生效；已有会话用输入框底栏的选择器切换</p>
    </div>
  )
}

function OptionRow({
  label,
  desc,
  selected,
  onClick
}: {
  label: string
  desc?: string
  selected: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${
        selected ? 'border-accent bg-accent-soft' : 'border-surface-border hover:bg-surface-1'
      }`}
    >
      <span>
        <span className="block text-[13px] text-neutral-800">{label}</span>
        {desc && <span className="block text-[11px] text-neutral-400">{desc}</span>}
      </span>
      {selected && <span className="text-accent">✓</span>}
    </button>
  )
}

/** 后端配置：自定义 cli-chat-proxy 兼容网关地址（WorkBuddy 后端接入点） */
function BackendTab(): JSX.Element {
  const { settings, updateSettings } = useAppStore()
  const [url, setUrl] = useState(settings?.backendUrl ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  if (!settings) return <></>

  const save = (value: string): void => {
    void updateSettings({ backendUrl: value.trim() || null })
  }
  const test = async (): Promise<void> => {
    if (!url.trim()) return
    setTesting(true)
    setTestResult(null)
    const r = await api.testBackend(url.trim())
    setTestOk(r.ok)
    setTestResult(r.detail)
    setTesting(false)
  }

  return (
    <div>
      <SectionTitle>后端</SectionTitle>
      <div className="mb-1 text-[13px] font-medium text-neutral-700">后端网关地址</div>
      <div className="mb-2 flex items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="留空 = xAI 官方（cli-chat-proxy.grok.com）"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-surface-border bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-neutral-400"
        />
        <button
          onClick={() => save(url)}
          className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] text-white hover:bg-neutral-700"
        >
          保存
        </button>
        <button
          onClick={() => void test()}
          disabled={!url.trim() || testing}
          className="shrink-0 rounded-md border border-surface-border px-3 py-1.5 text-[12px] text-neutral-700 hover:bg-surface-2 disabled:opacity-40"
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>
      {testResult && (
        <p className={`mb-2 text-[11px] ${testOk ? 'text-emerald-600' : 'text-red-500'}`}>
          {testOk ? '✓ ' : '✗ '}
          {testResult}
        </p>
      )}
      <div className="mb-4 rounded-md bg-surface-1 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        当前生效：
        <code className="font-mono text-neutral-700">
          {settings.backendUrl ?? 'https://cli-chat-proxy.grok.com/v1（xAI 官方）'}
        </code>
        {settings.backendUrl && !settings.backendManual && (
          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
            自动连接
          </span>
        )}
        {settings.backendUrl && settings.backendManual && (
          <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-neutral-500">
            手动配置
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-neutral-400">
        前后端是一家：本机 workbuddy-backend 运行时（
        <code className="font-mono">npm run dev:backend</code>）会自动接入，无需任何配置。
        手动保存地址后将不再自动接入（标记为手动配置）。
        {settings.backendManual && (
          <button
            onClick={() =>
              void updateSettings({ backendUrl: null, backendManual: false })
            }
            className="ml-1 text-accent hover:underline"
          >
            恢复自动探测
          </button>
        )}
      </p>
    </div>
  )
}

function AccountTab(): JSX.Element {
  const { account, logout, closeSettings } = useAppStore()
  return (
    <div>
      <SectionTitle>账号</SectionTitle>
      {account ? (
        <>
          <div className="mb-4 rounded-lg border border-surface-border p-3">
            <div className="text-[13px] font-medium text-neutral-800">
              {account.displayName ?? account.email}
            </div>
            {account.email && <div className="text-[12px] text-neutral-400">{account.email}</div>}
            <div className="mt-1 text-[12px] text-neutral-500">
              {account.planLabel}
              {account.billingPeriod && ` · 计费周期 ${account.billingPeriod}`}
            </div>
          </div>
          <button
            onClick={() => {
              logout()
              closeSettings()
            }}
            className="rounded-md border border-red-200 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
          >
            退出登录
          </button>
        </>
      ) : (
        <p className="text-[13px] text-neutral-400">未读取到登录态，请在终端运行 grok login</p>
      )}
    </div>
  )
}

function AboutTab(): JSX.Element {
  const { grokVersion, mode, backendDetail } = useAppStore()
  return (
    <div>
      <SectionTitle>关于</SectionTitle>
      <div className="space-y-2 text-[13px] text-neutral-600">
        <Row k="Grok Desktop" v="0.1.0" />
        <Row k="后端模式" v={mode === 'acp' ? 'ACP（grok agent stdio）' : 'Mock'} />
        <Row k="grok 后端版本" v={grokVersion ?? '未知'} />
        <Row k="协议" v="ACP v1（JSON-RPC 2.0 over stdio）" />
        <div className="pt-2 text-[11px] text-neutral-400">{backendDetail}</div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-surface-border pb-2">
      <span className="text-neutral-400">{k}</span>
      <span className="font-mono text-[12px]">{v}</span>
    </div>
  )
}
