import { rawHttpsRequest } from '../transport.mjs';

/**
 * GitHub Copilot 订阅（VS Code Copilot Chat 同源代理）OAuth 实现。
 * 认证链三层（社区事实标准，LiteLLM / tokscale / copilot-api 同款）：
 * ① GitHub OAuth device flow（RFC 8628）拿长期 GitHub token —— client_id 用
 *    VS Code Copilot Chat 的 GitHub App（Iv1.b507a08c87ecfe98）。gh CLI 的
 *    client_id 无权铸造 Copilot token（2026-10-05 实测 403），不能用 gh token 兜底。
 * ② api.github.com/copilot_internal/v2/token 换 ~30 分钟短效 Copilot JWT
 *    （endpoints.api 随响应给出：individual/business/enterprise 域名不同）。
 * ③ 带「编辑器身份头」打 {api}/chat/completions | /responses | /v1/messages | /models。
 *    Copilot-Integration-Id 缺失直接 400，取值影响模型可见集；403 多为身份头不匹配。
 *
 * 凭据分层：credentials.githubToken 是唯一权威长期凭据（无 refresh token 概念）；
 * Copilot JWT 是运行时缓存（authManager.expiresAt + refresher 按需重铸），不入 vault 权威态。
 */

// 目录池/路由 match 用的客户端前缀（对齐 chatgpt-web 的 ^web-(.+)$ + upstreamModel $1 先例）：
// 模型 slug 形如 copilot-gpt-5.3-codex，路由 match `^copilot-(.+)$` 还原上游真名。
export const COPILOT_MODEL_PREFIX = 'copilot-';

export const COPILOT_OAUTH = Object.freeze({
  clientId: process.env.GITHUB_COPILOT_CLIENT_ID || 'Iv1.b507a08c87ecfe98',
  deviceCodeUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  copilotTokenUrl: 'https://api.github.com/copilot_internal/v2/token',
  copilotUserUrl: 'https://api.github.com/copilot_internal/user',
  verificationUrl: 'https://github.com/login/device',
  scope: 'read:user',
  deviceTimeoutMs: 15 * 60 * 1000,
  // 代理身份头（2026-10 实测可用组合，模拟 VS Code Copilot Chat；可按需升级版本号）
  editorVersion: process.env.COPILOT_EDITOR_VERSION || 'vscode/1.99.0',
  editorPluginVersion: process.env.COPILOT_EDITOR_PLUGIN_VERSION || 'copilot-chat/0.26.7',
  // vscode-chat 仅对 OAuth token 有效（PAT 被拒）；copilot-developer-cli 对两者通用但模型集更窄。
  // OAuth device flow 凭据固定走 vscode-chat。
  integrationId: process.env.COPILOT_INTEGRATION_ID || 'vscode-chat',
  userAgent: process.env.COPILOT_USER_AGENT || 'GitHubCopilotChat/0.26.7',
});

function proxyOptions(proxy) {
  if (!proxy) return {};
  return { viaProxy: true, proxy };
}

async function githubPostForm(url, params, { proxy, requestFn = rawHttpsRequest } = {}) {
  const body = new URLSearchParams(params).toString();
  const target = new URL(url);
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': COPILOT_OAUTH.userAgent,
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    ...proxyOptions(proxy),
    timeouts: { requestMs: 30000 },
  });
  let data = null;
  try { data = JSON.parse(res.bodyText); } catch { /* 非 JSON 错误体 */ }
  return { status: res.status, data, raw: res.bodyText };
}

async function githubGetJson(url, token, { proxy, requestFn = rawHttpsRequest, accept = 'application/json' } = {}) {
  const target = new URL(url);
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'User-Agent': COPILOT_OAUTH.userAgent,
    },
    ...proxyOptions(proxy),
    timeouts: { connectMs: 15_000, responseHeaderMs: 20_000, requestMs: 30_000 },
    maxResponseBytes: 4 * 1024 * 1024,
  });
  let data = null;
  try { data = JSON.parse(res.bodyText); } catch { /* 非 JSON 错误体 */ }
  return { status: res.status, data, raw: res.bodyText };
}

// ---------- ① GitHub 设备码授权（RFC 8628） ----------
// GitHub 的语义与 OpenAI 私有变体不同：token 端点对「未批准」返回 HTTP 200 + body.error
// （authorization_pending / slow_down）；用户在验证页输错码时回 incorrect_device_code，
// 但设备码仍有效——浏览器里重输即可，轮询应继续而非终止。

/** 第一步：申请设备码。返回 { deviceCode, userCode, intervalMs, verificationUrl, expiresAt }。 */
export async function startCopilotDeviceAuth({ proxy, requestFn } = {}) {
  const { status, data, raw } = await githubPostForm(COPILOT_OAUTH.deviceCodeUrl, {
    client_id: COPILOT_OAUTH.clientId,
    scope: COPILOT_OAUTH.scope,
  }, { proxy, requestFn });
  if (status !== 200 || !data || typeof data !== 'object') {
    // 错误体带入摘要：GitHub 对高频申请会回 429/ abuse 提示，纯状态码无法定位
    const err = new Error(`GitHub 设备码申请失败 (HTTP ${status}): ${String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    err.code = 'copilot_device_start_failed';
    err.status = status;
    throw err;
  }
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
  const userCode = typeof data.user_code === 'string' ? data.user_code : '';
  if (!deviceCode || !userCode) {
    const err = new Error('GitHub 设备码响应缺少 device_code / user_code');
    err.code = 'copilot_device_invalid_response';
    throw err;
  }
  const intervalSeconds = Number(data.interval);
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0 && intervalSeconds <= 300
    ? Math.max(1000, Math.ceil(intervalSeconds * 1000))
    : 5000;
  return {
    deviceCode,
    userCode,
    intervalMs,
    verificationUrl: COPILOT_OAUTH.verificationUrl,
    expiresAt: Date.now() + COPILOT_OAUTH.deviceTimeoutMs,
  };
}

/**
 * 第二步：单次轮询。返回
 *   { status: 'pending', intervalHintMs? }          —— 未批准（可含 slow_down 加速提示/输错码重试）
 *   { status: 'authorized', accessToken }           —— 用户已批准
 * expired_token / access_denied 等终局态抛错。
 */
export async function pollCopilotDeviceAuth({ deviceCode, proxy, requestFn } = {}) {
  if (!deviceCode) throw new Error('pollCopilotDeviceAuth 需要 deviceCode');
  const { status, data } = await githubPostForm(COPILOT_OAUTH.tokenUrl, {
    client_id: COPILOT_OAUTH.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, { proxy, requestFn });
  // GitHub token 端点偶发 5xx（网关抖动）：按 pending 处理继续轮询，不让瞬时故障
  // 杀死整个授权会话（对齐 openai poller 的容错口径）；会话自身有过期兜底。
  if (status >= 500) {
    return { status: 'pending' };
  }
  const error = typeof data?.error === 'string' ? data.error : '';
  if (error === 'authorization_pending' || error === 'incorrect_device_code') {
    return { status: 'pending' };
  }
  if (error === 'slow_down') {
    // RFC 8628：收到 slow_down 后轮询间隔 +5s（ intervalHint 由调用方并入会话）
    return { status: 'pending', intervalHintMs: 10_000 };
  }
  if (error) {
    const messages = {
      expired_token: '设备码已过期（15 分钟），请重新发起授权',
      access_denied: '授权被拒绝（用户点了取消）',
      unsupported_grant_type: 'GitHub 不支持该 grant_type（client_id 可能失效）',
    };
    const err = new Error(`GitHub 设备码授权失败：${messages[error] || error}`);
    err.code = error === 'expired_token' ? 'device_auth_expired' : `copilot_device_${error}`;
    err.status = status;
    throw err;
  }
  if (status !== 200 || !data?.access_token) {
    const err = new Error(`GitHub 设备码授权失败 (HTTP ${status}): ${String(data?.error_description || '').slice(0, 160)}`);
    err.code = 'copilot_device_poll_failed';
    err.status = status;
    throw err;
  }
  return { status: 'authorized', accessToken: data.access_token };
}

// ---------- ② Copilot 短效 JWT 铸造 ----------

/**
 * GitHub token → Copilot API token（~30 分钟短效）。免交互幂等，可随时重铸。
 * 返回 { copilotToken, expiresAt(epoch ms), apiEndpoint, trackingId }。
 * 403 = GitHub token 无效或该 client 无 Copilot 权限（调用方标记 auth_expired）。
 */
export async function exchangeCopilotApiToken({ githubToken, proxy, requestFn } = {}) {
  if (!githubToken) {
    const err = new Error('缺少 GitHub token（请重新完成设备码授权）');
    err.code = 'copilot_no_github_token';
    throw err;
  }
  const { status, data } = await githubGetJson(COPILOT_OAUTH.copilotTokenUrl, githubToken, { proxy, requestFn });
  if (status === 401 || status === 403) {
    const err = new Error(`GitHub 拒绝铸造 Copilot token (HTTP ${status})：登录态可能已失效，请重新授权`);
    err.code = 'copilot_token_mint_denied';
    err.status = status;
    throw err;
  }
  if (status !== 200 || !data?.token) {
    const err = new Error(`Copilot token 铸造失败 (HTTP ${status}): ${String(data?.message || '').slice(0, 160)}`);
    err.code = 'copilot_token_mint_failed';
    err.status = status;
    throw err;
  }
  // expires_at 为秒级 epoch；无值时按 25 分钟兜底（官方典型值 30 分钟）
  const expiresAtSeconds = Number(data.expires_at);
  const expiresAt = Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
    ? expiresAtSeconds * 1000
    : Date.now() + 25 * 60_000;
  return {
    copilotToken: data.token,
    expiresAt,
    apiEndpoint: typeof data.endpoints?.api === 'string' && data.endpoints.api
      ? data.endpoints.api.replace(/\/+$/, '')
      : 'https://api.individual.githubcopilot.com',
    trackingId: typeof data.tracking_id === 'string' ? data.tracking_id : '',
  };
}

/** 代理请求身份头集合（集中管理：403 排查先看这里；integration-id 影响模型可见集）。 */
export function copilotProxyHeaders(copilotToken, overrides = {}) {
  return {
    authorization: `Bearer ${copilotToken}`,
    'editor-version': overrides.editorVersion || COPILOT_OAUTH.editorVersion,
    'editor-plugin-version': overrides.editorPluginVersion || COPILOT_OAUTH.editorPluginVersion,
    'copilot-integration-id': overrides.integrationId || COPILOT_OAUTH.integrationId,
    'user-agent': overrides.userAgent || COPILOT_OAUTH.userAgent,
    ...(overrides.extra || {}),
  };
}

// ---------- ③ 订阅信息 / 额度快照（copilot_internal/user） ----------
// 2026-06-01 起 premium requests 被 AI Credits（token 计费）取代，但截至 2026-10
// 该端点快照仍是 legacy 三类（chat/completions/premium_interactions）+ token_based_billing
// 与 credits_used 新字段并存。个体 AI Credits 余额无官方 API：快照只做参考口径。

/**
 * 订阅信息与额度快照。返回 { login, plan, sku, chatEnabled, apiEndpoint, quotaSnapshots }。
 * 快照结构由上游决定，原样透传（quota_snapshots.{chat,completions,premium_interactions}）。
 */
export async function fetchCopilotUser({ githubToken, proxy, requestFn } = {}) {
  const { status, data } = await githubGetJson(COPILOT_OAUTH.copilotUserUrl, githubToken, {
    proxy,
    requestFn,
    accept: 'application/vnd.github+json',
  });
  if (status !== 200 || !data) {
    const err = new Error(`Copilot 订阅信息拉取失败 (HTTP ${status}): ${String(data?.message || '').slice(0, 160)}`);
    err.code = 'copilot_user_fetch_failed';
    err.status = status;
    throw err;
  }
  return {
    login: typeof data.login === 'string' ? data.login : '',
    plan: typeof data.copilot_plan === 'string' ? data.copilot_plan : '',
    sku: typeof data.access_type_sku === 'string' ? data.access_type_sku : '',
    chatEnabled: Boolean(data.chat_enabled),
    apiEndpoint: typeof data.endpoints?.api === 'string' && data.endpoints.api
      ? data.endpoints.api.replace(/\/+$/, '')
      : '',
    quotaSnapshots: data.quota_snapshots && typeof data.quota_snapshots === 'object'
      ? data.quota_snapshots
      : null,
  };
}

// ---------- ④ 模型目录（GET {api}/models） ----------

/**
 * 上游模型是否只能走 /responses（GPT-5.3-Codex 系在 /chat/completions 直接 400，
 * 2026-10 上游行为：仅 codex 系强制 responses，其余默认 chat）。
 */
export function copilotResponsesOnly(upstreamId) {
  return /codex/i.test(String(upstreamId || ''));
}

/**
 * 拉取 Copilot 代理模型目录并归一为目录池入库形态。
 * 返回 [{ name: 'copilot-<id>', displayName, upstreamId, vendor, images,
 *         contextWindow, maxOutputTokens, responsesOnly, premium }]。
 * 仅保留 policy.state === 'enabled' 的对话模型（embeddings / disabled 条目剔除）。
 */
export async function fetchCopilotModels({ copilotToken, apiEndpoint, proxy, requestFn } = {}) {
  if (!copilotToken) throw new Error('fetchCopilotModels 需要 copilotToken');
  const base = apiEndpoint || 'https://api.individual.githubcopilot.com';
  const { status, data } = await githubGetJson(`${base}/models`, copilotToken, { proxy, requestFn });
  if (status !== 200) {
    const err = new Error(`Copilot 模型清单拉取失败 (HTTP ${status}): ${String(data?.message || '').slice(0, 160)}`);
    err.status = status;
    throw err;
  }
  const list = Array.isArray(data?.data) ? data.data : [];
  const models = [];
  for (const entry of list) {
    const upstreamId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!upstreamId) continue;
    if (entry?.policy?.state && entry.policy.state !== 'enabled') continue;
    const capabilities = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
    if (capabilities.type && capabilities.type !== 'chat') continue;
    const supports = capabilities.supports && typeof capabilities.supports === 'object' ? capabilities.supports : {};
    const limits = capabilities.limits && typeof capabilities.limits === 'object' ? capabilities.limits : {};
    const contextWindow = Number(limits.max_context_window_tokens);
    const maxOutput = Number(limits.max_output_tokens);
    models.push({
      name: `${COPILOT_MODEL_PREFIX}${upstreamId}`,
      displayName: typeof entry.display_name === 'string' && entry.display_name
        ? entry.display_name
        : (typeof entry.name === 'string' && entry.name ? entry.name : upstreamId),
      upstreamId,
      vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
      images: Boolean(supports.vision),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 0,
      responsesOnly: copilotResponsesOnly(upstreamId),
      premium: Boolean(entry?.billing?.premium) || undefined,
    });
  }
  return models;
}
