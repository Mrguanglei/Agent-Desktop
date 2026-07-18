#!/usr/bin/env node
// 真实编辑探针：自动放行权限，让 grok 真的创建/修改文件，
// 完整打印 tool_call 内容块结构、diff_review 聚合变更等事件的真实形态。
// 用法：node scripts/acp-edit-probe.mjs [prompt]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
const PROMPT =
  process.argv[2] ?? '创建文件 probe-hello.txt，内容为 hello grok，创建后不用做任何其他事'
const MODE = process.argv[3] // 可选：plan / ask / default
const CWD = '/tmp'

let nextId = 1
const pending = new Map()
const proc = spawn(GROK_BIN, ['agent', '--no-leader', 'stdio'], {
  cwd: CWD,
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

const INTERESTING = new Set([
  'session/update',
  '_x.ai/session/update',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/prompt_complete'
])
let promptDone
const done = new Promise((r) => (promptDone = r))

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
    if (msg.method === 'session/request_permission') {
      // 自动放行：选第一个 allow 选项，并打印完整请求结构
      console.log(`\n[permission] ${JSON.stringify(msg.params).slice(0, 500)}`)
      const opts = msg.params?.options ?? []
      const allow = opts.find((o) => o.kind?.startsWith('allow'))
      console.log(`[permission] → auto ${allow?.optionId}\n`)
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: allow
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      })
    } else {
      console.log(`\n[agent-request] ${msg.method} ${JSON.stringify(msg.params).slice(0, 1500)}`)
      if (msg.method.includes('exit_plan_mode')) {
        console.log('[agent-request] → respond {"outcome":"approved"}')
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'approved' } })
      } else if (msg.method.includes('ask_user_question')) {
        console.log('[agent-request] → respond {"outcome":"cancelled"}')
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'cancelled' } })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe' } })
      }
    }
    return
  }
  if (msg.method) {
    if (!INTERESTING.has(msg.method)) return
    const u = msg.params?.update ?? msg.params ?? {}
    const kind = u.sessionUpdate ?? ''
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') return // 正文不打印
    if (kind === 'user_message_chunk' || kind === 'available_commands_update') return
    console.log(`\n[${msg.method}${kind ? ':' + kind : ''}]`)
    console.log(JSON.stringify(msg.params, null, 1).slice(0, 1200))
    if (msg.method === '_x.ai/session/prompt_complete') promptDone()
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
  const session = await request('session/new', { cwd: CWD, mcpServers: [] })
  console.log(`session=${session.sessionId} prompt=${PROMPT}`)
  if (MODE) {
    try {
      const r = await request('session/set_mode', { sessionId: session.sessionId, modeId: MODE })
      console.log(`[set_mode ${MODE}] ${JSON.stringify(r).slice(0, 300)}`)
    } catch (e) {
      console.log(`[set_mode ${MODE}] ERROR: ${e.message}`)
    }
  }
  const respP = request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: PROMPT }]
  })
  await Promise.race([done, new Promise((r) => setTimeout(r, 180_000))])
  const resp = await respP
  console.log(`\n[prompt response] stopReason=${resp.stopReason}`)
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
