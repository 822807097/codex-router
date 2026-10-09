# GitHub Copilot 订阅账号接入调查报告与改造计划

> 调查目标：把 GitHub Copilot 订阅额度以「OAuth 订阅账号池」形态接进本路由，对齐 openai / google provider 的待遇（加号、池化轮换、冷却、额度展示）。
> 日期：2026-10-05。事实来源：Docker 官方文档（Copilot provider 页）、LiteLLM 官方 `github_copilot` provider 文档、tokscale issue #912、GitHub Community 讨论 #178117/#197089、GitHub Plans 定价页；本仓库现状由工作区代码核查（file:line 以 2026-10-05 工作区为准）。
>
> **落地状态（2026-10-05 当日实现）**：
> - P0-1 Copilot 认证模块 → `lib/auth/copilot-sub-auth.mjs`（startCopilotDeviceAuth/pollCopilotDeviceAuth/exchangeCopilotApiToken/fetchCopilotUser/fetchCopilotModels/copilotProxyHeaders；RFC 8628 标准语义，`incorrect_device_code` 视为继续轮询）。单测 `test/copilot-sub-auth.test.mjs`（7 例全过）。
> - P0-2 admin 接线 → `lib/admin-api.mjs`：`device-start` 白名单 + `driveDeviceAuthCompletion` provider 参数化（openai 私有变体 / GitHub 标准流分派）；`persistCopilotAccount`（GitHub token 入 vault，JWT 由 refresher 重铸）；`fetch-models`/`test-model`/`accounts/quota` copilot 分支；`POST /_admin/api/copilot-channel/setup` 一键接入（两族 match 通道 + 目录入库，事务提交）。
> - refresher → `codex-router.mjs` `registerRefresher('copilot')`：长期凭据只有 githubToken，短效 JWT（~30min）幂等重铸；铸造被拒（403）归入 401→auth_expired 语义。
> - 路由消费 → `lib/router-handler.mjs authHeadersForTarget` platform==='copilot' 分支：账号池选号 + `copilotProxyHeaders` 身份头；`keyAttempt.source='account'` 与 openai 同构（429→decide429Cooldown、401→markAuthExpired、请求内换号自动生效）。
> - 面板 → 订阅页 Copilot 平台卡 + Copilot 额度快照渲染（quota_snapshots 三行进度条）；OAuthDialog 设备码 Tab 支持 copilot（默认落设备码模式，无回环 OAuth 选项；手动 Token 导入 githubToken 形态）；`--brand-github` 色板。
> - M0 实测：gh CLI token 铸 Copilot token **403**（gh 的 client_id 178c… 无 Copilot 铸币权限）——印证必须走自己的 device flow；`copilot_internal/user` 实拍确认账号为 `free_limited_copilot` 档，快照已含 `token_based_billing: true` / `credits_used` 新字段。
> - 负路径实测（2026-10-05，mock 账号注入后清理）：假 githubToken → refresher 铸 JWT 被拒（GitHub 401）→ 账号自动标记 `auth_expired`（lastAuthError 带原因）→ quota/fetch-models 优雅报错 `copilot_token_mint_denied` → setup 端点在无可用账号时 `copilot_account_missing` 拦截；账号删除 = 内存+SQLite+vault 三清 ✓。admin 端点 device-start/device-cancel 实测 ✓。**正路径（真实授权后 fetch-models→setup→quota→test-model）待账号绑定后回填**。
> - 发布前自检修复（2026-10-09）：test-model `/responses` 非流式响应判定修正（`stream:false` 返回单个 JSON 对象而非 SSE 事件流，原事件名正则会把成功误判为失败——改为按 `choices`/`output`/`object+status` 结构分型）；设备码轮询对上游 5xx 按 pending 继续轮（网关抖动不再杀死授权会话）；device-start 报错带响应体摘要。

## 0. TL;DR

1. **可行且有大量先例**。LiteLLM 官方 provider、tokscale、CodexBar、copilot-api 等工具都走同一条链路：GitHub OAuth **device flow**（设备码）拿长期 GitHub token → `api.github.com/copilot_internal/v2/token` 换 **~30 分钟短效 Copilot JWT** → 带「编辑器身份头」打 `api.individual.githubcopilot.com` 的 OpenAI 兼容代理。本仓库 2026-10-03 刚落地的 OpenAI device flow 基础设施（`startOpenAiDeviceAuth` 三件套 + admin `device-start` 端点 + OAuthDialog 设备码 Tab）**几乎可以直接参数化复用**，加号新增成本是四个 provider 里最低的。
2. **上游是「一代理多协议」**：`/chat/completions`（OpenAI）、`/responses`（GPT-5.x-Codex 系**只**走这个，chat 端点直接 400）、`/v1/messages`（Anthropic 格式，claude 系模型）、`/embeddings`、`GET /models`。本仓库 wireApi 已支持 responses/chat 两种形态，路由侧主要工作是**按模型选端点**。
3. **必须带「编辑器身份头」**：`Copilot-Integration-Id` 缺失直接 400；且该头的值决定模型可见集（`vscode-chat` 对 PAT 拒绝、`copilot-developer-cli` 通用）；`Editor-Version`/`User-Agent`/`Editor-Plugin-Version` 按 LiteLLM 惯例模拟 VS Code Copilot Chat。403 多半是身份头不匹配，不是 token 坏。
4. **额度口径已变**：2026-06-01 起 premium requests 被 **GitHub AI Credits**（token 计费，1 credit = $0.01，Pro 含 1000 credits/月、Pro+ 含 3900）取代。个体余额**没有官方 API**，社区仍读 `copilot_internal/user` 的 `quota_snapshots`（截至 2026-07 字段还是 legacy 三类 chat/completions/premium_interactions）。所以额度展示 = 快照 + 本地 token 计量估算双口径。
5. **最大的风险不是技术是成本与条款**：token 计费下 agentic 大上下文流量烧额度极快（社区实测首月 10–50x 支出波动）；`copilot_internal` 系端点未公开文档，属「社区大规模使用、GitHub 容忍但不支持」。建议：账号默认**低优先级 fallback 定位**、GitHub 侧 spending limit 设 $0 硬护栏、面板做月度硬上限。

## 1. Copilot 订阅 API 事实拆解

### 1.1 认证链（三层）

```
GitHub 账号（长期凭据，无 refresh token 概念）
   │ ① RFC 8628 device flow
   │    POST https://github.com/login/device/code        client_id=Iv1.b507a08c87ecfe98, scope=read:user
   │    → { device_code, user_code, verification_uri: https://github.com/login/device, interval }
   │    轮询 POST https://github.com/login/oauth/access_token
   │    grant_type=urn:ietf:params:oauth:grant-type:device_code（pending→slow_down 语义与 OpenAI 类似）
   ▼
ghu_… GitHub OAuth token（长期，落 vault）
   │ ② 换短效 API token（免交互、幂等，可随时重换）
   │    GET https://api.github.com/copilot_internal/v2/token   Authorization: Bearer <ghu_>
   ▼
Copilot JWT（~30 分钟，expires_at/refresh_in 随响应给出）
   │ ③ 调代理
   │    GET  {endpoints.api}/models
   │    POST {endpoints.api}/chat/completions | /responses | /v1/messages | /embeddings
   ▼
api.individual.githubcopilot.com（个人版；business/enterprise 为对应域名，endpoints.api 随 ② 返回）
```

与现有 provider 的关键差异：**凭据分两层**——长期层是 GitHub token（`credentials.githubToken`），短效层是 Copilot JWT（运行时缓存，**不是**权威凭据；401 时重换一次即可）。刷新器语义因此与 openai/google 不同：不是「续 refresh token」，而是「按需重铸 JWT」。

### 1.2 请求头（代理侧硬要求）

| 头 | 要求 | 备注 |
|---|---|---|
| `Authorization: Bearer <Copilot JWT>` | 必须 | 注意是 JWT 不是 GitHub token，拿错层会 401 |
| `Copilot-Integration-Id` | 必须，缺失 400 | `vscode-chat` 仅 OAuth token 接受；`copilot-developer-cli` 对 OAuth/PAT 都接受；**值影响 /models 可见集** |
| `Editor-Version`（如 `vscode/1.99.0`） | 惯例必带 | LiteLLM 默认模拟 `vscode/1.95.0` |
| `Editor-Plugin-Version` / `User-Agent`（`copilot-chat/0.26.7`、`GitHubCopilotChat/0.26.7`） | 惯例必带 | 403 优先排查这组头 |

- `client_id` 用社区事实标准 `Iv1.b507a08c87ecfe98`（VS Code Copilot Chat 的 GitHub App）。**client_id 会影响模型集**（OpenCode 用自己的 client_id 拿到不同模型列表），做成配置项留后路。
- PAT 兜底：classic PAT（`copilot` scope）可替代 GitHub token 走 ②，但 integration-id 受限（`vscode-chat` 被拒）；fine-grained PAT 不行。手动导入模式以此为主。

### 1.3 模型目录与端点选择

- `GET /models` 返回 `capabilities.{type, supports, limits.{max_context_window_tokens, max_output_tokens, max_prompt_tokens}}`、`policy.state`（enabled/disabled）、`vendor`（openai/anthropic/google/azure）、preview 标记。**目录随 plan + client_id + integration-id 变化**，必须运行时拉取入库（本仓库 fetch-models → models.json 目录池机制现成）。
- 端点兼容性（2026-10 实况）：GPT-5.3-Codex 系**仅 `/responses`**；GPT-5.2 等默认 `/chat/completions`；claude 系走 `/v1/messages`（LiteLLM 即如此派发）；新模型趋势是只走 responses。路由侧要允许「同一上游不同模型不同 wireApi」。

### 1.4 额度与限流

- **计费（2026-10 现行）**：AI Credits，1 credit = $0.01，按 token 以各模型 API 费率折算；Pro $10 含 1000 credits/月、Pro+ $39 含 3900；超额自动扣费（可在 GitHub 侧设 spending limit，设 $0 即硬停）。旧 premium requests 口径（Free 50 / Pro 300 / Pro+ 1500 / Business 300 / Enterprise 1000）2026-06-01 起废弃。
- **额度查询**：`GET https://api.github.com/copilot_internal/user`（Bearer **GitHub token**）→ `copilot_plan` + `quota_snapshots.{chat, completions, premium_interactions{entitlement, remaining, percent_remaining, overage_count}}`；截至 2026-07 仍是 legacy 三类（tokscale #912），AI Credits 余额无 API。口径结论：**快照只做参考，真实额度以本地 token 计量 + GitHub 计费页为准**。
- **限流**：无公开 RPM 数字；超限 429 + `Retry-After`（docs.github.com/en/copilot/concepts/rate-limits）。与现有 `decide429Cooldown` 分型语义吻合：突发 429 短冷却，月度额度耗尽长冷却/停用。

## 2. 与现有 provider 对照

| 维度 | openai（Codex） | google（Antigravity） | copilot（拟新增） |
|---|---|---|---|
| 加号 | PKCE 回环 + device flow | PKCE 回环 | **device flow**（UI 模式现成） |
| 长期凭据 | refresh_token | refresh_token | GitHub token（无 refresh 概念） |
| 短效凭据 | access_token（自动续） | access_token（自动续） | Copilot JWT ~30min（按需重铸，新增一层） |
| 上游协议 | responses | v1internal:gemail SSE | chat + responses（+messages 可选） |
| 鉴权位置 | `authHeadersForTarget` 账号池分支 | 派发器内部（`openGoogleChatStream`） | 账号池分支 + 头集合组装（仿 google 模式） |
| 额度来源 | 上游响应头 `x-codex-*` 被动 + 主动探测 | 上游不支持，本地周计数 | **主动拉 quota_snapshots** + 本地 token 计量 |
| 冷却分型 | 429 分型（窗口/突发） | 同构 | 429 短冷却；额度耗尽→月度重置点；401→重铸一次→auth_expired；403→suspect（多为身份头问题） |
| 账号 metadata | planType, chatgptAccountId | planType, projectId | plan（copilot_plan）, apiEndpoint, integrationId |

## 3. 改造计划

### P0-1 `lib/auth/copilot-sub-auth.mjs`（新建）

**动机**：三层认证链需要一个独立 auth 模块；device flow 部分与 openai 同构但端点/语义不同（标准 RFC 8628，非 OpenAI 私有变体），不值得硬塞进 openai-sub-auth。

**改动**：
- `startCopilotDeviceAuth()`：POST `github.com/login/device/code`（client_id 可配置，默认 `Iv1.b507a08c87ecfe98`，scope `read:user`）→ `{device_code, user_code, verification_uri, interval, expires_in}`。
- `pollCopilotDeviceAuth()`：轮询 `github.com/login/oauth/access_token`，`authorization_pending`/`slow_down` 继续、尊重 `interval`，成功返回 GitHub token；15 分钟超时（对齐现有 oauthSessions TTL）。
- `exchangeCopilotApiToken(githubToken)`：GET `copilot_internal/v2/token` → `{token, expires_at, endpoints.api}`；返回 JWT + 端点 + 过期时间，供刷新器与运行时缓存共用。
- `fetchCopilotModels(jwt, endpoint, headers)`：GET `/models`，供 fetch-models 入库。
- 头集合组装函数 `copilotProxyHeaders(jwt)`（integration-id / editor-version / user-agent 集中管理，默认模拟 VS Code Copilot Chat，可被账号 metadata 覆盖）。

**验收**：模块单测覆盖 pending/slow_down/403 分支；用真实账号手动跑通 ①→②→③ curl 级验证（M0 清单见 §5）。

### P0-2 admin API + 刷新器接线

**动机**：账号生命周期管理全部走 `lib/admin-api.mjs` 的 provider switch；device flow 后台轮询器当前写死 OpenAI 函数，是唯一需要参数化的硬编码点。

**改动**（行号对 2026-10-05 工作区）：
- `lib/admin-api.mjs:3067` oauth start 分支加 `copilot`（直接返回 device-start 引导）；`:3135` device 白名单加 `copilot`。
- `:1138 driveDeviceAuthCompletion`：把写死的 `pollOpenAiDeviceAuth`/`completeOpenAiDeviceAuth`（:1150/:1170）按 provider 派发（openai 走原函数，copilot 走新函数），轮询循环与取消/超时回收逻辑复用。
- `:1072 completeAuthorization` 加分支：入库 `credentials{githubToken}`（vault）、`metadata{plan, apiEndpoint, integrationId}`；`:975 persistAuthorizedAccount` alias 三元加 copilot。
- provider switch 三处：`fetch-models`（:3362，JWT 换取 + /models 入 models.json 目录池）、`test-model`（:3504，按模型选 chat/completions 或 responses 发一条最小请求）、`accounts/quota`（:3640，`copilot_internal/user` 快照，60s 节流同 openai）。
- `codex-router.mjs:472` `registerRefresher('copilot', …)`：懒刷新语义——出站前检查 JWT 缓存过期（`expires_at - 60s`）即重铸；GitHub token 失效（重铸 401）→ `auth_expired`。
- 手动导入：现有 `POST /accounts/add` 与 OAuthDialog token 模式平移为「贴 GitHub token」（本机 `gh auth token` 或 classic PAT 可直接用），作为 M0 之外的快速加号路径。

**验收**：面板设备码加号全程不碰终端；账号列表出现 plan 标签；fetch-models 拉到真实目录；quota 端点返回快照。

### P1-1 路由消费（账号池 + targets）

**动机**：让 Copilot 账号进入轮换、冷却、熔断、统计的既有链路，成为模型路由的真实上游。

**改动**：
- config `targets[]`：按端点形态加 1–2 条 target（`host: api.individual.githubcopilot.com`，`wireApi: 'responses'` / `'chat'`，`platform: 'copilot'`，match 覆盖 `gpt-5.3-codex.*` 等 Copilot 独占模型名）；熔断器/统计环/请求统计自动受益，零改动。
- `lib/router-handler.mjs:439 authHeadersForTarget` 加 `platform === 'copilot'` 分支（仿 google 的「鉴权在派发内部处理」模式，`:559`）：`acquireAccount({provider:'copilot', model})` → JWT 缓存检查/重铸 → 返回 1.2 头集合。
- 同一 target 内按模型选上游路径：`resolveProvider` 处（`lib/provider-adapters.mjs:41`）允许 target 级 wireApi 被模型目录的 `supported_endpoints` 覆盖（GPT-5.3-Codex 强制 responses）。
- 429/401/403 分型接线：429 → `decide429Cooldown`（`lib/account-quota.mjs:94`）；401 → 重铸一次再判；403 → suspect + 日志提示身份头；quota 快照 `percent_remaining === 0` → 冷却至月度重置。
- 参照 `/google-channel/setup`（`lib/admin-api.mjs:2712`）做 `POST /_admin/api/copilot-channel/setup`：按账号 plan/endpoints.api 动态生成 targets + 目录，避免手写 config。

**验收**：Codex 桌面端把模型指到 Copilot 独占模型名能出流式响应；池内多账号按优先级/余量轮换；拔 JWT 模拟 401 自动恢复；429 形态保真返回。

### P1-2 面板 UI

**改动**：
- `web-admin/src/views/subscriptions/Index.vue:328` platforms 数组加 Copilot 卡；`:126` 额度区按快照渲染（月度余量 + 重置日期；注明「AI Credits 口径以 GitHub 计费页为准」）。
- `web-admin/src/views/subscriptions/components/OAuthDialog.vue:241` `supportDeviceAuth` 加 `copilot`；`:243` `dialogTitle`、`:253` `credentialLabel` 补词条；设备码 UI（user_code + verification_uri + 复制/打开 + 轮询）完全复用，验证链接是 `https://github.com/login/device`。
- `web-admin/src/api/accounts.js` 无需新端点封装（provider 字符串参数化即可）。
- 改完 `cd web-admin && npm run build`（产物进 `web/`）。

**验收**：手机扫码完成加号；订阅页看到月度额度进度条；dashboard 的 token_logs 正常归账到该账号。

### P2（可选，按需排期）

- **`/v1/messages` 上游 wireApi 适配**：目前 vendor-presets 明确只支持 OpenAI 兼容 chat/responses（`lib/vendor-presets.mjs:1`）。做完后 Claude Desktop（Anthropic 兼容层）可直接吃到 Copilot 的 claude 系模型——这是 Copilot 池对本用户最值钱的场景，但要新写一条 anthropic-messages 上游派发分支，工作量另估。
- AI Credits 本地计量：token_logs 按「模型 API 费率 → credits」折算列，补齐快照缺失的真实余额口径。
- `authHeadersForTarget` 出站走账号代理：沿用 `resolveAccountProxy`。

## 4. 风险与对策

| 风险 | 事实 | 对策 |
|---|---|---|
| 条款灰色 | `copilot_internal/*` 未公开文档；代理仅官方支持 IDE/CLI 客户端。但 LiteLLM 官方内置 provider、tokscale/CodexBar 等公开运营多年，未见封号案例 | 用个人号；模拟正常编辑器头；不加并发轰炸；client_id/头集合做成可配置（被封可换马甲） |
| 成本失控 | AI Credits 按 token 计费，agentic 大上下文极易烧穿月度额度并触发超额扣费（社区首月 10–50x 支出波动） | GitHub 侧 spending limit 设 $0；账号 metadata 设月度硬上限；路由默认低优先级 fallback；面板余量告警 |
| 目录漂移 | 模型集随 plan/client_id/integration-id 变化；GPT-5.3-Codex 系只走 responses | 一律运行时 fetch-models 入目录池，按 `supported_endpoints` 选端点，不硬编码模型清单 |
| 403 误判 | 身份头不匹配返回 403，易误判为凭据坏 | 403 → suspect + 提示「检查 integration-id/User-Agent」，不直接 auth_expired |
| 平台差异 | Business/Enterprise 域名与组织策略不同；GHE 端点全套不同（LiteLLM 有 env 对应表） | M1 只做个人版；endpoints.api 以 v2/token 响应为准不硬编码 |
| 快照口径过期 | quota_snapshots 是 legacy 字段，AI Credits 余额无 API | UI 明示口径；P2 本地计量兜底 |

## 5. 里程碑与顺序

1. **M0（1 小时，动手验证，先于一切）**：本机 `gh auth token` → curl 跑通 §1.1 全链路：v2/token 拿 JWT 与 `endpoints.api`、`/models` 看本 plan 真实模型集与 `supported_endpoints`、一次 chat/completions、一次 `copilot_internal/user` 实拍快照字段。**确认额度档位与模型集值得接再开工。**
2. **M1（1 天）**：P0-1 + P0-2——加号/导入、fetch-models、test-model、quota 全通，账号可见可测但未进路由。
3. **M2（1 天）**：P1-1 targets + 鉴权分支 + 冷却分型，真实流量进池。
4. **M3（半天）**：P1-2 面板 UI + setup 端点。
5. P2 视 M2 实际体验决定（尤其 /v1/messages 场景）。

每步独立可发布；遵守仓库现有「配置改动需重启、DB/内存态热生效」边界；web-admin 改动必须重新 build。
