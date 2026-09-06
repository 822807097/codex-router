// ---------- 路由内置工具桥（Tool Bridge） ----------
// 厂商模型没有官方那种服务端工具（web_search 由 OpenAI 上游执行）。本模块让
// 路由自己充当工具提供方与执行方：把内置工具（联网搜索 / MCP 工具）以 function
// 声明注入请求，模型调用时由路由执行并把结果回注，继续请求直到模型给出最终回答。
//
// - 联网搜索：DuckDuckGo（免 key）默认；可选 Tavily（key 走环境变量 TAVILY_API_KEY，
//   遵循「密钥不进配置文件」原则）。
// - MCP：stdio 传输的最小 JSON-RPC 客户端（initialize / tools/list / tools/call），
//   网关进程按 server 惰性拉起并缓存，空闲超时回收。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { rawHttpsRequest } from './transport.mjs';

const SEARCH_TIMEOUT_MS = 15_000;
const MCP_INIT_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 60_000;
const MCP_IDLE_TTL_MS = 5 * 60 * 1000;

/** 读取 tools 配置段（缺省安全值）。 */
export function readToolsConfig(config = {}) {
  const tools = config.tools || {};
  const webSearch = tools.webSearch || {};
  return {
    webSearch: {
      enabled: webSearch.enabled === true,
      provider: ['duckduckgo', 'tavily'].includes(webSearch.provider) ? webSearch.provider : 'duckduckgo',
      maxResults: Math.min(Math.max(Number(webSearch.maxResults) || 5, 1), 10),
    },
    mcpServers: (Array.isArray(tools.mcpServers) ? tools.mcpServers : [])
      .filter((s) => s && typeof s.name === 'string' && s.name.trim() && typeof s.command === 'string' && s.command.trim())
      .map((s) => ({
        name: s.name.trim(),
        command: s.command.trim(),
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)])) : {},
        enabled: s.enabled !== false,
      })),
    skills: (Array.isArray(tools.skills) ? tools.skills : [])
      .filter((s) => s && typeof s.name === 'string' && typeof s.content === 'string')
      .map((s) => ({ name: s.name.trim().slice(0, 80), content: String(s.content).slice(0, 16_000), enabled: s.enabled !== false })),
  };
}

// ---------- 联网搜索提供方 ----------

function decodeDuckDuckGoUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return href;
  }
}


async function searchTavily(query, maxResults, apiKey) {
  if (!apiKey) throw new Error('未配置 TAVILY_API_KEY 环境变量');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: 'basic' }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Tavily 返回 ${res.status}: ${String(data?.detail || '').slice(0, 120)}`);
  return (data.results || []).map((r) => ({ title: r.title || '', url: r.url || '', snippet: String(r.content || '').slice(0, 300) }));
}

/** 执行联网搜索，返回统一结果结构。 */
// DDG 在部分网络（如国内直连）不可达：走路由全局代理（v2rayN HTTP CONNECT）访问。
async function fetchViaProxy(url, proxy) {
  const target = new URL(url);
  const outcome = await rawHttpsRequest({
    protocol: 'https',
    host: target.host,
    path: target.pathname + target.search,
    method: 'GET',
    viaProxy: Boolean(proxy),
    proxy,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html',
    },
    timeouts: { connectMs: 10_000, responseHeaderMs: 20_000, requestMs: SEARCH_TIMEOUT_MS },
    maxResponseBytes: 4 * 1024 * 1024,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`搜索源返回 ${outcome.status}`);
  }
  return outcome.bodyText || '';
}

async function searchDuckDuckGo(query, maxResults, proxy) {
  const body = new URLSearchParams({ q: query, kl: 'cn-zh' }).toString();
  const html = await fetchViaProxy(`https://html.duckduckgo.com/html/?${body}`, proxy);
  const results = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html))) snippets.push(sm[1]);
  let bm;
  while ((bm = blockRe.exec(html)) && results.length < maxResults) {
    const url = decodeDuckDuckGoUrl(bm[1]);
    const title = bm[2].replace(/<[^>]+>/g, '').trim();
    if (!title || !url.startsWith('http')) continue;
    results.push({ title, url, snippet: (snippets[results.length] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300) });
  }
  if (!results.length) throw new Error('DuckDuckGo 未解析到结果（可能被反爬拦截）');
  return results;
}

/** 执行联网搜索，返回统一结果结构。 */
export async function executeWebSearch(toolsConfig, query, env = process.env, proxy = null) {
  const { provider, maxResults } = toolsConfig.webSearch;
  const order = provider === 'tavily'
    ? ['tavily', 'duckduckgo']
    : ['duckduckgo', 'tavily'];
  let lastError = '';
  for (const candidate of order) {
    try {
      if (candidate === 'duckduckgo') {
        const results = await searchDuckDuckGo(query, maxResults, proxy);
        return { ok: results.length > 0, provider: 'duckduckgo', results };
      }
      const apiKey = env.TAVILY_API_KEY || '';
      if (!apiKey) { lastError = 'TAVILY_API_KEY 未设置'; continue; }
      const results = await searchTavily(query, maxResults, apiKey);
      return { ok: results.length > 0, provider: 'tavily', results };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 200);
    }
  }
  return { ok: false, provider, error: lastError || '无可用搜索源', results: [] };}


// ---------- MCP stdio 最小客户端（JSON-RPC 2.0） ----------

class McpStdioClient {
  constructor(server) {
    this.server = server;
    this.process = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = null;
    this.lastUsedAt = 0;
  }

  start() {
    if (this.process) return;
    this.process = spawn(this.server.command, this.server.args, {
      env: { ...process.env, ...this.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
          }
        } catch { /* 非法行忽略 */ }
      }
    });
    this.process.on('exit', () => {
      this.process = null;
      for (const resolver of this.pending.values()) resolver({ error: { code: -1, message: 'MCP server exited' } });
      this.pending.clear();
      this.tools = null;
    });
  }

  request(method, params, timeoutMs) {
    this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: -32000, message: `${method} 超时` } });
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      try {
        this.process.stdin.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { code: -1, message: String(error?.message || error) } });
      }
    });
  }

  async ensureInitialized() {
    this.start();
    this.lastUsedAt = Date.now();
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex-router', version: '1.0.0' },
    }, MCP_INIT_TIMEOUT_MS);
    if (init.error) throw new Error(init.error.message || 'MCP initialize 失败');
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools() {
    if (this.tools) return this.tools;
    await this.ensureInitialized();
    const res = await this.request('tools/list', {}, MCP_CALL_TIMEOUT_MS);
    if (res.error) throw new Error(res.error.message || 'tools/list 失败');
    this.tools = (res.result?.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  async callTool(name, args) {
    await this.ensureInitialized();
    const res = await this.request('tools/call', { name, arguments: args || {} }, MCP_CALL_TIMEOUT_MS);
    if (res.error) throw new Error(res.error.message || 'tools/call 失败');
    const content = (res.result?.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    return content || '(空结果)';
  }

  /** 空闲回收：超 TTL 且无 pending 的进程退出。 */
  maybeReap(now = Date.now()) {
    if (this.process && now - this.lastUsedAt > MCP_IDLE_TTL_MS && this.pending.size === 0) {
      try { this.process.kill(); } catch { /* 已退出 */ }
    }
  }
}

const mcpClients = new Map();
let lastReapAt = 0;

function getMcpClient(server) {
  let client = mcpClients.get(server.name);
  if (!client) {
    client = new McpStdioClient(server);
    mcpClients.set(server.name, client);
  }
  return client;
}

/** 收集全部内置工具的 function 声明（注入请求 tools）。 */
export async function collectBuiltinTools(toolsConfig, env = process.env) {
  const tools = [];
  if (toolsConfig.webSearch.enabled) {
    tools.push({
      name: 'web_search',
      description: '联网搜索最新信息。当需要实时/最新/无法离线获知的信息时调用，query 用精确关键词。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    });
  }
  for (const server of toolsConfig.mcpServers) {
    if (!server.enabled) continue;
    try {
      const toolsList = await getMcpClient(server).listTools();
      for (const tool of toolsList) {
        tools.push({
          name: `mcp__${server.name}__${tool.name}`.slice(0, 64),
          description: `[MCP:${server.name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema,
        });
      }
    } catch (error) {
      // 单个 MCP server 失败不阻塞其余工具注入
    }
  }
  // 回收空闲 MCP 进程（低频触发）
  if (Date.now() - lastReapAt > 60_000) {
    lastReapAt = Date.now();
    for (const client of mcpClients.values()) client.maybeReap();
  }
  return tools;
}

/** 执行内置工具调用（name 来自注入声明）。 */
export async function executeBuiltinTool(toolsConfig, name, args, env = process.env) {
  if (name === 'web_search') {
    const result = await executeWebSearch(toolsConfig, String(args?.query || '').trim(), env);
    if (!result.ok) return `搜索失败：${result.error || '无结果'}`;
    return result.results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
      .join('\n\n');
  }
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    const serverName = sep > 0 ? rest.slice(0, sep) : '';
    const toolName = sep > 0 ? rest.slice(sep + 2) : rest;
    const server = toolsConfig.mcpServers.find((s) => s.name === serverName && s.enabled);
    if (!server) return `MCP server ${serverName} 未启用`;
    return getMcpClient(server).callTool(toolName, args);
  }
  throw new Error(`未知内置工具：${name}`);
}

/** 启用的技能拼接为 system 附加指令（Codex 未提供的技能由路由注入）。 */
export function buildSkillsSystemAppendix(toolsConfig) {
  const enabled = toolsConfig.skills.filter((s) => s.enabled && s.content.trim());
  if (!enabled.length) return '';
  const blocks = enabled.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`);
  return `\n\n<routed-skills>以下技能由路由器提供，命中场景时按技能内容执行：\n${blocks.join('\n')}\n</routed-skills>`;
}

export function resetMcpClientsForTests() {
  mcpClients.clear();
}
