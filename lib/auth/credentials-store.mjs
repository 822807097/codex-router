import fs from 'node:fs';
import path from 'node:path';

/**
 * 零凭据泄露安全存储驱动
 * - 凭据优先从环境变量或系统安全存储读取
 * - 磁盘状态文件仅保留脱敏元数据，防止凭据落盘泄露
 */
export function createCredentialsStore(options = {}) {
  const persistPath = options.persistPath || null;

  function loadAccounts() {
    if (!persistPath || !fs.existsSync(persistPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      return Array.isArray(data.accounts) ? data.accounts : [];
    } catch {
      return [];
    }
  }

  function saveAccounts(accounts) {
    if (!persistPath) return;
    try {
      const dir = path.dirname(persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // 仅存储脱敏数据和非密钥配置
      const sanitizedAccounts = accounts.map((acc) => ({
        id: acc.id,
        provider: acc.provider,
        alias: acc.alias,
        status: acc.status,
        metadata: acc.metadata,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      }));

      fs.writeFileSync(
        persistPath,
        JSON.stringify({ accounts: sanitizedAccounts, updatedAt: Date.now() }, null, 2),
        'utf8',
      );
    } catch {
      // 存储旁路不阻塞运行时
    }
  }

  return {
    loadAccounts,
    saveAccounts,
  };
}

/**
 * 订阅账号凭据保险库：授权得到的 OAuth refresh/access token 的唯一持久化位置。
 * - 元数据继续留在 SQLite accounts 表；本文件只存凭据本体
 * - 原子写（tmp + rename），避免进程崩溃写坏文件
 * - 与 config.json / router.db 同目录同级保护，不进版本库
 */
export function createCredentialsVault(options = {}) {
  const vaultPath = options.vaultPath;

  // 内存缓存：磁盘是持久化层，进程内以缓存为权威，避免每次 set 全量读盘。
  // 全部操作同步（fs 同步调用），JS 单线程天然串行，无并发覆盖风险。
  let cached = null;
  // 损坏标记：vault 文件不可解析时置位——set() 拒绝全量覆盖（见下），防止
  // 「损坏恢复路径」变成「损坏放大路径」：基于空缓存 persistAll 会把其余全部
  // 账号的 refresh token 永久抹掉。原文件已改名 .corrupt-<ts> 保全证据。
  let poisoned = false;

  function loadAll() {
    if (cached !== null) return cached;
    if (!vaultPath || !fs.existsSync(vaultPath)) {
      cached = {};
      return cached;
    }
    try {
      const data = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        markCorrupted('vault 根节点不是对象');
        cached = {};
        return cached;
      }
      // loadAll 必须返回「accountId -> 凭据」纯 map；磁盘格式为 { updatedAt, accounts }。
      // 兼容历史双重包装损坏：accounts 里再嵌一层 { updatedAt, accounts } 时递归解开，
      // 并把误挂在外层的凭据条目（值含已知凭据键的对象）合并回来。
      // 凭据识别键必须覆盖全部 provider 形态：openai/google/claude 是 accessToken/
      // refreshToken，copilot 只有 githubToken（2026-10 引入，曾因识别遗漏被启动
      // 加载静默丢弃——重启后 copilot 账号凭据变空、refresher 报缺 token 死循环）。
      const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'githubToken', 'copilotToken'];
      const looksLikeCredential = (value) => value && typeof value === 'object'
        && !Array.isArray(value)
        && CREDENTIAL_KEYS.some((key) => key in value);
      // 历史缺陷曾把 loadAll 的外层包装整个写回，每写一次多嵌套一层
      // { updatedAt, accounts }；循环剥壳直到没有 accounts 包装，逐层收齐
      // 误挂的凭据条目（深层较新，覆盖浅层同 id 旧值）。
      const merged = {};
      let layer = data;
      for (let depth = 0; depth < 16 && layer && typeof layer === 'object' && !Array.isArray(layer); depth += 1) {
        for (const [id, value] of Object.entries(layer)) {
          if (id !== 'updatedAt' && id !== 'accounts' && looksLikeCredential(value)) {
            merged[id] = value;
          }
        }
        layer = layer.accounts && typeof layer.accounts === 'object' && !Array.isArray(layer.accounts)
          ? layer.accounts
          : null;
      }
      cached = merged;
      return cached;
    } catch {
      markCorrupted('vault JSON 解析失败');
      cached = {};
      return cached;
    }
  }

  // 损坏保全：原文件改名留证 + poisoned 标记。改名失败（权限/只读卷）不阻塞启动，
  // 但 poisoned 仍置位——宁可 set() 拒写也不能让空缓存覆盖全库。
  function markCorrupted(reason) {
    poisoned = true;
    try {
      if (vaultPath && fs.existsSync(vaultPath)) {
        fs.renameSync(vaultPath, `${vaultPath}.corrupt-${Date.now()}`);
      }
    } catch { /* 改名失败不影响 poisoned 语义 */ }
    // stderr 直写：vault 是凭据唯一持久层，损坏必须有人看见（进程日志兜底）
    try { console.error(`[vault] 凭据库损坏（${reason}），已保全原文件并锁定全量写入；set() 将只允许显式重建`); } catch { /* 旁路 */ }
  }

  function persistAll(map) {
    if (!vaultPath) return;
    try {
      const dir = path.dirname(vaultPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // tmp 与正式文件统一 0o600：vault 内是 OAuth token 明文，权限基线对齐
      // json-file-store（POSIX 下默认 0666&umask 过宽；Windows 上该位无实际效果）
      const tmpPath = `${vaultPath}.tmp`;
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ updatedAt: Date.now(), accounts: map }, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, vaultPath);
    } catch {
      // 存储旁路不阻塞运行时
    }
  }

  // 变更操作保持同步契约（调用方不 await）；缓存 map 就地修改后写盘。
  return {
    get(accountId) {
      return loadAll()[accountId] || null;
    },
    set(accountId, credentials) {
      // poisoned 态：磁盘内容已不可信（原文件已改名保全），基于空缓存的 persistAll
      // 会把其余全部账号凭据抹掉。拒绝写入并抛错——调用方（授权/刷新链）会把
      // 错误冒给用户，由人工确认 .corrupt-* 备份后再决定恢复方式。
      if (poisoned) {
        throw new Error('vault 已损坏（原文件已保全为 .corrupt-*），拒绝全量写入；请人工恢复后再操作');
      }
      const map = loadAll();
      map[accountId] = credentials || {};
      persistAll(map);
    },
    delete(accountId) {
      if (poisoned) {
        throw new Error('vault 已损坏（原文件已保全为 .corrupt-*），拒绝全量写入；请人工恢复后再操作');
      }
      const map = loadAll();
      if (!(accountId in map)) return;
      delete map[accountId];
      persistAll(map);
    },
    loadAll,
    /** 损坏探测（供启动自检/面板告警）：true = 原文件已改名保全、写入口已锁 */
    isPoisoned() {
      return poisoned;
    },
  };
}
