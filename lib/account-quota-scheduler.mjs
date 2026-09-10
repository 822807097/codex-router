// ---------- W1 主动配额感知调度器（2026-09-08） ----------
// 零流量/低流量官方订阅账号的额度盲区由周期探测收口：probeCodexRateLimits 发一条
// 最小请求、响应头一到立即断开（不消耗生成输出），解析 5h/周两个额度窗口写回
// metadata.rateLimits——与 router-handler 被动学习（captureCodexRateLimits）同一
// 存储位，面板与选号从此读同一份快照。
// 兼职 W2 恢复探测：suspect 账号探测成功 → recordAccountSuccess 立即复活，
// 不必等退避期自然到期。auth_expired 账号不探测（等人工重新授权）。
// 全部动作串行错峰；探测失败计 suspect，但网络类瞬时错误不计数（代理抖动常见，
// 不该让账号背锅——与 handler 侧瞬时判据同源）。

import { probeCodexRateLimits } from './account-quota.mjs';

const DEFAULT_INTERVAL_MIN = 30;
const JITTER_RATIO = 0.2; // ±20% 抖动，避免多实例同时打上游
const PROBE_GAP_MS = 1_500; // 同一轮多账号探测的间隔
// 网络类瞬时错误判据：与 router-handler 账号刷新路径同源（超时/断连/DNS）
const TRANSIENT_NETWORK_RE = /timeout|timed? out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed|socket hang up/i;

export function createAccountQuotaScheduler(options = {}) {
  const {
    authManager,
    log = () => {},
    probe = probeCodexRateLimits,
    intervalMinutes = DEFAULT_INTERVAL_MIN,
    proxy = undefined,
    now = Date.now,
  } = options;

  const intervalMs = Math.max(5, Number(intervalMinutes) || DEFAULT_INTERVAL_MIN) * 60_000;
  let timer = null;
  let probing = false;
  let stopped = false;

  function pickCandidates() {
    const currentTime = now();
    return authManager.listAccounts({ sanitized: false }).filter((acc) => {
      if (acc.provider !== 'openai') return false;
      if (acc.status === 'auth_expired') return false; // 等人工重新授权，探测无意义
      if (!acc.credentials || Object.keys(acc.credentials).length === 0) return false;
      // 快照仍新鲜（实时流量或近期探测刚写入）→ 跳过
      const updatedAt = Number(acc.metadata?.rateLimits?.updatedAt) || 0;
      if (updatedAt && currentTime - updatedAt < intervalMs) return false;
      return acc.status === 'active' || acc.status === 'suspect';
    });
  }

  async function probeAccount(acc) {
    const currentTime = now();
    // getValidCredentials 内部含临期刷新与 401→markAuthExpired 联动
    const creds = await authManager.getValidCredentials(acc.id);
    if (!creds?.accessToken) throw new Error('账号没有可用凭据，请重新授权');
    const accountIdHeader = acc.metadata?.chatgptAccountId || creds.accountId || '';
    const limits = await probe({
      accessToken: creds.accessToken,
      accountId: accountIdHeader,
      proxy: acc.proxy?.enabled && acc.proxy.url ? acc.proxy.url : proxy,
    });
    // 探测窗口内真实流量可能已更新 metadata（rateLimits/suspectCount）：
    // 取最新账号对象合并，不用探测前的旧快照覆盖回去
    const fresh = authManager.getAccount(acc.id) || acc;
    if (!limits) {
      // 中性结果：该套餐本就不回额度头（如 free），不算失败不计 suspect，
      // 只记一次探测时间防止每轮重复空打
      authManager.updateAccount(acc.id, {
        metadata: { ...(fresh.metadata || {}), rateLimits: { ...(fresh.metadata?.rateLimits || {}), updatedAt: currentTime } },
      });
      authManager.persistAccount?.(acc.id);
      return null;
    }
    authManager.updateAccount(acc.id, {
      metadata: { ...(fresh.metadata || {}), rateLimits: { ...limits, updatedAt: currentTime } },
    });
    // 探测成功即恢复派发资格：清零 suspect 连败计数并复活 suspect 账号
    authManager.recordAccountSuccess?.(acc.id);
    // 快照落库：重启后调度成果不丢（与被动学习共用 metadata.rateLimits 存储位）
    authManager.persistAccount?.(acc.id);
    return limits;
  }

  async function probeOne(acc) {
    try {
      await probeAccount(acc);
      log({ event: 'account.quota_probe', account: acc.id, ok: true, status: acc.status });
      return true;
    } catch (error) {
      const message = String(error?.message || error || 'unknown');
      if (error?.status === 401) {
        // getValidCredentials 已 markAuthExpired；此处只记录
        log({ event: 'account.quota_probe', account: acc.id, ok: false, reason: 'auth_expired_during_probe' });
        return false;
      }
      if (!TRANSIENT_NETWORK_RE.test(message)) {
        // 非网络类失败（凭据缺失/上游明确拒绝）计入 suspect 连败，3 次升级退避
        authManager.recordAccountFailure?.(acc.id, `额度探测失败: ${message.slice(0, 140)}`);
      }
      log({ event: 'account.quota_probe', account: acc.id, ok: false, reason: message.slice(0, 160) });
      return false;
    }
  }

  async function tick() {
    if (probing || stopped) return 0;
    probing = true;
    try {
      const candidates = pickCandidates();
      let ok = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (stopped) break;
        if (await probeOne(candidates[i])) ok += 1;
        // 错峰：同一轮多账号之间留间隔，避免探测请求扎堆
        if (i < candidates.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, PROBE_GAP_MS));
        }
      }
      return ok;
    } finally {
      probing = false;
    }
  }

  // 周期 = interval ± 20% 抖动；setTimeout 链式自排程，unref 不阻碍进程自然退出
  function scheduleNext() {
    if (stopped) return;
    const delay = Math.round(intervalMs * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
    timer = setTimeout(async () => {
      timer = null;
      try { await tick(); } catch { /* 旁路 */ }
      scheduleNext();
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (timer || stopped) return;
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tick,
    status() {
      return { stopped, probing, intervalMs };
    },
  };
}
