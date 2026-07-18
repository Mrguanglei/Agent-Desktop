import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { PtyEvent, PtyTabInfo } from '../shared/types'

interface PtyEntry {
  proc: IPty
  info: PtyTabInfo
  buffer: string
  exitCode: number | null
  exitSignal: string | null
  waiters: { resolve: (v: { exitCode: number | null; signal: string | null }) => void }[]
}

const MAX_BUFFER = 512 * 1024

/**
 * PTY 管理器：用户内嵌终端 + grok ACP terminal/* 反向请求的宿主。
 * 与 grok 集成零 ANSI 解析——用户终端是独立 shell；
 * agent 终端经 ACP 协议（terminal/create|output|wait_for_exit|release|kill）驱动。
 */
export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  constructor(private readonly emit: (ev: PtyEvent) => void) {}

  /** 用户 shell 终端（默认登录 shell） */
  createUser(cwd: string, cols: number, rows: number): PtyTabInfo {
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    return this.spawn({
      file: shell,
      args: ['-l'],
      cwd,
      cols,
      rows,
      kind: 'user',
      title: shell.split('/').pop() ?? 'shell'
    })
  }

  /** ACP terminal/create：agent 要求 client 执行命令，返回 terminalId */
  createAgent(opts: { command: string; args: string[]; cwd?: string; threadId?: string }): string {
    const info = this.spawn({
      file: opts.command,
      args: opts.args,
      cwd: opts.cwd ?? homedir(),
      cols: 120,
      rows: 30,
      kind: 'agent',
      title: `${opts.command} ${opts.args.join(' ')}`.slice(0, 60),
      threadId: opts.threadId
    })
    return info.id
  }

  private spawn(opts: {
    file: string
    args: string[]
    cwd: string
    cols: number
    rows: number
    kind: 'user' | 'agent'
    title: string
    threadId?: string
  }): PtyTabInfo {
    const id = randomUUID()
    const proc = ptySpawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: process.env as Record<string, string>
    })
    const info: PtyTabInfo = { id, title: opts.title, kind: opts.kind, threadId: opts.threadId }
    const entry: PtyEntry = { proc, info, buffer: '', exitCode: null, exitSignal: null, waiters: [] }
    this.ptys.set(id, entry)

    proc.onData((data) => {
      entry.buffer += data
      if (entry.buffer.length > MAX_BUFFER) entry.buffer = entry.buffer.slice(-MAX_BUFFER)
      this.emit({ kind: 'data', id, data })
    })
    proc.onExit(({ exitCode, signal }) => {
      entry.exitCode = exitCode
      entry.exitSignal = signal != null ? String(signal) : null
      for (const w of entry.waiters.splice(0)) {
        w.resolve({ exitCode, signal: entry.exitSignal })
      }
      this.emit({ kind: 'exit', id, exitCode })
    })
    this.emit({ kind: 'meta', tab: info })
    return info
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.proc.resize(cols, rows)
    } catch {
      /* 进程已退出时忽略 */
    }
  }

  dispose(id: string): void {
    const e = this.ptys.get(id)
    if (!e) return
    try {
      e.proc.kill()
    } catch {
      /* 已退出 */
    }
    for (const w of e.waiters.splice(0)) w.resolve({ exitCode: e.exitCode, signal: e.exitSignal })
    this.ptys.delete(id)
  }

  disposeAll(): void {
    for (const id of [...this.ptys.keys()]) this.dispose(id)
  }

  /** ACP terminal/output：返回累计输出（末尾截断保留）与退出状态 */
  output(id: string): {
    output: string
    truncated: boolean
    exitStatus?: { exitCode: number | null; signal: string | null }
  } {
    const e = this.ptys.get(id)
    if (!e) return { output: '', truncated: false }
    if (e.exitCode !== null) {
      return {
        output: e.buffer,
        truncated: false,
        exitStatus: { exitCode: e.exitCode, signal: e.exitSignal }
      }
    }
    return { output: e.buffer, truncated: false }
  }

  /** ACP terminal/wait_for_exit */
  waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const e = this.ptys.get(id)
    if (!e) return Promise.resolve({ exitCode: null, signal: null })
    if (e.exitCode !== null) {
      return Promise.resolve({ exitCode: e.exitCode, signal: e.exitSignal })
    }
    return new Promise((resolve) => e.waiters.push({ resolve }))
  }
}
