// Codex 桌面端接入管理：一键恢复官方直连 / 一键接入路由（含模型动态加载）。
// 读写 CODEX_HOME 下的 config.toml 与 models.json，所有覆盖前先做时间戳备份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 官方存量模型（恢复「官方直连」时仅保留这些；其余为路由自定义/第三方模型）。
export const OFFICIAL_MODEL_SLUGS = Object.freeze([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2',
  'codex-auto-review',
]);

export function filterOfficialModels(catalogEntries) {
  return catalogEntries.filter((entry) => OFFICIAL_MODEL_SLUGS.includes(entry.slug));
}

// 官方存量模型的内置近似目录：全新机器上桌面端从未在官方模式写过 models.json，
// 模型池里没有任何官方条目，直接「接入路由」会让桌面选择器只剩自定义模型
// （官方模型凭空消失，且无任何提示——2026-09-06 macOS 首装实测）。
// 这里为每个官方 slug 合成一条桌面端可解析的目录条目（必填字段由
// ensureDesktopModelDefaults 补全）；官方真实元数据（指令模板等）以桌面端
// 自行写回的目录为准，写回后自然覆盖近似值。
export const OFFICIAL_FALLBACK_CATALOG = Object.freeze([
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', context_window: 272000, max_context_window: 272000, priority: 1 },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', context_window: 272000, max_context_window: 272000, priority: 2 },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', context_window: 272000, max_context_window: 272000, priority: 3 },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, max_context_window: 272000, priority: 4 },
  { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 272000, priority: 5 },
  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', context_window: 272000, max_context_window: 272000, priority: 6 },
  { slug: 'gpt-5.2', display_name: 'GPT-5.2', context_window: 272000, max_context_window: 272000, priority: 7 },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, max_context_window: 272000, priority: 8 },
]);

/**
 * 池中缺失的官方 slug 用内置近似条目补齐（已有官方条目一律保留原值）。
 * @returns {{pool: Array<object>, synthesizedSlugs: string[]}}
 */
export function ensureOfficialCatalogEntries(catalogEntries) {
  const pool = Array.isArray(catalogEntries) ? [...catalogEntries] : [];
  const known = new Set(pool.map((entry) => entry?.slug).filter(Boolean));
  const synthesizedSlugs = [];
  for (const fallback of OFFICIAL_FALLBACK_CATALOG) {
    if (known.has(fallback.slug)) continue;
    pool.push({ ...fallback });
    synthesizedSlugs.push(fallback.slug);
  }
  return { pool, synthesizedSlugs };
}

export function selectModels(catalogEntries, slugs) {
  const list = Array.isArray(slugs) ? slugs : [];
  const wanted = new Set(list.map((slug) => String(slug)));
  return catalogEntries.filter((entry) => wanted.has(entry.slug));
}

// 目录条目按 slug 去重（保序，先出现者优先）——池 ∪ 已加载目录合并用。
export function dedupeCatalogEntries(entries) {
  const bySlug = new Map();
  for (const entry of entries) {
    if (entry?.slug && !bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
  }
  return [...bySlug.values()];
}

// 桌面端目录安全校验（2026-08 实锤的必填：supported_in_api / priority / base_instructions 等）
export function assertDesktopSafeModels(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry.slug !== 'string' || !entry.slug) {
      throw new Error('模型条目缺少 slug');
    }
    if (typeof entry.display_name !== 'string' || !entry.display_name) {
      throw new Error(`${entry.slug}: display_name 必填`);
    }
    if (typeof entry.supported_in_api !== 'boolean') {
      throw new Error(`${entry.slug}: supported_in_api 缺失（桌面端必填布尔）`);
    }
    if (!Number.isSafeInteger(entry.priority) || entry.priority < 0) {
      throw new Error(`${entry.slug}: priority 缺失（桌面端必填非负整数）`);
    }
    if (typeof entry.base_instructions !== 'string' || !entry.base_instructions.trim()) {
      throw new Error(`${entry.slug}: base_instructions 缺失（桌面端必填）`);
    }
  }
}

// 桌面端目录条目的通用指令模板：路由侧合成模型（如谷歌订阅一键导入的条目）可能没有
// 实际指令内容，而 base_instructions 是桌面端解析目录的必填非空字段，缺失会让
// apply-router 校验直接失败。模板与 model-routing-plan 的 create/update 补全保持一致。
export function genericInstructions(displayName) {
  const name = typeof displayName === 'string' && displayName ? displayName : 'an expert coding agent';
  return `You are ${name}. Collaborate with the user in their shared workspace using the available tools; reason about each step, verify your work, and keep responses concise and actionable.`;
}

// 桌面端目录条目缺省字段补全：历史数据（早期谷歌订阅导入的条目）可能缺少
// display_name / supported_in_api / priority / base_instructions 等桌面端必填字段，
// 勾选这类模型接入路由时会被 assertDesktopSafeModels 拦下。在写入桌面端
// models.json 前调用本函数补全缺省；已有合法值的字段一律保留原值。
//
// 2026-09-02 起补齐桌面端 ModelInfo 反序列化的全部硬必需字段（client 0.151.0
// 实测契约，对应 codex-rs protocol/openai_models.rs）：slug / display_name /
// supported_reasoning_levels / shell_type / visibility / supported_in_api /
// priority / support_verbosity / truncation_policy / experimental_supported_tools，
// 外加目录级约束 base_instructions（或 model_messages.instructions_template）。
// 这些字段无 serde default，缺任何一个都会让桌面端整个 /models 目录解析失败
// （静默回退官方内置模型，第三方模型全部消失——这正是「选择器没有其他模型」的
// 根因之一）。取值与 model-routing-plan 的 create/update 补全保持一致。
export function ensureDesktopModelDefaults(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.slug !== 'string' || !entry.slug) return entry;
  if (typeof entry.display_name !== 'string' || !entry.display_name) {
    entry.display_name = entry.slug;
  }
  if (typeof entry.supported_in_api !== 'boolean') {
    entry.supported_in_api = true;
  }
  if (!Number.isSafeInteger(entry.priority) || entry.priority < 0) {
    entry.priority = 0;
  }
  if (typeof entry.base_instructions !== 'string' || !entry.base_instructions.trim()) {
    entry.base_instructions = genericInstructions(entry.display_name || entry.slug);
  }
  // ---- 桌面端 ModelInfo 硬必需字段（无 serde default，缺失整目录解析失败）----
  if (!Array.isArray(entry.supported_reasoning_levels) || entry.supported_reasoning_levels.length === 0) {
    entry.supported_reasoning_levels = [
            { effort: 'low', description: '快速响应，较轻推理' },
            { effort: 'medium', description: '平衡速度与推理深度' },
            { effort: 'high', description: '复杂问题的更深推理' },
            { effort: 'max', description: '最大推理深度' },
          ];
  }
  if (typeof entry.default_reasoning_level !== 'string' || !entry.default_reasoning_level) {
    // 与 model-routing-plan 的 model.create 同值（'medium'）：两条补全路径默认档
    // 不一致会让同名模型行为漂移（2026-09-13 审计），medium 不在支持列表才退首档
    entry.default_reasoning_level = entry.supported_reasoning_levels.some((l) => l.effort === 'medium')
      ? 'medium'
      : entry.supported_reasoning_levels[0].effort;
  }
  if (typeof entry.shell_type !== 'string' || !entry.shell_type) {
    entry.shell_type = 'shell_command';
  }
  if (typeof entry.visibility !== 'string' || !entry.visibility) {
    entry.visibility = 'list';
  }
  if (typeof entry.support_verbosity !== 'boolean') {
    entry.support_verbosity = true;
  }
  if (!entry.truncation_policy || typeof entry.truncation_policy !== 'object'
    || !Number.isSafeInteger(entry.truncation_policy.limit) || entry.truncation_policy.limit < 1) {
    entry.truncation_policy = { mode: 'tokens', limit: 10000 };
  }
  if (!Array.isArray(entry.experimental_supported_tools)) {
    entry.experimental_supported_tools = [
      'apply_patch', 'shell', 'goal', 'computer_use',
      'web_search', 'tool_search', 'mcp_read', 'mcp_write',
      'image_generation',
    ];
  }
  // 2026-09-02 第 2 轮实锤（codex-rs protocol/openai_models.rs v0.152.1）：
  // 以下字段同样无 serde(default)——即使语义是 Option，反序列化也要求 key 必须
  // 出现（值可为 null）；缺失会令整个目录解析失败（静默回退官方内置模型）。
  // availability_nux / upgrade / default_verbosity / apply_patch_tool_type 均是
  // 这种「optional-but-required-key」形态：补 null 即可。
  for (const field of ['availability_nux', 'upgrade', 'default_verbosity', 'apply_patch_tool_type']) {
    if (!(field in entry)) entry[field] = null;
  }
  return entry;
}

// TOML 顶层作用域：任何 [section] 头出现之前的区域。model / model_provider 等
// 全局键的增删改只允许作用于顶层；[projects.*] 等段内的同名键是项目级设置，必须原样保留。
function isTomlSectionHeader(line) {
  return /^\s*\[{1,2}[^\]]*\]{1,2}\s*$/.test(line);
}

// 只过滤顶层作用域中命中 predicate 的行；进入任何段之后不再匹配。
function filterTopLevelLines(content, predicate) {
  const kept = [];
  let inSection = false;
  for (const line of String(content || '').split(/\r?\n/)) {
    if (isTomlSectionHeader(line)) inSection = true;
    if (!inSection && predicate(line)) continue;
    kept.push(line);
  }
  return kept;
}

// 读顶层字符串键（到首个段头为止）；找不到返回 ''。
function topLevelTomlString(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of String(content || '').split(/\r?\n/)) {
    if (isTomlSectionHeader(line)) break;
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return '';
}

// TOML 段级手术（恢复官方用）：移除顶层 model_provider / model_catalog_json 行，
// 但**保留** [model_providers.router] 段——历史会话 rollout 元数据持久化了
// model_provider:"router"，桌面端打开旧对话串时按元数据找 provider 定义，
// 段被删会报「Model provider `router` not found」导致聊天记录打不开。
// 恢复官方 = 新会话走官方默认（不设顶层 model_provider），旧会话仍可继续。
function stripRouterDefaultToToml(content) {
  return filterTopLevelLines(content, (line) => (
    /^\s*model_provider\s*=/.test(line) || /^\s*model_catalog_json\s*=/.test(line)
  )).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// TOML basic string 完整转义：值含 \ " 或控制字符时不转义会产出桌面端无法解析
// 的 TOML（正是「应用打不开」故障形态，且写前校验对引号已配对的坏转义失明）。
function tomlEscape(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// 官方直连的 config.toml：新会话走桌面端内置官方通道（删除顶层 model_provider 行），
// 但保留 [model_providers.router] 段声明，历史会话（元数据引用 router provider）可继续。
// 传现有内容时做增量剥离（保留主题/插件/MCP/项目级设置等全部配置），不传时退回最小模板。
export function buildOfficialConfigToml(defaultModel = 'gpt-5.6-sol', currentContent = '') {
  if (!String(currentContent || '').trim()) {
    return `model = "${tomlEscape(defaultModel)}"\n`;
  }
  const modelLine = `model = "${tomlEscape(defaultModel)}"`;
  // 顶层旧 model 行剔除后在文件头部统一写入；[projects.*] 内的项目级 model 不动。
  const rest = filterTopLevelLines(
    stripRouterDefaultToToml(currentContent),
    (line) => /^\s*model\s*=/.test(line),
  ).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return rest ? `${modelLine}\n${rest}\n` : `${modelLine}\n`;
}

// 段级剥离（接入路由幂等用）：删除旧的 [model_providers.router] 段，其余行原样保留。
function stripRouterSectionToToml(content) {
  const lines = String(content || '').split(/\r?\n/);
  const kept = [];
  let inRouterSection = false;
  for (const line of lines) {
    const isSectionHeader = /^\[{1,2}[^\]]+]$/.test(line.trim());
    if (isSectionHeader) {
      inRouterSection = line.trim().startsWith('[model_providers.router]');
      if (inRouterSection) continue;
      kept.push(line);
      continue;
    }
    if (inRouterSection) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 接入路由的 config.toml：路由作为唯一 provider（本机回环，开放直连；wire_api=responses）。
// 传现有内容时先剥离旧路由段/行再写入（幂等，可重复执行），保留其余全部配置（含项目级设置）。
export function buildRouterConfigToml(defaultModel = 'gpt-5.6-sol', currentContent = '', options = {}) {
  // model_catalog_json 指向桌面端目录文件：没有这一行，桌面端把整个 provider 当
  // 纯外部自定义供应商，models.json 里官方模型也被归进「自定义」分组（2026-09-02
  // 实锤：只写 model/model_provider 两行时选择器全部落「自定义」组）。
  const catalogPath = options.modelsJsonPath
    ? String(options.modelsJsonPath).replace(/\\/g, '/')
    : '';
  // 无感启用有两种鉴权形态：
  //  auth  (默认): requires_openai_auth=true —— 复用桌面端 ChatGPT 官方登录态
  //  apiKey: requires_openai_auth=false + experimental_bearer_token —— 脱钩官方登录态。
  //        官方账号周/分钟额度耗尽时桌面端会把选择器锁成 Luna 降级档（官方产品行为），
  //        API-key 形态让桌面端不再感知官方额度，自定义模型恒可选用（2026-09-02 实测
  //        实锤：LocalRouter 模式下 claude/gemini 任务正常跑，选择器全量）。
  const apiKeyMode = options.apiKeyAuth === true;
  const routerSection = [
    '[model_providers.router]',
    'name = "LocalRouter"',
    `base_url = "http://127.0.0.1:${options.port ?? 15730}/v1"`,
    'wire_api = "responses"',
    apiKeyMode ? 'requires_openai_auth = false' : 'requires_openai_auth = true',
    'supports_websockets = false',
    ...(apiKeyMode && options.apiBearerToken
      ? [`experimental_bearer_token = "${tomlEscape(options.apiBearerToken)}"`]
      : []),
    '',
  ].join('\n');
  const headLines = [
    `model = "${tomlEscape(defaultModel)}"`,
    'model_provider = "router"',
    ...(catalogPath ? [`model_catalog_json = "${tomlEscape(catalogPath)}"`] : []),
  ];
  if (!String(currentContent || '').trim()) {
    return [...headLines, '', routerSection].join('\n');
  }
  const stripped = stripRouterSectionToToml(currentContent);
  // 统一幂等：只剔除顶层 model / model_provider / model_catalog_json 行（段内项目级
  // 设置原样保留），再在文件头部固定写入。
  const rest = filterTopLevelLines(stripped, (line) => (
    /^\s*model\s*=/.test(line)
    || /^\s*model_provider\s*=/.test(line)
    || /^\s*model_catalog_json\s*=/.test(line)
  )).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = [...headLines, ...(rest ? [rest] : [])].join('\n');
  return `${body}\n\n${routerSection}`;
}

export function parseConfigTomlModel(content) {
  return topLevelTomlString(content, 'model');
}

// ---------- [mcp_servers.*] 段级管理（桌面端原生插件管理面） ----------
// Codex 官方插件机制 = config.toml 的 [mcp_servers.NAME] 段（command/args/env/
// startup_timeout_sec，env 挂在 .env 子段）。本组函数只动目标段的行区间，
// 其余内容（含其他 MCP 段、[projects.*]、顶层键）原样保留，改写走
// writeWithBackup（TOML 写前校验 + 备份）与 codexDesktopMutex。

const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_SECTION_RE = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\s*\]\s*$/;
const MCP_ENV_SECTION_RE = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\.env\s*\]\s*$/;

function parseTomlStringValue(raw) {
  const value = String(raw).trim();
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1); // literal string（Windows 路径常见）
  if (/^"[^"]*"$/.test(value)) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return null;
}

function parseTomlStringArrayValue(raw) {
  const value = String(raw).trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { items.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  const parsed = items.map(parseTomlStringValue);
  return parsed.every((item) => typeof item === 'string') ? parsed : null;
}

function tomlLiteralString(value) {
  const text = String(value ?? '');
  // 优先 literal 单引号串（反斜杠不转义，Windows 路径友好）；含单引号退 basic 串
  if (!text.includes("'")) return `'${text}'`;
  return JSON.stringify(text);
}

/** 段区间扫描：Map<name, {start, end}>（end 为排他行号；.env 子段计入父段区间，
 * 其余任何段头终止当前区间）。同名多段属非法 TOML，后写覆盖前写并置 duplicate。
 * `.env` 子段出现在父段之前 / 嵌在其他段区间内（TOML 合法但超出本工具手术能力）
 * 一律标记 duplicate=true → 面板只读，防整段替换时静默丢 env 或产生重复表头
 *（2026-09-13 对抗审查：validateTomlSyntax 不查重复表头，桌面端会解析失败）。 */
function mcpSectionRanges(lines) {
  const ranges = new Map();
  const malformed = new Set();
  let currentName = null;
  for (let i = 0; i < lines.length; i += 1) {
    const serverMatch = MCP_SECTION_RE.exec(lines[i]);
    if (serverMatch) {
      if (currentName) ranges.get(currentName).end = i;
      currentName = serverMatch[1];
      const previous = ranges.get(currentName);
      if (previous) previous.duplicate = true;
      ranges.set(currentName, { start: i, end: lines.length, duplicate: false });
      continue;
    }
    const envMatch = MCP_ENV_SECTION_RE.exec(lines[i]);
    if (envMatch) {
      const envOwner = envMatch[1];
      // 合法形态：紧跟在 owner 自己的区间内；否则（先于父段出现 / 嵌在别的段里）
      // 双方都标记：owner 不可编辑（env 不可见），容器段不可编辑（替换会吞掉别人的 env）
      if (currentName !== envOwner) {
        malformed.add(envOwner);
        if (currentName) malformed.add(currentName);
      }
      continue; // 子段延续父区间
    }
    if (isTomlSectionHeader(lines[i])) {
      if (currentName) ranges.get(currentName).end = i;
      currentName = null;
    }
  }
  for (const name of malformed) {
    const range = ranges.get(name);
    if (range) range.duplicate = true;
  }
  return ranges;
}

/**
 * 解析 config.toml 中的 MCP 插件段。editable=false 表示段内含本工具不认识的
 * 形态（多行数组/非常规键等）——面板应只读展示，改写前必须保留原段。
 * 已识别的官方键（openai/codex mcp_types.rs RawMcpServerConfig）：
 * command/args/env/startup_timeout_sec/tool_timeout_sec/enabled/enabled_tools/disabled_tools。
 */
export function listMcpServerSections(content) {
  const lines = String(content || '').split(/\r?\n/);
  const ranges = mcpSectionRanges(lines);
  const servers = [];
  for (const [name, range] of ranges) {
    const server = {
      name,
      command: '',
      args: null,
      startupTimeoutSec: null,
      toolTimeoutSec: null,
      enabled: true,
      enabledTools: null,
      disabledTools: null,
      env: {},
      editable: !range.duplicate,
    };
    let inEnv = false;
    for (let i = range.start + 1; i < range.end; i += 1) {
      const line = lines[i];
      if (MCP_ENV_SECTION_RE.test(line)) { inEnv = true; continue; }
      if (MCP_SECTION_RE.test(line) || isTomlSectionHeader(line)) break;
      const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!kv) continue;
      const [, key, rawValue] = kv;
      if (inEnv) {
        const value = parseTomlStringValue(rawValue);
        if (value === null) server.editable = false;
        else server.env[key] = value;
      } else if (key === 'command') {
        const value = parseTomlStringValue(rawValue);
        if (value === null) server.editable = false;
        else server.command = value;
      } else if (key === 'args') {
        const value = parseTomlStringArrayValue(rawValue);
        if (value === null) server.editable = false;
        else server.args = value;
      } else if (key === 'startup_timeout_sec') {
        const value = Number(rawValue);
        if (Number.isFinite(value) && value > 0) server.startupTimeoutSec = value;
        else server.editable = false;
      } else if (key === 'tool_timeout_sec') {
        const value = Number(rawValue);
        if (Number.isFinite(value) && value > 0) server.toolTimeoutSec = value;
        else server.editable = false;
      } else if (key === 'enabled') {
        if (rawValue === 'true') server.enabled = true;
        else if (rawValue === 'false') server.enabled = false;
        else server.editable = false;
      } else if (key === 'enabled_tools' || key === 'disabled_tools') {
        const value = parseTomlStringArrayValue(rawValue);
        if (value === null) server.editable = false;
        else if (key === 'enabled_tools') server.enabledTools = value;
        else server.disabledTools = value;
      } else {
        // 官方规范外的键（codex++ 扩展等）：保留展示但标记不可结构化编辑
        server.editable = false;
        server.extraKeys = [...new Set([...(server.extraKeys || []), key])];
      }
    }
    servers.push(server);
  }
  return servers;
}

/** 序列化一个 MCP 段为标准文本（literal 串风格，与桌面端导出形态一致）。 */
export function buildMcpServerSection(server) {
  const name = String(server?.name || '').trim();
  if (!MCP_SERVER_NAME_RE.test(name)) {
    throw new Error('插件名只能是 1..64 位字母/数字/下划线/连字符');
  }
  const command = String(server?.command || '').trim();
  if (!command) throw new Error('command 不能为空');
  const args = Array.isArray(server?.args) ? server.args.map((item) => {
    const text = String(item);
    if (/[\r\n]/.test(text)) throw new Error('args 不能包含换行');
    return text;
  }) : [];
  if (args.length > 32) throw new Error('args 最多 32 项');
  const startupTimeoutSec = Number(server?.startupTimeoutSec);
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlLiteralString(command)}`,
    args.length ? `args = [${args.map((item) => tomlLiteralString(item)).join(', ')}]` : 'args = []',
  ];
  if (server?.enabled === false) {
    // 官方键（默认 true）：false 时桌面端跳过初始化——面板「禁用但不删」的实现
    lines.push('enabled = false');
  }
  if (Number.isFinite(startupTimeoutSec) && startupTimeoutSec >= 1) {
    lines.push(`startup_timeout_sec = ${Math.floor(startupTimeoutSec)}`);
  }
  const toolTimeoutSec = Number(server?.toolTimeoutSec);
  if (Number.isFinite(toolTimeoutSec) && toolTimeoutSec >= 1) {
    lines.push(`tool_timeout_sec = ${Math.floor(toolTimeoutSec)}`);
  }
  for (const [key, list] of [['enabled_tools', server?.enabledTools], ['disabled_tools', server?.disabledTools]]) {
    if (Array.isArray(list) && list.length) {
      const tools = list.map(String).filter((item) => MCP_SERVER_NAME_RE.test(item)).slice(0, 64);
      if (tools.length) lines.push(`${key} = [${tools.map((item) => tomlLiteralString(item)).join(', ')}]`);
    }
  }
  const envEntries = Object.entries(server?.env || {})
    .filter(([key, value]) => MCP_SERVER_NAME_RE.test(key) && typeof value === 'string' && value !== '')
    .slice(0, 32);
  if (envEntries.length) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [key, value] of envEntries) {
      if (/[\r\n]/.test(value)) throw new Error(`环境变量 ${key} 不能包含换行`);
      lines.push(`${key} = ${tomlLiteralString(value)}`);
    }
  }
  return lines.join('\n');
}

/** 增改一个 MCP 段（存在即整段替换，不存在追加到文件末尾）；返回新内容。 */
export function upsertMcpServerSection(content, server) {
  const sectionText = buildMcpServerSection(server);
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const ranges = mcpSectionRanges(lines);
  const existing = ranges.get(server.name);
  if (existing?.duplicate) throw new Error(`配置中存在多个同名段 [mcp_servers.${server.name}]，请先手工修复`);
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, sectionText);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(sectionText);
  }
  return normalizeTomlSpacing(lines.join('\n'));
}

/** 删除一个 MCP 段（含 .env 子段）；段不存在时原样返回。 */
export function removeMcpServerSection(content, name) {
  if (!MCP_SERVER_NAME_RE.test(String(name || ''))) throw new Error('插件名非法');
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const ranges = mcpSectionRanges(lines);
  const existing = ranges.get(name);
  if (!existing) return String(content || '');
  if (existing.duplicate) throw new Error(`配置中存在多个同名段 [mcp_servers.${name}]，请先手工修复`);
  lines.splice(existing.start, existing.end - existing.start);
  return normalizeTomlSpacing(lines.join('\n'));
}

// 空行折叠：仅在文件不含多行字符串（""" / '''）时做全文 \n{3,}→\n\n——
// 多行串内的连续空行是内容，折叠会静默改写（2026-09-13 对抗审查 P2）
function normalizeTomlSpacing(text) {
  if (/"{3}|'{3}/.test(text)) return text.trimEnd() + '\n';
  return text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function detectAccessMode(tomlContent, modelSlugs) {
  // 顶层 model_provider = "router" 才表示新会话走路由；[model_providers.router] 段
  // 本身保留是为了历史会话可继续（元数据引用 router provider），不算接入路由。
  // models.json 保留路由模型同样是刻意设计（历史会话引用），不再参与判定。
  return topLevelTomlString(tomlContent, 'model_provider') === 'router' ? 'router' : 'official';
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const MAX_BACKUP_FILES = 10;

// 在原文上带引号感知地提取表头括号内的键路径文本：引号内的 ] 不计深度。
// 返回 inner 文本（保留引号），表头未闭合/闭括号后有多余内容时返回 null。
const headerInner = (text) => {
  const open = text.startsWith('[[') ? 2 : 1;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const close = open === 2 ? 2 : 1;
        const innerEnd = i + 1 - close;
        if (innerEnd < open) return null;
        const rest = text.slice(i + 1).trim();
        if (rest && !rest.startsWith('#')) return null;
        return text.slice(open, innerEnd);
      }
      if (depth < 0) return null;
    }
  }
  return null;
};

// 字符级解析点分键路径（表头段名或 = 左侧键），返回去重用的唯一身份：
// 裸键段 [A-Za-z0-9_-]+；带引号段解码内容（基本串支持 \\ \" \n \uXXXX \UXXXXXXXX 等转义，
// 字面串原样），段间允许点旁空白，结尾允许注释。非法结构返回 null。
// 不能用「剥离引号后的文本」做身份：[plugins."a"] 与 [plugins."b"] 会坍缩成同一段，
// 各段内同名键（enabled 等）会被误判重复——这正是桌面端真实配置大量使用的形态。
const canonicalKeyPath = (text) => {
  const src = String(text || '');
  const len = src.length;
  const tokens = [];
  let i = 0;
  const skipWs = () => { while (i < len && /\s/.test(src[i])) i += 1; };
  skipWs();
  if (i >= len) return null;
  for (;;) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let decoded = '';
      let closed = false;
      i += 1;
      while (i < len) {
        const c = src[i];
        if (quote === '"' && c === '\\') {
          const next = src[i + 1];
          if (next === undefined) return null;
          if (next === 'u' || next === 'U') {
            const hexLen = next === 'u' ? 4 : 8;
            const hex = src.slice(i + 2, i + 2 + hexLen);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hexLen !== hex.length) return null;
            const code = Number.parseInt(hex, 16);
            if (Number.isNaN(code) || code > 0x10ffff) return null;
            decoded += String.fromCodePoint(code);
            i += 2 + hexLen;
            continue;
          }
          const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
          if (!(next in map)) return null;
          decoded += map[next];
          i += 2;
          continue;
        }
        if (c === quote) { closed = true; i += 1; break; }
        if (quote === '"' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c)) return null;
        decoded += c;
        i += 1;
      }
      if (!closed) return null;
      // 引号键与等值的裸键在 TOML 中是同一个键：token 只存解码内容。
      tokens.push(decoded);
    } else if (/[A-Za-z0-9_-]/.test(ch)) {
      let bare = '';
      while (i < len && /[A-Za-z0-9_-]/.test(src[i])) { bare += src[i]; i += 1; }
      tokens.push(bare);
    } else {
      return null;
    }
    skipWs();
    if (i >= len) break;
    if (src[i] === '.') {
      i += 1;
      skipWs();
      if (i >= len) return null;
      continue;
    }
    if (src[i] === '#') break; // 尾注释
    return null;
  }
  return JSON.stringify(tokens);
};

/**
 * 生成内容的轻量 TOML 结构校验：把「生成器 bug 产出坏文件」拦在写盘前
 * （桌面端解析失败会整体打不开）。字符级扫描 + 行级状态机：字符串字面量内容
 * 被剥离、注释只在引号外生效，因此引号内的 #/]/[ 不会误判；表头/键名身份在
 * 原文上解析（headerInner + canonicalKeyPath），带引号的段名与键不坍缩；跟踪
 * 多行字符串（""" / '''）、跨行数组括号深度、[[数组表]] 每次出现都是新表。
 * 已知宽松项（放行而非误拒）：内联表跨行、多行字符串内的转义定界符、重复表头。
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateTomlSyntax(content) {
  const problems = [];
  const seenKeys = new Map();
  const tableArrayCounts = new Map();
  let section = '';
  let multiline = '';
  let arrayDepth = 0;
  const lines = String(content || '').split(/\r?\n/);

  // 单遍扫描：剥离字符串内容、在引号外第一个 # 截断注释；
  // 同时记录引号外第一个 '=' 在原文与剥离文本中的位置。
  // basic string 内的反斜杠转义必须校验后继字符（b t n f r " \ u U）——
  // 盲跳过会让 `\q` 这类非法转义通过写前校验、写坏桌面端（2026-09-13 审计）。
  const scanLine = (text, lineno = 0) => {
    let bare = '';
    let quote = '';
    let eqAt = -1;
    let origEqAt = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (quote === '"' && ch === '\\') {
          const next = text[i + 1];
          if (next === undefined || !'btnfr"\\uU'.includes(next)) {
            if (lineno > 0) problems.push(`第 ${lineno} 行含非法转义序列 \\${next ?? '行尾'}`);
          }
          i += 1;
          continue;
        }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') break;
      if (ch === '=' && eqAt === -1) { eqAt = bare.length; origEqAt = i; }
      bare += ch;
    }
    return { bare, eqAt, origEqAt, inString: quote !== '' };
  };
  const bracketDelta = (bareText) => {
    const text = String(bareText);
    return (text.match(/\[/g) || []).length - (text.match(/\]/g) || []).length;
  };
  // 提取以引号开头的值的首个字符串字面量：返回 [token, 其后剩余] 或 null（未闭合）。
  const extractQuoted = (text) => {
    const quote = text[0];
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) return [text.slice(0, i + 1), text.slice(i + 1)];
    }
    return null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineno = index + 1;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) {
      problems.push(`第 ${lineno} 行含控制字符`);
      continue;
    }
    if (multiline) {
      const closer = multiline === 'basic' ? '"""' : "'''";
      const at = line.indexOf(closer);
      if (at === -1) continue;
      multiline = '';
      // 闭合后的同行剩余内容罕见，保守跳过该行其余检查
      continue;
    }
    if (arrayDepth > 0) {
      arrayDepth += bracketDelta(scanLine(line, lineno).bare);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const scanned = scanLine(trimmed, lineno);
    if (scanned.inString) {
      // 可能是多行字符串的开头（值以 """ / ''' 开始）：交给多行状态机，不算未闭合
      const valueEarly = scanned.eqAt > 0 ? trimmed.slice(scanned.origEqAt + 1).trim() : '';
      if (valueEarly.startsWith('"""') || valueEarly.startsWith("'''")) {
        const closer = valueEarly.startsWith('"""') ? '"""' : "'''";
        if (!valueEarly.slice(3).includes(closer)) multiline = valueEarly.startsWith('"""') ? 'basic' : 'literal';
        continue;
      }
      problems.push(`第 ${lineno} 行引号未闭合：${trimmed.slice(0, 60)}`);
      continue;
    }
    const bareTrimmed = scanned.bare.trim();
    if (bareTrimmed.startsWith('[')) {
      const opens = (bareTrimmed.match(/\[/g) || []).length;
      const closes = (bareTrimmed.match(/\]/g) || []).length;
      // 括号配平用剥离文本粗查；段名身份必须在原文上取（保留引号键）。
      const inner = opens === closes && /^\[{1,2}[^\[\]]+\]{1,2}$/.test(bareTrimmed)
        ? headerInner(trimmed)
        : null;
      const canonical = inner === null ? null : canonicalKeyPath(inner);
      if (!canonical) {
        problems.push(`第 ${lineno} 行段头格式非法：${trimmed.slice(0, 60)}`);
        // 段身份未知：落到当行唯一哨兵，后续键不会误挂到旧段造成假重复。
        section = `#invalid-header#${lineno}`;
      } else if (bareTrimmed.startsWith('[[')) {
        // [[数组表]]：每次出现都是独立的新表，键不跨出现去重。
        const count = (tableArrayCounts.get(canonical) || 0) + 1;
        tableArrayCounts.set(canonical, count);
        section = `${canonical}#arr#${count}`;
      } else {
        section = canonical;
      }
      continue;
    }
    if (scanned.eqAt <= 0) {
      problems.push(`第 ${lineno} 行缺少键值分隔（=）：${trimmed.slice(0, 60)}`);
      continue;
    }
    const value = trimmed.slice(scanned.origEqAt + 1).trim();
    // 键名身份在原文上解析：裸键/点分/带引号键（含转义）统一解码后去重，
    // 全引号键之间不会坍缩成同一个 "<quoted>" 假身份。
    const dedupeKey = canonicalKeyPath(trimmed.slice(0, scanned.origEqAt));
    if (!dedupeKey) {
      problems.push(`第 ${lineno} 行键名非法：${trimmed.slice(0, scanned.origEqAt + 1).trim().slice(0, 40)}`);
      continue;
    }
    const bucket = seenKeys.get(section) || new Set();
    if (bucket.has(dedupeKey)) {
      problems.push(`第 ${lineno} 行重复键（${section || '顶层'}）：${dedupeKey}`);
    }
    bucket.add(dedupeKey);
    seenKeys.set(section, bucket);

    if (value.startsWith('"""') || value.startsWith("'''")) {
      const closer = value.startsWith('"""') ? '"""' : "'''";
      if (!value.slice(3).includes(closer)) multiline = value.startsWith('"""') ? 'basic' : 'literal';
      continue;
    }
    if (value.startsWith('"') || value.startsWith("'")) {
      const extracted = extractQuoted(value);
      const rest = extracted ? extracted[1].trim() : '';
      if (!extracted || (rest && !rest.startsWith('#') && !rest.startsWith(']'))) {
        problems.push(`第 ${lineno} 行引号未配对或其后有多余内容：${trimmed.slice(0, 60)}`);
      }
      continue;
    }
    if (value.startsWith('[')) {
      const delta = bracketDelta(scanned.bare.slice(scanned.eqAt + 1));
      if (delta > 0) arrayDepth = delta;
      else if (delta < 0) problems.push(`第 ${lineno} 行数组括号不配平：${trimmed.slice(0, 60)}`);
      continue;
    }
    if (value.startsWith('{')) {
      const braces = (value.match(/\{/g) || []).length - (value.match(/\}/g) || []).length;
      if (braces !== 0) problems.push(`第 ${lineno} 行内联表大括号不配平：${trimmed.slice(0, 60)}`);
      continue;
    }
    if (!/^(true|false|[+-]?(?:inf|nan)|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?)/.test(value)) {
      // 裸值只允许布尔/数字/inf/nan/日期时间；其余必须引号/数组/内联表开头
      problems.push(`第 ${lineno} 行值缺少引号或非法字面量：${trimmed.slice(0, 60)}`);
    }
  }
  if (multiline) problems.push('文件在多行字符串中间结束（未闭合）');
  if (arrayDepth > 0) problems.push('文件在跨行数组中间结束（未闭合）');
  return { ok: problems.length === 0, problems };
}

// 备份保留上限：按时间戳排序裁掉最老的 <file>.bak-*，防止无限累积。
function pruneBackups(filePath) {
  try {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.bak-`;
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - MAX_BACKUP_FILES))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * 原子写入（唯一 .tmp + fsync + rename），任一覆盖前都备份成 <file>.bak-<UTCts>。
 * @returns {string|null} 备份文件路径（不存在原文件时返回 null）
 */
export function writeWithBackup(filePath, content) {
  // TOML 写前校验：生成器出 bug 时在这里拦截，绝不把坏文件写进桌面端配置目录。
  if (/\.toml$/i.test(filePath)) {
    const check = validateTomlSyntax(content);
    if (!check.ok) {
      const error = new Error(
        `TOML 写前校验失败，已拒绝写入 ${path.basename(filePath)}：${check.problems.slice(0, 3).join('；')}`,
      );
      error.code = 'toml_precheck_failed';
      throw error;
    }
  }
  const backup = fs.existsSync(filePath)
    ? `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
    : null;
  if (backup) fs.copyFileSync(filePath, backup);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    // 写入/fsync 失败：临时文件当场清理，避免 .tmp-* 残留累积。
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  // Windows 上目标文件被桌面端短暂占用时 rename 可能瞬时 EPERM：短暂等待重试。
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
  if (lastError) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清理失败可接受 */ }
    throw lastError;
  }
  if (backup) pruneBackups(filePath);
  return backup;
}

/** 组装最终 models.json（保留原文件全部既有字段，仅按规则筛选条目）。 */
export function buildModelsJson(entries) {
  // 官方内置模型同名冲突（2026-09-03 实锤）：26.831 带有官方内置 GLM 模型，
  // 本地自定义 slug 与它同名时桌面端按「官方模型」直连官方 → "not supported
  // when using Codex with a ChatGPT account" 400——slug 自动改写为与官方
  // 完全无关的 zhipu- 名字规避；显示名不再追加任何标记（2026-09-03 用户决定：
  // 选择器只按「厂商/模型名」呈现，如 zhipu/GLM-5.3-Flash）。
  const renamed = entries.map((entry) => {
    const slug = typeof entry?.slug === 'string' ? entry.slug : '';
    // 历史条目清洗：早期为区分同名官方模型加的「(路由)」后缀一律剥掉
    const displayName = String(entry?.display_name ?? '').replace(/ \(路由\)$/, '').trim();
    const base = displayName ? { ...entry, display_name: displayName } : { ...entry };
    // 桌面端按 slug 片段识别官方内置模型（官方 ID 为无连字符的 glm5.3-flash 等，
    // 2026-09-03 实锤：含该片段的 slug（含带 -router/-glm 变体）都会被直连官方而
    // 400）。自定义条目（无 available_in_plans）改为与官方完全无关的 zhipu- 名字；
    // 官方内置 GLM 保留原名走官方通道。
    if (/^glm/i.test(slug) && !/^zhipu-/i.test(slug) && !entry?.available_in_plans) {
      const core = slug.toLowerCase();
      // 5.3 系映射到既有专有名（zhipu-plan / zhipu-flash-plan）；其余保留版本点号
      // （glm-5.1 → zhipu-glm-glm5.1，对齐官方 glm5.3 无连字符形态）
      const renamedSlug = /5\.3/.test(core)
        ? /flash/.test(core) ? 'zhipu-flash-plan' : 'zhipu-plan'
        : `zhipu-glm-${core.replace(/[^a-z0-9.]+/g, '')}`;
      return { ...base, slug: renamedSlug };
    }
    return base;
  });
  const sorted = [...renamed].sort((a, b) => {
    const pa = Number.isSafeInteger(a.priority) ? a.priority : 0;
    const pb = Number.isSafeInteger(b.priority) ? b.priority : 0;
    return pa - pb;
  });
  return `${JSON.stringify({ models: sorted }, null, 2)}\n`;
}

export function resolveDesktopPaths(codexHome) {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return {
    configToml: path.join(home, 'config.toml'),
    // 模型目录「池」：路由侧全量已知模型（/v1/models、分组自定义模型页、一键接入都写这里）
    modelsJson: path.join(home, 'models.json'),
    // 桌面端「已加载」精简目录：选择器只显示这里（apply-router 按勾选生成）。
    // 与池分离后，一键接入拉取的新模型不再直接涌入桌面选择器——用户勾选了才带入。
    modelsDesktopJson: path.join(home, 'models.desktop.json'),
  };
}

// 目录快照文件名：与目标文件同目录、按文件名派生（models.json 的快照名与历史版本一致）。
export const CATALOG_SNAPSHOT_NAME = 'models.json.router-snapshot.json';

export function catalogSnapshotPath(modelsJsonPath) {
  return path.join(path.dirname(modelsJsonPath), `${path.basename(modelsJsonPath)}.router-snapshot.json`);
}

/**
 * 恢复官方直连前快照完整模型目录。官方模式下桌面端会自行同步裁剪 models.json
 * （只保留官方模型 + 近期用过的自定义模型），路由侧模型条目会静默丢失；
 * 快照让下一次「接入路由」能把被裁掉的勾选模型自动找回。
 * 只在 models.json 存在且是合法 JSON 时快照；失败不影响主流程。
 * @returns {string|null} 快照路径（无条件跳过时 null）
 */
export function snapshotDesktopCatalog(modelsJsonPath) {
  try {
    const content = fs.readFileSync(modelsJsonPath, 'utf8');
    JSON.parse(content);
    const snapshotPath = catalogSnapshotPath(modelsJsonPath);
    fs.writeFileSync(snapshotPath, content);
    return snapshotPath;
  } catch {
    return null;
  }
}

/** 读取目录快照条目（无快照/损坏时返回空数组，条目必须带字符串 slug）。 */
export function readCatalogSnapshot(modelsJsonPath) {
  try {
    const data = JSON.parse(
      fs.readFileSync(catalogSnapshotPath(modelsJsonPath), 'utf8'),
    );
    return Array.isArray(data?.models)
      ? data.models.filter((entry) => entry && typeof entry.slug === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * apply-router 的勾选解析：目录条目 ∪ 快照回填。
 * 勾选中不在当前目录、但快照里还有的模型（官方模式期间被桌面端裁掉的）
 * 自动从快照回填进候选池；目录与快照都没有的才是真正的未知 slug。
 * @returns {{unknownSlugs: string[], pool: Array<object>}}
 */
export function mergeCatalogWithSnapshot(catalog, snapshotEntries, requested) {
  const known = new Set(catalog.map((entry) => entry.slug));
  const snapshotBySlug = new Map(snapshotEntries.map((entry) => [entry.slug, entry]));
  const wanted = [...new Set(requested.map((slug) => String(slug)))];
  const unknownSlugs = wanted.filter((slug) => !known.has(slug) && !snapshotBySlug.has(slug));
  const recovered = wanted
    .map((slug) => snapshotBySlug.get(slug))
    .filter((entry) => entry && !known.has(entry.slug));
  return { unknownSlugs, pool: recovered.length ? [...catalog, ...recovered] : catalog };
}