# 计划：通道「无可用密钥」报错修复（开源用户 Mac Codex 反馈）

日期：2026-09-06
状态：实施中

## 目标（用户目标提示词）

开源用户在 macOS Codex 上选择 `b.ai/glm-5.3-flash` 后收到：

> unexpected status 502 Bad Gateway: router error: 通道 zhipu-api 无可用密钥（密钥池为空且环境变量 ZHIPU_API_KEY 未设置）, url: http://127.0.0.1:5730/v1/responses

且桌面端「正在重新连接 5/5」盲目重试。修复该报错的诊断失真、状态码语义与可操作性，使开源用户能自助定位。

## 根因分析（已核实）

1. **配置缺失，非平台 bug**：报错本身说明路由进程在 Mac 上正常运行。用户手动建了 `zhipu-api` 通道（预设一键接入强制要求至少一把 key，`buildTargetFromPreset` 也不落 envKey，不会产生此状态），但密钥池为空且未设置环境变量 `ZHIPU_API_KEY`。该模型锚定精确匹配仅命中此一个通道，无备用可切换。
2. **状态码语义错误**：`env_key_missing` 未设 `error.status`，最终按 502 返回 → Codex 视为网关故障盲目重试 5 次。本地配置缺失应属 4xx，让客户端立即停止重试、直接展示错误。
3. **文案失真（真 bug）**：`acquireKey` 返回 null 有三种不同情形——池空、池内 key 全部冷却中、env_ref 环境变量未解析（兜底 envKey 也缺失）。现有文案一律报「密钥池为空」，全冷却时误导诊断。
4. **文案不可操作**：纯中文、无修复指引，开源国际用户无法自助。

## 修复设计

### A. `lib/channel-key-pool.mjs`
新增 `describeKeyShortfall(target)`：`acquireKey` 返回 null 时给出精确原因。
返回 `null`（密钥可得，不调用）或 `{ reason, coolingCount, totalKeys, earliestRecoveryAt }`：
- `reason: 'empty'` — 该通道在池中无任何条目；
- `reason: 'all_cooling'` — 有条目但全部冷却中（earliestRecoveryAt = 最早恢复时间）；
- `reason: 'env_ref_unresolved'` — 有条目未冷却但 env_ref 引用的环境变量全部解析失败。
复用 `dbListChannelKeysFor`，只读，仅在错误路径调用。

### B. `lib/router-handler.mjs`（两处 env_key_missing）
- **池分支**（~L433）：`acquireKey` 失败时按 shortfall 生成双语文案：
  - empty → 401：`通道 ${name} 没有配置任何 API Key：请在管理页「渠道密钥池」添加，或设置环境变量 ${envKey} / No API key configured for channel "${name}": add one in the web admin (Channel Key Pool) or set env var ${envKey}`
  - all_cooling → 429 + `retryAfter`（秒，取最早恢复时间）：`通道 ${name} 的 N 把密钥全部冷却中，最早 HH:MM 恢复 / All N keys of channel "${name}" are cooling down until ...`
  - env_ref_unresolved → 401：`通道 ${name} 密钥引用的环境变量未设置 / keys reference unset environment variables`
- **env 兜底分支**（~L449，无 keyPool 老链路）：同 401 + 双语：`通道 ${name} 缺少密钥：环境变量 ${envKey} 未设置 / channel "${name}" has no API key: env var ${envKey} is not set`
- `describeKeyShortfall` 经注入传入或直接经 `keyPool` 调用（与 `acquireKey` 同一注入对象）。

### C. `lib/provider-pool.mjs`
`isRetryableProviderFailure`：把 `RETRYABLE_ERROR_CODES.has(code)` 检查**移到 status 检查之前**。
否则 B 给 `env_key_missing` 加上 401/429 status 后，401 会在 `if (status) return ...` 处被判为不可重试，破坏「主通道缺 key 切备用通道」的既有 failover 能力（回归）。

### D. `lib/admin-api.mjs`
`targets/fetch-models` 的 env_key_missing 文案（~L3445）同样用 shortfall 区分（池全冷却时不再误报「环境变量未设置」）。

## 不做的事（范围控制）

- 不改桌面端 models.json 写入逻辑（接入时写目录的既有流程不动）；
- 不动 vendor-presets 激活的 keys_required 校验（已正确）；
- web-admin 前端不加「通道未配密钥」角标（后端已暴露 hasEnvKey，UI 强化另开任务）。

## 自测计划

1. `node --test test/channel-key-pool.test.mjs`：新增 describeKeyShortfall 三情形 + 密钥可得返回 null。
2. `node --test test/provider-pool.test.mjs`：env_key_missing 带 401/429 status 仍可 failover；普通 401 不 failover 保持。
3. `node --test test/router-handler*.test.mjs`（若存在对 env_key_missing 的断言则同步更新）：无密钥请求返回 401 + 双语文案；全冷却返回 429 + retry-after。
4. 全量 `npm test`。

## 自查计划

- 对抗审查：实现完成后派新鲜眼睛代理审查本改动（重点：isRetryableProviderFailure 顺序调整是否影响其他 code；401 对桌面端自定义 provider 是否安全——官方通道 401 语义不经过此路径）。
- 安全约束：文案不含任何真实凭据；不新增密钥落盘路径。
