// ---------- 通道密钥池 ----------
// 同一通道（host 相同）挂多把订阅 key = 多账号轮换（sub2api account pool 的 key 维度等价物）。
// - 每把 key 有用户可调优先级（数字小者先试；同优先级内轮询均摊）
// - key 级冷却持久化到 SQLite（cooldown_until），重启不丢
// - 单请求只取一把 key（acquireKey 返回 pool 命中或 envKey 兜底，二选一）
// 安全约束：所有 SQL 走 db.mjs 预编译参数绑定；key 明文只驻留 SQLite 与进程内存，
// 列表导出经 maskKey 脱敏（前 6 后 4），不写日志、不落盘。

import { randomBytes } from 'node:crypto';
import { resolveQuotaRetryAt } from './model-quota-cooldown.mjs';

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const TOUCH_THROTTLE_MS = 60_000;
const KEY_ID_PREFIX = 'ckey_';
const MAX_LABEL_LENGTH = 120;

export function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 10) return '****';
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function newEntryId() {
  return `${KEY_ID_PREFIX}${randomBytes(10).toString('hex')}`;
}

export function createChannelKeyPool(options) {
  const {
    db,
    envKeySource,
    now = Date.now,
    log = () => {},
  } = options;

  // 同优先级组内的轮询起点：`${target}\u0000${priority}` -> 下一起始下标
  const rrCursor = new Map();
  const lastTouched = new Map(); // entryId -> 上次 last_used_at 写入时间（节流）

  function resolveEntryValue(entry) {
    if (!entry) return undefined;
    if (entry.kind === 'env_ref') {
      return envKeySource.getKey(entry.key_value);
    }
    return entry.key_value;
  }

  /**
   * 取该通道本请求应使用的一把 key。
   * 优先级升序找第一个有可用 key 的优先级组（跳过冷却中/环境变量解析失败的条目），
   * 组内轮询；池空/全冷却/全解析失败时回退 target.envKey 现有链路。
   * 返回 { value, source: 'pool'|'env', entryId? } 或 null（连 envKey 也没有）。
   */
  function acquireKey(target) {
    const targetName = target && (typeof target === 'string' ? target : target.name);
    if (!targetName) return null;
    const currentTime = now();
    const rows = dbListChannelKeysFor(targetName);

    // 按优先级分组，只保留未被冷却的条目
    const groups = new Map();
    for (const row of rows) {
      if (row.revoked || Number(row.cooldown_until) > currentTime) continue;
      const priority = Number(row.priority) || 0;
      if (!groups.has(priority)) groups.set(priority, []);
      groups.get(priority).push(row);
    }

    const priorities = Array.from(groups.keys()).sort((a, b) => a - b);
    for (const priority of priorities) {
      const group = groups.get(priority);
      // 环境变量引用解析失败的条目不可用，但继续保留同组其他条目
      const usable = group.filter((entry) => resolveEntryValue(entry));
      if (usable.length === 0) continue;
      const cursorKey = `${targetName}\u0000${priority}`;
      const start = rrCursor.get(cursorKey) || 0;
      const picked = usable[start % usable.length];
      rrCursor.set(cursorKey, (start + 1) % usable.length);
      touchEntry(picked.id);
      // env_ref 记录的是变量名（非凭据），原样输出便于诊断；plaintext 只输出掩码
      const logValue = picked.kind === 'env_ref' ? picked.key_value : maskKey(picked.key_value);
      log(`key pool hit [${targetName}] ${picked.kind}:${logValue} (p${priority})`);
      return { value: resolveEntryValue(picked), source: 'pool', entryId: picked.id };
    }

    // 池空/全冷却 → envKey 兜底（原链路不变）
    const fallbackName = typeof target === 'string' ? null : target?.envKey;
    if (fallbackName) {
      const fallbackValue = envKeySource.getKey(fallbackName);
      if (fallbackValue) return { value: fallbackValue, source: 'env' };
    }
    return null;
  }

  /**
   * acquireKey 返回 null 时给出精确缺因（错误路径专用，只读不落库）。
   * acquireKey 的 null 混淆了三种情形（全冷却时报「密钥池为空」误导诊断），这里还原：
   * - empty：通道在池中没有任何未吊销条目
   * - all_cooling：有条目但全部冷却中（earliestRecoveryAt = 最早恢复时间戳）
   * - env_ref_unresolved：有条目未冷却，但 env_ref 引用的环境变量全部解析失败
   * 与 acquireKey 同口径：池内可得或 envKey 兜底可得（acquireKey 不会失败）时返回 null。
   */
  function describeKeyShortfall(target) {
    const targetName = target && (typeof target === 'string' ? target : target.name);
    if (!targetName) return { reason: 'empty' };
    const rows = dbListChannelKeysFor(targetName).filter((row) => !row.revoked);
    if (rows.length === 0) {
      return envKeyFallbackAvailable(target) ? null : { reason: 'empty', totalKeys: 0, coolingCount: 0 };
    }
    const currentTime = now();
    const cooling = rows.filter((row) => Number(row.cooldown_until) > currentTime);
    const active = rows.filter((row) => Number(row.cooldown_until) <= currentTime);
    if (active.length === 0) {
      const shortfall = {
        reason: 'all_cooling',
        totalKeys: rows.length,
        coolingCount: cooling.length,
        earliestRecoveryAt: Math.min(...cooling.map((row) => Number(row.cooldown_until) || currentTime)),
      };
      return envKeyFallbackAvailable(target) ? null : shortfall;
    }
    if (!active.some((row) => resolveEntryValue(row))) {
      return envKeyFallbackAvailable(target)
        ? null
        : { reason: 'env_ref_unresolved', totalKeys: rows.length, coolingCount: cooling.length };
    }
    return null;
  }

  function envKeyFallbackAvailable(target) {
    const fallbackName = typeof target === 'string' ? null : target?.envKey;
    return Boolean(fallbackName && envKeySource.getKey(fallbackName));
  }

  function touchEntry(entryId) {
    const lastWrite = lastTouched.get(entryId);
    const currentTime = now();
    if (lastWrite && currentTime - lastWrite < TOUCH_THROTTLE_MS) return;
    lastTouched.set(entryId, currentTime);
    try {
      dbTouchChannelKeyFor(entryId, currentTime);
    } catch (error) {
      log(`key pool touch failed: ${error.message}`);
    }
  }

  // 429 分型（对齐官方账号池 decide429Cooldown 的思路）。判定优先级：
  // 1) 显式耗尽短语（周/月使用上限、余额不足、usage limit reached——含 Anthropic
  //    usage-limit 文案）→ exhausted：有重置时间冷到重置点，否则 2h 再探；
  // 2) 速率/频率/并发/每分钟配额（Google「Quota exceeded ... RequestsPerMinute」、
  //    Anthropic burst 的 rate_limit_error、智谱「速率限制」）→ burst：retry-after
  //    优先，否则 20s。注意 burst 判定必须后于显式耗尽——Anthropic 所有 429 的
  //    error.type 都是 rate_limit_error，先判 burst 会把真耗尽也吞进去（审查 #12）；
  //    而 bare「quota exceeded」必须在 per-minute 检查之后——否则 Google 每分钟
  //    配额报文被误判 exhausted 冷 2h（审查 #14）。
  // 3) bare quota exceeded/exhausted（无速率语境，多为日/月配额）→ exhausted；
  // 4) 其余 → unknown：5min 旧行为。
  const BURST_COOLDOWN_MS = 20_000;
  const EXHAUSTED_COOLDOWN_MS = 2 * 60 * 60_000;
  function classifyKeyCooldown(bodyText) {
    const text = typeof bodyText === 'string' ? bodyText.slice(0, 4096) : '';
    if (!text) return 'unknown';
    if (/使用上限|额度不足|余额不足|insufficient[_ -]?(?:quota|balance|funds)|billing[_ -]?(?:hard[_ -]?)?limit|usage[_ -]?limit[_ -]?(?:reached|exceeded)|usagelimiterror|reached your (?:usage|weekly|monthly|plan)[_ ]?limit/i.test(text)) {
      return 'exhausted';
    }
    if (/per[- ]?(?:minute|second)|requests?\s*per\s*(?:minute|second)|\brpm\b|\btpm\b|并发|请求频率|速率限制|请求过于频繁|too many requests|rate[_ -]?limit/i.test(text)) {
      return 'burst';
    }
    if (/quota[_ -]?(?:exceeded|exhausted)|配额.{0,6}(?:超|耗尽)/i.test(text)) return 'exhausted';
    return 'unknown';
  }

  /**
   * key 级冷却落库：上游 401/429 后调用。
   * retryAt 未显式传入时按分型解析：先走配额解析器（retry-after 头 → 结构化字段 →
   * 报文重置时间），解析不到按分型给兜底时长（burst 20s / exhausted 2h / 未知 5min）。
   * note 未显式传入时从错误体提炼额度类型摘要。
   */
  function markKeyCooldown(entryId, { retryAt = null, note = '', headers = {}, bodyText = '' } = {}) {
    if (!entryId) return null;
    let fallbackMs = DEFAULT_COOLDOWN_MS;
    let resolvedRetryAt = retryAt;
    if (!resolvedRetryAt) {
      const kind = classifyKeyCooldown(bodyText);
      resolvedRetryAt = resolveQuotaRetryAt({ headers, bodyText, now });
      if (!resolvedRetryAt) {
        // 嵌套三元改为查表（项目风格规约，审查 #13）
        const fallbackByKind = { burst: BURST_COOLDOWN_MS, exhausted: EXHAUSTED_COOLDOWN_MS, unknown: DEFAULT_COOLDOWN_MS };
        fallbackMs = fallbackByKind[kind] || DEFAULT_COOLDOWN_MS;
      }
    }
    const until = resolvedRetryAt || now() + fallbackMs;
    let effectiveNote = note;
    if (!effectiveNote && typeof bodyText === 'string' && bodyText) {
      try {
        const parsed = JSON.parse(bodyText.slice(0, 64 * 1024));
        const message = parsed?.error?.message || parsed?.message;
        if (typeof message === 'string' && message.trim()) {
          effectiveNote = message.trim().slice(0, 120);
        }
      } catch { /* 非 JSON 错误体不提炼 */ }
    }
    dbMarkChannelKeyCooldownFor(entryId, until, effectiveNote);
    log(`key pool cooldown [${entryId}] until ${new Date(until).toISOString()}${effectiveNote ? ` (${effectiveNote})` : ''}`);
    return until;
  }

  function clearKeyCooldown(entryId) {
    if (!entryId) return;
    dbClearChannelKeyCooldownFor(entryId);
    lastTouched.delete(entryId);
  }

  // ---------- 管理操作（全部经 db.mjs 参数绑定） ----------

  function listWithCooldown(targetName = null) {
    const currentTime = now();
    const rows = targetName ? dbListChannelKeysFor(targetName) : dbListAllChannelKeysFor();
    return rows.map((row) => {
      const cooled = Number(row.cooldown_until) > currentTime;
      const envResolved = row.kind === 'env_ref'
        ? Boolean(envKeySource.getKey(row.key_value))
        : null;
      return {
        id: row.id,
        target: row.target,
        kind: row.kind,
        label: row.label,
        maskedKey: maskKey(row.key_value),
        // env_ref 的 key_value 是变量名，直接展示变量名（非密钥）
        refName: row.kind === 'env_ref' ? row.key_value : null,
        priority: Number(row.priority) || 0,
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at || 0),
        cooldown: cooled ? {
          active: true,
          retryAt: Number(row.cooldown_until),
          remainingMs: Number(row.cooldown_until) - currentTime,
          note: row.cooldown_note || '',
        } : { active: false, retryAt: 0, remainingMs: 0, note: '' },
        envResolved,
      };
    });
  }

  // 池内最早恢复时间（用于「全部账号耗尽」报错与通道卡片汇总）
  function earliestRetryAt(targetName) {
    const currentTime = now();
    const rows = dbListChannelKeysFor(targetName);
    let earliest = 0;
    for (const row of rows) {
      if (row.revoked) continue;
      const until = Number(row.cooldown_until);
      if (until > currentTime && (earliest === 0 || until < earliest)) earliest = until;
    }
    return earliest;
  }

  function createEntry({ target, kind, label, key, priority = 0 }) {
    const id = newEntryId();
    dbCreateChannelKeyFor({
      id,
      target: String(target),
      kind: kind === 'env_ref' ? 'env_ref' : 'plaintext',
      label: label ? String(label).slice(0, MAX_LABEL_LENGTH) : '',
      key_value: String(key),
      priority,
    });
    return id;
  }

  function updateEntry(id, patch = {}) {
    const changed = dbUpdateChannelKeyFor(id, patch);
    // 覆写 key 或切换形态后冷却状态不再可靠，一并清除
    if (changed && (patch.key_value !== undefined || patch.kind !== undefined)) {
      clearKeyCooldown(id);
    }
    return changed;
  }

  function revokeEntry(id) {
    dbRevokeChannelKeyFor(id);
    lastTouched.delete(id);
  }

  function getEntry(id) {
    const row = dbGetChannelKeyFor(id);
    if (!row) return null;
    return {
      id: row.id,
      target: row.target,
      kind: row.kind,
      label: row.label,
      key_value: row.key_value,
      priority: Number(row.priority) || 0,
      cooldownUntil: Number(row.cooldown_until || 0),
      revoked: Boolean(row.revoked),
    };
  }

  return {
    acquireKey,
    describeKeyShortfall,
    markKeyCooldown,
    clearKeyCooldown,
    listWithCooldown,
    earliestRetryAt,
    createEntry,
    updateEntry,
    revokeEntry,
    getEntry,
  };
}

// 与 db.mjs 的间接对接：延迟取 getDatabase()，避免模块加载期初始化数据库
import {
  dbCreateChannelKey,
  dbListChannelKeys,
  dbGetChannelKey,
  dbUpdateChannelKey,
  dbRevokeChannelKey,
  dbMarkChannelKeyCooldown,
  dbClearChannelKeyCooldown,
  dbTouchChannelKey,
} from './db.mjs';

const dbCreateChannelKeyFor = (entry) => dbCreateChannelKey(entry);
const dbListChannelKeysFor = (target) => dbListChannelKeys(target);
const dbListAllChannelKeysFor = () => dbListChannelKeys(null);
const dbGetChannelKeyFor = (id) => dbGetChannelKey(id);
const dbUpdateChannelKeyFor = (id, patch) => dbUpdateChannelKey(id, patch);
const dbRevokeChannelKeyFor = (id) => dbRevokeChannelKey(id);
const dbMarkChannelKeyCooldownFor = (id, until, note) => dbMarkChannelKeyCooldown(id, until, note);
const dbClearChannelKeyCooldownFor = (id) => dbClearChannelKeyCooldown(id);
const dbTouchChannelKeyFor = (id, ts) => dbTouchChannelKey(id, ts);
