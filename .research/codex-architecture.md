# Codex 桌面端架构调研（本机实测）与 grok 对照

调研对象：用户本机 Codex CLI 0.142.5（npm 全局安装）、Codex.app 进程、
`codex app-server generate-ts/json-schema` 生成的官方协议绑定。

## 1. Codex 真实架构（进程拓扑）

```
┌─────────────┐   ┌──────────────┐   ┌─────────────────┐
│ Codex.app   │   │ VSCode 插件  │   │ codex TUI       │
│ (Electron   │   │              │   │ (--remote ws://)│
│  + 内嵌 node│   │              │   │                 │
│  kernel.js) │   │              │   │                 │
└──────┬──────┘   └──────┬───────┘   └────────┬────────┘
       │ JSON-RPC 2.0 over stdio / ws / unix socket
       └─────────────────┼────────────────────┘
                         ▼
              ┌─────────────────────┐
              │ codex app-server    │  ← 每个客户端 spawn 一个（stdio://），
              │ (Rust agent 核心)   │    或共享 daemon（unix/ws 监听 + proxy）
              └─────────────────────┘
```

- 桌面端 = Electron 壳（"Codex Framework" = 改名 Electron，crashpad 佐证）
  + 内置 node 运行时（Resources/cua_node）跑 kernel.js。
- **前后端完全分离**：UI 只是 app-server 的 JSON-RPC 客户端；CLI、VSCode 插件、
  桌面端共享同一后端协议（VSCode 插件也在本机 spawn 了 `codex app-server`）。
- 传输可选：`stdio://`（默认）、`unix://`、`ws://IP:PORT`；有 daemon 常驻模式
  （`app-server daemon` + `app-server proxy` 把 stdio 字节桥到控制 socket）。

## 2. 协议面（85 请求 + 67 通知 + 反向请求）

核心模型：**Thread → Turn → ThreadItem**（v2 命名空间）。

- 握手：`initialize`（clientInfo + capabilities）→ 客户端回 `initialized` 通知。
- 线程：`thread/start|resume|fork|archive|delete|list|read|rollback|name/set|compact/start`
  （list 支持游标分页 + cwd/archived/searchTerm 过滤；read includeTurns 拉全量历史）。
- 回合：`turn/start`（input: UserInput[] 支持 text/image/skill/mention）、`turn/interrupt`、
  `turn/steer`（回合中追加输入）、`review/start`。
- 流式通知：`turn/started|completed`、`item/started|completed`、
  `item/agentMessage/delta`、`item/reasoning/*Delta`、`item/commandExecution/outputDelta`、
  `turn/plan/updated`、`turn/diff/updated`（整回合聚合 unified diff）、
  `thread/tokenUsage/updated`（上下文用量条）、`error`。
- Item 类型：userMessage / agentMessage / reasoning / plan / commandExecution
  （command+cwd+exitCode+aggregatedOutput）/ fileChange（path+kind+unified diff）/
  mcpToolCall / webSearch / collabAgentToolCall / contextCompaction …
- 审批（服务端反向请求）：
  - `item/commandExecution/requestApproval` → accept / acceptForSession / decline / cancel
  - `item/fileChange/requestApproval` → 同上
  - `item/permissions/requestApproval`、`item/tool/requestUserInput`（结构化问答）
  - 策略：`AskForApproval = untrusted|on-failure|on-request|granular{...}|never`，
    `SandboxMode = read-only|workspace-write|danger-full-access`
- 辅助面：`fuzzyFileSearch`（@提及）、`model/list`、`account/login/start|logout|read`、
  `command/exec(/write/terminate/resize)`（独立 PTY，内嵌终端用）、`fs/*`（文件树）、
  `gitDiffToRemote`、`mcpServer*`、`skills/*`、`plugin/*`、`config/*`。
- 注意：**此版本协议中没有 automations/定时任务**（桌面端「已安排」是云端功能）。

## 3. grok ACP 对照映射（结论：覆盖度足够，可以对等实现）

| Codex app-server | grok（ACP 标准 / x.ai 扩展） | 差异说明 |
|---|---|---|
| initialize / initialized | `initialize`（protocolVersion 1） | 等价 |
| thread/start | `session/new`（_meta: rules/systemPromptOverride/agentProfile/modelId/yoloMode） | 等价 |
| thread/list | `x.ai/sessions/list`、`x.ai/session/search` | 扩展方法，等价 |
| thread/read(includeTurns) | `session/load`（重放 session/update）+ `x.ai/session/load_history`、`x.ai/session/updates` | 等价 |
| thread/fork | `x.ai/session/fork` | 等价 |
| thread/name/set | `x.ai/session/rename` | 等价 |
| thread/archive/delete | `x.ai/session/delete`（归档无对应） | 基本等价 |
| thread/rollback | `x.ai/rewind*`（grok 支持文件级回滚，更强） | grok 更强 |
| turn/start | `session/prompt` | 等价 |
| turn/interrupt | `session/cancel` | 等价 |
| turn/steer | `x.ai/interject` | 等价 |
| item/agentMessage/delta | `agent_message_chunk` | 等价 |
| item/reasoning/*Delta | `agent_thought_chunk` | 等价 |
| commandExecution + outputDelta | `tool_call`(kind=execute) + terminal content；声明 terminal 能力后 `terminal/output` 流式 | 等价 |
| fileChange（unified diff） | `tool_call`(kind=edit)，content: `{type:diff, path, oldText, newText}` | 形式不同（old/new 全文 vs unified diff），Monaco 均可渲染 |
| turn/diff/updated（聚合） | `x.ai/session/update: diff_review` | 等价 |
| turn/plan/updated | `plan` sessionUpdate | 等价 |
| thread/tokenUsage/updated | prompt 响应 `_meta`（totalTokens/inputTokens/...）+ `turn_completed` | 等价 |
| item/commandExecution/requestApproval | `session/request_permission`（options: allow-once / always-allow / reject-once） | 等价 |
| item/tool/requestUserInput | `x.ai/ask_user_question`（结构化问答，带选项） | 等价 |
| （Plan 审批） | `x.ai/exit_plan_mode` | grok 特有，Codex 用 review 模式近似 |
| fuzzyFileSearch（@提及） | `x.ai/search/*` | 等价 |
| model/list | initialize `_meta.modelState` / session/new 响应 `models`；`session/set_model` 切换 | 等价 |
| command/exec（独立 PTY） | `x.ai/terminal/*`（agent 侧终端管理） | 等价；用户内嵌终端也可纯 node-pty 本地实现 |
| account/login/* | `authenticate` + `x.ai/auth/*`（get_url/submit_code/logout/info） | 等价 |
| fs/* | `x.ai/fs/*` | 等价 |
| gitDiffToRemote | `x.ai/git/*`、`x.ai/git/worktree/*` | grok 更细 |
| automations（无） | `x.ai/scheduler/*` | grok 有，Codex 协议无 → 「已安排」可做 |
| daemon/共享后端 | `grok agent serve --bind 127.0.0.1:2419 --secret <token>` + leader 模式 | 等价（我们默认 --no-leader 每线程一进程） |
