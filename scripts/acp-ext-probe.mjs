#!/usr/bin/env node
// 探测 grok ACP 扩展方法的真实返回结构。
// 用法：node scripts/acp-ext-probe.mjs <method> [paramsJSON]
//   例：node scripts/acp-ext-probe.mjs x.ai/auth/info
//       node scripts/acp-ext-probe.mjs session/set_model '{"modelId":"grok-4.5"}'  (自动带 sessionId)

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
const METHOD = process.argv[2]
const EXTRA = process.argv[3] ? JSON.parse(process.argv[3]) : {}
if (!METHOD) {
  console.error('usage: node scripts/acp-ext-probe.mjs <method> [paramsJSON]')
  process.exit(2)
}

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
proc.stderr.on('data', () => {}) // 静默
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
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'probe: not impl' } })
  }
})

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'grok-desktop-probe', version: '0.1.0' },
    clientCapabilities: {},
    _meta: { clientType: 'desktop' }
  })
  await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })
  const session = await request('session/new', { cwd: homedir(), mcpServers: [] })

  const params = { ...EXTRA }
  if (METHOD.startsWith('session/') || EXTRA['sessionId'] === '$auto') params['sessionId'] = session.sessionId

  const result = await request(METHOD, params)
  console.log(JSON.stringify(result, null, 2).slice(0, 4000))
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
