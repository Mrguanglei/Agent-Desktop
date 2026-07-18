# workbuddy-backend

WorkBuddy 企业级后端（MVP 骨架）。实现 **cli-chat-proxy 兼容契约**，grok CLI / grok-desktop
零改动接入。设计文档见 `../.research/enterprise-backend-design.md`。

## MVP 已实现

| 端点 | 行为 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /v1/models` | 模型目录：网关自有条目（`models.json`，热加载）+ 上游目录合并，ETag 直通 |
| `POST /v1/responses` | 推理主路径：SSE 流式透传上游（凭证头透传） |
| `POST /v1/chat/completions` | OpenAI 兼容路径：透传 |
| `GET /v1/user` | 用户资料：透传，上游不可达时本地兜底 |
| `GET /v1/billing` | 额度：透传，兜底返回超大额度（开发不卡 402） |
| `GET /v1/settings` | 访问门：直接放行 |

## 运行

```sh
cd backend
npm install
npm run dev        # http://127.0.0.1:8399
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8399` / `127.0.0.1` | 监听地址 |
| `UPSTREAM_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | 上游模型服务 |
| `PASSTHROUGH_AUTH` | `1` | 是否透传客户端凭证头给上游 |

## 把 grok 指向本网关

```sh
# grok CLI / 探针脚本
GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:8399/v1 grok

# grok-desktop：settings 后续加「后端地址」配置页（V1）
```

## 路线图

- MVP（当前）：透传网关 + 目录合并 + 健康检查
- V1：身份中心（OIDC 验签）、组织/工作区/角色模型、计量流水 + 层级限额（402 语义）
- V2：`/v1/deployment/config` Ed25519 签名策略下发、审计事件流、SCIM
