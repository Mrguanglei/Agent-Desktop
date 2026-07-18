# grok-desktop

Grok Build（`grok` CLI）的桌面客户端，对标 Codex 桌面端：多线程任务列表、流式对话、Diff 审查、Plan 审批、内嵌终端（后续）。

## 集成方式（硬性约束）

- **主用 ACP 协议**：Electron 主进程 spawn `grok agent --no-leader stdio`，走 NDJSON / JSON-RPC 2.0（`src/main/acp/`）。
- **辅用 headless streaming-json**：`grok -p ... --output-format streaming-json`（后续按需补充，事件面是 ACP 子集，可直接复用现有归一化事件）。
- 禁止 node-pty 抓 TUI / 解析 ANSI。node-pty 仅用于面向用户的内嵌终端（Phase 4）。
- 不修改 grok 源码。

## 后端分发模型（对标 Codex 的实锤调研结论）

Codex 桌面端把 260MB 的 agent 二进制捆绑在 ChatGPT.app/Contents/Resources/ 内，
GUI 直接 spawn 包内二进制；VSCode 插件也捆绑独立副本；npm 装的 CLI 是第三条通道。
三者共享 `~/.codex/auth.json` 登录态。我们照搬这套：

| 阶段 | 模式 | 说明 |
|---|---|---|
| 开发期（现在） | spawn 系统已装 grok | `~/.grok/bin/grok`，随 grok 自更新，登录态零配置共享 |
| 打包分发（R5） | 捆绑二进制 | electron-builder extraResources 把 `grok-macos-aarch64` 拷入 `Contents/Resources/grok-bin/grok`，spawn 优先级：env > 捆绑 > PATH/常见路径（代码已就绪） |
| 后续增强 | 首启下载/热更 | 用 x.ai/cli 版本端点检查更新，下载到 App Support 目录（捆绑版在只读包内无法自更新） |

鉴权不受分发模式影响：任何路径的 grok 都读写同一份 `~/.grok/auth.json`。

## 运行

```sh
npm install
npm run dev
```

后端自动探测：

- PATH 中找到 `grok` → 真实 ACP 后端（窗口右上角显示 **ACP · grok**）
- 未找到 → **Mock 后端**，回放脚本化事件流，用于 UI 开发（无需安装 grok / 无需 API Key）

环境变量：

| 变量 | 说明 |
|---|---|
| `GROK_DESKTOP_BACKEND=mock` | 强制 Mock（即使已安装 grok） |
| `GROK_BIN=/path/to/grok` | 指定 grok 二进制路径 |

鉴权：真实后端会先尝试 `cached_token`（即本机 `~/.grok/auth.json` 已登录态），失败时提示 `grok login` 或设置 `XAI_API_KEY`。

## 目录结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts           # 窗口、生命周期
│   ├── backend.ts         # 后端管理器（每线程一个后端，事件归一化出口）
│   ├── ipc.ts             # ipcMain.handle 注册
│   └── acp/
│       ├── agent-backend.ts   # AgentBackend 接口 + BackendSink
│       ├── connection.ts      # NDJSON JSON-RPC 2.0 传输层（自研，含 x.ai/* 扩展余地）
│       ├── grok-backend.ts    # 真实 ACP：spawn grok agent --no-leader stdio
│       └── mock-backend.ts    # Mock：脚本化回放完整事件流
├── preload/
│   ├── index.ts           # contextBridge 暴露 window.grok
│   └── index.d.ts         # 全局类型声明
├── shared/
│   └── types.ts           # 三端共享：IPC 契约 + 归一化事件 + 领域模型
└── renderer/              # React 18 + Zustand + Tailwind
    └── src/
        ├── App.tsx            # 布局：标题栏 / 侧栏 / 主区 / 状态栏
        ├── monaco-setup.ts    # Monaco 离线打包 + worker
        ├── stores/            # app-store（线程/后端状态）、chat-store（消息流）
        └── components/        # ThreadList / ChatView / DiffView / Composer / PermissionDialog
```

## ACP 事件映射（依据 grok-build 源码调研）

| grok ACP 事件 | 归一化事件 | UI |
|---|---|---|
| `session/update: agent_message_chunk` | `text_chunk` | 正文流式渲染 |
| `agent_thought_chunk` | `thought_chunk` | 可折叠「思考过程」 |
| `tool_call` / `tool_call_update`（content 含 diff/terminal） | `tool_call(_update)` | 工具卡片 + Monaco DiffEditor |
| `plan` | `plan` | 顶部计划面板 |
| `current_mode_update` | `mode_changed` | 标题栏 mode 徽章 |
| `session/request_permission`（反向请求） | `permission_request` | 权限弹窗（allow/always/reject） |
| `session/prompt` 响应 `_meta`（totalTokens/modelId/...） | `turn_end` | usage 展示 |
| `x.ai/session/update`（约 40 种扩展更新） | —（一期忽略，按需映射） | — |
| `x.ai/ask_user_question`、`x.ai/exit_plan_mode`（反向请求） | —（二期） | Plan 审批 / 交互提问 |

## 路线图

- [x] R0：grok 安装 + `grok login` 鉴权
- [x] R1：真实 ACP 对话（initialize → authenticate → session/new → session/prompt；流式正文/思考/工具卡片/Diff/权限弹窗）
- [x] R1.5：真实模型选择器（session/set_model + models/update 同步）、真实账号菜单（_x.ai/auth/info + billing + logout）
- [x] R2：真实会话列表（_x.ai/sessions/list 按 cwd 分组）+ session/load 历史回放（isReplay 事件流）
- [x] R2.5：会话重命名/删除（_x.ai/session/rename|delete）；工具卡片真实 diff 统计 +N -N
- [ ] R3：Plan 审批（_x.ai/exit_plan_mode）、结构化问答（_x.ai/ask_user_question）、聚合变更面板（diff_review）、reasoning effort 选择（grok-4.5 high/medium/low）
- [ ] R4：内嵌终端（xterm.js + node-pty 或 _x.ai/terminal/*）、@文件提及（_x.ai/search/*）
- [ ] R5：打磨（Markdown 渲染、sqlite 缓存）与 macOS 打包（捆绑 grok 二进制，见上文分发模型）
