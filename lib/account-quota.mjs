// ---------- ChatGPT 订阅账号真实额度（Codex 额度池响应头捕获 + 主动探测） ----------
// Codex 后端没有独立的配额查询端点（实测 /backend-api/codex/rate_limits 404）：额度
// 以响应头随每次 /backend-api/codex/responses 返回（与 Codex CLI 的
// parse_default_rate_limit 同源）：
//   x-codex-primary-used-percent / -window-minutes / -reset-at(-after-seconds)   （窗口 1）
//   x-codex-secondary-used-percent / -window-minutes / -reset-at(-after-seconds) （窗口 2）
// 两个窗口的时长随账号状态变化（周窗口 10080min 或 5h 窗口 300min），reset-at 为
// unix 秒、reset-after-seconds 为相对秒。零流量的账号可用 probeCodexRateLimits
// 发一条最小请求读响应头（响应头一到立即断开，不消耗生成输出）。

function windowFromHeaders(headers, prefix) {
  const usedRaw = headers[`${prefix}-used-percent`];
  const windowRaw = headers[`${prefix}-window-minutes`];
  const resetsAtRaw = Number(headers[`${prefix}-reset-at`]);
  const resetAfterRaw = Number(headers[`${prefix}-reset-after-seconds`]);
  const usedPercent = Number(usedRaw);
  let resetsAt = Number.isFinite(resetsAtRaw) && resetsAtRaw > 0 ? resetsAtRaw * 1000 : NaN;
  if (!Number.isFinite(resetsAt)) {
    const after = Number(resetAfterRaw);
    resetsAt = Number.isFinite(after) && after > 0 ? Date.now() + after * 1000 : NaN;
  }
  if (!Number.isFinite(usedPercent) && !Number.isFinite(resetsAt)) return null;
  return {
    windowMinutes: Number(windowRaw) || 0,
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/** 从上游响应头解析两个额度窗口；无任何额度头返回 null。 */
export function parseCodexRateLimitHeaders(headers = {}) {
  const fiveHour = windowFromHeaders(headers, 'x-codex-primary');
  const weekly = windowFromHeaders(headers, 'x-codex-secondary');
  if (!fiveHour && !weekly) return null;
  return {
    fiveHour,
    weekly,
    planType: String(headers['x-codex-plan-type'] || ''),
    activeLimit: String(headers['x-codex-active-limit'] || ''),
    creditsBalance: String(headers['x-codex-credits-balance'] || ''),
  };
}

/**
 * 零流量账号的主动额度探测：向 Codex 额度池发一条最小请求（1 token 输入、stream:true），
 * 响应头一到立即销毁连接（不再消耗生成输出），从响应头解析两个额度窗口。
 *
 * 模型名会随上游目录漂移（2026-10-24 实锤：探测硬编码 gpt-5.5 已被下线，400
 * model_not_found 不带额度头，面板全部账号「额度探测失败」）。因此按候选清单
 * 逐个降级：400/404 换下一个模型重试，拿到额度头（2xx 或 429 响应均可能携带）
 * 即停；全部候选失败时抛错并带出状态码与上游错误摘要，不再盲报「未返回额度头」。
 * 返回 parseCodexRateLimitHeaders 的结构。
 */
const PROBE_MODEL_CANDIDATES = Object.freeze([
  'gpt-5.6-luna',   // 2026-10-24 实测可用（free 档亦可）
  'gpt-5.6-terra',
  'gpt-5.4-mini',
  'gpt-5.5',        // 2026-10-24 前的默认探测名，已下线，留作兼容位
]);

export async function probeCodexRateLimits({ accessToken, accountId = '', proxy, openStream, models } = {}) {
  const open = openStream || (await import('./transport.mjs')).openHttpsStream;
  const candidates = Array.isArray(models) && models.length ? models : PROBE_MODEL_CANDIDATES;
  let lastDetail = '';
  for (const model of candidates) {
    const upstream = await open({
      protocol: 'https',
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      viaProxy: true,
      proxy,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'codex_cli_rs/0.45.0',
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
      // 最小请求：1 token 输入；响应头到达即 resolve，随后立刻销毁读写两侧
      body: JSON.stringify({
        model,
        instructions: '',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '1' }] }],
        stream: true,
        store: false,
      }),
      timeouts: { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 60_000 },
      maxResponseBytes: 64 * 1024,
    });
    try { upstream.socket?.destroy?.(); } catch { /* 已销毁 */ }
    try { upstream.stream?.destroy?.(); } catch { /* 已销毁 */ }
    const limits = parseCodexRateLimitHeaders(upstream.headers || {});
    if (limits) return limits;
    // 未拿到额度头：400/404 = 该模型不可用，换下一个候选；其他状态码（401/403/5xx）
    // 换模型也无济于事，直接以该响应收口报错
    const status = Number(upstream.status) || 0;
    lastDetail = `模型 ${model} HTTP ${status}${status === 400 || status === 404 ? '' : `（${String(upstream.bodyText || '').slice(0, 120)}）`}`;
    if (status !== 400 && status !== 404) break;
  }
  const err = new Error(`上游未返回额度头：${lastDetail || '无响应'}`);
  err.code = 'probe_no_rate_headers';
  throw err;
}

// ---------- 429 冷却决策：区分「窗口耗尽」与「突发限流」（2026-09-11） ----------
// 429 有两类，处置完全不同：
//   1) 窗口耗尽（5h/周额度用完）→ 冷却到窗口重置点（原 v1.10.0 行为）；
//   2) 突发限流（每分钟 TPM/RPM 超限、并发冲突等）→ 窗口余量还很大，冷却到
//      窗口尾等于把账号无辜封掉几小时甚至几天（2026-09-11 实锤：两个 openai
//      账号被冷却到 5h 窗口尾与 4 天后的周窗口尾，池子全空、桌面端报
//      "exceeded retry limit 429"，而面板额度明明还有余）。
// 判据只用响应头自身：429 响应同样携带常规额度头（used-percent/reset-at）。
//   - 某窗口 used-percent ≥ 100 → 该窗口真耗尽 → until=该窗口 reset-at；
//   - 否则一律按突发限流 → 优先 retry-after（上游显式指令），缺省 15 秒。
// 之前 v1.10.0 的实现只看 reset-at、完全没用 used-percent，是本 bug 根因。
const BURST_COOLDOWN_DEFAULT_MS = 15_000; // sub2api 同场景用 5s；取 15s 兼顾上游喘息
const BURST_COOLDOWN_MAX_MS = 2 * 60 * 60_000; // retry-after 异常巨大时兜底 2h，防止脏头封死账号

export function decide429Cooldown({ headers = {}, now = Date.now() } = {}) {
  const limits = parseCodexRateLimitHeaders(headers);
  const exhausted = [limits?.fiveHour, limits?.weekly]
    .filter((w) => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 100)
    .sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0];
  if (exhausted?.resetsAt && exhausted.resetsAt > now) {
    return {
      kind: 'window_exhausted',
      until: exhausted.resetsAt,
      windowMinutes: exhausted.windowMinutes || null,
      usedPercent: exhausted.usedPercent,
    };
  }
  const retryAfter = Number(headers['retry-after']);
  const cooldownMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, BURST_COOLDOWN_MAX_MS)
    : BURST_COOLDOWN_DEFAULT_MS;
  return {
    kind: 'burst',
    cooldownMs,
    maxUsedPercent: limits ? Math.max(
      limits.fiveHour?.usedPercent ?? 0,
      limits.weekly?.usedPercent ?? 0,
    ) : null,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}
