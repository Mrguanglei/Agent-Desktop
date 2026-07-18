#!/usr/bin/env node
// 验证：不建 session 的连接上，sessions/list、auth/info、fuzzy 是否可用。
// 若可用，meta client 就不再需要 session/new（消灭空会话污染源）。

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

const check = async (name, fn) => {
  try {
    const r = await fn()
    console.log(`✓ ${name}: OK ${JSON.stringify(r).slice(0, 120)}`)
  } catch (e) {
    console.log(`✗ ${name}: ${e.message.slice(0, 150)}`)
  }
}

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'probe', version: '0.1.0' },
    clientCapabilities: {},
    _meta: { clientType: 'desktop' }
  })
  await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })
  console.log('握手完成（未建 session）')

  await check('auth/info', () => request('_x.ai/auth/info'))
  await check('billing', () => request('_x.ai/billing'))
  await check('sessions/list', () => request('_x.ai/sessions/list', {}))
  await check('fuzzy/open', () => request('_x.ai/search/fuzzy/open', { cwd: homedir() }))
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
