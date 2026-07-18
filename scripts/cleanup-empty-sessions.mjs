#!/usr/bin/env node
// 清理空会话：扫描 ~/.grok/sessions/*\/*\/summary.json，删除 num_messages === 0 的会话。
// 这些大多是探测/meta 预热产生的无内容会话。用法：node scripts/cleanup-empty-sessions.mjs [--dry]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
const SESSIONS_ROOT = join(homedir(), '.grok/sessions')
const DRY = process.argv.includes('--dry')

// 1. 找空会话
const empty = []
for (const cwdDir of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
  if (!cwdDir.isDirectory()) continue
  const cwdPath = join(SESSIONS_ROOT, cwdDir.name)
  for (const sessDir of readdirSync(cwdPath, { withFileTypes: true })) {
    if (!sessDir.isDirectory()) continue
    const summaryPath = join(cwdPath, sessDir.name, 'summary.json')
    if (!existsSync(summaryPath)) continue
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
      const num = summary.num_messages ?? summary.numMessages ?? null
      if (num === 0) {
        empty.push({ sessionId: sessDir.name, cwdDir: cwdDir.name })
      }
    } catch {
      /* 无法解析的跳过 */
    }
  }
}
console.log(`发现 ${empty.length} 个空会话（num_messages=0）`)
if (DRY || empty.length === 0) {
  for (const e of empty.slice(0, 20)) console.log(`  [dry] ${e.sessionId} @ ${e.cwdDir}`)
  process.exit(0)
}

// 2. 连接并逐个删除
let nextId = 1
const pending = new Map()
const proc = spawn(GROK_BIN, ['agent', '--no-leader', 'stdio'], {
  cwd: homedir(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})
const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n')
const request = (method, params) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params: params ?? {} })
  })
}
proc.stderr.on('data', () => {})
createInterface({ input: proc.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    }
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe' } })
  }
})

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'cleanup', version: '0.1.0' },
    clientCapabilities: {},
    _meta: { clientType: 'desktop' }
  })
  await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })

  let ok = 0
  let fail = 0
  for (const e of empty) {
    try {
      await request('_x.ai/session/delete', { sessionId: e.sessionId })
      ok++
    } catch (err) {
      fail++
      console.log(`  ✗ ${e.sessionId}: ${err.message.slice(0, 80)}`)
    }
  }
  console.log(`已删除 ${ok}/${empty.length} 个空会话${fail ? `，失败 ${fail}` : ''}`)
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
