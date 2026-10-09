# webcodex 调查报告与 codex-router 改造计划

> 调查对象：`Kiowx/webcodex` @ commit `785b2f0`（2026-08-24，基于其 pin 的 Codex Desktop 26.721.30844）。
> 日期：2026-10-03。本文先还原 webcodex 的真实架构，再对照本仓库现状给出可落地的改造项。
>
> **落地状态（2026-10-03 当日全部实现并验证）**：
> - P0-2 通道熔断器 → `lib/channel-circuit.mjs`（新增），接线 `lib/router-handler.mjs` 候选循环 + 五个分支出口；管理端点 `GET /_admin/api/targets/health`、`POST /_admin/api/targets/health/reset`；config 保存自动重置；面板仪表盘「实时运行状态」卡片（`web-admin/src/components/LiveStatusCard.vue`）。配置项 `config.channelCircuit.{enabled,failureThreshold,openMs}`（默认开/3 次/30s）。
> - P1-1 整轮失败重试 → `lib/router-handler.mjs` rounds 包裹层。配置项 `config.infiniteRetryRounds`（默认 **false**）+ `config.infiniteRetryRoundsMaxMs`（默认 600s）；只对 429/408/5xx/传输类失败生效，模型冷却 422 与 env_key_missing 立即终局。
> - P1-2 请求统计环 → `lib/request-stats-ring.mjs`（新增，默认 500 条），路由五个出口分支统一收口；端点 `GET /_admin/api/stats/recent`；与熔断健康同卡片展示。错误体截断沿用既有 readStreamSnippet(64KB)/摘要 300 字符设计，未另做。
> - P0-1 设备码 OAuth → `lib/auth/openai-sub-auth.mjs`（startOpenAiDeviceAuth/pollOpenAiDeviceAuth/completeOpenAiDeviceAuth，PKCE timing-safe 自证）+ `lib/admin-api.mjs`（`/oauth/{openai,chatgpt-web}/device-start|device-status|device-cancel`，后台轮询器随会话取消/超时回收）+ 面板 OAuthDialog 第三 Tab。已实测真实发放设备码并验证取消回收。
>
> 已知边界：熔断/统计为内存态，重启清零（有意设计）；熔断只统计传输层失败与 5xx/408，429/401 由 key 池与账号状态机管辖；`/v1/responses` 的内置工具桥分支（`markSuccess` 出口）与全部 chat 分支均已覆盖埋点。

## 0. TL;DR

1. **GitHub 上叫 "webcodex" 的仓库不止一个**。2.1k star 的 `yyjeqhc/webcodex` 是"给 ChatGPT 网页版接 MCP 操作本地开发环境"，与额度无关；`weituo470/WEBCODEX` 是 tmux+ttyd 网页终端基线。**真正做"额度池 + API 渠道 + 协议转换"的是 `Kiowx/webcodex`**（linux.do 社区项目，自托管 Codex Web GUI），本报告以它为准。
2. **方向澄清**：webcodex 并不是"把 ChatGPT 网页额度转成对外 API"。它对 ChatGPT 订阅额度（额度池）的做法是——**官方 OAuth + 每账号托管 `CODEX_HOME` 投影 + 热重启 Codex app-server**，让官方二进制替它消费额度；它真正"转协议"的方向是反的：**把第三方 API（Chat Completions / Anthropic Messages）转成 Responses 协议喂给 Codex**，走一个"带熔断的回环渠道路由器"。
3. 对照本仓库：codex-router **已经用另一种（HTTP 直连、无子进程）架构覆盖了同样两条链路**——官方 Codex 额度池（`chatgpt.com/backend-api/codex` + 账号池）和 ChatGPT 网页会话池（`chatgpt-web` platform，PoW/Turnstile）。webcodex 真正值得抄的是四件小事：**设备码 OAuth 加号**、**通道级熔断器**、**整轮失败无限重试（可开关）**、**有界请求统计/错误体截断**。详见 §3 改造计划。

## 1. webcodex（Kiowx）架构拆解

它把 Codex Desktop（Electron）"塞进浏览器"，再在服务端做账号/渠道管理。五层：

```
浏览器（打补丁后的 Codex Desktop 渲染层，shim.ts 冒充 Electron preload）
   │  认证 WebSocket（IPC 桥，src/server/main.ts）
服务端（Node，Fastify）
   ├─ ProfileStore（src/server/profile-store.ts，AES-256-GCM 保险库）
   │    ├─ 账号 profile：ChatGPT/Codex 订阅账号（额度池）
   │    ├─ 渠道 profile：第三方 Responses/Chat/Anthropic API
   │    └─ 账号态与渠道态后端强制互斥（启用一个停用另一个，配置互不删除）
   ├─ 运行时投影：每个 profile 一个托管 CODEX_HOME（runtime auth.json/config.toml, 0600）
   │    + 切换时经串行队列发 `codex-app-server-restart` IPC 热重启 app-server
   │    + 渠道态额外隔离 CODEX_SQLITE_HOME；非活跃 runtime 凭据清理
   └─ ChannelRouter（src/server/channel-router.ts，127.0.0.1 回环）
        Codex app-server --Responses--> 回环路由器 --协议转换--> 上游 API
        （上游真 Key 不进 app-server；app-server 只拿内部一次性 Key）
```

关键源码事实（路径均相对 `Kiowx/webcodex` 仓库）：

- **加号（登录账号）有两条流**：
  - `src/server/codex-oauth.ts`：标准 PKCE，`localhost:1455` 回环（与本仓库 `lib/auth/openai-sub-auth.mjs` 同源同 client_id `app_EMoamEEZ73f0CkXaXp7hrann`）。
  - `src/server/codex-device-oauth.ts`：**设备码流**，不依赖本机回调。端点：
    `POST https://auth.openai.com/api/accounts/deviceauth/usercode`（body 只有 `{client_id}`）→ `{device_auth_id, user_code, interval}`；
    轮询 `POST .../deviceauth/token`（`{device_auth_id, user_code}`），`403/404/429/5xx` 继续轮询；成功返回 `{authorization_code, code_verifier, code_challenge}`，先校验 `sha256(code_verifier) == code_challenge`（timing-safe）；再走常规 `POST auth.openai.com/oauth/token`（`grant_type=authorization_code`，`redirect_uri=https://auth.openai.com/deviceauth/callback`）换 token；用户侧打开 `https://auth.openai.com/codex/device` 输 user_code。产出 `auth.json`：`{auth_mode:"chatgpt", tokens:{access_token,id_token,refresh_token?,account_id}}`，`account_id` 取自 id_token 的 `https://api.openai.com/auth` claim。单活跃登录守卫 + 15 分钟超时。
- **账号切换 = 投影 + 热重启**（`profile-store.ts` `materializeAccount` / `prepareActiveRuntime`，`main.ts` `reloadRuntime`）：切换操作过串行尾队列防止并发；激活时把解密后的 `auth.json` 和拼好的 `config.toml` 写进 `profile-runtime/account/<uuid>/`（0600），共享目录用符号链接复用，`CODEX_SQLITE_HOME` 每账号独立；然后向渲染层发 `codex-app-server-restart`（`killCodexProcess:false`）；最后 `cleanupInactiveRuntimeCredentials()` 清掉非活跃 runtime 的凭据。**token 若被 app-server 刷新，会从 runtime `auth.json` 回同步进加密保险库**（`syncActiveAccountCredentials`）。
- **渠道路由器**（`channel-router.ts`）：
  - 熔断器：`CIRCUIT_FAILURE_THRESHOLD=3` 连续失败 → `open` 30s（`CIRCUIT_COOLDOWN_MS`）→ 下次候选筛选时置 `half-open` 放行探测；**全部熔断时兜底选第一个候选，绝不因熔断直接 503**。
  - 重试：每渠道 `requestMaxRetries` 次，退避尊重 `retry-after`（秒数或 HTTP 日期），否则 `250ms * 2^n` 封顶 2s；一轮候选全失败且全是可重试失败（408/429/5xx/传输错）后，按持久化开关进入"无限整轮重试"，`500ms * 2^min(round,10)` 封顶 10s；**所有等待共享客户端 AbortSignal**，断开即终止；401/参数错等不可重试错误立即返回。
  - `previous_response_id` 转换史：进程内有界 Map（100 条、TTL 1h），把 Responses 请求展开成完整消息史喂 Chat/Anthropic 上游。
  - 统计：最近 500 条请求环形缓冲（含 failover 来源、延迟、token 数）；上游错误体截断 16KB；出站 URL 做 SSRF 校验（拒绝私网/回环/链路本地地址）。
- **协议转换**：`channel-protocol.ts`（Responses↔Chat，含 SSE 工具调用增量）、`channel-anthropic.ts`（Responses↔Anthropic Messages，含认证、content/tool 块、usage、SSE 生命周期）。
- **ASAR 侧**：pin 版本下载 Codex Desktop zip（SHA-256 校验）→ 抽 `app.asar` → git apply 小补丁 → 渲染层跑在普通浏览器里；README 明确 npm 包若重分发解包产物需自行确认 OpenAI 条款。**这是它做"网页 GUI"的手段，与额度无关。**

## 2. 与 codex-router 现状对照

| 能力 | webcodex | codex-router 现状 | 结论 |
|---|---|---|---|
| ChatGPT 订阅额度池 | OAuth 账号池 + 托管 CODEX_HOME 投影 + app-server 热重启（子进程消费额度） | HTTP 直连 `chatgpt.com/backend-api/codex/responses`，账号池（429 分型冷却/suspect/auth_expired/双窗口额度/主动探测），桌面端切号写 auth.json | ✅ 已覆盖，架构更轻（无常驻子进程） |
| ChatGPT 网页会话额度 | **不做**（彻底绕开 conversation/PoW/Turnstile 这条脆弱链路） | `chatgpt-web` platform：sentinel→PoW→Turnstile→conversation SSE | ✅ 已覆盖且更激进；webcodex 的选择反证"能用 backend-api 就别走网页会话" |
| 第三方 API 接进 Codex | 回环路由器 + Responses↔Chat/Anthropic 转换 | targets[] + wireApi + chat/responses 双向转换 + Anthropic 适配层 | ✅ 已覆盖 |
| key/账号 故障转移 | 请求内换渠道 + 熔断器 + 无限整轮重试 | 请求内换 key/换号 + 分型冷却 + suspect 退避 | ⚠️ 缺**通道级熔断**与**整轮无限重试开关** |
| 加号方式 | PKCE 回环 + **设备码流** | PKCE 回环 + 手动贴 code 兜底 + 借 codex CLI device-auth 脚本 | ⚠️ 缺**原生设备码流**（headless/远程最顺） |
| 凭据安全 | AES-256-GCM，publicState 剥离密钥，SSRF 校验渠道 URL | credentials-vault.json + admin 只回环 + CSRF + channel_keys 白名单加固 | 基本对齐，SSRF 校验可作可选硬化 |
| 观测 | 500 条请求环 + 渠道健康面板 | token_logs + 额度进度条 + targets/test | ⚠️ 缺请求级环形统计与目标健康视图 |

**不适用、明确不抄**：app-server 子进程托管账号（本仓库 HTTP 直连已同构覆盖且无状态更简单）；ASAR 浏览器化（本仓库直接配置真实桌面端）；账号/渠道模式互斥 UI（本仓库两者并存正是卖点）。

## 3. 改造计划

### P0-1 设备码 OAuth 加号（openai / chatgpt-web 账号共用）

**动机**：现在加号要么依赖本机 `localhost:1455` 回环，要么借 codex CLI device-auth（`scripts/login-device.sh` 是 workaround）。远程场景（VPS + Tailscale、headless）体验差；webcodex 证明 `auth.openai.com/api/accounts/deviceauth/*` 是稳定可直调的官方端点。

**改动**：
- `lib/auth/openai-sub-auth.mjs`：新增 `startDeviceAuth()/pollDeviceAuth()/completeDeviceAuth()`。参数与校验照抄 §1 端点表：`client_id=app_EMoamEEZ73f0CkXaXp7hrann`；轮询间隔尊重响应 `interval`（下限 1s，容错 5s）；`code_challenge === sha256(code_verifier)` 用 `timingSafeEqual`；换 token 的 `redirect_uri` 必须是 `https://auth.openai.com/deviceauth/callback`；产出与现有账号同构的凭据对象（`account_id` 从 id_token claim 取）。
- `lib/admin-api.mjs`：在现有 `/_admin/api/oauth/openai/start|status|exchange` 旁加 `device-start|device-status|device-complete`，复用账号入库/保险库路径；同一 provider 单活跃登录守卫 + 15 分钟过期。
- `web-admin/`：账号面板加"设备码登录"按钮 → 展示 user_code + `https://auth.openai.com/codex/device` 链接 + 轮询状态；手机可扫。
- `chatgpt-web` provider 复用同一凭据形态，天然受益。

**验收**：在一台无图形界面的机器上，仅凭 admin 面板完成加号并进池、能出额度进度条；本地 macOS 上旧 PKCE 流不受影响。

### P0-2 通道级熔断器（closed/open/half-open）

**动机**：现有故障转移粒度是"请求内换 key/换号"，但**目标级**没有熔断：某个上游挂掉（连接超时 15s/TLS 失败/连续 5xx）时，每个请求仍会先撞它一次，白付首字延迟。webcodex 的参数经过实测：**连续 3 次失败 → open 30s → half-open 放行 1 个探测**，全熔断时兜底放行第一个候选（熔断永不直接导致 503）。

**改动**：
- 新建 `lib/channel-circuit.mjs`：内存 Map<targetName, {state, consecutiveFailures, openUntil, lastError, lastLatencyMs}>；`allow(target)` / `markSuccess()` / `markFailure()`；**只统计传输层与 5xx/408**，429 与 401 不进熔断计数（它们已有 key 冷却/账号状态机语义，避免双重惩罚）。
- `lib/router-handler.mjs` 候选循环入口接 `allow()`；成功/失败回调接线；配置变更（`/_admin/api/config` 写入、target 重启）时重置对应条目。
- `lib/admin-api.mjs` 加 `GET /_admin/api/targets/health`；`web-admin` 通道列表加健康徽章（绿/黄/红 + openUntil 倒计时 + lastError 悬浮）。

**验收**：拔掉某通道上游（错误 host），第 3 次失败后该通道在 30s 内被后续请求跳过（日志可见 circuit open），30s 后半开放行；恢复后自动 closed。

### P1-1 整轮失败无限重试（默认关）

**动机**：长任务（Codex 大重构、Claude Desktop 长会话）打到"所有候选都 429 耗尽"时，现在把 429 形态保真返给客户端，客户端（尤其非 Codex 的通用客户端）不一定自己重试。webcodex 的做法是持久化开关（默认开，我们改默认关）+ 整轮退避 `500ms * 2^min(round,10)` 封顶 10s + **共享客户端取消信号**。

**改动**：`lib/router-handler.mjs` 主循环外层加轮次循环；`config.json` 增 `"infiniteRetryRounds": false`（全局）+ target 级覆盖；硬护栏：只对"可重试失败"轮继续（非重试错误立即返回，保持现有 429/401 形态保真），**必须**同时受客户端断开与总墙钟上限（建议 10 分钟，防僵尸循环）约束；轮次间每轮都重新做账号/key 冷却挑选（现有逻辑天然如此）。

**验收**：关=行为与现状逐字节一致；开=所有 key 冷却期间请求挂住不返回，任一 key 出冷却即成功或客户端断开即终止，日志记录轮数。

### P1-2 请求统计环 + 上游错误体截断

**动机**：排障时要"最近 N 个请求谁 failover 过、错在哪"，现在只有 token_logs 用量与日志文件。抄 webcodex 两个常量：`MAX_STATS=500`、`UPSTREAM_ERROR_BODY_LIMIT=16KB`。

**改动**：`lib/router-handler.mjs` 加内存环形数组（每请求：target、最终 status、failoverFrom、耗时、模型、token 数、错误摘要）；上游非 2xx 响应体读入时截断 16KB 再进日志/统计；`/_admin/api/stats/recent` 暴露 + 面板"最近请求"页。

### P2（可选硬化）

- 出站 SSRF 校验：target.host 解析结果拒绝链路本地/云元数据地址（169.254.169.254 等）。当前 admin 仅回环+CSRF，威胁模型内优先级低，做不做都行。
- `previous_response_id` 有界转换史：仅当未来出现"无 store 的 Chat 上游 + 带 previous_response_id 的 Responses 客户端"组合才需要，现阶段 Codex 桌面端 `store:false` 全量重发 input，不缺。

### 里程碑与顺序

1. **M1（半天）**：P0-2 熔断器（纯内存、无迁移、收益立现）。
2. **M2（1 天）**：P0-1 设备码 OAuth（auth 模块 + admin API + 面板按钮）。
3. **M3（半天）**：P1-1 无限重试开关（带默认关的护栏）。
4. **M4（半天）**：P1-2 统计环 + 面板页。
5. P2 视需要。

每步独立可发布，互不阻塞；都遵守仓库现有"配置改动需重启、DB/内存态热生效"的边界。
