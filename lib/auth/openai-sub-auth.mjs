import { createHash, timingSafeEqual } from 'node:crypto';

import { rawHttpsRequest } from '../transport.mjs';

/**
 * OpenAI / ChatGPT 订阅（Codex CLI 官方客户端）OAuth 实现。
 * 常量与请求格式对齐 sub2api backend/internal/pkg/openai/oauth.go：
 * - client app_EMoamEEZ73f0CkXaXp7hrann（公共客户端，PKCE，无 client_secret）
 * - PKCE verifier 为 64 随机字节的 hex 串（OpenAI 特有编码）
 * - ID Token（JWT）payload 解析出 email / chatgpt_plan_type / 组织信息
 */

export const OPENAI_OAUTH = Object.freeze({
  clientId: process.env.OPENAI_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  defaultRedirectUri: 'http://localhost:1455/auth/callback',
  scopes: 'openid profile email offline_access',
  refreshScopes: 'openid profile email',
  // 设备码授权（2026-10-03）：不依赖本机回调端口，headless / 远程服务器加号用。
  // 端点族 auth.openai.com/api/accounts/deviceauth/*，验证页为 codex/device。
  deviceUsercodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  deviceVerificationUrl: 'https://auth.openai.com/codex/device',
  deviceTimeoutMs: 15 * 60 * 1000,
});

function proxyOptions(proxy) {
  if (!proxy) return {};
  return { viaProxy: true, proxy };
}

async function postJson(url, payload, { proxy, requestFn = rawHttpsRequest } = {}) {
  const body = JSON.stringify(payload);
  const target = new URL(url);
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

async function postForm(url, params, { proxy, requestFn = rawHttpsRequest } = {}) {
  const body = new URLSearchParams(params).toString();
  const target = new URL(url);
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    ...proxyOptions(proxy),
    timeouts: { requestMs: 30000 },
  });
  let data = null;
  try { data = JSON.parse(res.bodyText); } catch { /* 非 JSON 错误体 */ }
  if (res.status !== 200) {
    const rawError = data?.error_description || data?.error || res.bodyText.slice(0, 300);
    const detail = typeof rawError === 'object' && rawError !== null
      ? `${rawError.type || 'error'}: ${rawError.message || JSON.stringify(rawError)}`
      : rawError;
    const err = new Error(`OpenAI OAuth 请求失败 (HTTP ${res.status}): ${detail}`);
    err.code = data?.error || 'openai_oauth_http_error';
    err.status = res.status;
    throw err;
  }
  return data;
}

export function buildOpenAiAuthUrl({ redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_OAUTH.clientId,
    redirect_uri: redirectUri || OPENAI_OAUTH.defaultRedirectUri,
    scope: OPENAI_OAUTH.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${OPENAI_OAUTH.authorizeUrl}?${params.toString()}`;
}

export async function exchangeOpenAiCode({ code, codeVerifier, redirectUri, proxy, requestFn } = {}) {
  if (!code || !codeVerifier) throw new Error('exchangeOpenAiCode 需要 code / codeVerifier');
  const data = await postForm(OPENAI_OAUTH.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: OPENAI_OAUTH.clientId,
    code,
    redirect_uri: redirectUri || OPENAI_OAUTH.defaultRedirectUri,
    code_verifier: codeVerifier,
  }, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    idToken: data.id_token || '',
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in || 3600,
    tokenType: data.token_type || 'Bearer',
  };
}

// ---------- 设备码授权（device auth flow，2026-10-03） ----------
// 面向 headless / 远程部署：无本机回调端口依赖，任意设备的浏览器打开验证页输
// user_code 即可完成授权。轮询端点在「用户尚未批准」时以 403/404 应答——按官方
// 客户端口径视为继续轮询，而非失败。

/** 第一步：申请设备码。返回 { deviceAuthId, userCode, intervalMs, expiresAt }。 */
export async function startOpenAiDeviceAuth({ proxy, requestFn } = {}) {
  const { status, data } = await postJson(OPENAI_OAUTH.deviceUsercodeUrl, {
    client_id: OPENAI_OAUTH.clientId,
  }, { proxy, requestFn });
  if (status === 404) {
    const err = new Error('OpenAI 设备码授权暂不可用（上游返回 404），请使用一键授权或手动导入');
    err.code = 'openai_device_unavailable';
    err.status = 404;
    throw err;
  }
  if (status !== 200 || !data || typeof data !== 'object') {
    const err = new Error(`OpenAI 设备码申请失败 (HTTP ${status}): ${String((status === 200 ? '' : data && data.error_description) || '')}`);
    err.code = 'openai_device_start_failed';
    err.status = status;
    throw err;
  }
  const deviceAuthId = typeof data.device_auth_id === 'string' ? data.device_auth_id : '';
  const userCode = typeof (data.user_code || data.usercode) === 'string' ? (data.user_code || data.usercode) : '';
  if (!deviceAuthId || !userCode) {
    const err = new Error('OpenAI 设备码响应缺少 device_auth_id / user_code');
    err.code = 'openai_device_invalid_response';
    throw err;
  }
  // 轮询间隔尊重上游 interval（秒）；缺失或异常时兜底 5 秒
  const intervalSeconds = Number(data.interval);
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0 && intervalSeconds <= 300
    ? Math.max(1000, Math.ceil(intervalSeconds * 1000))
    : 5000;
  return {
    deviceAuthId,
    userCode,
    intervalMs,
    verificationUrl: OPENAI_OAUTH.deviceVerificationUrl,
    expiresAt: Date.now() + OPENAI_OAUTH.deviceTimeoutMs,
  };
}

/**
 * 第二步：单次轮询。返回
 *   { status: 'pending' }                              —— 未批准/需继续轮询（403/404/429/5xx）
 *   { status: 'authorized', authorizationCode, codeVerifier } —— 用户已批准
 * 其余状态抛错（会话过期、被拒等）。
 */
export async function pollOpenAiDeviceAuth({ deviceAuthId, userCode, proxy, requestFn } = {}) {
  if (!deviceAuthId || !userCode) throw new Error('pollOpenAiDeviceAuth 需要 deviceAuthId / userCode');
  const { status, data } = await postJson(OPENAI_OAUTH.deviceTokenUrl, {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  }, { proxy, requestFn });
  if (status === 403 || status === 404 || status === 429 || status >= 500) {
    return { status: 'pending' };
  }
  if (status !== 200 || !data || typeof data !== 'object') {
    const err = new Error(`OpenAI 设备码授权失败 (HTTP ${status})`);
    err.code = 'openai_device_poll_failed';
    err.status = status;
    throw err;
  }
  const authorizationCode = typeof data.authorization_code === 'string' ? data.authorization_code : '';
  const codeVerifier = typeof data.code_verifier === 'string' ? data.code_verifier : '';
  const codeChallenge = typeof data.code_challenge === 'string' ? data.code_challenge : '';
  if (!authorizationCode || !codeVerifier || !codeChallenge) {
    const err = new Error('OpenAI 设备码授权响应不完整（缺少 authorization_code / PKCE 三元组）');
    err.code = 'openai_device_invalid_response';
    throw err;
  }
  // PKCE 自证：上游回传的 verifier 与 challenge 必须自洽（sha256(verifier) 的
  // base64url == challenge），防上游/代理链路被篡改后拿坏凭据去换 token
  const derivedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(derivedChallenge);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const err = new Error('OpenAI 设备码授权返回的 PKCE 校验不一致，已中止换取 token');
    err.code = 'openai_device_pkce_mismatch';
    throw err;
  }
  return { status: 'authorized', authorizationCode, codeVerifier };
}

/** 第三步：授权码换 token（redirect_uri 固定为设备码回调页，与网页流不同）。 */
export async function completeOpenAiDeviceAuth({ authorizationCode, codeVerifier, proxy, requestFn } = {}) {
  if (!authorizationCode || !codeVerifier) throw new Error('completeOpenAiDeviceAuth 需要 authorizationCode / codeVerifier');
  return exchangeOpenAiCode({
    code: authorizationCode,
    codeVerifier,
    redirectUri: OPENAI_OAUTH.deviceRedirectUri,
    proxy,
    requestFn,
  });
}

export async function refreshOpenAiTokens({ refreshToken, proxy, requestFn } = {}) {
  if (!refreshToken) {
    const err = new Error('缺少 OpenAI Refresh Token');
    err.code = 'openai_no_refresh_token';
    throw err;
  }
  const data = await postForm(OPENAI_OAUTH.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH.clientId,
    scope: OPENAI_OAUTH.refreshScopes,
  }, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    idToken: data.id_token || '',
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * 解码 ID Token（JWT）payload 提取用户与订阅信息。
 * 仅解码不验签（对齐 sub2api DecodeIDToken：作为展示用途的尽力解析）。
 */
export function decodeOpenAiIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('invalid JWT format: expected 3 parts');
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('failed to decode JWT payload');
  }
  const auth = claims['https://api.openai.com/auth'] || {};
  const organizations = Array.isArray(auth.organizations) ? auth.organizations : [];
  const defaultOrg = organizations.find((o) => o?.is_default) || organizations[0] || null;
  return {
    email: claims.email || '',
    emailVerified: Boolean(claims.email_verified),
    chatgptAccountId: auth.chatgpt_account_id || '',
    chatgptUserId: auth.chatgpt_user_id || '',
    planType: auth.chatgpt_plan_type || '',
    userId: auth.user_id || '',
    organizationId: defaultOrg?.id || '',
    organizations,
  };
}

// ChatGPT 订阅账号无公开模型列表端点（OAuth 类型无列表接口）；
// 内置清单为实测可用名（经 /backend-api/codex/responses 验证，2026-08 实测）。
// 重要：这些模型消耗的是订阅的 Codex 额度池（与 ChatGPT 网页对话额度池相互独立），
// 走 Codex 后端接口；按钮返回并标注 source: builtin；每个模型可用「测试」按钮验证。
export const CODEX_KNOWN_MODELS = Object.freeze([
  { name: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', thinking: true, images: true },
  { name: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', thinking: true, images: true },
  { name: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', thinking: true, images: true },
  { name: 'gpt-5.5', displayName: 'GPT-5.5', thinking: true, images: true },
  { name: 'gpt-5.4', displayName: 'GPT-5.4', thinking: true, images: true },
  { name: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', thinking: true, images: true },
  { name: 'codex-auto-review', displayName: 'Codex Auto Review', thinking: true, images: false },
  { name: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', thinking: true, images: true },
]);

/**
 * 实时拉取 Codex 额度池的完整模型清单（对齐 sub2api：GET /backend-api/codex/models）。
 * 上游要求 client_version 查询参数；返回 [{ name, displayName, thinking, images }]，
 * 失败时抛错由调用方决定回退内置清单。
 */
export async function fetchOpenAiCodexModels({ accessToken, proxy, requestFn = rawHttpsRequest } = {}) {
  const res = await (requestFn || rawHttpsRequest)({
    protocol: 'https',
    host: 'chatgpt.com',
    path: '/backend-api/codex/models?client_version=1.0.0',
    method: 'GET',
    viaProxy: true,
    proxy,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      originator: 'codex_cli',
    },
    timeouts: { connectMs: 15_000, responseHeaderMs: 20_000, requestMs: 25_000 },
    maxResponseBytes: 4 * 1024 * 1024,
  });
  if (res.status !== 200) {
    const err = new Error(`Codex 模型清单拉取失败 (HTTP ${res.status}): ${String(res.bodyText || '').slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    throw new Error('Codex 模型清单响应不是有效 JSON');
  }
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return models
    .map((m) => {
      const name = typeof m?.slug === 'string' ? m.slug.trim() : '';
      if (!name) return null;
      // 能力在顶层字段（无 capabilities 容器）：
      // - 思考 = supported_reasoning_levels 存在（含 default_reasoning_level 兜底）
      // - 图片 = input_modalities 含 image
      const modalities = Array.isArray(m?.input_modalities) ? m.input_modalities : [];
      return {
        name,
        displayName: typeof m?.display_name === 'string' && m.display_name ? m.display_name : name,
        thinking: Array.isArray(m?.supported_reasoning_levels) && m.supported_reasoning_levels.length > 0,
        images: modalities.includes('image'),
      };
    })
    .filter(Boolean);
}
