// ---------- 网页池工具目录·单一事实源（治根改造 P1.3，2026-09-14） ----------
// 历史问题：路由硬编码 15 工具镜像 vs 插件真实 18 工具长期漂移（get_app_state 13 参数
// 只剩 3），改插件必忘路由。本模块统一供给两个消费方：
//   1) 文本协议模式（chatgpt-web-tools 注入提示）——拉插件真实 tools/list，压缩 schema
//      控制提示词体积；拉取失败回退内置精简镜像（行为与迁移前完全一致）。
//   2) 原生 MCP 门面（webpool-mcp-server tools/list）——同一目录同源。
// 目录来源解析优先级：config tools.mcpServers 同名条目 → 桌面端 config.toml
// [mcp_servers.windows_computer_use] 段（部署在哪就从哪读，零新增配置）。

import { readFileSync } from 'node:fs';
import { listMcpServerSections, resolveDesktopPaths } from './codex-desktop-config.mjs';
import { probeMcpServerFull } from './tool-bridge.mjs';

export const CU_SERVER_NAME = 'windows_computer_use';

// 内置精简镜像：真实目录拉取失败（进程不可用/超时）时的兜底，保证文本协议
// 永不因上游探测问题失去工具面（原 chatgpt-web-tools 硬编码表原样迁入）
const FALLBACK_CU_CATALOG = [
  { name: 'list_apps', description: '列出当前可见的桌面应用窗口（名称/pid/标题）', parameters: { type: 'object', properties: {} } },
  {
    name: 'get_app_state',
    description: '读取目标应用的窗口状态、截图与紧凑可操作控件树（element_index/screen 坐标），操作前必须先调用',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: '应用名/进程名/窗口标题' }, depth: { type: 'integer' }, compact: { type: 'boolean' } },
      required: ['app'],
    },
  },
  { name: 'dump_app_targets', description: '轻量获取应用的可点击/可编辑/可滚动控件列表（不含截图）', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
  { name: 'screenshot_window', description: '对目标应用窗口截图', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
  {
    name: 'click',
    description: '点击控件（element_index 或 x/y 坐标），不移动用户真实鼠标',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'string', description: 'get_app_state 输出的控件序号' },
        x: { type: 'number' }, y: { type: 'number' },
        coordinateSpace: { type: 'string', enum: ['auto', 'screen', 'window', 'screenshot'] },
        click_count: { type: 'integer', description: '2=双击' },
        mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['app'],
    },
  },
  { name: 'perform_secondary_action', description: '触发控件的次要 UI Automation 动作', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, action: { type: 'string' } }, required: ['app', 'element_index', 'action'] } },
  { name: 'scroll', description: '在控件上滚动（不移动真实鼠标）', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number' } }, required: ['app', 'element_index', 'direction'] } },
  { name: 'drag', description: '屏幕坐标拖拽（不移动真实鼠标）', parameters: { type: 'object', properties: { app: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } }, required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'] } },
  { name: 'press_key', description: '聚焦目标应用并按键/组合键（如 ctrl+l）', parameters: { type: 'object', properties: { app: { type: 'string' }, key: { type: 'string' } }, required: ['app', 'key'] } },
  { name: 'type_text', description: '聚焦目标应用并输入文本', parameters: { type: 'object', properties: { app: { type: 'string' }, text: { type: 'string' } }, required: ['app', 'text'] } },
  { name: 'set_value', description: '设置可编辑控件的值', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, value: { type: 'string' } }, required: ['app', 'element_index', 'value'] } },
  { name: 'move_cursor', description: '移动虚拟光标到屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'start_computer_use', description: '开始电脑操作会话（预热桥）', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  { name: 'windows_computer_use_status', description: '查询电脑控制桥状态', parameters: { type: 'object', properties: {} } },
  { name: 'app_instruction_catalog', description: '列出内置的应用专属操作指南', parameters: { type: 'object', properties: { app: { type: 'string' } } } },
];

const FALLBACK_CATALOGS = { [CU_SERVER_NAME]: FALLBACK_CU_CATALOG };

// ---------- schema 压缩（提示词体积控制） ----------

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 递归压缩 JSON Schema：只保留模型选择/填参所需的最小骨架。 */
function compactSchemaNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return { type: 'object' };
  const out = {};
  if (typeof node.type === 'string') out.type = node.type;
  if (Array.isArray(node.enum)) out.enum = node.enum.slice(0, 12);
  const desc = clipText(node.description, 64);
  if (desc) out.description = desc;
  if (node.type === 'array') {
    out.items = compactSchemaNode(node.items, depth + 1);
  } else if (node.properties && typeof node.properties === 'object') {
    const props = {};
    for (const [key, sub] of Object.entries(node.properties).slice(0, 24)) {
      props[key] = compactSchemaNode(sub, depth + 1);
    }
    out.properties = props;
    const required = Array.isArray(node.required) ? node.required.filter((r) => typeof r === 'string') : [];
    if (required.length) out.required = required.slice(0, 24);
  }
  if (!out.type && out.properties) out.type = 'object';
  return out;
}

export function compactMcpTool(tool) {
  return {
    name: String(tool?.name || ''),
    description: clipText(tool?.description, 120),
    parameters: compactSchemaNode(tool?.inputSchema || { type: 'object', properties: {} }),
  };
}

// ---------- 目录来源解析（config tools.mcpServers → 桌面 config.toml 段） ----------

function normalizeServerName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

/** 解析 CU 插件的启动 spec；找不到返回 null（消费方走兜底镜像）。 */
export function resolveWebpoolMcpSpec({ toolsConfig = {}, codexHome = '', readFile = readFileSync } = {}) {
  const configured = (toolsConfig?.mcpServers || [])
    .find((s) => s && s.enabled !== false && normalizeServerName(s.name) === CU_SERVER_NAME);
  if (configured?.command) {
    return { command: configured.command, args: configured.args || [], env: configured.env || {}, source: 'router-config' };
  }
  try {
    const paths = resolveDesktopPaths(codexHome);
    const content = readFile(paths.configToml, 'utf8');
    const section = listMcpServerSections(content)
      .find((s) => normalizeServerName(s.name) === CU_SERVER_NAME && s.enabled !== false);
    if (section?.command) {
      return { command: section.command, args: section.args || [], env: section.env || {}, source: 'desktop-config' };
    }
  } catch { /* 桌面配置不存在/不可读：走兜底 */ }
  return null;
}

// ---------- 运行时缓存 ----------

const runtimeCatalogs = new Map(); // serverKey -> [{name, description, parameters}]
let refreshStatus = {
  server: CU_SERVER_NAME,
  source: 'fallback', // 'runtime' | 'fallback'
  toolCount: 0,
  lastRefreshAt: 0,
  lastError: '',
  specSource: '',
};

/** 刷新目录：拉真实 tools/list 成功即替换缓存；失败保留旧值并记录错误。 */
export async function refreshWebpoolToolCatalog(serverName = CU_SERVER_NAME, spec = null, { probe = probeMcpServerFull } = {}) {
  if (!spec?.command) {
    refreshStatus = { ...refreshStatus, lastError: '未找到 windows_computer_use 插件启动配置', };
    return { ok: false, error: refreshStatus.lastError };
  }
  const probed = await probe(spec, 25_000);
  if (!probed.ok || !probed.tools.length) {
    refreshStatus = { ...refreshStatus, lastError: String(probed.error || 'tools/list 空结果').slice(0, 200) };
    return { ok: false, error: refreshStatus.lastError };
  }
  const entries = probed.tools.map(compactMcpTool).filter((t) => t.name);
  runtimeCatalogs.set(serverName, entries);
  refreshStatus = {
    server: serverName,
    source: 'runtime',
    toolCount: entries.length,
    lastRefreshAt: Date.now(),
    lastError: '',
    specSource: spec.source || '',
  };
  return { ok: true, toolCount: entries.length };
}

/** 同步读目录（热路径零等待：只读缓存，缺省回退镜像）。 */
export function getWebpoolToolCatalog(serverName = CU_SERVER_NAME) {
  const cached = runtimeCatalogs.get(serverName);
  if (cached?.length) return cached;
  return FALLBACK_CATALOGS[serverName] || [];
}

export function getWebpoolToolCatalogStatus() {
  const active = runtimeCatalogs.get(refreshStatus.server)?.length ? 'runtime' : 'fallback';
  return { ...refreshStatus, active };
}

export function resetWebpoolToolCatalogForTests(entries = null) {
  runtimeCatalogs.clear();
  refreshStatus = {
    server: CU_SERVER_NAME, source: 'fallback', toolCount: 0, lastRefreshAt: 0, lastError: '', specSource: '',
  };
  if (entries) runtimeCatalogs.set(CU_SERVER_NAME, entries);
}
