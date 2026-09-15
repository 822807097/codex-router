// ---------- 网页池原生 MCP 门面（治根改造 P1b，2026-09-14） ----------
// ChatGPT 网页端官方 Secure MCP Tunnel 要求暴露一个 streamable HTTP MCP server。
// 本模块把路由包装成仅绑定 127.0.0.1 的 MCP 门面（隧道一跳由 tunnel-client 本地注入
// Bearer，ChatGPT 端 No Auth，密钥永不出机）：
//   - tools/list：直接读工具目录单一事实源（P1.3），不再有任何镜像可漂移；
//   - tools/call：委派现有执行面（windows_computer_use 热客户端 + 可选 web_search）。
// 设计约束（P0 侦察吸收）：
//   - 无状态：每个 POST 独立处理（DevSpace #256 教训——ChatGPT Host 高频重连/24h 会话
//     清理，服务端绝不能依赖跨请求会话态）；
//   - 快速返回：长操作排队而非阻塞 Host（#352 长调用被 Host 超时）；
//   - 电脑操作面单飞队列：桌面是单一资源，并发调用交错点击（P4.2 原生模式部分）；
//   - 调用审计：每次 tools/call 落 webpool_mcp.call 事件（工具名/耗时/成败），
//     幻觉成功无处遁形。

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CU_SERVER_NAME, getWebpoolToolCatalog } from './webpool-tool-catalog.mjs';
import { callMcpServerTool, executeWebSearch } from './tool-bridge.mjs';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_COMPUTER_QUEUE = 12;
const MAX_QUEUE_WAIT_MS = 30_000;

/** 读原生工具配置段（默认关——账号实弹验证前不自动启用任何对外面）。 */
export function readNativeToolsConfig(config = {}) {
  const native = (config.chatgptWeb && config.chatgptWeb.nativeTools) || {};
  return {
    enabled: native.enabled === true,
    port: Math.min(Math.max(Number(native.port) || 15731, 1), 65535),
    // Bearer 凭据名：值一律经 env-key-source（进程环境→注册表）读取，源码零字面量
    bearerKey: typeof native.bearerKey === 'string' && native.bearerKey.trim()
      ? native.bearerKey.trim() : 'ROUTER_MCP_BEARER',
    exposeWebSearch: native.exposeWebSearch === true,
    exposeComputer: native.exposeComputer !== false,
  };
}

function bearerMatches(header, bearer) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.slice(7)).digest();
  const want = createHash('sha256').update(bearer).digest();
  return timingSafeEqual(given, want);
}

/**
 * 创建门面。deps 为测试注入缝：
 * - callComputerTool(toolName, args)：执行 CU 工具（默认热客户端代理）
 * - searchWeb(query)：执行联网搜索
 * - version：serverInfo 版本号
 */
export function createWebpoolMcpServer({
  log = () => {},
  getToolsConfig = () => ({}),
  deps = {},
  version = '0.0.0',
  maxComputerQueue = MAX_COMPUTER_QUEUE,
} = {}) {
  let server = null;
  let port = 0;
  let queueTail = Promise.resolve();
  let queueDepth = 0;
  const counters = { calls: 0, ok: 0, fail: 0, denied: 0 };
  let bearer = ''; // 空串=不校验（仅当 env-key 未配置时；绑定固定 127.0.0.1 兜底）

  const callComputer = deps.callComputerTool
    || ((name, args) => callMcpServerTool(getToolsConfig(), CU_SERVER_NAME, name, args));
  const searchWeb = deps.searchWeb
    || (async (query) => {
      const result = await executeWebSearch(getToolsConfig(), query);
      if (!result.ok) return `搜索失败：${result.error || '无结果'}`;
      return result.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    });

  function listTools(nativeConfig) {
    const tools = [];
    if (nativeConfig.exposeComputer) {
      for (const entry of getWebpoolToolCatalog(CU_SERVER_NAME)) {
        tools.push({
          name: entry.name,
          description: entry.description || entry.name,
          inputSchema: entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : { type: 'object', properties: {} },
        });
      }
    }
    if (nativeConfig.exposeWebSearch) {
      tools.push({
        name: 'web_search',
        description: '联网搜索最新信息，query 用精确关键词。',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
      });
    }
    return tools;
  }

  // 单飞队列（ promise 链经典模式）。acquire 返回「入场 promise」：解析为 release 函数
  // 表示持锁；解析为 null 表示等待超时已放弃并把顺位让给后继。队满返回 null（同步）。
  function acquireComputerSlot() {
    if (queueDepth >= maxComputerQueue) return null;
    queueDepth += 1;
    const prev = queueTail;
    let releaseNext;
    queueTail = new Promise((r) => { releaseNext = r; });
    let admitted = false;
    const admission = prev.then(() => { admitted = true; });
    let timer;
    const enter = Promise.race([
      admission.then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), MAX_QUEUE_WAIT_MS); timer.unref?.(); }),
    ]).then((got) => {
      if (timer) clearTimeout(timer);
      if (!got && !admitted) {
        queueDepth -= 1;
        releaseNext(); // 放弃顺位：放行全部后继，避免链头空洞卡死队列
        return null;
      }
      let done = false;
      return () => { if (done) return; done = true; queueDepth -= 1; releaseNext(); };
    });
    return enter;
  }

  async function handleToolCall(name, args, nativeConfig) {
    if (name === 'web_search' && nativeConfig.exposeWebSearch) {
      const query = String(args?.query || '').trim();
      if (!query) return { text: '缺少 query 参数', isError: true };
      try {
        return { text: await searchWeb(query), isError: false };
      } catch (error) {
        return { text: `搜索执行失败：${String(error?.message || error).slice(0, 200)}`, isError: true };
      }
    }
    if (nativeConfig.exposeComputer && getWebpoolToolCatalog(CU_SERVER_NAME).some((t) => t.name === name)) {
      const enter = acquireComputerSlot();
      if (!enter) return { text: '电脑操作排队已满（并发过多），请稍后重试', isError: true };
      const release = await enter;
      if (!release) return { text: `等待电脑操作空闲超时（${MAX_QUEUE_WAIT_MS / 1000}s），请稍后重试`, isError: true };
      try {
        const text = await callComputer(name, args);
        return { text: String(text ?? ''), isError: false };
      } catch (error) {
        return { text: `工具执行失败：${String(error?.message || error).slice(0, 300)}`, isError: true };
      } finally {
        release();
      }
    }
    return { text: `未知工具：${String(name).slice(0, 64)}`, isError: true };
  }

  function respondJson(res, httpStatus, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(httpStatus, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /** 单条 JSON-RPC 消息 → 响应对象；通知/无效返回 null（202）。 */
  async function runMessage(message, nativeConfig) {
    const id = message?.id;
    const hasId = id !== undefined && id !== null;
    const method = String(message?.method || '');
    if (!method) {
      return hasId ? { id, jsonrpc: '2.0', error: { code: -32600, message: '缺少 method' } } : null;
    }
    if (method.startsWith('notifications/')) return null;
    switch (method) {
      case 'initialize':
        return {
          id, jsonrpc: '2.0',
          result: {
            protocolVersion: typeof message?.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'codex-multi-model-router', version },
          },
        };
      case 'ping':
        return { id, jsonrpc: '2.0', result: {} };
      case 'tools/list':
        return { id, jsonrpc: '2.0', result: { tools: listTools(nativeConfig) } };
      case 'tools/call': {
        const name = String(message?.params?.name || '');
        const args = message?.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
        const startedAt = Date.now();
        const { text, isError } = await handleToolCall(name, args, nativeConfig);
        counters.calls += 1;
        if (isError) counters.fail += 1; else counters.ok += 1;
        log({
          event: 'webpool_mcp.call',
          tool: name.slice(0, 64),
          ok: !isError,
          ms: Date.now() - startedAt,
          queue_depth: queueDepth,
          args_keys: Object.keys(args || {}).slice(0, 10).join(','),
        });
        return { id, jsonrpc: '2.0', result: { content: [{ type: 'text', text }], isError } };
      }
      default:
        return hasId ? { id, jsonrpc: '2.0', error: { code: -32601, message: `不支持的方法：${method.slice(0, 40)}` } } : null;
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('payload_too_large');
        error.code = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function onMcpRequest(req, res, nativeConfig) {
    if (bearer) {
      if (!bearerMatches(req.headers.authorization, bearer)) {
        counters.denied += 1;
        log({ event: 'webpool_mcp.denied', path: String(req.url || '').slice(0, 40) });
        respondJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
        return;
      }
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      respondJson(res, error.code === 413 ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: error.code === 413 ? -32000 : -32600, message: error.code === 413 ? '请求体过大' : '读取请求体失败' } });
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      respondJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const list = Array.isArray(message) ? message.slice(0, 32) : [message];
    const respondMany = Array.isArray(message);
    const out = [];
    for (const one of list) {
      if (one === null || one === undefined) continue;
      const result = await runMessage(one, nativeConfig);
      if (result === null) { if (!respondMany) { res.writeHead(202); res.end(); return; } continue; }
      out.push(result);
    }
    if (respondMany) { respondJson(res, 200, out); return; }
    if (out.length) respondJson(res, 200, out[0]);
    else res.writeHead(202), res.end();
  }

  return {
    /**
     * 启动门面。bearerProvider 返回 Promise<string>（env-key-source 读取）；
     * 空值=不校验（循环地址绑定兜底）。返回实际监听端口。
     */
    async start({ port: wantPort, bearerProvider = async () => '', getNativeConfig = () => readNativeToolsConfig({}) }) {
      bearer = String(await bearerProvider().catch(() => '') || '');
      const want = Number(wantPort);
      port = Number.isInteger(want) && want >= 0 && want <= 65535 ? want : 15731;
      server = http.createServer((req, res) => {
        const urlPath = String(req.url || '').split('?')[0];
        if (req.method === 'GET' && urlPath === '/healthz') {
          // 显式字段：spread counters 会把计数键 ok:0 覆盖到健康标记上（测试实锤）
          respondJson(res, 200, { ok: true, queue_depth: queueDepth, calls: counters.calls, failed: counters.fail, denied: counters.denied });
          return;
        }
        if (req.method !== 'POST' || urlPath !== '/mcp') {
          respondJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not found' } });
          return;
        }
        onMcpRequest(req, res, getNativeConfig()).catch((error) => {
          log({ event: 'webpool_mcp.crash', reason: String(error?.message || error).slice(0, 200) });
          try { respondJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: '内部错误' } }); } catch { /* 已发出 */ }
        });
      });
      // 与 Host 高频重连共处：socket 快速回收
      server.keepAliveTimeout = 30_000;
      server.headersTimeout = 35_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      port = server.address().port;
      return port;
    },

    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      await new Promise((resolve) => {
        active.closeAllConnections?.();
        active.close(resolve);
        setTimeout(resolve, 2000).unref?.();
      });
    },

    /**
     * 进程内自探（管理页「测试」用）：与 HTTP 层同一条 runMessage 链路直通一遍
     * initialize + tools/list。不走网络（服务端发起 localhost 请求被安全约束禁止，
     * HTTP 传输层由 test/webpool-mcp-server.test.mjs 覆盖）。
     */
    async probe(getNativeConfig) {
      const nativeConfig = typeof getNativeConfig === 'function' ? getNativeConfig() : (getNativeConfig || readNativeToolsConfig({}));
      const init = await runMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'admin-selftest', version: '1' } } }, nativeConfig);
      const listed = await runMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, nativeConfig);
      const tools = (listed?.result?.tools || []).map((t) => String(t.name));
      return {
        ok: Boolean(init?.result && listed?.result),
        serverInfo: init?.result?.serverInfo || null,
        toolCount: tools.length,
        tools: tools.slice(0, 40),
      };
    },

    status() {
      return {
        listening: Boolean(server),
        port,
        bearerConfigured: Boolean(bearer),
        queueDepth,
        maxQueue: MAX_COMPUTER_QUEUE,
        ...counters,
      };
    },
  };
}
