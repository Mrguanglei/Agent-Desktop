import type { AgentBackend, BackendSink } from './agent-backend'

const THOUGHT = '用户反馈登录页在小屏设备上按钮被挤出屏幕。我先读取 LoginForm 的现有实现，确认布局结构，再调整 flex 布局与间距。'

const DIFF_OLD = `export function LoginForm() {
  return (
    <div className="login-container">
      <h1>欢迎回来</h1>
      <input placeholder="邮箱" />
      <input placeholder="密码" type="password" />
      <button className="login-btn">登录</button>
    </div>
  )
}`

const DIFF_NEW = `export function LoginForm() {
  return (
    <div className="login-container flex min-h-screen flex-col items-center justify-center px-4">
      <h1 className="mb-6 text-2xl">欢迎回来</h1>
      <input className="w-full max-w-sm" placeholder="邮箱" />
      <input className="mt-3 w-full max-w-sm" placeholder="密码" type="password" />
      <button className="login-btn mt-6 w-full max-w-sm shrink-0">登录</button>
    </div>
  )
}`

const TERMINAL_OUT = `$ npm test
Test Suites: 12 passed, 12 total
Tests:       148 passed, 148 total
Snapshots:   0 total
Time:        4.213 s`

const REPLY_OK =
  '已修复。问题出在 .login-container 没有约束高度且按钮缺少 shrink-0，小屏下内容溢出。我把容器改为 min-h-screen 的纵向 flex 布局，输入框与按钮限制 max-w-sm，全部测试通过（12 个套件、148 个用例）。'
const REPLY_DENIED =
  '已修复。问题出在 .login-container 没有约束高度且按钮缺少 shrink-0，小屏下内容溢出。我已把容器改为 min-h-screen 的纵向 flex 布局。你拒绝了测试执行，请自行运行 npm test 验证。'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 模拟后端：按脚本回放一个完整 turn 的 ACP 事件流
 * （plan → thought → 工具调用 → diff → 权限请求 → 终端输出 → 流式回复 → usage），
 * 用于 grok 未安装时的 UI 开发。事件形态与 GrokAcpBackend 归一化后的输出完全一致。
 */
export class MockBackend implements AgentBackend {
  readonly kind = 'mock' as const
  private seq = new Map<string, number>()

  constructor(private readonly sink: BackendSink) {}

  async startSession(): Promise<string> {
    return `mock-${Date.now()}`
  }

  async loadSession(threadId: string): Promise<void> {
    this.sink.emit({ type: 'history_loaded', threadId })
  }

  async cancel(threadId: string): Promise<void> {
    this.seq.set(threadId, (this.seq.get(threadId) ?? 0) + 1)
    this.sink.emit({ type: 'turn_end', threadId, stopReason: 'cancelled' })
  }

  async setSessionModel(): Promise<void> {
    /* mock 无真实模型 */
  }

  async setSessionMode(): Promise<void> {
    /* mock 无模式 */
  }

  async setSessionEffort(): Promise<void> {
    /* mock 无 effort */
  }

  disposeAll(): void {
    /* no-op */
  }

  async prompt(threadId: string, _text: string): Promise<void> {
    const my = (this.seq.get(threadId) ?? 0) + 1
    this.seq.set(threadId, my)
    const alive = (): boolean => this.seq.get(threadId) === my

    // 1. Plan
    this.sink.emit({
      type: 'plan',
      threadId,
      entries: [
        { content: '阅读 LoginForm 现有实现', status: 'in_progress', priority: 'high' },
        { content: '修复移动端布局（flex + 间距）', status: 'pending', priority: 'high' },
        { content: '运行测试验证', status: 'pending', priority: 'medium' }
      ]
    })
    await sleep(400)
    if (!alive()) return

    // 2. Thought
    await this.stream(threadId, 'thought', THOUGHT, alive)
    if (!alive()) return

    // 3. 工具调用：读取文件
    this.sink.emit({
      type: 'tool_call',
      threadId,
      tool: {
        toolCallId: 'call-read-1',
        title: '读取 src/pages/LoginForm.tsx',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: 'src/pages/LoginForm.tsx' }]
      }
    })
    await sleep(700)
    if (!alive()) return
    this.sink.emit({
      type: 'tool_call_update',
      threadId,
      toolCallId: 'call-read-1',
      patch: { status: 'completed', contentPreview: DIFF_OLD }
    })
    this.sink.emit({
      type: 'plan',
      threadId,
      entries: [
        { content: '阅读 LoginForm 现有实现', status: 'completed', priority: 'high' },
        { content: '修复移动端布局（flex + 间距）', status: 'in_progress', priority: 'high' },
        { content: '运行测试验证', status: 'pending', priority: 'medium' }
      ]
    })
    await sleep(300)
    if (!alive()) return

    // 4. 工具调用：编辑（带 diff）
    this.sink.emit({
      type: 'tool_call',
      threadId,
      tool: {
        toolCallId: 'call-edit-1',
        title: '修改 src/pages/LoginForm.tsx',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'src/pages/LoginForm.tsx' }],
        diff: { path: 'src/pages/LoginForm.tsx', oldText: DIFF_OLD, newText: DIFF_NEW }
      }
    })
    await sleep(600)
    if (!alive()) return

    // 5. 权限请求：执行测试
    this.sink.emit({
      type: 'tool_call',
      threadId,
      tool: { toolCallId: 'call-exec-1', title: 'npm test', kind: 'execute', status: 'pending' }
    })
    const optionId = await this.sink.requestPermission(threadId, {
      threadId,
      toolCallId: 'call-exec-1',
      title: '执行命令：npm test',
      kind: 'execute',
      options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'always-allow', name: '总是允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' }
      ]
    })
    if (!alive()) return

    const approved = optionId !== null
    this.sink.emit({
      type: 'tool_call_update',
      threadId,
      toolCallId: 'call-exec-1',
      patch: approved
        ? { status: 'completed', terminalOutput: TERMINAL_OUT }
        : { status: 'failed', contentPreview: '用户拒绝了该命令的执行。' }
    })
    this.sink.emit({
      type: 'plan',
      threadId,
      entries: [
        { content: '阅读 LoginForm 现有实现', status: 'completed', priority: 'high' },
        { content: '修复移动端布局（flex + 间距）', status: 'completed', priority: 'high' },
        {
          content: '运行测试验证',
          status: approved ? 'completed' : 'pending',
          priority: 'medium'
        }
      ]
    })
    await sleep(300)
    if (!alive()) return

    // 6. 流式正文回复
    await this.stream(threadId, 'text', approved ? REPLY_OK : REPLY_DENIED, alive)
    if (!alive()) return

    // 7. turn 结束（usage 对齐 grok prompt 响应 _meta 的字段）
    this.sink.emit({
      type: 'turn_end',
      threadId,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 7210,
        outputTokens: 1893,
        totalTokens: 50103,
        costUSD: 0.0127,
        modelId: 'grok-build'
      }
    })
  }

  /** 按小 chunk 流式推送，模拟真实流式渲染 */
  private async stream(
    threadId: string,
    kind: 'text' | 'thought',
    full: string,
    alive: () => boolean
  ): Promise<void> {
    const step = 6
    for (let i = 0; i < full.length; i += step) {
      if (!alive()) return
      this.sink.emit({
        type: kind === 'text' ? 'text_chunk' : 'thought_chunk',
        threadId,
        text: full.slice(i, i + step)
      })
      await sleep(50)
    }
  }
}
