# WorkBuddy 总架评审（对 8 层架构图）

> 评审对象：《WorkBuddy 全局端到端架构》图（8 层：用户入口/前端桌面壳/通信网关/Agent 引擎/
> Harness 编排/后端服务/模型底座/数据与安全）。结论：**分层逻辑正确，与已实现系统基本同构；
> 有 4 个必须澄清的决策点 + 2 个缺口**。2026-07-19。

## 一、逐层对照（现状实现 vs 图）

| 层 | 图上内容 | 已建成现状 | 判定 |
|---|---|---|---|
| ① 用户入口 | 桌面工作台 / IM直联 / 小程序 / 云端沙箱 | 桌面工作台 ✅（grok-desktop）；其余为路线图 | ✅ 正确，标注阶段 |
| ② 前端桌面壳 | Electron 41 / Chromium / **VS Code Fork** / Monaco / **Ghostty** | Electron + React + Monaco + xterm.js(node-pty) ✅ | ⚠️ 决策点 1 |
| ③ 通信 | IPC / stdio / HTTP / WebSocket | **ACP**(stdio JSON-RPC) + Electron IPC + WebSocket ✅ | ⚠️ 决策点 2 |
| ④ Agent 引擎 | @genie/cli / CellJS / OpenAI Ag / Ink+React19 / Agent Loop | **grok CLI（Rust，ACP 协议，84 万行）** ✅ | ❌ 决策点 3（最重要） |
| ⑤ Harness 编排 | 意图路由 / 渐进加载 / 多模型路由 / Teams / Skills·MCP / 30+工具 | grok 内置 Skills/MCP/30+工具/subagent；模型路由=网关职责 | ⚠️ 决策点 4 |
| ⑥ 后端服务层 | 主网关 / 模型路由 / Credits / 用量告警 / RBAC / 审计 | workbuddy-backend MVP ✅（网关+目录合并+透传）；其余=V1/V2 | ✅ 与设计文档一致 |
| ⑦ 模型底座 | 混元 / DeepSeek / GLM / Kimi / MiniMax / Ollama | 当前=xAI 上游透传；多模型路由=网关 V1 | ✅ Model Agnostic=网关职责 |
| ⑧ 数据与安全 | SQLite / 三层记忆 / **腾讯网盘** / TSbx沙箱 / 权限管控 | settings.json；SQLite=R5；grok 有记忆/沙箱 | ⚠️ "腾讯网盘"→对象存储（COS/S3 兼容） |

## 二、四个必须澄清的决策点

### 1. ② VS Code Fork 与 Electron 自研壳：二选一，不是并列
- 现状：已走 Electron 自研壳（任务为中心，Codex 桌面端同形态），端到端可用。
- Fork VS Code = 编辑器为中心的另一条产品线，与现路线互斥。**从图中删除**。
- Ghostty 同样多余：内嵌终端已用 xterm.js + node-pty 实现（含 ACP terminal 桥）。

### 2. ③ "通信网关层"与 ⑥"主网关"撞名
- ③ 所列 IPC/stdio/HTTP/WS 是**进程间通信协议**，不是网关服务。
- 改名「**通信协议层**」，并显式写入 **ACP**（Agent Client Protocol over stdio NDJSON）——
  它是前端壳 ⇄ Agent 引擎的解耦核心，不只是 "stdio"。

### 3. ④ 引擎选型：grok CLI，不是 Node 系自研（全图最重要的决策）
- 图上 @genie/cli、CellJS、Ink+React19 意味着自研 agent 引擎（agent 主循环 + 工具集 +
  权限系统，数月级项目）。
- 现实：grok CLI 已作引擎端到端跑通（ACP 协议、Skills/MCP/工具/沙箱/企业管控内置）。
- **结论：④ = grok CLI（Agent 引擎，Rust / ACP）**。自研引擎仅作为 grok 不满足时的远期选项。

### 4. ⑤ Harness 编排层职责重叠 → 坍塌并入 ④/⑥
- Skills、MCP、30+工具、Teams（subagent）：**grok 引擎内置**。
- 多模型路由：**⑥ 网关职责**（上游路由/降级）。
- 意图路由：引擎内 model routing 或网关上游选择，二选一归属。
- **结论：⑤ 不作为独立服务层存在**，能力 = ④ 引擎内置 + ⑥ 网关路由。保留它会诱导造出
  与 grok 抢活干的中间件。

## 三、两个缺口（企业级必须补入图中）

1. **身份中心**（SSO/OIDC + SCIM + 组织/工作区/角色）——与 ⑥ RBAC 并列或单独成框。
   「登录自己的后端」的核心，方案见 `enterprise-backend-design.md` §4.1。
2. **策略下发**（客户端管控：`/v1/deployment/config`，Ed25519 签名 + fail-closed）——
   grok 客户端已内置支持，后端实现即可管控模型白名单/禁 yolo/端点钉死。见 §4.4。

## 四、修正后的架构（定稿版）

```
用户入口      桌面工作台✅ ─ IM 直联(V3) ─ 小程序(V3) ─ 云端沙箱(V3)
                 │
前端壳        Electron + React + Monaco + xterm.js ✅
                 │
通信协议层    ACP(stdio NDJSON JSON-RPC) ✅ ─ Electron IPC ✅ ─ WebSocket(预留)
                 │
Agent 引擎    grok CLI（Rust）✅ 〔Agent Loop / Skills / MCP / 30+工具 / subagent / 沙箱〕
                 │
后端服务      workbuddy-backend（cli-chat-proxy 兼容契约）MVP✅
               ├─ 模型网关：/v1/responses、/v1/models(目录+ETag)、上游路由/降级
               ├─ 身份中心：OIDC 验签 + 组织/工作区/角色/Key（V1）
               ├─ 配额计费：计量流水 + 层级限额 + 402 语义（V1）
               ├─ 策略下发：/v1/deployment/config 签名包（V2）
               └─ 审计合规：事件流 + Compliance API（V2）
                 │
模型底座      xAI ✅ ─ 混元 / DeepSeek / GLM / Kimi / MiniMax / Ollama（V1 起按网关路由）
                 │
数据与安全    SQLite(R5) ─ grok 记忆体系 ─ 对象存储(COS/S3 兼容) ─ 权限管控/沙箱✅
```

本地侧：入口 + 壳 + 协议 + 引擎 + 本地数据（桌面 + CLI 进程）。
云端侧：后端服务 + 模型底座（自有网关 + 模型服务）。

## 五、落地路线（与现状对齐）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 桌面端 R1-R4 | 真实 ACP 对话/会话/权限/Plan 审批/终端/@提及/设置中心 | ✅ 已完成 |
| 网关 MVP | 透传 + 目录合并 + 全端点透明 | ✅ 已完成 |
| 前后端自动接入 | desktop 探测并静默接入本地网关 | ✅ 已完成 |
| 后端 V1 | 身份中心（OIDC）+ 组织/角色 + 计量限额（402） | ⬜ 下一个 |
| 后端 V2 | 策略签名下发 + 审计事件流 + SCIM | ⬜ |
| 桌面端 R5 | Markdown/sqlite/打包捆绑 grok | ⬜ |
| V3 | IM/小程序入口、domain capture、ZDR、SOC2 | ⬜ |
