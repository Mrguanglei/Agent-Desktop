#!/usr/bin/env node
// 探测 session/load 的历史回放事件序列。
// 用法：node scripts/acp-load-probe.mjs [sessionId]（不给则自动取列表里第一个有 title 的）

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
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
    send({ jsonrpc: '2.0', id, method, params })
  })
}
proc.stderr.on('data', () => {})

let notifCount = 0
let loadDone = false
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
    return
  }
  if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe' } })
    return
  }
  if (msg.method && loadDone === false) {
    notifCount++
    if (notifCount > 80) return
    const u = msg.params?.update ?? msg.params ?? {}
    const kind = u.sessionUpdate ?? ''
    const replay = u._meta?.isReplay ?? msg.params?._meta?.isReplay
    let brief = ''
    if (kind.includes('chunk')) brief = (u.content?.text ?? '').slice(0, 60).replace(/\n/g, '⏎')
    else if (kind === 'tool_call' || kind === 'tool_call_update')
      brief = `${u.title ?? u.toolCallId ?? ''} status=${u.status ?? ''}`
    else brief = JSON.stringify(u).slice(0, 100)
    console.log(
      `[${String(notifCount).padStart(3)}] ${msg.method}${kind ? ':' + kind : ''}${replay ? ' (replay)' : ''} ${brief}`
    )
  }
})

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'probe', version: '0.1.0' },
    clientCapabilities: {},
    _meta: { clientType: 'desktop' }
  })
  await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })

  let sessionId = process.argv[2]
  let cwd = homedir()
  if (!sessionId) {
    const list = await request('_x.ai/sessions/list', {})
    const sessions = list?.result?.sessions ?? list?.sessions ?? []
    const withTitle = sessions.find((s) => s.title) ?? sessions[0]
    sessionId = withTitle.sessionId
    cwd = withTitle.cwd
    console.log(`自动选择会话: ${sessionId} title=${withTitle.title} cwd=${cwd}\n`)
  }

  console.log(`--- session/load ${sessionId} ---`)
  const resp = await request('session/load', { sessionId, cwd, mcpServers: [] })
  loadDone = true
  console.log(`\n--- load 响应 (${notifCount} 条回放通知后返回) ---`)
  console.log(JSON.stringify(resp, null, 2).slice(0, 1500))
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
