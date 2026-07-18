#!/usr/bin/env node
// ACP 握手冒烟测试：用与 src/main/acp/grok-backend.ts 完全相同的消息序列
// 直连真实 `grok agent --no-leader stdio`，验证 initialize → authenticate
// → session/new → session/prompt 全链路。不依赖任何 npm 包。
// 用法：node scripts/acp-smoke.mjs [prompt]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const GROK_BIN = process.env['GROK_BIN'] ?? `${homedir()}/.grok/bin/grok`
const PROMPT = process.argv[2] ?? '用一句话介绍你自己'

let nextId = 1
const pending = new Map()

const proc = spawn(GROK_BIN, ['agent', '--no-leader', 'stdio'], {
  cwd: homedir(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})

function send(msg) {
  const line = JSON.stringify(msg)
  console.log(`\x1b[90m→ ${line.slice(0, 160)}\x1b[0m`)
  proc.stdin.write(line + '\n')
}
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

proc.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (line.trim()) console.log(`\x1b[33m[stderr] ${line.slice(0, 200)}\x1b[0m`)
  }
})
proc.on('exit', (code, signal) => {
  console.log(`\x1b[31m[exit] code=${code} signal=${signal}\x1b[0m`)
  process.exit(code ?? 1)
})

const rl = createInterface({ input: proc.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    console.log(`\x1b[90m[non-json] ${line.slice(0, 120)}\x1b[0m`)
    return
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
    return
  }
  if (msg.id !== undefined && msg.method) {
    console.log(`\x1b[35m[request] ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}\x1b[0m`)
    if (msg.method === 'session/request_permission') {
      send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'not implemented in smoke' }
      })
    }
    return
  }
  if (msg.method) {
    // notification：只打印摘要（带到达时间戳，验证是否实时流式）
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const u = msg.params?.update ?? msg.params
    const kind = u?.sessionUpdate ?? ''
    let brief = ''
    if (kind === 'agent_message_chunk') brief = u.content?.text ?? ''
    else if (kind === 'agent_thought_chunk') brief = `\x1b[90m${u.content?.text ?? ''}\x1b[0m`
    else brief = JSON.stringify(u).slice(0, 150)
    process.stdout.write(
      kind.includes('chunk')
        ? `\x1b[36m[${elapsed}s]\x1b[0m` + brief
        : `\n\x1b[36m[${elapsed}s ${msg.method}${kind ? ':' + kind : ''}]\x1b[0m ${brief}\n`
    )
  }
})

const t0 = Date.now()
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'grok-desktop-smoke', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { clientType: 'desktop' }
  })
  console.log(`\n\x1b[32m✓ initialize\x1b[0m protocolVersion=${init.protocolVersion}`)
  console.log(`  authMethods=${JSON.stringify(init.authMethods?.map((m) => m.id ?? m.methodId))}`)
  console.log(
    `  defaultAuthMethodId=${init._meta?.defaultAuthMethodId} agentVersion=${init._meta?.agentVersion}`
  )

  const methodId = init._meta?.defaultAuthMethodId ?? 'cached_token'
  await request('authenticate', { methodId })
  console.log(`\x1b[32m✓ authenticate (${methodId})\x1b[0m`)

  const session = await request('session/new', { cwd: homedir(), mcpServers: [] })
  console.log(`\x1b[32m✓ session/new\x1b[0m sessionId=${session.sessionId}`)
  console.log(
    `  models=${JSON.stringify(session.models?.availableModels?.map((m) => m.modelId ?? m.id) ?? session.models).slice(0, 200)}`
  )

  console.log(`\x1b[90m--- prompt: ${PROMPT} ---\x1b[0m`)
  const resp = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: PROMPT }]
  })
  console.log(`\n\x1b[32m✓ session/prompt\x1b[0m stopReason=${resp.stopReason}`)
  console.log(
    `  usage=${JSON.stringify(resp._meta?.usage ?? { totalTokens: resp._meta?.totalTokens })}`
  )
  console.log(`\x1b[32m全部通过 (${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m`)
  proc.kill()
  process.exit(0)
} catch (err) {
  console.log(`\n\x1b[31m✗ 失败: ${err.message}\x1b[0m`)
  proc.kill()
  process.exit(1)
}
