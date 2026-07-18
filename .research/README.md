# 调研档案

本目录存放对标调研的原始资料：

- `codex-app-server-ts/`：OpenAI Codex CLI 0.142.5 通过 `codex app-server generate-ts`
  生成的官方 TypeScript 协议绑定（87 个文件），即 Codex 桌面端 / VSCode 插件
  与 `codex app-server` 后端之间 JSON-RPC 协议的完整类型定义。
- `codex-app-server-schema/`：同协议的 JSON Schema 版本。
- `codex-architecture.md`：Codex 桌面端架构调研结论 + 与 grok ACP 的功能映射表。

重新生成：`codex app-server generate-ts --out ./codex-app-server-ts`
