// 最近请求统计环（2026-10-03，吸收 webcodex 的 bounded-stats 设计）：
// token_logs 只记用量，「最近 N 个请求最终落在哪个通道、failover 了几次、
// 败在哪」要翻日志文件才能拼出来。本模块在内存里维护固定容量环形数组，
// 管理面直接读；重启即清零（排障看的是当下，不值得落库）。
// 只存摘要：错误文本统一截断，避免坏上游的超长错误体吃内存。

export const STATS_RING_DEFAULT_LIMIT = 500;
const ERROR_TEXT_LIMIT = 300;

function clipText(value, limit = ERROR_TEXT_LIMIT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function createStatsRing(limit = STATS_RING_DEFAULT_LIMIT) {
  const capacity = Math.max(1, Math.min(5_000, Number(limit) || STATS_RING_DEFAULT_LIMIT));
  const entries = [];

  /**
   * 记录一条请求终态。字段全部由调用方给齐（路由出口两处收口），
   * 这里只做类型修剪，保证环形数组不会因脏字段膨胀。
   */
  function record(entry = {}) {
    entries.push({
      id: String(entry.id || '').slice(0, 64),
      at: Number(entry.at) || Date.now(),
      model: clipText(entry.model, 120),
      target: clipText(entry.target, 120),
      status: Number(entry.status) || 0,
      ok: Boolean(entry.ok),
      durationMs: Math.max(0, Number(entry.durationMs) || 0),
      attempts: Math.max(1, Number(entry.attempts) || 1),
      failovers: Math.max(0, Number(entry.failovers) || 0),
      errorCode: clipText(entry.errorCode, 80),
      error: clipText(entry.error),
      stream: Boolean(entry.stream),
    });
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
  }

  function list({ limit = 100, ok, target } = {}) {
    const max = Math.max(1, Math.min(capacity, Number(limit) || 100));
    let items = entries;
    if (ok === true) items = items.filter((item) => item.ok);
    if (ok === false) items = items.filter((item) => !item.ok);
    if (target) items = items.filter((item) => item.target === String(target).slice(0, 120));
    return {
      total: entries.length,
      capacity,
      items: items.slice(-max).reverse(),
    };
  }

  function summary() {
    const now = Date.now();
    const buckets = [
      { label: '5m', since: now - 5 * 60_000 },
      { label: '1h', since: now - 60 * 60_000 },
    ];
    return buckets.map(({ label, since }) => {
      const recent = entries.filter((item) => item.at >= since);
      const failed = recent.filter((item) => !item.ok);
      const totalMs = recent.reduce((sum, item) => sum + item.durationMs, 0);
      return {
        window: label,
        total: recent.length,
        failed: failed.length,
        avgDurationMs: recent.length ? Math.round(totalMs / recent.length) : 0,
        failovers: recent.reduce((sum, item) => sum + item.failovers, 0),
      };
    });
  }

  function clear() {
    entries.length = 0;
  }

  return { record, list, summary, clear, capacity };
}
