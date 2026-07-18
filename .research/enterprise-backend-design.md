# WorkBuddy 企业级后端设计（调研 + 架构）

> 调研对象：OpenAI ChatGPT Enterprise / Codex、Anthropic Claude Enterprise / Claude Code、
> xAI Grok Build（源码级）。目标：为 WorkBuddy 设计「认证组织管理 + 模型网关 + 权限配额
> + 客户端管控 + 审计合规」的企业级后端。2026-07。

---

## 一、三家对标结论（一页速览）

| 维度 | OpenAI (ChatGPT Ent / Codex) | Anthropic (Claude Ent / Claude Code) | xAI (Grok Build) |
|---|---|---|---|
| 组织层级 | Workspace（扁平）→（API 平台：Org→Project→ServiceAccount） | Org（父子组织）→ Workspace（≤100） | Team → Organization（auth 主体三层：principal/team/org） |
| 认证 | SAML/OIDC SSO + 域名验证 + SCIM（WorkOS） | SAML/OIDC SSO + SCIM/JIT + **domain capture**（30 天迁移窗口） | OIDC SSO（自有 IdP）/ xAI OAuth / 外部 provider 命令 / deployment key |
| 角色 | Owner/Admin/Member + **自定义 RBAC**（能力逐项开关，经组赋权，additive） | Primary Owner/Owner/Admin/User + **自定义角色**（总闸→角色→组→成员取最严） | team_role / organization_role（服务端下发） |
| 模型控制 | Project 级 model allowlist + 按模型 rate limit | `availableModels` 托管锁 + ZDR 服务端禁模型 | requirements `allowed_models/hidden_models/disabled_models`（glob） |
| 配额计费 | 席位 + credits 双轨；5h 滚动窗 + 周上限；**超限跑完当前 turn，可买 credits 续** | 每 workspace 月 spend limit（硬阻断）+ 按组每用户月度 cap | 统一计费池，402=池耗尽；`/billing` credits 制（美分）；auto-topup 规则 |
| 客户端管控 | requirements（不可覆盖）+ managed_config（可覆盖默认）；系统文件/MDM/**云端签名包 fail-closed** | managed settings 三通道（server 轮询/MDM/文件），**容错解析**，managed 永远压用户层 | requirements.toml 六层合并 + **Ed25519 签名 deployment config** + fail-closed 启动门（exit 1/2） |
| 审计 | Dashboard / Analytics API / **Compliance API（append-only，无正文）** | Compliance API（无正文）+ Data Export（独立高权限正文通道） | OTLP `/traces`（身份属性）+ GCS trace 上传（可重定向到企业自有桶） |
| ZDR | — | **服务端强制**：禁用一切需存储功能并在后端拒绝 | `team_blocked_reasons` 携带 `BLOCKED_REASON_NO_LOGS*`，客户端据此关采集 |

**核心共识**（三家一致）：
1. 身份是策略路由的锚点：域名验证 → SSO 强制 → SCIM 供给 → 收编影子账号
2. 权限是**多层求交**，不是单层 RBAC（总闸 × 角色 × 组 × 席位）
3. 客户端管控 = **双层语义**（requirements 不可覆盖 + defaults 可覆盖）+ **多通道下发**（系统文件/MDM/云端签名包）+ **fail-closed**
4. 审计走**双管道**：元数据事件流（无正文，进 SIEM）+ 内容导出（独立授权）
5. 准入（席位）与消耗（额度）分离，超额给优雅出路而不是生硬 403

---

## 二、WorkBuddy 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     WorkBuddy Cloud（你的后端）                     │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ 身份中心  │  │ 模型网关      │  │ 配额计费    │  │ 策略中心    │ │
│  │ (OIDC    │  │ /v1/responses│  │ /v1/billing│  │ /deployment│ │ │
│  │  IdP+    │  │ /v1/models   │  │  usage计量 │  │ /config    │ │ │
│  │  SCIM)   │  │  路由/降级   │  │  限额/402  │  │ (签名下发) │ │ │
│  └────┬─────┘  └──────┬───────┘  └─────┬──────┘  └─────┬──────┘ │
│       └────────┬──────┴────────┬───────┴───────┬───────┘        │
│           ┌────▼────┐     ┌────▼────┐     ┌────▼────┐            │
│           │ 管理后台 │     │ 审计事件 │     │ 模型提供方│           │
│           │ (Admin  │     │ 总线     │     │ xAI/OpenAI│           │
│           │ Console)│     │ (Kafka/ │     │ /Anthropic│           │
│           │         │     │  OTLP)  │     │ /自托管   │           │
│           └─────────┘     └─────────┘     └──────────┘            │
└──────────────────────────────▲───────────────────────────────────┘
                               │ HTTPS（cli-chat-proxy 兼容契约）
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
  ┌─────┴─────┐        ┌──────┴──────┐        ┌──────┴──────┐
  │ grok CLI   │        │ grok-desktop│        │ 其他客户端    │
  │ (TUI)      │        │ (我们的 GUI) │        │ (IDE 插件等)  │
  └───────────┘        └─────────────┘        └─────────────┘
   本地 agent 引擎（工具执行/文件读写/ACP server），零修改直连你的后端
```

**最重要的战略决策：API 契约兼容 cli-chat-proxy。** grok 客户端（TUI、我们的 desktop）已内置全部企业管控客户端机制（OIDC、deployment key、签名策略校验、fail-closed、402 退避、ETag 模型目录）。你的后端实现同一契约 = **客户端零改动接管**，WorkBuddy 第一天就有成熟的企业客户端。

---

## 三、域模型

```
Organization（组织/企业租户）
├── Domain（域名，DNS TXT 验证；用于 SSO 强制与 domain capture）
├── Workspace（工作区/部门隔离，≤N 个；配额与 key 的作用域）
│   ├── Member（成员；组织角色 × 工作区角色）
│   ├── Group（组；SCIM 同步或手工；角色的载体）
│   ├── Role（内置 Owner/Admin/Member + 自定义；能力项集合）
│   ├── ApiKey（用户 key / service account key；绑定 workspace）
│   ├── ModelGrant（模型授权：allowlist + 每模型 rate limit + effort 上限）
│   ├── Budget（月度美元/token 上限：soft 告警 + hard 阻断）
│   └── Policy（客户端策略包：requirements TOML + defaults TOML，按组差异化）
├── BillingAccount（计费主体；credits 池 / 订阅席位）
└── AuditLog（append-only 事件流）
```

**用户/会话主体**（对齐 grok 的 principal 模型）：
`{principalType: "User"|"Team", userId, email, teamId, teamRole, organizationId, organizationRole, blockedReasons[]}` —— `blockedReasons` 字符串枚举同时承载封禁与合规状态（如 `NO_LOGS` = ZDR 组织），客户端据此改变行为。

---

## 四、五大子系统设计

### 4.1 身份中心（AuthN/AuthZ）

- **OIDC Provider**：自建或 Authentik/Keycloak/Logto。grok 客户端已实现 Auth Code + PKCE（loopback 回调）与 Device Code 两种流，服务端标准 OIDC 即可（discovery、JWKS、refresh_token grant）。
- **组织生命周期**：域名验证（DNS TXT）→ 强制 SSO 开关 → 供给三选一（SCIM 推荐 / JIT / 手工邀请）→ **domain capture**：收编该域名已有个人账号（30 天迁移窗，数据合并或全新加入，学 Anthropic）。
- **角色模型**：组织总闸（功能开关天花板）× 自定义角色（能力项集合）× 组（SCIM 映射）× 成员，**additive 求并集**；席位类型（Chat seat / Code seat）与角色正交取交集。变更延迟生效（≤15min）需明确语义。
- **token 契约**：access token（JWT 或 opaque，≤1h）+ refresh token（滚动轮换，复用检测=被盗吊销全链）；deployment key（企业部署级，走独立 management 认证路由）。
- **fail-closed 认证锁定**：`preferred_method`、`disable_api_key_auth`、`force_login_team_uuid`（把客户端认证钉死在管控组织，防换账号绕过一切管控——三家共同教训）。

### 4.2 模型网关（核心资产）

**对外契约（客户端可见，cli-chat-proxy 兼容）：**

| 端点 | 说明 |
|---|---|
| `POST /v1/responses` | 推理主路径（OpenAI Responses API + SSE 流式；usage 带 `cost_in_usd_ticks` 成本钩子） |
| `POST /v1/chat/completions` | OpenAI 兼容（备用路径，方便 LiteLLM/One-API 系对接） |
| `GET /v1/models` | 模型目录（OpenAI `{"data":[...]}` 形状 + **ETag**；客户端启动拉取+etag 变化热刷新） |
| `GET /v1/user` | 用户/团队资料（principal 模型；`?include=subscription` 带套餐） |
| `GET /v1/billing?format=credits` | 额度/用量/周期（美分单位，proto3 JSON 零值省略风格） |
| `GET /v1/deployment/config` | **客户端策略下发**（Ed25519 签名信封，见 4.4） |
| `GET /v1/settings` | 远端功能旗标 + 访问门（`allow_access, gate_message, gate_url`） |
| `POST /v1/traces` | OTLP 遥测（可选；也可直接让客户端 OTEL 打企业 collector） |

**请求/响应头规范**：`Authorization: Bearer`、`x-grok-client-version`（版本门控）、`x-userid`、响应头 `x-models-etag`、`x-grok-context-window`（在线调整模型上下文）、`Retry-After` + `x-should-retry`（控制客户端退避）。

**对内路由**：统一抽象 `Provider`（xAI / OpenAI / Anthropic / vLLM 自托管），按模型条目配置上游 base_url + key；支持每模型**降级链**（主→备）；成本归一化（各家 usage → 统一 `cost_in_usd_ticks` = 1e-10 USD）。

**模型目录即控制面**：目录条目的增删改实时生效（ETag 失效 → 客户端热刷新）——**"后端加模型，前端立即可选"就是这么实现的**；每模型元数据含 `contextWindow / reasoningEfforts / agentType / apiBackend(responses|chat_completions|messages)`。

### 4.3 配额与计费

- **层级限额**：Org → Workspace → User 三级预算（子级 ≤ 父级）；每级两类：**hard limit**（阻断，返回 402）与 **soft limit**（告警阈值，推送通知）。
- **速率限制**：org/workspace/model 三维 RPM/TPM；响应头透出 remaining/reset 供客户端退避。
- **402 语义**（照 grok）：统一计费池耗尽返回 402 + 消息体 `<scope>-blocked:<reason>`；客户端退避重试 + 显示升级入口（`gate_url`）。**允许当前 turn 跑完**（fair use，学 OpenAI）。
- **计量**：网关在推理响应时按 token 记账（usage → 费用），写 metering 表（不可变流水）；credits 池扣减（预付费）或月度账单（后付费）两种模式。
- **默认值陷阱**（Anthropic 的教训）：新建/重建实体的默认限额必须显式设定，禁止"继承最大限额"。

### 4.4 客户端策略管控（grok 已内置，直接接管）

**双层语义**（照 grok/OpenAI）：`requirements`（管理员强制，用户不可覆盖）+ `managed_config`（默认偏好，用户会话内可改）。

**下发契约**（实现 `GET /v1/deployment/config` 即可，grok 客户端原生支持）：

```json
{
  "deployment_id": "uuid",
  "team_id": "team-uuid",
  "managed_config": "<TOML 字符串>",
  "requirements": "<TOML 字符串>",
  "signatures": [{
    "signed_payload": "{\"version\":1,\"team_id\":\"...\",\"fail_closed\":true,\"expires_at\":...,\"key_id\":\"v1\"}",
    "signature": "<base64 Ed25519>",
    "key_id": "v1"
  }]
}
```

- **签名信封**（服务端 Ed25519 私钥签名，客户端内置公钥验）：绑定 principal（防串租户）+ 过期时间 + key_id（支持轮换）；`fail_closed` 在签名字节内，本地不可翻。
- **可管控项**（grok requirements schema 直接可用）：功能开关（`[features]`）、模型白名单/黑名单（glob）、端点钉死（`[endpoints]` 把模型/遥测重定向到你的网关）、禁用 yolo（`[ui] disable_bypass_permissions_mode`）、权限规则（`[permission]` allow/deny/ask）、沙箱 profile、遥测开关/重定向、最低版本地板、`fail_closed = true`。
- **下发通道**：云端签名包（5min 轮询 + 磁盘 sidecar 离线重验）+ 系统文件（`/etc/grok/requirements.toml`）+ macOS MDM——三通道优先级合并，**拉取失败 fail-closed**（exit 1/2）。
- **容错解析**：单条非法配置剥离、其余照常生效（Anthropic 经验），配置加载错误软失败，只有显式 fail-closed 才硬拒。

### 4.5 审计与可观测

**双管道**（三家共识）：

1. **元数据事件流（无正文，进 SIEM）**：事件 = who/when/what（登录、策略变更、key 变更、模型调用计量、权限决策、管理员操作）；append-only；提供 Compliance API（程序化拉取）+ OTLP 直推企业 collector。客户端侧 grok 已能导出 OTel（`GROK_EXTERNAL_OTEL=1` + 内容门默认关）。
2. **内容导出（独立高权限通道）**：会话正文导出仅 Primary Owner 级角色可用，独立授权、独立留存、独立审计。**审计日志永不包含 prompt/代码正文**（grok v1.23 起 prompt 也不进 trace metadata——学这个）。

**合规基线**：SOC 2 Type II → ISO 27001；ZDR 组织 = 服务端强制（禁用一切需存储功能并在后端拒绝，`blockedReasons` 下发，不只靠客户端自觉）；数据驻留（workspace_geo）。

---

## 五、分阶段落地路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **MVP（2~3 周）** | 网关实现 `/v1/responses`（转发 1~2 家上游）+ `/v1/models`（静态目录）+ OIDC 登录（Authentik）+ 简单硬限额 | grok CLI/desktop 指向你的网关完成对话；模型选择器出现你的模型 |
| **V1（+4 周）** | 域模型全套（org/workspace/user/role/key）+ 管理后台（成员/模型/限额）+ `/v1/user` `/v1/billing` + 402 语义 + 计量流水 | 管理后台加模型前端立即可见；超限 402 横幅正确显示；用量报表 |
| **V2（+4 周）** | `/v1/deployment/config` 签名策略下发 + 策略编辑 UI + 审计事件流 + Compliance API + SCIM | 管理员下发模型白名单/禁 yolo 到客户端；审计接 SIEM |
| **V3** | domain capture、ZDR 组织、多区域驻留、降级链、SOC2 | 企业销售就绪 |

**网关技术选型建议**：自研薄层（Go/Rust/Node 均可，契约就十几个端点）优于硬套 One-API——One-API 系的模型/权限模型与 grok 的 cli-chat-proxy 契约不一致，套壳改造成本高于自研；其管理后台思路（渠道/额度/日志）可借鉴。

---

## 六、关键设计决策与权衡

1. **网关模式 > 纯客户端管控**：客户端管控不是安全边界（用户可改二进制）；真正的安全边界在网关——认证、模型可见性、限额、ZDR 都在服务端强制执行，客户端管控只负责"默认体验与便利性"。三家都诚实标注了这一点。
2. **契约兼容 > 自研协议**：兼容 cli-chat-proxy 让 WorkBuddy 零成本获得成熟客户端生态（TUI/desktop/未来的 IDE 插件）；未来若需差异化能力，走 `_x.ai/*` 风格的扩展命名空间（`workbuddy/*`），不破坏基础契约。
3. **失败语义显式化**：402（额度）、429（限流+Retry-After）、403+reason（封禁）、exit 1/2（策略 fail-closed）——每种的客户端行为都要定义清楚并被测试锁定。
4. **默认安全**：网络默认关、最小权限、ZDR 可做组织级默认值；"重建实体继承最大限额"类默认值陷阱在 schema 层面杜绝。
