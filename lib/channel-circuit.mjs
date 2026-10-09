// 通道级熔断器（2026-10-03，吸收 webcodex 渠道路由的设计而非代码）：
// 现有故障转移粒度是「请求内换 key / 换号」，粒度到凭据为止；上游主机整体不可达
// （连接超时 / TLS 失败 / 连续 5xx）时每个请求仍会先撞一次坏通道，白付首字延迟。
// 本模块按 target 维护 closed / open / half-open 三态：
//   - 连续 N 次传输级失败 → open openMs 毫秒，期间候选预检直接跳过该通道；
//   - openUntil 过后 allow() 放行（视为 half-open 探测），成功即 closed；
//   - 全部候选都在 open 时绝不因熔断直接 503：调用方兜底放行一个探测。
// 计数边界（有意为之，避免与既有状态机双重惩罚）：
//   - 429 不计数——额度语义归 channel-key-pool 分型冷却与账号池状态机；
//   - 401/403/400 等明确应答视为「通道可达」→ 归零连败（配置错误靠面板告警暴露）；
//   - 客户端主动取消（AbortError）不计数。
// 状态存内存（进程级单例，由 codex-router.mjs 创建后注入路由与管理面）：
// 熔断是短周期信号，持久化反而会让重启后延续过期判断。

const DEFAULTS = Object.freeze({
  enabled: true,
  failureThreshold: 3,
  openMs: 30_000,
});

function normalizeErrorText(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function createChannelCircuit(options = {}) {
  const settings = {
    enabled: options.enabled !== false,
    failureThreshold: Math.max(1, Number(options.failureThreshold) || DEFAULTS.failureThreshold),
    openMs: Math.max(100, Number(options.openMs) || DEFAULTS.openMs),
  };
  // targetName -> { state, consecutiveFailures, openUntil, lastError, lastLatencyMs, lastCheckedAt }
  const channels = new Map();

  function entry(name) {
    let item = channels.get(name);
    if (!item) {
      item = { state: 'closed', consecutiveFailures: 0, openUntil: 0, lastError: '', lastLatencyMs: null, lastCheckedAt: null };
      channels.set(name, item);
    }
    return item;
  }

  /** 候选预检：open 且未到期的通道返回 false（跳过）；到期的转 half-open 并放行。 */
  function allow(name) {
    if (!settings.enabled) return true;
    const item = entry(name);
    if (item.state === 'open' && item.openUntil > Date.now()) return false;
    if (item.state === 'open') item.state = 'half-open';
    return true;
  }

  function markSuccess(name, latencyMs = null) {
    const item = entry(name);
    item.state = 'closed';
    item.consecutiveFailures = 0;
    item.openUntil = 0;
    item.lastError = '';
    if (Number.isFinite(Number(latencyMs))) item.lastLatencyMs = Number(latencyMs);
    item.lastCheckedAt = new Date().toISOString();
  }

  /** 传输级失败（连接超时 / 5xx / 408 / 响应头前断连）计一次连败。 */
  function markFailure(name, error, latencyMs = null) {
    const item = entry(name);
    item.consecutiveFailures += 1;
    item.lastError = normalizeErrorText(error);
    if (Number.isFinite(Number(latencyMs))) item.lastLatencyMs = Number(latencyMs);
    item.lastCheckedAt = new Date().toISOString();
    if (item.consecutiveFailures >= settings.failureThreshold) {
      item.state = 'open';
      item.openUntil = Date.now() + settings.openMs;
    }
  }

  /** 上游给出明确非限流应答（4xx）或调用方判定为本地配置错误：通道可达，归零连败。 */
  function markReachable(name) {
    const item = entry(name);
    if (item.consecutiveFailures > 0 || item.state !== 'closed') {
      item.state = 'closed';
      item.consecutiveFailures = 0;
      item.openUntil = 0;
      item.lastCheckedAt = new Date().toISOString();
    }
  }

  function reset(name) {
    channels.delete(name);
  }

  function resetAll() {
    channels.clear();
  }

  /**
   * 路由主循环的统一观察入口：按上游状态码归类，避免调用方散落判断。
   *   2xx/3xx → 成功；429 → 忽略（额度语义归 key/账号状态机）；
   *   408/5xx → 失败；其余 4xx → 可达归零。
   */
  function observeUpstream(name, status, latencyMs = null) {
    if (!settings.enabled) return;
    const code = Number(status);
    if (!code) return;
    if (code >= 200 && code < 400) return markSuccess(name, latencyMs);
    if (code === 429) return;
    if (code === 408 || code >= 500) return markFailure(name, `HTTP ${code}`, latencyMs);
    return markReachable(name);
  }

  /**
   * catch 路径的统一观察入口：只认传输级失败与上游 5xx；429/401 有各自状态机；
   * 明确 4xx 应答 = 通道可达；AbortError / 本地配置缺失（env_key_missing）忽略。
   */
  function observeError(name, error, { isRetryable = () => false } = {}) {
    if (!settings.enabled) return;
    if (error?.name === 'AbortError') return;
    if (error?.code === 'env_key_missing' || error?.code === 'model_quota_cooldown') return;
    const status = Number(error?.status);
    if (status === 429 || status === 401 || status === 403) return;
    if (status && status >= 400 && status < 500) return markReachable(name);
    if ((status && (status === 408 || status >= 500)) || (!status && isRetryable(error))) {
      return markFailure(name, error);
    }
  }

  /** 管理面快照：全部通道 + 派生可读状态。 */
  function snapshot() {
    const now = Date.now();
    const items = [];
    for (const [name, item] of channels) {
      const isOpen = item.state === 'open' && item.openUntil > now;
      items.push({
        target: name,
        state: isOpen ? 'open' : item.state === 'half-open' ? 'half-open' : 'closed',
        consecutiveFailures: item.consecutiveFailures,
        openUntil: isOpen ? item.openUntil : 0,
        openRemainingMs: isOpen ? item.openUntil - now : 0,
        lastError: item.lastError,
        lastLatencyMs: item.lastLatencyMs,
        lastCheckedAt: item.lastCheckedAt,
      });
    }
    items.sort((a, b) => a.target.localeCompare(b.target));
    return {
      enabled: settings.enabled,
      failureThreshold: settings.failureThreshold,
      openMs: settings.openMs,
      channels: items,
      openCount: items.filter((item) => item.state === 'open').length,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    allow,
    markSuccess,
    markFailure,
    markReachable,
    observeUpstream,
    observeError,
    reset,
    resetAll,
    snapshot,
    settings,
  };
}
