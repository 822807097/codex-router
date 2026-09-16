// 网页池原生模式指标聚合器（治根改造 P5，2026-09-14）
// 纯内存滑动窗口：消费诊断事件流，按「本地日期键」累计近 N 天的
// 原生会话 / 文本协议 / 自动回落 / 裁决结果 / 上传失败 / 门面调用计数。
// 设计约束：
// - 只读旁路：observe 绝不抛异常、绝不写文件，随 flog 每事件调用零成本可忽略；
// - 容量防膨胀：日期键最多保留 days 天（超出淘汰最旧），单日键集合固定 8 个计数器；
// - 面板消费：snapshot() 供 /_admin/api/webpool/metrics 与订阅页原生工具模式卡片使用。

const METRIC_KEYS = [
  'nativeRequests', // chatgpt_web.tools_effective outcome=native
  'textProtocolRequests', // chatgpt_web.tools_effective outcome=text_protocol
  'nativeFallbacks', // webpool.native_fallback
  'verdictDone', // chatgpt_web.verdict outcome=done
  'verdictBlocked', // chatgpt_web.verdict outcome=blocked[:note]
  'uploadsFailed', // chatgpt_web.upload_failed
  'facadeCalls', // webpool_mcp.call（全部）
  'facadeCallFailures', // webpool_mcp.call ok=false
];

function emptyCounters() {
  const counters = {};
  for (const key of METRIC_KEYS) counters[key] = 0;
  return counters;
}

// 本地日期键（非 UTC）：面板与用户同时区，按日聚合以本机日历为准。
function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 创建网页池原生模式指标聚合器。
 * @param {{ days?: number, now?: () => number }} options
 *   - days：滑动窗口保留天数（默认 7，最小 1、最大 366）
 *   - now：时间源注入缝（测试用假时钟跨天断言）
 * @returns {{ observe(event: unknown): void, snapshot(): object }}
 */
export function createWebpoolMetrics({ days = 7, now = () => Date.now() } = {}) {
  const retention = Math.max(1, Math.min(366, Number(days) || 7));
  const timeSource = typeof now === 'function' ? now : () => Date.now();
  // dateKey('YYYY-MM-DD') -> { date, ...固定 8 计数器 }
  const byDate = new Map();
  let lastEventAt = 0;

  // 超容量时按日期键字典序（即时间序）淘汰最旧的日期，Map 键数恒 ≤ retention。
  function prune() {
    if (byDate.size <= retention) return;
    const keys = [...byDate.keys()].sort();
    for (const key of keys.slice(0, byDate.size - retention)) byDate.delete(key);
  }

  function dayBucket(dateKey) {
    let day = byDate.get(dateKey);
    if (!day) {
      day = { date: dateKey, ...emptyCounters() };
      byDate.set(dateKey, day);
      prune();
    }
    return day;
  }

  // 识别事件 → 生成 [计数键, 增量] 计划；未识别/形态不符返回 null（不建日期键，零膨胀）。
  function planFor(event) {
    const name = typeof event.event === 'string' ? event.event : '';
    switch (name) {
      case 'chatgpt_web.tools_effective':
        if (event.outcome === 'native') return [['nativeRequests', 1]];
        if (event.outcome === 'text_protocol') return [['textProtocolRequests', 1]];
        return null;
      case 'webpool.native_fallback':
        return [['nativeFallbacks', 1]];
      case 'chatgpt_web.verdict': {
        const outcome = typeof event.outcome === 'string' ? event.outcome : '';
        if (outcome === 'done') return [['verdictDone', 1]];
        if (outcome.startsWith('blocked')) return [['verdictBlocked', 1]]; // blocked / blocked:note
        return null;
      }
      case 'chatgpt_web.upload_failed':
        return [['uploadsFailed', 1]];
      case 'webpool_mcp.call':
        return event.ok === false
          ? [['facadeCalls', 1], ['facadeCallFailures', 1]]
          : [['facadeCalls', 1]];
      default:
        return null;
    }
  }

  function observe(event) {
    try {
      if (!event || typeof event !== 'object') return;
      const updates = planFor(event);
      if (!updates) return;
      const ts = Number(timeSource());
      if (!Number.isFinite(ts)) return;
      const day = dayBucket(localDateKey(ts));
      for (const [key, delta] of updates) day[key] += delta;
      lastEventAt = ts;
    } catch {
      // 指标旁路：任何异常都不允许外泄到日志链路
    }
  }

  function snapshot() {
    const dayKeys = [...byDate.keys()].sort();
    const days = dayKeys.map((key) => {
      const day = byDate.get(key);
      const out = { date: key, ...emptyCounters() };
      for (const metric of METRIC_KEYS) out[metric] = Number(day?.[metric]) || 0;
      return out;
    });
    const totals = emptyCounters();
    for (const day of days) {
      for (const metric of METRIC_KEYS) totals[metric] += day[metric];
    }
    return {
      days,
      totals,
      lastEventAt,
      updatedAt: Number(timeSource()) || 0,
    };
  }

  return { observe, snapshot };
}
