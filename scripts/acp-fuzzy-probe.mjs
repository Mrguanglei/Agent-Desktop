#!/usr/bin/env node
// 探测 _x.ai/search/fuzzy/open|change|close 与 fuzzy/status 通知的真实载荷。
// 用法：node scripts/acp-fuzzy-probe.mjs [cwd] [query]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
const CWD = process.argv[2] ?? '/Users/guanglei/Desktop/个人学习/workbudy/grok-desktop'
const QUERY = process.argv[3] ?? 'backend'

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
  if (msg.method?.includes('fuzzy')) {
    console.log(`\n[${msg.method}]`)
    console.log(JSON.stringify(msg.params, null, 1).slice(0, 2500))
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'probe', version: '0.1.0' },
    clientCapabilities: {},
    _meta: { clientType: 'desktop' }
  })
  await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })

  const opened = await request('_x.ai/search/fuzzy/open', { cwd: CWD })
  console.log(`[open] ${JSON.stringify(opened)}`)
  const searchId = opened?.searchId ?? opened?.result?.searchId

  await request('_x.ai/search/fuzzy/change', { searchId, query: QUERY, limit: 10 })
  console.log(`[change sent] query=${QUERY}，等待 status 通知…`)
  await sleep(4000)

  await request('_x.ai/search/fuzzy/close', { searchId })
  console.log('[closed]')
  proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  proc.kill()
  process.exit(1)
}
