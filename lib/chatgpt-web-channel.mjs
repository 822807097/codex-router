// ---------- ChatGPT 网页会话通道派发器：chat 请求 → chatgpt.com/backend-api/conversation ----------
// 在路由的 chat 上游派发点拦截 platform:'chatgpt-web' 的目标（镜像 google-channel 契约）：
// 1. authManager 账号池选号（provider='chatgpt-web'，复用优先级/轮换/suspect 状态机），
//    401→刷新→重试一次→仍失败标 auth_expired；429→冷却并换号重试
// 2. 每请求四步：bootstrap 首页（取 PoW 脚本引用）→ sentinel prepare/finalize（拿
//    requirements token，PoW 本地求解）→ POST /backend-api/conversation（SSE）
// 3. conversation SSE → chat SSE 转换流（chatgpt-web-sse），对下游呈现为标准 chat 上游，
//    桥接/统计/错误处理零改动。
// ToS 风险：网页协议属灰区，默认关闭——只有管理员在面板显式添加 chatgpt-web 账号才启用。
// 安全：token 只进 Authorization 头与 vault，不写日志；错误信息截断脱敏。

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { rawHttpsRequest } from './transport.mjs';
import {
  buildProofToken,
  buildLegacyRequirementsToken,
  parsePowResources,
  DEFAULT_POW_SCRIPT,
} from './chatgpt-web-pow.mjs';
import { solveTurnstileToken } from './chatgpt-web-turnstile.mjs';
import {
  buildToolProtocolPrompt,
  renderToolLoopTurns,
  mergeContinuationMcpTools,
  stripToolRefusalNarration,
  BRIDGE_CONFIRMATION,
} from './chatgpt-web-tools.mjs';
import {
  createConversationToChatTransform,
  conversationSseToChatCompletion,
} from './chatgpt-web-sse.mjs';

const BASE_URL = 'https://chatgpt.com';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const TRANSIENT_RE = /timeout|timed? out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed|socket hang up/i;

function readAll(stream, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
      else stream.destroy();
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** 单账号指纹：首用生成持久入 metadata.fingerprint，此后不漂移。 */
function ensureFingerprint(account) {
  const fp = account.metadata?.fingerprint;
  if (fp && fp.userAgent && fp.deviceId) return fp;
  return {
    userAgent: DEFAULT_UA,
    deviceId: randomUUID(),
    sessionId: randomUUID(),
    secChUa: '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  };
}

function sessionHeaders(fp) {
  return {
    'user-agent': fp.userAgent,
    'oai-device-id': fp.deviceId,
    'oai-session-id': fp.sessionId,
    'sec-ch-ua': fp.secChUa,
    'sec-ch-ua-mobile': fp.secChUaMobile,
    'sec-ch-ua-platform': fp.secChUaPlatform,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

async function httpsJson({ path, method = 'POST', body, accessToken, fp, proxy, openStream, timeouts, signal }) {
  const options = {
    protocol: 'https',
    host: 'chatgpt.com',
    path,
    method,
    viaProxy: true,
    proxy,
    headers: {
      ...sessionHeaders(fp),
      'x-openai-target-path': path,
      'x-openai-target-route': path,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body } : {}),
    signal,
    timeouts: timeouts || { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 120_000 },
  };
  const upstream = openStream ? await openStream(options) : await rawHttpsRequest(options);
  const text = typeof upstream.bodyText === 'string'
    ? upstream.bodyText
    : await readAll(upstream.stream || upstream.socket);
  return { status: upstream.status || 0, text, headers: upstream.headers };
}

// chat messages → conversation messages（V1：仅文本；图片部分原样丢弃不冒进）
// system 归并到首条 user 消息头部（conversation 协议无独立 system 通道）。
// 历史截断：网页通道每请求无状态（history_and_training_disabled），全量历史纯粹
// 是上下文；上限既保护负载，也防「模型复读了自己的历史」滚雪球放大（复读循环实证）。
const MAX_WEB_HISTORY_MESSAGES = 60;

export function chatMessagesToConversationMessages(messages = []) {
  const systemParts = [];
  const conversationMessages = [];
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    // 工具桥：assistant(tool_calls) + 连续 role:"tool" 结果 → 合并为一对文本消息
    if (item?.role === 'assistant' && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
      const turn = renderToolLoopTurns(messages, index);
      if (turn) {
        conversationMessages.push({
          id: randomUUID(),
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [turn.assistantText] },
        });
        conversationMessages.push({
          id: randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [turn.userText] },
        });
        // 跳过紧随的 tool 结果消息（已合并）
        let skip = index + 1;
        while (skip < messages.length && messages[skip]?.role === 'tool') skip += 1;
        index = skip - 1;
        continue;
      }
    }
    if (item?.role === 'tool') continue; // 无配对调用方的孤儿结果：丢弃（防串味）
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'system' ? 'system' : 'user';
    let text = '';
    if (typeof item?.content === 'string') {
      text = item.content;
    } else if (Array.isArray(item?.content)) {
      text = item.content
        .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('');
    } else if (item?.role === 'assistant' && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
      continue; // 空 content 且无配对结果的调用轮：跳过
    }
    if (role === 'system') {
      systemParts.push(text);
      continue;
    }
    conversationMessages.push({
      id: randomUUID(),
      author: { role },
      content: { content_type: 'text', parts: [text] },
    });
  }
  // 截断：保留首条（承载合并 system 的开场）+ 最近 N-1 条。切点必须落在工具对
  // 边界外——「工具结果：」开头的 user 消息与其前置 assistant 调用叙述是渲染出的
  // 一对（renderToolLoopTurns），劈开会产生孤儿结果回执（复读/幻觉诱因）
  let trimmed = conversationMessages;
  if (conversationMessages.length > MAX_WEB_HISTORY_MESSAGES) {
    const tailCount = MAX_WEB_HISTORY_MESSAGES - 1;
    let start = conversationMessages.length - tailCount;
    while (
      start > 1
      && start < conversationMessages.length
      && typeof conversationMessages[start]?.content?.parts?.[0] === 'string'
      && conversationMessages[start].content.parts[0].startsWith('工具结果：')
    ) {
      start -= 1;
    }
    trimmed = [conversationMessages[0], ...conversationMessages.slice(start)];
  }
  if (systemParts.length && trimmed.length) {
    const first = trimmed[0];
    if (first.author.role === 'user' && Array.isArray(first.content?.parts)) {
      first.content.parts[0] = `${systemParts.join('\n\n').trim()}\n\n${first.content.parts[0] || ''}`;
    } else {
      trimmed.unshift({
        id: randomUUID(),
        author: { role: 'system' },
        content: { content_type: 'text', parts: [systemParts.join('\n\n')] },
      });
    }
  }
  return trimmed;
}

export function buildConversationPayload(messages, model, timezone = 'Asia/Shanghai', tools = null) {
  // tools 为调用方已合并 CU 目录后的工具表（mergeContinuationMcpTools 在上游统一做）。
  // 注入发生过时，剔除历史中模型自己的「工具不可用」拒绝文本——模型照着自己的
  // 历史继续拒绝的惯性比重新注入的工具表更强（2026-09-10 实测）
  const cleanedMessages = tools?.toolsRestored === true
    ? stripToolRefusalNarration(messages)
    : messages;
  const conversation = {
    action: 'next',
    messages: chatMessagesToConversationMessages(cleanedMessages),
    model,
    parent_message_id: randomUUID(),
    conversation_mode: { kind: 'primary_assistant' },
    conversation_origin: null,
    force_paragen: false,
    force_paragen_model_slug: '',
    force_rate_limit: false,
    force_use_sse: true,
    history_and_training_disabled: true,
    reset_rate_limits: false,
    suggestions: [],
    supported_encodings: [],
    system_hints: [],
    timezone,
    timezone_offset_min: -480,
    variant_purpose: 'comparison_implicit',
    websocket_request_id: randomUUID(),
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 120,
      page_height: 900,
      page_width: 1400,
      pixel_ratio: 2,
      screen_height: 1440,
      screen_width: 2560,
    },
  };
  // 工具桥 V2.4：伪历史布防。确认词必须确立「执行器已接入」的既成事实（V2.3 换成
  // 「好的。」后模型会否认有工具——实测回归），但长确认词会被模型当开场白逐字复述
  // （复读循环实证）——由输出侧 sanitizeBridgeOutput 精确剥离兜底，两头兼得。
  // tools 为调用方合并过 CU 目录后的最终工具表（提示与解析必须同一份）。
  const toolPrompt = buildToolProtocolPrompt(tools);
  if (toolPrompt) {
    conversation.messages.unshift(
      {
        id: randomUUID(),
        author: { role: 'system' },
        content: { content_type: 'text', parts: [toolPrompt] },
      },
      {
        id: randomUUID(),
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: [BRIDGE_CONFIRMATION] },
      },
    );
  }
  return conversation;
}

/**
 * 每请求 sentinel 门禁：bootstrap → prepare（legacy p token）→ PoW → finalize。
 * arkose/turnstile required 时抛出明确错误（V1 不做，账号不背冷却）。
 */
export async function acquireChatRequirements({ accessToken, fp, proxy, openStream, timeouts, signal, log = () => {} }) {
  let powScriptSources = [DEFAULT_POW_SCRIPT];
  let powDataBuild = '';
  try {
    const bootstrap = await httpsJson({
      path: '/', method: 'GET', accessToken: null, fp, proxy, openStream, timeouts, signal,
    });
    if (bootstrap.status === 200) {
      const parsed = parsePowResources(bootstrap.text);
      powScriptSources = parsed.scriptSources;
      powDataBuild = parsed.dataBuild;
    } else {
      log({ event: 'chatgpt_web.bootstrap_non200', status: bootstrap.status });
    }
  } catch (error) {
    log({ event: 'chatgpt_web.bootstrap_failed', reason: String(error?.message || '').slice(0, 120) });
  }

  const powOpts = { scriptSources: powScriptSources, dataBuild: powDataBuild };
  const pToken = buildLegacyRequirementsToken(fp.userAgent, powOpts);

  const prepare = await httpsJson({
    path: '/backend-api/sentinel/chat-requirements/prepare',
    body: JSON.stringify({ p: pToken }),
    accessToken,
    fp, proxy, openStream, timeouts, signal,
  });
  if (prepare.status !== 200) {
    const error = new Error(`sentinel prepare 失败: HTTP ${prepare.status}`);
    error.status = prepare.status;
    throw error;
  }
  let prepareData = {};
  try { prepareData = JSON.parse(prepare.text); } catch { /* 畸形响应走 requirements 缺失报错 */ }
  if (prepareData?.arkose?.required) {
    const error = new Error('上游要求 arkose 验证（本通道不支持），请稍后重试或换通道');
    error.code = 'arkose_required';
    throw error;
  }

  let proofToken = '';
  const pow = prepareData?.proofofwork || {};
  if (pow.required) {
    proofToken = await buildProofToken(pow.seed || '', pow.difficulty || '', fp.userAgent, powOpts);
  }
  // turnstile：sentinel 偶发要求时用本地 VM 求解器解 dx 字节码（参考
  // chatgpt2api/utils/turnstile.py 逐操作码移植，见 lib/chatgpt-web-turnstile.mjs）；
  // dx 缺失或求解失败才走快速失败（不冷却账号）
  let turnstileToken = '';
  if (prepareData?.turnstile?.required) {
    const dx = prepareData.turnstile.dx || '';
    turnstileToken = solveTurnstileToken(dx, pToken) || '';
    if (!turnstileToken) {
      // 诊断：dx 缺失/null/空串与解码失败是不同病因，log 里区分（dx 只打长度与前 8 位）
      log({
        event: 'chatgpt_web.turnstile_solve_failed',
        dx_present: Boolean(dx),
        dx_length: dx.length,
        dx_prefix: dx.slice(0, 8),
        p_token_length: pToken.length,
      });
      const error = new Error('上游要求 turnstile 人机验证且本地求解失败，请稍后重试或换通道');
      error.code = 'turnstile_required';
      throw error;
    }
    log({ event: 'chatgpt_web.turnstile_solved' });
  }

  const finalize = await httpsJson({
    path: '/backend-api/sentinel/chat-requirements/finalize',
    body: JSON.stringify({
      prepare_token: prepareData?.prepare_token || '',
      proof_token: proofToken,
      turnstile_token: turnstileToken,
    }),
    accessToken,
    fp, proxy, openStream, timeouts, signal,
  });
  if (finalize.status !== 200) {
    const error = new Error(`sentinel finalize 失败: HTTP ${finalize.status}`);
    error.status = finalize.status;
    throw error;
  }
  let finalizeData = {};
  try { finalizeData = JSON.parse(finalize.text); } catch { /* 同上 */ }
  const token = finalizeData?.token;
  if (!token) {
    const error = new Error('sentinel 未返回 requirements token（响应畸形）');
    error.code = 'requirements_missing';
    throw error;
  }
  return {
    token,
    proofToken,
    turnstileToken,
    soToken: finalizeData?.so_token || '',
    powScriptSources,
    powDataBuild,
  };
}

/**
 * openChatGptWebChatStream：与 openGoogleChatStream 同契约。
 * 返回 {status, headers, stream}（stream=chat SSE 转换流）或抛 {status,message} 错误。
 */
export async function openChatGptWebChatStream({
  chatBody,
  target,
  model,
  authManager,
  proxy,
  openStream,
  signal,
  timeouts,
  log = () => {},
} = {}) {
  const maxAccountAttempts = 3;
  const triedAccounts = new Set();
  const failure = { status: 502, message: '' };

  // handler 已按 target 映射把 chatBody.model 换成上游 slug（upstreamModel '$1' 捕获替换），
  // 优先取它；target.upstreamModel 的模板占位（$N）不是真实模型名，不能直接发上游
  const requestedSlug = (typeof chatBody?.model === 'string' && chatBody.model) || '';
  const staticSlug = (typeof target?.upstreamModel === 'string' && !/\$\d/.test(target.upstreamModel)
    && target.upstreamModel) || '';
  const modelSlug = requestedSlug || staticSlug || 'auto';

  for (let attemptNo = 0; attemptNo < maxAccountAttempts; attemptNo += 1) {
    if (signal?.aborted) break;
    let account = authManager?.acquireAccount
      ? authManager.acquireAccount({ provider: 'chatgpt-web' })
      : null;
    let rollGuard = 0;
    while (account && triedAccounts.has(account.id) && rollGuard < 8) {
      account = authManager.acquireAccount({ provider: 'chatgpt-web' });
      rollGuard += 1;
    }
    if (!account || triedAccounts.has(account.id)) break;
    triedAccounts.add(account.id);

    let credentials = null;
    try {
      credentials = await authManager.getValidCredentials(account.id);
    } catch (error) {
      const transient = TRANSIENT_RE.test(String(error?.message || ''));
      authManager.markCooldown?.(account.id, transient ? 60_000 : 60 * 60_000);
      failure.message = `账号凭据刷新失败：${String(error?.message || '').slice(0, 160)}`;
      continue;
    }
    if (!credentials?.accessToken) {
      authManager.markAuthExpired?.(account.id, '账号没有可用凭据（access_token 缺失）');
      failure.message = '账号没有可用凭据，请在管理页重新导入';
      continue;
    }

    const fp = ensureFingerprint(account);
    if (fp !== account.metadata?.fingerprint) {
      // 首次生成：持久化，之后不再漂移
      try {
        authManager.updateAccount(account.id, {
          metadata: { ...(account.metadata || {}), fingerprint: fp },
        });
      } catch { /* 持久化失败不阻断本次请求 */ }
    }

    try {
      const requirements = await acquireChatRequirements({
        accessToken: credentials.accessToken,
        fp, proxy, openStream, timeouts, signal, log,
      });

      // 工具面统一：注入 CU 目录后的工具表同时喂给组包（提示）与解析（allowedNames）——
      // 只喂提示会让模型输出的调用被解析器当未知名丢弃（2026-09-10 实测最后一环断裂）
      const effectiveTools = mergeContinuationMcpTools(
        Array.isArray(chatBody?.messages) ? chatBody.messages : [],
        Array.isArray(chatBody?.tools) ? chatBody.tools : null,
      );
      log({
        event: 'chatgpt_web.tools_effective',
        model: modelSlug,
        request_tools: Array.isArray(chatBody?.tools) ? chatBody.tools.length : 0,
        effective_tools: effectiveTools.length,
        tools_restored: effectiveTools?.toolsRestored === true,
      });
      const payload = buildConversationPayload(
        Array.isArray(chatBody?.messages) ? chatBody.messages : [],
        modelSlug,
        'Asia/Shanghai',
        effectiveTools,
      );
      const conversationPath = '/backend-api/conversation';
      const upstream = await (openStream || rawHttpsRequest)({
        protocol: 'https',
        host: 'chatgpt.com',
        path: conversationPath,
        method: 'POST',
        viaProxy: true,
        proxy,
        headers: {
          ...sessionHeaders(fp),
          'x-openai-target-path': conversationPath,
          'x-openai-target-route': conversationPath,
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.accessToken}`,
          'openai-sentinel-chat-requirements-token': requirements.token,
          ...(requirements.proofToken ? { 'openai-sentinel-proof-token': requirements.proofToken } : {}),
          ...(requirements.turnstileToken ? { 'openai-sentinel-turnstile-token': requirements.turnstileToken } : {}),
          ...(requirements.soToken ? { 'openai-sentinel-so-token': requirements.soToken } : {}),
        },
        body: JSON.stringify(payload),
        signal,
        timeouts: timeouts || { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 600_000 },
      });

      const status = upstream.status || 0;
      if (status === 200) {
        // 成功即恢复账号派发资格（清 suspect 连败）
        authManager.recordAccountSuccess?.(account.id);
        log({ event: 'chatgpt_web.request', account: account.id, model: modelSlug, attempt_no: attemptNo + 1 });
        const tools = Array.isArray(chatBody?.tools) ? chatBody.tools : null;
        // 上游 conversation 端点永远回 SSE；客户端 stream:false 时在桥内聚合成
        // 单个 chat.completion JSON（OpenAI 形态），否则非流式客户端收到 chunk 流。
        if (chatBody?.stream === false) {
          // 聚合上限给到 16MB（与请求体防护同量级）：默认 256KB 会把长回答
          // 无声截断，工具模式下半截协议块还会以正文形态泄漏
          const sseText = await readAll(upstream.stream || upstream.socket, 16 * 1024 * 1024);
          const completion = conversationSseToChatCompletion(sseText, { model: modelSlug, tools: effectiveTools });
          return {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-web-bridge-version': 'v24-narration-strip' },
            stream: Readable.from([JSON.stringify(completion)]),
          };
        }
        const transform = createConversationToChatTransform({
          model: modelSlug,
          tools: effectiveTools,
        });
        return { status: 200, headers: { 'content-type': 'text/event-stream', 'x-web-bridge-version': 'v24-narration-strip' }, stream: upstream.stream.pipe(transform) };
      }

      // 非 200：读完错误体做分类（账号级冷却 + failover），连接释放
      const errorText = typeof upstream.bodyText === 'string'
        ? upstream.bodyText
        : await readAll(upstream.stream || upstream.socket);
      try { upstream.stream?.destroy?.(); } catch { /* 已销毁 */ }
      try { upstream.socket?.destroy?.(); } catch { /* 已销毁 */ }

      if (status === 401) {
        // token 失效：刷新（getValidCredentials 临期才刷，这里强制失败态由 markAuthExpired 表达）
        authManager.markAuthExpired?.(account.id, `conversation 401: ${errorText.slice(0, 120)}`);
        failure.message = `账号登录态被上游拒绝 (401)，请在管理页重新导入该账号`;
        continue;
      }
      if (status === 403) {
        authManager.markAuthExpired?.(account.id, `conversation 403: ${errorText.slice(0, 120)}`);
        failure.message = '账号被上游拒绝访问 (403)，可能需要人工在网页端确认';
        continue;
      }
      if (status === 429) {
        // 网页额度耗尽/限流：冷却并换号
        authManager.markCooldown?.(account.id, { cooldownMs: 30 * 60_000, reason: '网页会话额度限流 (429)' });
        failure.message = '账号网页会话额度限流 (429)，已冷却换号';
        continue;
      }
      // 5xx/其他：瞬时失败计 suspect，重试下一账号
      authManager.recordAccountFailure?.(account.id, `conversation HTTP ${status}`);
      failure.status = status >= 500 ? 502 : status;
      failure.message = `上游 HTTP ${status}: ${errorText.slice(0, 200)}`;
      continue;
    } catch (error) {
      const message = String(error?.message || '').slice(0, 200);
      if (error?.code === 'arkose_required' || error?.code === 'turnstile_required'
        || error?.code === 'requirements_missing') {
        // 反爬升级类：不冤枉账号（不冷却不计 suspect），直接把原因冒给客户端
        failure.status = 502;
        failure.message = message;
        break;
      }
      if (error?.status === 401) {
        // sentinel 阶段就被拒：登录态失效，标记过期换号
        authManager.markAuthExpired?.(account.id, `sentinel 401: ${message.slice(0, 140)}`);
        failure.message = '账号登录态被上游拒绝 (401)，请在管理页重新导入该账号';
        continue;
      }
      const transient = TRANSIENT_RE.test(message) || !error?.status;
      if (transient) {
        authManager.recordAccountFailure?.(account.id, message);
        failure.message = `上游连接失败：${message}`;
      } else {
        authManager.markCooldown?.(account.id, 60_000);
        failure.message = message;
      }
      continue;
    }
  }

  const error = new Error(failure.message || 'ChatGPT 网页通道无可用账号（请在管理页导入）');
  error.status = failure.status || 502;
  throw error;
}

export { conversationSseToChatCompletion };

/**
 * 面板「测试」按钮：单账号真实走一遍 sentinel 门禁 + 最小 conversation 请求。
 * 返回 {ok, latencyMs, status, note}；turnstile/arkose 风控信息原样透传（不冷却账号）。
 */
export async function testChatGptWebModel({ accessToken, model, proxy, openStream, timeouts } = {}) {
  const startedAt = Date.now();
  const fp = {
    userAgent: DEFAULT_UA,
    deviceId: randomUUID(),
    sessionId: randomUUID(),
    secChUa: '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  };
  try {
    const requirements = await acquireChatRequirements({
      accessToken, fp, proxy, openStream, timeouts, log: () => {},
    });
    const payload = buildConversationPayload(
      [{ role: 'user', content: 'ping' }],
      model,
    );
    const conversationPath = '/backend-api/conversation';
    const upstream = await (openStream || rawHttpsRequest)({
      protocol: 'https',
      host: 'chatgpt.com',
      path: conversationPath,
      method: 'POST',
      viaProxy: true,
      proxy,
      headers: {
        ...sessionHeaders(fp),
        'x-openai-target-path': conversationPath,
        'x-openai-target-route': conversationPath,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'openai-sentinel-chat-requirements-token': requirements.token,
        ...(requirements.proofToken ? { 'openai-sentinel-proof-token': requirements.proofToken } : {}),
        ...(requirements.turnstileToken ? { 'openai-sentinel-turnstile-token': requirements.turnstileToken } : {}),
        ...(requirements.soToken ? { 'openai-sentinel-so-token': requirements.soToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: undefined,
      timeouts: timeouts || { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 45_000 },
    });
    const status = upstream.status || 0;
    const bodyText = typeof upstream.bodyText === 'string'
      ? upstream.bodyText
      : await readAll(upstream.stream || upstream.socket);
    try { upstream.stream?.destroy?.(); } catch { /* 已销毁 */ }
    const latencyMs = Date.now() - startedAt;
    if (status === 200) {
      // patch 增量事件（"v":"..."}）或收尾 [DONE] 任一出现即算对话通路正常
      const hasText = /"v":"[^"]/.test(bodyText) || bodyText.includes('[DONE]');
      return {
        ok: hasText,
        latencyMs,
        status,
        note: hasText
          ? `账号可用 ✓ 模型 ${model} 响应正常`
          : `服务器已响应（200），但模型 ${model} 未正常返回（响应流不完整）`,
      };
    }
    return {
      ok: false,
      latencyMs,
      status,
      note: `服务器已响应（${status}），但模型 ${model} 未正常返回（${String(bodyText).slice(0, 140)}）`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: error?.status || 0,
      note: String(error?.message || error).slice(0, 160),
    };
  }
}

/**
 * 拉取网页会话通道可用模型清单（GET /backend-api/models）。
 * 返回 [{name, displayName}]（目录池入库形态）；对照参考实现 list_models：
 * 认证账号走 /backend-api/models?history_and_training_disabled=false。
 */
export async function fetchChatGptWebModels({ accessToken, fp, proxy, openStream, timeouts, log = () => {} } = {}) {
  const sessionFp = fp || {
    userAgent: DEFAULT_UA,
    deviceId: randomUUID(),
    sessionId: randomUUID(),
    secChUa: '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  };
  const modelsPath = '/backend-api/models?history_and_training_disabled=false';
  const upstream = await (openStream || rawHttpsRequest)({
    protocol: 'https',
    host: 'chatgpt.com',
    path: modelsPath,
    method: 'GET',
    viaProxy: true,
    proxy,
    headers: {
      ...sessionHeaders(sessionFp),
      'x-openai-target-path': modelsPath,
      'x-openai-target-route': '/backend-api/models',
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    signal: undefined,
    timeouts: timeouts || { connectMs: 15_000, responseHeaderMs: 20_000, requestMs: 25_000 },
  });
  const status = upstream.status || 0;
  const text = typeof upstream.bodyText === 'string'
    ? upstream.bodyText
    : await readAll(upstream.stream || upstream.socket);
  if (status !== 200) {
    try { upstream.stream?.destroy?.(); } catch { /* 已销毁 */ }
    const error = new Error(`网页模型清单拉取失败 (HTTP ${status}): ${String(text).slice(0, 160)}`);
    error.status = status;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('网页模型清单响应不是有效 JSON'); }
  const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
  return rawModels
    .map((m) => {
      const name = typeof m?.slug === 'string' ? m.slug.trim() : '';
      if (!name) return null;
      // 过滤非对话条目（rag/插件类 slug 对 chat completions 无意义）
      if (/^(rag|plugin|tools?)$/i.test(name)) return null;
      return {
        name,
        displayName: typeof m?.display_name === 'string' && m.display_name ? m.display_name : name,
      };
    })
    .filter(Boolean);
}
