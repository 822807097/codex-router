// ============================================================================
// claude-desktop-manager.mjs — Claude Desktop 接入管理（管理面板后端）
// ----------------------------------------------------------------------------
// 与 codex-desktop 管理组对齐的 Claude Desktop 管理能力：
//   · 状态检测（跨平台）：安装路径/版本、进程是否运行
//       macOS:   /Applications/Claude.app（Info.plist 读版本）
//       Windows: %LOCALAPPDATA%\AnthropicClaude\claude.exe（app-<ver> 目录读版本）
//       Linux:   无官方桌面端，社区构建（deb/AppImage/AUR）按常见路径尽力检测
//   · 网关接入感知：Desktop 的网关配置经 Chromium safeStorage 加密落盘，路由
//     侧不可读写；改用「流量感知」——Anthropic 适配器（anthropic-adapter.mjs）
//     的 anthropic.* 事件全部喂进本管理器，最近 24h 有 /v1/messages 流量即认为
//     已接入，比读文件更可靠（配置生效与否以真实请求为准）。
//   · 暴露模型与别名管理（claude-desktop.json，路由重启后保留）：
//       exposed: null=全部目录模型；数组=白名单（Desktop 模型列表只显示这些）
//       aliases: { 真实模型ID: 自定义别名 }，缺省用 claude-<8hex>（sha1 派生）。
//       别名规则 ^claude-[a-z0-9]{1,40}$（Desktop 会把带连字符的后缀解析为版本号，
//       且 ≥1.7196.0 拒绝含第三方关键词的 ID，故统一 claude-* 单 token）。
//     适配器每次请求经 getAliasEntries 实时读取，保存即生效，无需重启路由。
//   · 用量统计：请求数/错误数/token、按真实模型的明细、最近事件环形缓冲
//   · 连通性探活：经 127.0.0.1 回环打一次真实 /v1/messages（与 Desktop 同路径）
//   · 重启桌面端：macOS pkill+open -a / Windows taskkill+spawn / Linux 尽力+
//     手动打开提示（对齐 lib/desktop-process.mjs 的 Codex 模式）
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';

const RING_BUFFER_MAX = 50;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const LINUX = process.platform === 'linux';
// 平台显示名查表（项目风格规约禁嵌套三元，审查 #6）
const PLATFORM_NAME_MAP = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const PLATFORM_NAME = PLATFORM_NAME_MAP[process.platform] || process.platform;

// Desktop 进程/安装位置（跨平台）。Windows 官方安装器落在 %LOCALAPPDATA%\AnthropicClaude；
// Linux 无官方桌面端，按社区构建（deb/AppImage/AUR claude-desktop）常见位置尽力检测。
const CANDIDATES = MAC
  ? {
      appPaths: ['/Applications/Claude.app', `${os.homedir()}/Applications/Claude.app`],
      plist: (appPath) => `${appPath}/Contents/Info.plist`,
      processPatterns: ['Claude.app/Contents/MacOS/Claude'],
      launch: () => spawn('open', ['-a', 'Claude'], { stdio: 'ignore' }),
      launchFallbackNote: '若未拉起请手动打开 Claude',
    }
  : WIN
    ? {
        appPaths: [
          path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AnthropicClaude', 'claude.exe'),
        ],
        plist: null,
        processPatterns: ['AnthropicClaude'],
        launch: () => {
          const exe = CANDIDATES.appPaths.find((p) => fs.existsSync(p));
          if (!exe) return null;
          const child = spawn(exe, [], { stdio: 'ignore', detached: true, windowsHide: true });
          child.once('error', () => { /* 拉起失败按文案手动打开 */ });
          child.unref?.();
          return child;
        },
        launchFallbackNote: '若未拉起请手动打开 Claude',
      }
    : {
        appPaths: [
          '/usr/share/claude-desktop',
          '/opt/Claude',
          '/opt/claude-desktop',
          `${os.homedir()}/.local/share/applications/claude-desktop.desktop`,
          `${os.homedir()}/Applications/claude-desktop.AppImage`,
        ],
        plist: null,
        processPatterns: ['claude-desktop', '/claude( |$)', '/Claude( |$)'],
        launch: null, // Linux 无统一入口：返回 unsupported 由前端提示手动打开
        launchFallbackNote: 'Linux 无统一桌面入口，请手动打开 Claude（社区构建）',
      };

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout || '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

function readInstalledInfo() {
  const appPath = CANDIDATES.appPaths.find((p) => fs.existsSync(p));
  if (!appPath) return { installed: false, platform: PLATFORM_NAME };
  let version = '';
  try {
    if (CANDIDATES.plist) {
      const plist = fs.readFileSync(CANDIDATES.plist(appPath), 'utf8');
      version = (plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || '';
    } else if (WIN) {
      // Squirrel 布局：app-<version> 子目录名即版本；按数值取最新（字典序会把
      // app-1.10.x 排在 app-1.9.x 前，误报旧版）
      const parent = path.dirname(appPath);
      const versionOf = (name) => name.replace(/^app-/, '').split(/[.\-]/).map((n) => Number(n) || 0);
      const dirs = fs.readdirSync(parent)
        .filter((name) => /^app-\d+\.\d+/.test(name))
        .sort((a, b) => {
          const A = versionOf(a);
          const B = versionOf(b);
          for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
            const diff = (A[i] || 0) - (B[i] || 0);
            if (diff) return diff;
          }
          return 0;
        });
      version = (dirs[dirs.length - 1] || '').replace(/^app-/, '');
    } else if (LINUX) {
      const desktopFile = appPath.endsWith('.desktop') ? appPath
        : path.join(appPath, 'claude-desktop.desktop');
      if (fs.existsSync(desktopFile)) {
        const text = fs.readFileSync(desktopFile, 'utf8');
        version = (text.match(/X-AppVersion=\s*([^\s]+)/) || text.match(/Version=\s*([^\s]+)/) || [])[1] || '';
      }
    }
  } catch { /* 版本读不到仅影响展示 */ }
  return { installed: true, version: String(version || '').trim(), appPath, platform: PLATFORM_NAME };
}

async function isRunning() {
  if (WIN) {
    const { ok, stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq claude.exe']);
    return ok && stdout.toLowerCase().includes('claude.exe');
  }
  for (const pattern of CANDIDATES.processPatterns) {
    const { ok, stdout } = await run('pgrep', ['-if', pattern], 4000);
    if (ok && stdout.trim()) return true;
  }
  return false;
}

// ---------- 暴露模型 / 别名 / 上下文 持久化（轻量原子写：temp + rename） ----------

// 别名两族：官方目录 role ID（claude-opus-4-8/sonnet-5/haiku-4-5-20251001/fable-5-1…
// 家族名+数字段，Desktop 原生识别、自带档位与 1M 计量）与旧自定义哈希（claude-6b6cb90c）。
// 此前只认哈希族——官方 role ID 在 loadStore/setAliases 两处都被过滤，别名表静默回退
// 到哈希槽位，把模型挂到已从目录下架的 ID 上，档位 UI 随之消失（2026-09-20 实锤）。
const ALIAS_RE = /^(?:claude-(?:opus|sonnet|haiku|fable)(?:-[0-9]{1,4}){1,3}|claude-[a-z0-9]{1,40})$/;
// Claude Desktop 的网关模型发现按 supports_1m 布尔或 max_input_tokens>=1M 判定
// 1M 变体（app.asar 解析器实锤）；上下文窗口本身随条目 max_input_tokens 传给
// Desktop 的上下文计量。

function loadStore(storePath) {
  const defaults = { exposed: null, aliases: {}, modelOptions: {} };
  try {
    if (!fs.existsSync(storePath)) return defaults;
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const aliases = (raw?.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases))
      ? Object.fromEntries(Object.entries(raw.aliases)
        .filter(([id, alias]) => typeof id === 'string' && typeof alias === 'string' && ALIAS_RE.test(alias)))
      : {};
    const exposed = Array.isArray(raw?.exposed)
      ? raw.exposed.filter((id) => typeof id === 'string' && id)
      : null;
    // modelOptions: { 模型ID: { maxInputTokens?: number, supports1m?: boolean } }
    const modelOptions = (raw?.modelOptions && typeof raw.modelOptions === 'object' && !Array.isArray(raw.modelOptions))
      ? Object.fromEntries(Object.entries(raw.modelOptions)
        .filter(([id, opt]) => typeof id === 'string' && opt && typeof opt === 'object')
        .map(([id, opt]) => [id, {
          ...(Number.isFinite(Number(opt.maxInputTokens)) && Number(opt.maxInputTokens) > 0
            ? { maxInputTokens: Math.floor(Number(opt.maxInputTokens)) }
            : {}),
          ...(typeof opt.supports1m === 'boolean' ? { supports1m: opt.supports1m } : {}),
        }]))
      : {};
    return { exposed, aliases, modelOptions };
  } catch {
    return defaults; // 损坏即回默认（全暴露 + 默认别名），不阻塞路由请求
  }
}

function saveStore(storePath, store) {
  const tmp = `${storePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, storePath);
}

// ---------- 主入口 ----------

export function createClaudeDesktopManager({
  port,
  apiKeyStore,
  getCatalogModelIds,
  getCatalogEntries,
  storePath,
  log,
  flog,
} = {}) {
  const recentEvents = [];
  const perModel = new Map(); // 真实模型 id → 用量明细
  const totals = {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    firstRequestAt: 0,
    lastRequestAt: 0,
  };

  let storeCache = { mtimeMs: -1, store: { exposed: null, aliases: {}, modelOptions: {} } };
  const store = () => {
    try {
      const mtimeMs = fs.existsSync(storePath) ? fs.statSync(storePath).mtimeMs : -1;
      if (mtimeMs !== storeCache.mtimeMs) storeCache = { mtimeMs, store: loadStore(storePath) };
    } catch { /* 读取失败用旧缓存 */ }
    return storeCache.store;
  };

  const catalogIds = () => (Array.isArray(getCatalogModelIds?.()) ? getCatalogModelIds() : []);
  // 目录条目（含 context_window）：[{id, contextWindow?}]；未注入时退化为纯 id 列表
  const catalogEntries = () => {
    if (typeof getCatalogEntries === 'function') {
      try {
        const entries = getCatalogEntries();
        if (Array.isArray(entries)) return entries;
      } catch { /* 退化到纯 id */ }
    }
    return catalogIds().map((id) => ({ id }));
  };

  // 暴露模型（白名单过滤后的目录子集）
  function exposedModelIds() {
    const { exposed } = store();
    const catalog = catalogIds();
    if (!Array.isArray(exposed)) return catalog;
    const set = new Set(exposed);
    return catalog.filter((id) => set.has(id));
  }

  // 别名表缓存（1 秒 TTL）：适配器每个请求都会读取，避免逐请求重复 sha1/目录扫描；
  // 保存操作主动置空缓存，实际生效延迟 ≤1 秒。
  let aliasCache = { at: 0, entries: [] };
  // 角色槽位池（全部是 Desktop 官方模型目录里真实存在的 Claude ID）：网关模型使用
  // 角色 ID 后，Desktop 原生提供 1M 上下文变体与思考档位选择器（cc-switch 同款思路）
  const ROLE_POOL = [
    // 全部核对自 Desktop model-catalog v831（~/Library/Application Support/Claude-3p/
    // model-catalog/published.json）：在册、带 effort 档位、1M 输入、gateway 面支持。
    // sonnet-4-5/haiku-4-5/opus-4-1 已从目录下架，禁止回用（haiku 档位本身无 effort UI）。
    'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-4-6',
    'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1',
    'claude-fable-5', 'claude-opus-4-7',
  ];
  function aliasEntries() {
    const now = Date.now();
    if (aliasCache.entries.length && now - aliasCache.at < 1000) return aliasCache.entries;
    const { aliases, modelOptions } = store();
    const ids = exposedModelIds();
    const catalogMap = new Map(catalogEntries().map((entry) => [entry.id, entry]));
    const entries = [];
    const used = new Set();
    for (const model of ids) {
      const custom = typeof aliases[model] === 'string' ? aliases[model] : '';
      let alias = custom && ALIAS_RE.test(custom) ? custom : '';
      // 稳定角色槽位：按模型 id 哈希选起始槽，冲突线性顺延（集合变化不漂移）
      if (!alias || used.has(alias)) {
        const h = crypto.createHash('sha1').update(model).digest();
        const start = h[0] % ROLE_POOL.length;
        for (let step = 0; step < ROLE_POOL.length; step += 1) {
          const cand = ROLE_POOL[(start + step) % ROLE_POOL.length];
          if (!used.has(cand)) { alias = cand; break; }
        }
        // ROLE_POOL 槽位（8 个）少于目录模型数时探环失败会留下空串——回退哈希别名，
        // 保证每个暴露模型都有可用别名（审查 #4：默认全暴露第 9 个模型起别名为空）
        if (!alias || used.has(alias)) alias = `claude-${crypto.createHash('sha1').update(model).digest('hex').slice(0, 16)}`;
      }
      used.add(alias);
      const opt = modelOptions[model] || {};
      const catalogContext = Number(catalogMap.get(model)?.contextWindow);
      const maxInputTokens = Number.isFinite(Number(opt.maxInputTokens)) && Number(opt.maxInputTokens) > 0
        ? Math.floor(Number(opt.maxInputTokens))
        : (Number.isFinite(catalogContext) && catalogContext > 0 ? Math.floor(catalogContext) : undefined);
      // 1M 变体默认关闭：模型本体行已按真实窗口计量（contextWindowByModel），
      // 变体行会把每个 ≥1M 模型展开成两条；需要时在面板按模型开关打开
      const supports1m = opt.supports1m === true;
      entries.push({ alias, model, maxInputTokens, supports1m });
    }
    aliasCache = { at: now, entries };
    return entries;
  }

  // 保存上下文/1M 变体配置：{ 模型ID: { maxInputTokens?, supports1m? } }；空条目=恢复目录默认
  async function setModelOptions(options) {
    const catalog = new Set(catalogIds());
    const input = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
    const modelOptions = {};
    for (const [model, opt] of Object.entries(input)) {
      if (!catalog.has(model)) continue;
      if (!opt || typeof opt !== 'object') continue;
      const entry = {};
      const rawTokens = Number(opt.maxInputTokens);
      if (Number.isFinite(rawTokens) && rawTokens > 0) {
        // 边界收敛：下限 1000 防误触，上限 1000 万防明显误填
        entry.maxInputTokens = Math.min(Math.max(Math.floor(rawTokens), 1000), 10000000);
      }
      if (typeof opt.supports1m === 'boolean') entry.supports1m = opt.supports1m;
      if (Object.keys(entry).length) modelOptions[model] = entry;
    }
    aliasCache = { at: 0, entries: [] };
    storeCache = { mtimeMs: -1, store: { ...store(), modelOptions } };
    saveStore(storePath, storeCache.store);
    log?.({ event: 'claude_desktop.model_options_saved', count: Object.keys(modelOptions).length });
    return { ok: true, modelOptions, note: '已保存，即时生效；Desktop 模型列表刷新（重开会话或重启 Desktop）后可见' };
  }

  const modelEntry = (model) => {
    const key = String(model || 'unknown');
    // 上限保护：客户端可控的模型名理论上可无限撑大 Map；超限清零重计（总量仍在 totals）
    if (!perModel.has(key) && perModel.size >= 500) perModel.clear();
    let entry = perModel.get(key);
    if (!entry) {
      entry = { model: key, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: 0 };
      perModel.set(key, entry);
    }
    return entry;
  };

  // 适配器 flog 旁路：只消费 anthropic.* 事件，异常全吞（统计绝不影响路由）
  function observe(event) {
    try {
      if (!event || typeof event.event !== 'string' || !event.event.startsWith('anthropic.')) return;
      const type = event.event;
      const now = Date.now();
      if (type === 'anthropic.request') {
        totals.requests += 1;
        totals.lastRequestAt = now;
        if (!totals.firstRequestAt) totals.firstRequestAt = now;
        const entry = modelEntry(event.resolved_model || event.model);
        entry.requests += 1;
        entry.lastRequestAt = now;
      } else if (type === 'anthropic.response') {
        const entry = modelEntry(event.model);
        const input = Number(event.input_tokens ?? event.input_tokens_estimated ?? 0);
        const output = Number(event.output_tokens ?? event.output_tokens_estimated ?? 0);
        if (Number.isFinite(input)) totals.inputTokens += input;
        if (Number.isFinite(output)) totals.outputTokens += output;
        entry.inputTokens += Number.isFinite(input) ? input : 0;
        entry.outputTokens += Number.isFinite(output) ? output : 0;
      } else if (type === 'anthropic.upstream_error') {
        totals.errors += 1;
        modelEntry(event.model).errors += 1;
      }
      recentEvents.push({
        at: now,
        event: type,
        model: String(event.model || event.resolved_model || ''),
        stream: event.stream === true ? true : event.stream === false ? false : undefined,
        status: event.status ?? event.mapped_status,
        stopReason: event.stop_reason,
        errorCode: event.error_code,
        latencyMs: event.latency_ms,
      });
      if (recentEvents.length > RING_BUFFER_MAX) recentEvents.splice(0, recentEvents.length - RING_BUFFER_MAX);
    } catch { /* 统计旁路绝不影响路由 */ }
  }

  async function setExposed(models) {
    const catalog = new Set(catalogIds());
    // 类型严格：非数组非 null 的入参（如字符串）过去会静默落成空白名单，
    // Desktop 网关瞬间 0 模型且返回 ok——这里显式报错
    if (models !== null && models !== undefined && !Array.isArray(models)) {
      return { ok: false, error: 'models 必须是字符串数组或 null（恢复全部）' };
    }
    if (models === null || models === undefined) {
      aliasCache = { at: 0, entries: [] };
    storeCache = { mtimeMs: -1, store: { ...store(), exposed: null } };
      saveStore(storePath, storeCache.store);
      log?.({ event: 'claude_desktop.expose_reset' });
      return { ok: true, exposed: storeCache.store.exposed };
    }
    const list = [...new Set((Array.isArray(models) ? models : [])
      .filter((id) => typeof id === 'string' && catalog.has(id)))];
    aliasCache = { at: 0, entries: [] };
    storeCache = { mtimeMs: -1, store: { ...store(), exposed: list } };
    saveStore(storePath, storeCache.store);
    log?.({ event: 'claude_desktop.expose_saved', count: list.length });
    return { ok: true, exposed: list, note: '已保存；Desktop 侧模型列表刷新（重开会话或重启 Desktop）后生效' };
  }

  async function setAliases(map) {
    const catalog = new Set(catalogIds());
    const input = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
    const aliases = {};
    const seen = new Set();
    for (const [model, alias] of Object.entries(input)) {
      if (!catalog.has(model)) continue; // 目录外模型忽略
      if (typeof alias !== 'string' || !alias.trim()) continue; // 空 = 恢复默认
      const normalized = alias.trim().toLowerCase();
      if (!ALIAS_RE.test(normalized)) {
        return { ok: false, error: `别名 "${normalized}" 不合法：官方角色 ID（claude-opus-4-8 等）或 claude- 开头小写字母/数字哈希` };
      }
      if (seen.has(normalized)) {
        return { ok: false, error: `别名 "${normalized}" 重复：每个模型需要唯一别名` };
      }
      seen.add(normalized);
      aliases[model] = normalized;
    }
    aliasCache = { at: 0, entries: [] };
    storeCache = { mtimeMs: -1, store: { ...store(), aliases } };
    saveStore(storePath, storeCache.store);
    log?.({ event: 'claude_desktop.aliases_saved', count: Object.keys(aliases).length });
    return { ok: true, aliases, note: '已保存；Desktop 侧模型列表刷新（重开会话或重启 Desktop）后生效' };
  }

  // 连通性探活：与 Desktop 完全同路径（/v1/messages → 适配器 → 路由管线）。
  // 依次尝试多个暴露模型（默认最多 3 个）：第一个别名可能路由到正在冷却/欠费的
  // 上游（如官方账号冷却、智谱余额不足），单点探测会把「上游账号问题」误报成
  // 「网关不可用」。
  let cachedProbeKey = '';

  async function probe({ model } = {}) {
    const aliases = aliasEntries();
    const preferred = aliases.filter((entry) => entry.alias === model || entry.model === model);
    const rest = aliases.filter((entry) => !preferred.includes(entry));
    // 最多尝试 4 个：指定模型优先，其余按暴露顺序兜底
    const candidates = [...preferred, ...rest].slice(0, 4);
    const attempts = [];
    for (const target of (candidates.length ? candidates : aliases).slice(0, 4)) {
      const result = await probeOnce(target);
      if (result.ok) return result;
      attempts.push({ alias: target.alias, model: target.model, error: result.error || `HTTP ${result.status}` });
      // 鉴权/请求体类错误（4xx 除 429/529）换模型也不会好，直接返回
      if (result.status && result.status !== 429 && result.status < 500 && result.status !== 529) {
        return { ...result, attempts };
      }
    }
    return { ok: false, error: `所有已暴露模型探测均失败：${attempts.map((a) => `${a.model}(${a.error})`).join('；')}`, attempts };
  }

  async function probeOnce(target) {
    const startedAt = Date.now();
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    let timer = null;
    try {
      if (apiKeyStore && typeof apiKeyStore.hasKeys === 'function' && apiKeyStore.hasKeys()) {
        // 密钥模式：探针 key 复用（401 时置空下次轮换），避免每次探活都写库轮换
        if (!cachedProbeKey) cachedProbeKey = apiKeyStore.rotateInternalProbeKey();
        headers['x-api-key'] = cachedProbeKey;
      }
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 60_000);
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: target.alias,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      if (response.status === 401) cachedProbeKey = '';
      if (response.status !== 200) {
        const bodyText = (await response.text()).slice(0, 200);
        return { ok: false, status: response.status, latencyMs, error: bodyText };
      }
      const message = await response.json();
      const text = (Array.isArray(message?.content) ? message.content : [])
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join(' ')
        .trim();
      return {
        ok: true,
        latencyMs,
        status: 200,
        model: message?.model || target.model,
        alias: target.alias,
        stopReason: message?.stop_reason || '',
        snippet: text.slice(0, 120),
      };
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, latencyMs: Date.now() - startedAt, error: String(error?.message || error).slice(0, 200) };
    }
  }

  async function restartApp() {
    const running = await isRunning();
    if (running) {
      if (WIN) {
        await run('taskkill', ['/IM', 'claude.exe', '/F']);
      } else {
        for (const pattern of CANDIDATES.processPatterns) {
          await run('pkill', ['-if', pattern], 4000);
        }
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!(await isRunning())) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!CANDIDATES.launch) {
      return { ok: true, launched: false, message: `Claude 已退出；${CANDIDATES.launchFallbackNote}` };
    }
    try {
      const child = CANDIDATES.launch();
      if (!child) {
        return { ok: true, launched: false, message: '未找到 Claude 安装位置，请手动打开' };
      }
      child.unref?.();
      return { ok: true, launched: true, message: 'Claude 桌面端已重启；约 10 秒后可用，若未拉起请手动打开' };
    } catch {
      return { ok: true, launched: false, message: `Claude 已退出；${CANDIDATES.launchFallbackNote}` };
    }
  }

  async function getState() {
    const installed = readInstalledInfo();
    const running = await isRunning();
    const active = totals.lastRequestAt > 0 && (Date.now() - totals.lastRequestAt) < ACTIVE_WINDOW_MS;
    const openMode = !(apiKeyStore && typeof apiKeyStore.hasKeys === 'function' && apiKeyStore.hasKeys());
    const current = store();
    const entries = aliasEntries();
    return {
      ok: true,
      platform: PLATFORM_NAME,
      installed: installed.installed,
      version: installed.version || '',
      appPath: installed.appPath || '',
      running,
      baseUrl: `http://127.0.0.1:${port}`,
      gateway: {
        active,
        lastRequestAt: totals.lastRequestAt,
        firstRequestAt: totals.firstRequestAt,
        note: totals.lastRequestAt
          ? undefined
          : '尚未收到 Claude Desktop 的请求；请在其「Developer → Configure Third-Party Inference」中配置下方 Base URL 并重启桌面端',
      },
      credentials: {
        openMode,
        suggestedKey: openMode ? 'local-claude' : '',
        note: openMode
          ? '路由处于开放模式：Desktop 侧填任意开发 Key（如 local-claude）即可'
          : '路由已启用 API Key：请在「API Keys」页创建专用 Key 并填入 Desktop（可在下方一键创建）',
      },
      expose: {
        mode: Array.isArray(current.exposed) ? 'custom' : 'all',
        exposed: current.exposed,
        count: entries.length,
      },
      catalog: catalogIds().map((model) => {
        const entry = entries.find((e) => e.model === model) || {};
        const catalogContext = Number(catalogEntries().find((c) => c.id === model)?.contextWindow);
        const opt = (store().modelOptions[model] || {});
        return {
          model,
          exposed: !Array.isArray(current.exposed) || current.exposed.includes(model),
          alias: entry.alias || '',
          customAlias: (typeof current.aliases[model] === 'string' ? current.aliases[model] : '') || '',
          // 上下文：目录默认值（弹窗 placeholder 用）
          catalogContextWindow: Number.isFinite(catalogContext) && catalogContext > 0 ? Math.floor(catalogContext) : null,
          // 当前生效值（用户覆盖 > 目录默认）
          maxInputTokens: entry.maxInputTokens ?? null,
          supports1m: entry.supports1m === true,
          customMaxInputTokens: opt.maxInputTokens ?? null,
        };
      }),
      totals,
      models: [...perModel.values()].sort((a, b) => b.requests - a.requests),
      recentEvents: recentEvents.slice(-20).reverse(),
      aliases: entries,
    };
  }

  return { observe, getState, probe, restartApp, setExposed, setAliases, setModelOptions, aliasEntries, exposedModelIds };
}
