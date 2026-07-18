#!/usr/bin/env node
// 跨进程删除验证：进程 A 创建并持有会话（resident），进程 B（无 session，模拟 meta）删除它。
// 用法：node scripts/acp-delete-probe.mjs

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`

function connect(tag) {
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
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim()
    if (s) console.log(`[${tag}:stderr] ${s.slice(0, 150)}`)
  })
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
  const handshake = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: `probe-${tag}`, version: '0.1.0' },
      clientCapabilities: {},
      _meta: { clientType: 'desktop' }
    })
    await request('authenticate', { methodId: init._meta?.defaultAuthMethodId ?? 'cached_token' })
  }
  return { proc, request, handshake }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const A = connect('A')
  await A.handshake()
  const created = await A.request('session/new', { cwd: homedir(), mcpServers: [] })
  const sid = created.sessionId
  console.log(`A 创建并持有会话: ${sid}`)

  const B = connect('B')
  await B.handshake()

  try {
    const r = await B.request('_x.ai/session/delete', { sessionId: sid })
    console.log(`B 删除结果: ${JSON.stringify(r)}`)
  } catch (e) {
    console.log(`B 删除失败: ${e.message}`)
  }

  await sleep(800)
  const list = await B.request('_x.ai/sessions/list', {})
  const sessions = list?.result?.sessions ?? list?.sessions ?? []
  const stillThere = sessions.some((s) => s.sessionId === sid)
  console.log(stillThere ? `✗ 会话仍在列表中` : `✓ 会话已从列表消失`)

  A.proc.kill()
  B.proc.kill()
  process.exit(0)
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
}
