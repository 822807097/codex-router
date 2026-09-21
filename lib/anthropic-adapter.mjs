// ============================================================================
// anthropic-adapter.mjs — Anthropic Messages API 兼容层（Claude Desktop Gateway 接入）
// ----------------------------------------------------------------------------
// 解决什么问题：Claude Desktop「Configure Third-Party Inference → Gateway」只讲
// Anthropic Messages 协议（POST /v1/messages），而本路由的原生协议是 OpenAI
// Responses（/v1/responses：openai 官方、deepseek-responses、google 全系、zhipu
// 等目标全部默认 responses wire）。本适配器把 Anthropic 请求转换为 Responses
// 请求后经 127.0.0.1 回环打回本进程既有 routerHandler 全管线（模型分流、供应商
// 鉴权、故障转移、官方/第三方适配、reasoning 回传、工具孤儿修复），再把上游
// Responses SSE 反向转换为 Anthropic Messages JSON / Anthropic SSE
// （message_start … message_stop）。
//
// 选择 /v1/responses 而非 /v1/chat/completions 的原因（实测）：本路由所有修复
// （DeepSeek reasoning 回传、call_id 补齐、孤儿/相邻修复、官方 store:false 适配）
// 都长在 responses 管道上；chat 透传路径会在 DeepSeek 思考模式工具闭环时 400。
//
// 不复制任何 Provider 系统；不触碰既有 /v1/chat/completions、/v1/responses、
// /v1/models 的 OpenAI 语义（模型列表仅在请求携带 anthropic-version/anthropic-beta
// 头时额外提供 Anthropic 形状）。
//
// Claude Desktop 对接要点（官方 Third-Party Inference 面板行为 + 社区代理项目
// ccrelay 交叉验证）：
//   · Gateway Base URL 填 http://127.0.0.1:<port>（不带 /v1，Desktop 自己在
//     base URL 后拼 /v1/messages）；本适配器同时宽容 /messages、/v1/v1/messages
//     等历史拼接形态并留痕，保证不会出现 /v1/v1/* 404。
//   · Desktop ≥1.7196.0 拒绝含第三方关键词（deepseek/glm/qwen/kimi/gpt…）的模型
//     ID，故对外模型列表使用 claude-<8hex> 稳定别名（sha1(模型ID) 派生）；
//     /v1/messages 收到别名后映射回真实模型再进入路由（真实 ID 同样接受）。
//   · Desktop 会向网关发 /api/event_logging 遥测 POST：回 200 空对象即可。
//   · 鉴权兼容 Authorization: Bearer 与 x-api-key；开放模式下 localhost 可用任意
//     开发 Key（如 local-claude）。已启用路由 API Key 时必须用真实 Key。
// ============================================================================

import crypto from 'node:crypto';

const PING_INTERVAL_MS = 15_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_INNER_ERROR_BYTES = 64 * 1024;
const MODEL_CREATED_AT = '2026-01-01T00:00:00Z';

// Anthropic 错误类型与 HTTP 状态映射（invalid_request/authentication/permission/
// not_found/rate_limit/api/overloaded），绝不把 HTML/堆栈/上游原文直接透给 Desktop。
function anthropicErrorType(status, code = '') {
  if (code === 'unknown_model') return 'not_found_error';
  switch (Number(status)) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'invalid_request_error';
    case 429: return 'rate_limit_error';
    case 529: return 'overloaded_error';
    default: return 'api_error';
  }
}

function truncate(text, limit = 300) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// tool_use id 归一：对外统一 toolu_ 前缀（Anthropic 惯例）。请求侧（function_call
// 的 call_id 与 function_call_output）与响应侧（工具调用输出）使用同一函数，保证
// 同一次请求历史里的 id 双向一致；原始 id 可读部分保留在尾部，唯一性不丢失。
function normalizeToolCallId(id) {
  const raw = String(id || '').trim();
  if (raw.startsWith('toolu_')) return raw;
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
  return `toolu_${safe || crypto.randomBytes(8).toString('hex')}`;
}

// 粗粒度 token 估算：CJK 字符 ≈1 token/字，其余 ≈4 字符/token（仅用于
// count_tokens 与流式 message_start 前的预估；真实 usage 以 response.completed 为准）。
function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (/[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function extractErrorMessage(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message
      ?? (typeof parsed?.error === 'string' ? parsed.error : null)
      ?? parsed?.message
      ?? parsed?.detail
      ?? bodyText;
    const code = parsed?.error?.code ?? parsed?.code ?? '';
    return { message: truncate(message), code: String(code || '') };
  } catch {
    return { message: truncate(bodyText || `upstream ${status}`), code: '' };
  }
}

// 稳定别名派生（单一事实源）：claude-<8hex> = sha1(模型ID) 前 8 位。管理面板
// （claude-desktop-manager）与适配器共用本函数，避免两处派生规则漂移。
export function buildAliasEntries(modelIds) {
  const seen = new Set();
  const entries = [];
  for (const id of Array.isArray(modelIds) ? modelIds : []) {
    if (!id || typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      alias: `claude-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}`,
      model: id,
    });
  }
  return entries;
}

// ---------- Anthropic → Responses 请求转换 ----------

function systemToText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function imageSourceToUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = String(source.media_type || 'image/png');
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

function toolResultToText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        // 非 text part（如图片结果）以占位注入，绝不静默丢弃块类型信息
        return `[${part?.type || 'unknown'} content omitted]`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

// Anthropic messages → Responses input items。item 形状与本路由 chatToResponsesInput
// / responsesToChatMessages 的既有约定一致（官方/第三方双层适配链均按此归一）。
export function anthropicToResponsesInput(messages) {
  const items = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const isAssistant = raw?.role === 'assistant';
    const content = typeof raw?.content === 'string'
      ? [{ type: 'text', text: raw.content }]
      : (Array.isArray(raw?.content) ? raw.content : []);

    if (isAssistant) {
      let text = '';
      const thinkingParts = [];
      const calls = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text = text ? `${text}\n\n${block.text}` : block.text;
        } else if ((block?.type === 'thinking' || block?.type === 'redacted_thinking')) {
          // redacted_thinking 无明文思考，无法合成回传（官方本就不回放合成思考）
          if (typeof block.thinking === 'string' && block.thinking) thinkingParts.push(block.thinking);
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          calls.push(block);
        }
      }
      // 思考回传：content(reasoning_text) + summary 双形状——DeepSeek 依 content
      // 校验回传，官方侧由 adaptOfficialResponsesBody 剥 content/丢合成项。
      const thinking = thinkingParts.join('\n\n');
      if (thinking) {
        items.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: thinking }],
          content: [{ type: 'reasoning_text', text: thinking }],
        });
      }
      if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of calls) {
        items.push({
          type: 'function_call',
          call_id: normalizeToolCallId(call.id),
          name: call.name,
          arguments: safeJsonStringify(call.input ?? {}),
        });
      }
      continue;
    }

    // user：tool_result 拆成 function_call_output（紧跟前一条 function_call，
    // 满足相邻约束），其余 block 合成 user 消息
    const outputs = [];
    const parts = [];
    for (const block of content) {
      if (block?.type === 'tool_result') {
        outputs.push({
          type: 'function_call_output',
          call_id: normalizeToolCallId(block?.tool_use_id),
          output: toolResultToText(block),
        });
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'input_text', text: block.text });
      } else if (block?.type === 'image') {
        const url = imageSourceToUrl(block?.source);
        if (url) parts.push({ type: 'input_image', image_url: { url } });
        else parts.push({ type: 'input_text', text: '[image block omitted: unsupported source]' });
      } else if (block?.type === 'document') {
        parts.push({ type: 'input_text', text: '[document block omitted: pdf not relayed via Anthropic adapter]' });
      }
      // thinking / redacted_thinking 历史块不进 user 侧
    }
    for (const output of outputs) items.push(output);
    if (parts.length) items.push({ role: 'user', content: parts });
    else if (!outputs.length) items.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
  }
  return items;
}

export function anthropicToResponsesBody(body) {
  const responses = {
    model: String(body.model || ''),
    input: anthropicToResponsesInput(body.messages),
    // 内部固定流式：responses 管道对 chat/google 目标本就总是回 SSE；
    // 非流式 Anthropic 客户端由适配器聚合后回 JSON。
    stream: true,
  };
  const systemText = systemToText(body.system);
  if (systemText) responses.instructions = systemText;

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool) => tool && typeof tool.name === 'string')
    .map((tool) => {
      const entry = {
        type: 'function',
        name: tool.name,
        parameters: (tool.input_schema && typeof tool.input_schema === 'object')
          ? tool.input_schema
          : { type: 'object', properties: {} },
      };
      if (typeof tool.description === 'string' && tool.description) entry.description = tool.description;
      return entry;
    });
  if (tools.length) responses.tools = tools;

  const choice = body.tool_choice;
  if (typeof choice === 'string') {
    if (choice === 'any') responses.tool_choice = 'required';
    else if (choice === 'none') responses.tool_choice = 'none';
    else if (choice) responses.tool_choice = 'auto';
  } else if (choice && typeof choice === 'object') {
    if (choice.type === 'any') responses.tool_choice = 'required';
    else if (choice.type === 'none') responses.tool_choice = 'none';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      responses.tool_choice = { type: 'function', name: choice.name };
    } else if (choice.type === 'auto') responses.tool_choice = 'auto';
  }

  if (typeof body.temperature === 'number') responses.temperature = body.temperature;
  if (typeof body.top_p === 'number') responses.top_p = body.top_p;
  {
    const maxTokens = Number(body.max_tokens);
    // Anthropic 协议 max_tokens 必填；畸形缺失时落默认值而非让上游自选（审查 #8，
    // 顺带让 DEFAULT_MAX_OUTPUT_TOKENS 真正被消费）
    responses.max_output_tokens = Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  }

  // 推理档位映射：Desktop 网关请求可能以多种形态携带档位——
  //   1. 顶层 effort / reasoning_effort 字符串（low/medium/high/xhigh/max/minimal）
  //   2. thinking:{type:"effort"|"effort_and_mode", effort:"…"}
  //   3. thinking:{type:"enabled", budget_tokens:N}（按预算分档）
  // 统一映射到 Responses 的 reasoning.effort（路由对 responses/chat 两条 wire 均已支持）。
  // max 一并收敛 high：budget≥32768 档会产出 'max'，但官方 Responses 不认
  // 'max' 档（400），归一上限即 high
  const effortMap = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', minimal: 'low', none: 'low' };
  let effort = '';
  if (typeof body.effort === 'string' && body.effort) effort = body.effort.toLowerCase();
  else if (typeof body.reasoning_effort === 'string' && body.reasoning_effort) effort = body.reasoning_effort.toLowerCase();
  const thinking = body.thinking;
  if (!effort && thinking && typeof thinking === 'object') {
    if (typeof thinking.effort === 'string' && thinking.effort) {
      effort = thinking.effort.toLowerCase();
    } else if (thinking.type === 'enabled' && Number(thinking.budget_tokens) > 0) {
      const budget = Number(thinking.budget_tokens);
      effort = budget < 4096 ? 'low' : budget < 16384 ? 'medium' : budget < 32768 ? 'high' : 'max';
    }
  }
  if (effortMap[effort]) responses.reasoning = { effort: effortMap[effort] };
  return responses;
}

// ---------- Responses stop 原因 → Anthropic stop_reason ----------

function mapStopReason(incompleteReason, hasToolUse) {
  if (incompleteReason === 'max_output_tokens') return 'max_tokens';
  if (incompleteReason === 'content_filter') return 'refusal';
  if (hasToolUse) return 'tool_use';
  return 'end_turn';
}

// ---------- Responses SSE 消费器 ----------
// 同一套事件状态机服务两个出口：stream 客户端实时产 Anthropic SSE；
// 非流式客户端聚合为单条 Anthropic message。事件词汇与本路由
// createChatSseToResponsesTransform / ResponsesSseToChatTransform 的输出一致。

function createSsePayloadParser(onPayload) {  let buffer = '';
  const feed = (text) => {
    buffer += text;
    let separator = buffer.indexOf('\n');
    while (separator >= 0) {
      const line = buffer.slice(0, separator).replace(/\r$/, '');
      buffer = buffer.slice(separator + 1);
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) onPayload(trimmed.slice(5).trim());
      separator = buffer.indexOf('\n');
    }
  };
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) onPayload(trimmed.slice(5).trim());
    buffer = '';
  };
  return { feed, flush };
}

function createResponsesConsumer({ clientRes, streamOut, requestedModel, inputTokensEstimate, cleanup }) {
  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let started = false;
  let finished = false;
  let nextBlockIndex = 0;
  let current = null; // { kind: 'text'|'thinking'|'tool', index }
  const tools = new Map(); // key: output_index → { blockIndex, id, name, argsChars }
  let emittedChars = 0;
  let incompleteReason = null;
  let hasToolUse = false;
  let usage = null;
  let upstreamModel = requestedModel;
  let upstreamResponseId = '';
  let lastError = null; // 流内错误载荷（非流式出口据此回 502，不再吞成空回复）

  // 聚合态（非流式出口也复用同一套增量记账）
  const agg = { reasoning: '', text: '', calls: [] };

  // Desktop 内置 goal 工具的条件上限 4000 字符（客户端硬校验）。模型（尤其 GLM/DeepSeek）
  // 常写出 4001~4100 字的超长条件，被桌面端拒绝导致会话报错。路由在转发层缓冲 goal
  // 工具的参数增量、结束后按 3900 字安全截断一次性下发：模型意图保留、校验通过。
  const GOAL_TOOL = 'goal';
  const GOAL_CONDITION_SAFE = 3900;
  const isGoalName = (name) => name === GOAL_TOOL;
  const trimGoalArgs = (argsText) => {
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object' && typeof parsed.condition === 'string'
        && parsed.condition.length > GOAL_CONDITION_SAFE) {
        parsed.condition = `${parsed.condition.slice(0, GOAL_CONDITION_SAFE)}…`;
      }
      return JSON.stringify(parsed);
    } catch {
      // 非 JSON 兜底：包成合法的 condition 字符串（直接切片会产生非法 JSON）
      return JSON.stringify({ condition: argsText.slice(0, GOAL_CONDITION_SAFE) });
    }
  };

  const safeSend = (event, data) => {
    if (!streamOut) return true;
    if (clientRes.destroyed || clientRes.writableEnded) return false;
    try {
      clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  const startMessage = () => {
    if (started) return;
    started = true;
    safeSend('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: Math.max(0, Math.round(inputTokensEstimate)), output_tokens: 0 },
      },
    });
  };

  const closeCurrentBlock = () => {
    if (!current) return;
    // goal 工具块关闭：把缓冲的完整参数按安全长度截断后整段下发
    if (current.kind === 'tool' && current.toolKey) {
      const entry = tools.get(current.toolKey);
      if (entry?.suppressStream) {
        const trimmed = trimGoalArgs(entry.rawArgs || '');
        entry.argsChars = trimmed.length;
        agg.calls.forEach((call) => {
          if ((call.key || '') === current.toolKey) call.args = trimmed;
        });
        safeSend('content_block_delta', {
          type: 'content_block_delta',
          index: current.index,
          delta: { type: 'input_json_delta', partial_json: trimmed },
        });
      }
    }
    safeSend('content_block_stop', { type: 'content_block_stop', index: current.index });
    current = null;
  };

  const openBlock = (contentBlock, meta = {}) => {
    closeCurrentBlock();
    const index = nextBlockIndex;
    nextBlockIndex += 1;
    current = { index, ...meta };
    safeSend('content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
    return index;
  };

  const ensureTextBlock = () => {
    // 块类型守卫：当前是 thinking 块时必须先关闭再开 text 块——否则 text_delta
    // 会发进 thinking 块索引，Desktop 端整条消息语义损坏
    if (current?.kind === 'text') return current.index;
    return openBlock({ type: 'text', text: '' }, { kind: 'text' });
  };

  const ensureThinkingBlock = () => {
    if (current?.kind === 'thinking') return current.index;
    return openBlock({ type: 'thinking', thinking: '', signature: '' }, { kind: 'thinking' });
  };

  const toolKeyOf = (payload) => {
    if (Number.isInteger(payload?.output_index)) return `i${payload.output_index}`;
    return `t${payload?.item_id || payload?.item?.id || crypto.randomBytes(4).toString('hex')}`;
  };

  const openToolBlock = (key, id, name) => {
    hasToolUse = true;
    const suppressStream = isGoalName(name);
    const blockIndex = openBlock({ type: 'tool_use', id, name, input: {} }, { kind: 'tool', toolKey: key });
    tools.set(key, { blockIndex, id, name, argsChars: 0, suppressStream, rawArgs: '' });
    return blockIndex;
  };

  const appendArgsDelta = (key, argsDelta) => {
    if (!argsDelta) return;
    const entry = tools.get(key);
    const blockIndex = entry?.blockIndex ?? current?.index;
    const suppressed = entry?.suppressStream === true;
    if (entry) {
      entry.argsChars += argsDelta.length;
      entry.rawArgs = (entry.rawArgs || '') + argsDelta;
    }
    agg.calls.forEach((call) => {
      if ((call.key || '') === key || !key) call.args += argsDelta;
    });
    emittedChars += argsDelta.length;
    // goal 工具：参数增量只缓冲不下发，块结束时按安全长度整段下发（见 trimGoalArgs）
    if (suppressed) return;
    safeSend('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: argsDelta },
    });
  };

  const appendTextDelta = (delta) => {
    startMessage();
    const index = ensureTextBlock();
    agg.text += delta;
    emittedChars += delta.length;
    safeSend('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: delta },
    });
  };

  const appendThinkingDelta = (delta) => {
    startMessage();
    const index = ensureThinkingBlock();
    agg.reasoning += delta;
    emittedChars += delta.length;
    safeSend('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: delta },
    });
  };

  const finish = (errorPayload = null) => {
    if (finished) return;
    finished = true;
    if (errorPayload) lastError = errorPayload;
    cleanup();
    closeCurrentBlock();
    if (errorPayload) {
      // 流内错误：Anthropic 以 error 事件收口（无 message_stop）
      safeSend('error', {
        type: 'error',
        error: {
          type: anthropicErrorType(errorPayload.status || 502, errorPayload.code),
          message: truncate(errorPayload.message || 'upstream stream error'),
        },
      });
      if (streamOut) {
        try { clientRes.end(); } catch { /* 已销毁 */ }
      }
      return;
    }
    startMessage();
    const stopReason = mapStopReason(incompleteReason, hasToolUse);
    const outputTokens = Number(usage?.output_tokens ?? 0) > 0
      ? Number(usage.output_tokens)
      : Math.max(1, Math.ceil(emittedChars / 4));
    if (streamOut) {
      safeSend('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      safeSend('message_stop', { type: 'message_stop' });
      try { clientRes.end(); } catch { /* 已销毁 */ }
    }
  };

  const buildFinalMessage = () => ({
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: upstreamModel || requestedModel,
    content: aggregateContent(),
    stop_reason: mapStopReason(incompleteReason, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage?.input_tokens ?? 0),
      output_tokens: Number(usage?.output_tokens ?? 0) > 0
        ? Number(usage.output_tokens)
        : Math.max(1, Math.ceil(emittedChars / 4)),
    },
  });

  function aggregateContent() {
    const content = [];
    if (agg.reasoning) content.push({ type: 'thinking', thinking: agg.reasoning, signature: '' });
    if (agg.text) content.push({ type: 'text', text: agg.text });
    for (const call of agg.calls) {
      let input = {};
      try {
        const parsed = JSON.parse(call.args || '{}');
        if (parsed && typeof parsed === 'object') input = parsed;
      } catch { /* 参数非法保底空对象，tool_use 结构不破 */ }
      // 非流式出口同样截断 goal 超长条件（与流式 suppress 策略一致）
      if (isGoalName(call.name) && typeof input.condition === 'string'
        && input.condition.length > GOAL_CONDITION_SAFE) {
        input.condition = `${input.condition.slice(0, GOAL_CONDITION_SAFE)}…`;
      }
      content.push({ type: 'tool_use', id: normalizeToolCallId(call.id), name: call.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    return content;
  }

  const handlePayload = (payload) => {
    if (finished) return;
    if (payload === '[DONE]') {
      finish();
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // 心跳注释行等非 JSON 载荷
    }
    const type = event?.type;

    if (event?.error || type === 'error') {
      const error = event?.error || {};
      finish({ status: error.status || event?.status, code: error.code, message: error.message || event?.message });
      return;
    }

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = event.response || {};
        if (response.model) upstreamModel = response.model;
        if (response.id) upstreamResponseId = response.id;
        startMessage();
        return;
      }
      case 'response.output_item.added': {
        const item = event.item || {};
        if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call') {
          startMessage();
          const key = toolKeyOf({ output_index: event.output_index, item_id: item.id });
          const callId = item.call_id || item.id || `call_${key}`;
          const name = item.name || (item.type === 'tool_search_call' ? 'tool_search' : 'tool');
          const existing = tools.get(key);
          if (!existing) {
            openToolBlock(key, normalizeToolCallId(callId), name);
            registerAggCall(key, normalizeToolCallId(callId), name);
            if (item.type === 'function_call' && typeof item.arguments === 'string' && item.arguments) {
              appendArgsDelta(key, item.arguments);
            } else if (item.type === 'custom_tool_call' && typeof item.input === 'string' && item.input) {
              appendArgsDelta(key, item.input);
            } else if (item.type === 'tool_search_call' && item.query) {
              appendArgsDelta(key, safeJsonStringify(
                item.limit !== undefined ? { query: item.query, limit: item.limit } : { query: item.query },
              ));
            }
          }
        }
        return;
      }
      case 'response.output_text.delta': {
        if (typeof event.delta === 'string' && event.delta) appendTextDelta(event.delta);
        return;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (typeof event.delta === 'string' && event.delta) appendThinkingDelta(event.delta);
        return;
      }
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta': {
        const key = toolKeyOf(event);
        if (!tools.has(key)) {
          // 骨架帧缺失（上游只发参数增量）：以未知名先开块，done 帧再补
          openToolBlock(key, normalizeToolCallId(event.item_id || key), 'tool');
          registerAggCall(key, normalizeToolCallId(event.item_id || key), 'tool');
        }
        appendArgsDelta(key, typeof event.delta === 'string' ? event.delta : '');
        return;
      }
      case 'response.output_item.done': {
        const item = event.item || {};
        if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call') {
          const key = toolKeyOf({ output_index: event.output_index, item_id: item.id });
          if (!tools.has(key)) {
            // done-only 网关：骨架与参数都在 done 帧，整块补发
            startMessage();
            const callId = item.call_id || item.id || `call_${key}`;
            const name = item.name || (item.type === 'tool_search_call' ? 'tool_search' : 'tool');
            openToolBlock(key, normalizeToolCallId(callId), name);
            registerAggCall(key, normalizeToolCallId(callId), name);
          }
          if (item.type === 'function_call' && typeof item.arguments === 'string') {
            backfillArgs(key, item.arguments);
          } else if (item.type === 'custom_tool_call' && typeof item.input === 'string') {
            backfillArgs(key, item.input);
          } else if (item.type === 'tool_search_call' && item.query) {
            backfillArgs(key, safeJsonStringify(
              item.limit !== undefined ? { query: item.query, limit: item.limit } : { query: item.query },
            ));
          }
          return;
        }
        if (item.type === 'message' && Array.isArray(item.content)) {
          // done-only 网关正文补齐：done 携带完整 output_text 时补差额
          const doneText = item.content
            .map((part) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
            .join('');
          if (doneText.length > agg.text.length) {
            appendTextDelta(doneText.slice(agg.text.length));
          }
        }
        if (item.type === 'reasoning') {
          // done-only 思考补齐（summary 或 content 双形状）
          const doneThinking = [
            ...((Array.isArray(item.summary) ? item.summary : [])
              .map((part) => (part?.type === 'summary_text' && typeof part.text === 'string' ? part.text : ''))),
            ...((Array.isArray(item.content) ? item.content : [])
              .map((part) => (part?.type === 'reasoning_text' && typeof part.text === 'string' ? part.text : ''))),
          ].filter(Boolean).join('\n');
          if (doneThinking && doneThinking.length > agg.reasoning.length) {
            appendThinkingDelta(doneThinking.slice(agg.reasoning.length));
          }
        }
        return;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response || {};
        if (response.model) upstreamModel = response.model;
        if (response.id) upstreamResponseId = response.id;
        if (response.usage && typeof response.usage === 'object') usage = response.usage;
        incompleteReason = response.incomplete_details?.reason || null;
        finish();
        return;
      }
      case 'response.failed': {
        const error = event.response?.error || {};
        finish({ status: 502, code: error.code, message: error.message || 'upstream response failed' });
        return;
      }
      default:
      // response.content_part.*、response.output_text.done 等终态旁路事件：忽略
    }
  };

  function registerAggCall(key, id, name) {
    agg.calls.push({ key, id, name, args: '' });
  }

  function backfillArgs(key, finalArgs) {
    const entry = tools.get(key);
    const emitted = entry?.argsChars ?? 0;
    if (!finalArgs || finalArgs.length <= emitted) return;
    appendArgsDelta(key, finalArgs.slice(emitted));
  }

  return {
    handlePayload,
    isFinished: () => finished,
    finish,
    consumeError: () => lastError,
    buildFinalMessage,
    upstreamModel: () => upstreamModel,
    upstreamResponseId: () => upstreamResponseId,
    stats: () => ({ emittedChars, hasToolUse, incompleteReason }),
  };
}

// ---------- 主入口 ----------

export function createAnthropicAdapter(options = {}) {
  const port = Number(options.port) || 15730;
  const apiKeyStore = options.apiKeyStore || null;
  const log = options.log || (() => {});
  const flog = options.flog || (() => {});
  const getModelIds = typeof options.getModelIds === 'function' ? options.getModelIds : () => [];
  const describeRoute = typeof options.describeRoute === 'function' ? options.describeRoute : null;
  const maxRequestBytes = Number(options.maxRequestBytes) || 8 * 1024 * 1024;

  const buildAliasMaps = () => {
    // 别名表来源：注入的 getAliasEntries（管理面板的暴露模型白名单 + 自定义别名，
    // 保存即生效）；未注入时按目录 id 派生默认别名（向后兼容旧调用方）
    const entries = typeof options.getAliasEntries === 'function'
      ? (() => {
        try { return options.getAliasEntries(); } catch { return []; }
      })()
      : buildAliasEntries(getModelIds());
    const aliasToReal = new Map();
    const realToAlias = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.alias || !entry?.model || realToAlias.has(entry.model)) continue;
      aliasToReal.set(entry.alias, entry.model);
      realToAlias.set(entry.model, entry.alias);
    }
    return { aliasToReal, realToAlias };
  };

  const resolveModel = (model) => {
    const { aliasToReal } = buildAliasMaps();
    let key = String(model || '');
    // Desktop 的 1M 上下文变体以 [1m] 后缀请求（如 claude-xxx[1m]）：剥掉后缀查表，
    // 由上游以其真实窗口服务（变体的存在性由 models 列表的 supports_1m 声明）
    const variant = key.match(/^(.*)\[1m\]$/i);
    if (variant) key = variant[1];
    return aliasToReal.get(key) || key;
  };

  const aliasEntriesSafe = () => {
    if (typeof options.getAliasEntries !== 'function') return buildAliasEntries(getModelIds());
    try {
      return Array.isArray(options.getAliasEntries()) ? options.getAliasEntries() : [];
    } catch {
      return [];
    }
  };

  const anthropicModelEntries = () => {
    const { realToAlias } = buildAliasMaps();
    return aliasEntriesSafe()
      .map(({ alias, model, maxInputTokens, supports1m }) => {
        const raw = Number.isFinite(Number(maxInputTokens)) && Number(maxInputTokens) > 0
          ? Math.floor(Number(maxInputTokens))
          : null;
        // Desktop 发现解析器对 max_input_tokens >= 1e6 一律自动展开「xxx 1M」变体条目
        // （与 supports_1m 字段无关）。变体开关关闭时把上报值压到 999,999：单条目、
        // 上下文计量几乎不变；开关打开才原值上报并声明 supports_1m（出现两条）。
        const capped = !supports1m && raw !== null && raw >= 1_000_000 ? 999_999 : raw;
        return {
          type: 'model',
          id: realToAlias.get(model) || alias,
          display_name: model,
          created_at: MODEL_CREATED_AT,
          ...(capped !== null ? { max_input_tokens: capped } : {}),
          ...(supports1m === true ? { supports_1m: true } : {}),
        };
      });
  };

  const writeAnthropicError = (clientRes, status, type, message, extraHeaders = {}) => {
    if (clientRes.headersSent || clientRes.destroyed || clientRes.writableEnded) return;
    clientRes.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    clientRes.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };

  const extractProvidedKey = (clientReq) => {
    const authHeader = String(clientReq.headers.authorization || '');
    const xApiKey = String(clientReq.headers['x-api-key'] || '');
    if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
    return xApiKey.trim();
  };

  // 与 routerHandler 同一套门控：key 模式必须验证通过；开放模式沿用浏览器跨站防线
  const authorize = (clientReq, clientRes) => {
    const providedKey = extractProvidedKey(clientReq);
    if (apiKeyStore && typeof apiKeyStore.hasKeys === 'function' && apiKeyStore.hasKeys()) {
      if (!providedKey || !apiKeyStore.verifyKey(providedKey)) {
        writeAnthropicError(clientRes, 401, 'authentication_error',
          'invalid x-api-key: 请在路由管理面板创建 API Key 并填入 Claude Desktop Gateway 凭据');
        return null;
      }
      return { key: providedKey, openMode: false };
    }
    const secSite = String(clientReq.headers['sec-fetch-site'] || '');
    const origin = String(clientReq.headers.origin || '');
    const isBrowserCrossSite = (secSite && secSite !== 'same-origin' && secSite !== 'none')
      || (origin && !origin.startsWith(`http://127.0.0.1:${clientReq.socket.localPort}`)
        && !origin.startsWith('http://localhost:') && !origin.startsWith('http://[::1]:'));
    if (isBrowserCrossSite) {
      writeAnthropicError(clientRes, 403, 'permission_error',
        '开放模式拒绝跨站浏览器请求；请在路由管理面板创建 API Key 并配置到 Claude Desktop');
      return null;
    }
    // 开放模式：localhost 任意 Key 放行（含开发 Key local-claude），回环不带凭据
    return { key: '', openMode: true };
  };

  const readJsonBody = (clientReq) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let failed = null;
    clientReq.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxRequestBytes) {
        failed = Object.assign(new Error('request body too large'), { status: 413 });
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    clientReq.on('end', () => {
      if (failed) {
        resolve({ error: failed });
        return;
      }
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      } catch {
        resolve({ error: Object.assign(new Error('invalid JSON body'), { status: 400 }) });
      }
    });
    clientReq.on('error', () => resolve({ error: Object.assign(new Error('request read error'), { status: 400 }) }));
  });

  const forwardToResponses = (responsesBody, providedKey, signal) => {
    const headers = { 'content-type': 'application/json' };
    if (providedKey) headers.authorization = `Bearer ${providedKey}`;
    return fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(responsesBody),
      signal,
    });
  };

  const handleCountTokens = async (clientReq, clientRes) => {
    const auth = authorize(clientReq, clientRes);
    if (!auth) return true;
    const parsed = await readJsonBody(clientReq);
    if (parsed.error) {
      writeAnthropicError(clientRes, parsed.error.status || 400, 'invalid_request_error', parsed.error.message);
      return true;
    }
    const body = parsed.value || {};
    let total = 0;
    total += estimateTextTokens(systemToText(body.system));
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      total += 4; // 每条消息固定开销
      const content = typeof message?.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (Array.isArray(message?.content) ? message.content : []);
      for (const block of content) {
        if (typeof block?.text === 'string') total += estimateTextTokens(block.text);
        else if (block?.type === 'thinking' && typeof block.thinking === 'string') total += estimateTextTokens(block.thinking);
        else if (block?.type === 'tool_use') total += estimateTextTokens(safeJsonStringify(block.input ?? {})) + 4;
        else if (block?.type === 'tool_result') total += estimateTextTokens(toolResultToText(block));
        else if (block?.type === 'image') total += 1600; // 与 Anthropic 视觉 token 量级一致
      }
    }
    for (const tool of Array.isArray(body.tools) ? body.tools : []) {
      total += estimateTextTokens(safeJsonStringify({
        name: tool?.name,
        description: tool?.description,
        schema: tool?.input_schema,
      })) + 16;
    }
    clientRes.writeHead(200, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ input_tokens: Math.round(total) }));
    return true;
  };

  const handleMessages = async (clientReq, clientRes) => {
    const requestStartedAt = Date.now();
    const auth = authorize(clientReq, clientRes);
    if (!auth) return true;

    const parsed = await readJsonBody(clientReq);
    if (parsed.error) {
      writeAnthropicError(clientRes, parsed.error.status || 400, 'invalid_request_error', parsed.error.message);
      return true;
    }
    const body = parsed.value || {};
    const requestedModelRaw = String(body.model || '');
    const requestedModel = resolveModel(requestedModelRaw);
    const stream = body.stream === true;
    const toolsCount = Array.isArray(body.tools) ? body.tools.length : 0;

    if (!requestedModel) {
      writeAnthropicError(clientRes, 400, 'invalid_request_error', 'model: required field is missing');
      return true;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      writeAnthropicError(clientRes, 400, 'invalid_request_error', 'messages: at least one message is required');
      return true;
    }

    let responsesBody;
    try {
      responsesBody = anthropicToResponsesBody({ ...body, model: requestedModel });
    } catch (error) {
      writeAnthropicError(clientRes, 400, 'invalid_request_error', truncate(error?.message || 'invalid request'));
      return true;
    }

    // 调试日志（绝不打印 Key；route 为路由主候选，实际故障转移见 anthropic.response/flog）
    const routeCandidates = describeRoute ? describeRoute(requestedModel) : [];
    const inputEstimate = estimateTextTokens(
      JSON.stringify({ system: body.system, messages: body.messages }),
    );
    flog({
      event: 'anthropic.request',
      model: requestedModelRaw,
      resolved_model: requestedModel,
      stream,
      tools: toolsCount,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      route_candidates: routeCandidates.slice(0, 4),
    });

    const abortController = new AbortController();
    clientRes.once('close', () => abortController.abort());
    clientReq.once('aborted', () => abortController.abort());

    let inner;
    try {
      inner = await forwardToResponses(responsesBody, auth.key, abortController.signal);
    } catch (error) {
      if (abortController.signal.aborted || clientRes.destroyed) return true;
      writeAnthropicError(clientRes, 502, 'api_error', `router loopback failed: ${truncate(error?.message || error)}`);
      return true;
    }

    if (inner.status !== 200) {
      let errorText = '';
      try {
        errorText = (await inner.text()).slice(0, MAX_INNER_ERROR_BYTES);
      } catch { /* 已断流 */ }
      const { message, code } = extractErrorMessage(inner.status, errorText);
      const mappedStatus = code === 'unknown_model' ? 404 : inner.status;
      flog({
        event: 'anthropic.upstream_error',
        model: requestedModel,
        status: inner.status,
        mapped_status: mappedStatus,
        error_code: code,
      });
      const retryAfter = inner.headers?.get?.('retry-after');
      writeAnthropicError(clientRes, mappedStatus, anthropicErrorType(mappedStatus, code), message,
        retryAfter ? { 'retry-after': retryAfter } : {});
      return true;
    }

    // 流式消费内部 Responses SSE；非流式客户端聚合为单条 message
    if (!stream) {
      // TextDecoder 必须循环外创建并以 stream:true 累积：逐 chunk 新建会把跨 chunk
      // 的多字节 UTF-8（中文必中）打成 U+FFFD 静默损坏正文
      const decoder = new TextDecoder('utf8');
      let fullText = '';
      try {
        for await (const chunk of inner.body) {
          if (clientRes.destroyed || abortController.signal.aborted) break;
          fullText += decoder.decode(chunk, { stream: true });
        }
        fullText += decoder.decode();
      } catch (error) {
        if (!abortController.signal.aborted && !clientRes.destroyed) {
          writeAnthropicError(clientRes, 502, 'api_error', `router stream read failed: ${truncate(error?.message || error)}`);
        }
        return true;
      }
      const consumer = createResponsesConsumer({
        clientRes,
        streamOut: false,
        requestedModel: requestedModelRaw,
        inputTokensEstimate: inputEstimate,
        cleanup: () => {},
      });
      const parser = createSsePayloadParser(consumer.handlePayload);
      parser.feed(fullText);
      parser.flush();
      if (!consumer.isFinished()) consumer.finish();
      // 流内错误（response.failed / error 事件）必须转成 502，不能当成功空回复
      const streamError = consumer.consumeError();
      if (streamError) {
        flog({
          event: 'anthropic.upstream_error',
          model: requestedModel,
          status: streamError.status || 502,
          error_code: streamError.code,
          error_message: truncate(streamError.message || ''),
        });
        writeAnthropicError(clientRes, 502, anthropicErrorType(502, streamError.code),
          `上游流式响应中途失败：${truncate(streamError.message || 'upstream error')}`);
        return true;
      }
      const message = consumer.buildFinalMessage();
      const latencyMs = Date.now() - requestStartedAt;
      log(
        `[Anthropic Adapter] model=${requestedModelRaw} stream=false tools=${toolsCount}`
        + ` upstream_model=${message.model || '?'} route=${routeCandidates[0] || '?'} status=200`
        + ` stop_reason=${message.stop_reason} in=${message.usage.input_tokens} out=${message.usage.output_tokens}`
        + ` latency=${latencyMs}ms`,
      );
      flog({
        event: 'anthropic.response',
        model: requestedModel,
        upstream_model: message.model,
        stream: false,
        status: 200,
        stop_reason: message.stop_reason,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        latency_ms: latencyMs,
        blocks: message.content.map((block) => block.type),
      });
      if (clientRes.destroyed || clientRes.writableEnded) return true;
      clientRes.writeHead(200, { 'content-type': 'application/json', 'request-id': message.id });
      clientRes.end(JSON.stringify(message));
      return true;
    }

    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    clientRes.flushHeaders?.();

    const pingTimer = setInterval(() => {
      if (clientRes.destroyed || clientRes.writableEnded) return;
      try {
        clientRes.write('event: ping\ndata: {"type":"ping"}\n\n');
      } catch { /* 客户端已断开 */ }
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();

    const consumer = createResponsesConsumer({
      clientRes,
      streamOut: true,
      requestedModel: requestedModelRaw,
      inputTokensEstimate: inputEstimate,
      cleanup: () => clearInterval(pingTimer),
    });
    const decoder = new TextDecoder('utf8');
    const parser = createSsePayloadParser(consumer.handlePayload);
    try {
      for await (const chunk of inner.body) {
        if (clientRes.destroyed || consumer.isFinished()) break;
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.flush();
      consumer.finish(); // 上游未发终态就断流：按当前内容收口，不强行报错
    } catch (error) {
      if (!abortController.signal.aborted && !clientRes.destroyed && !consumer.isFinished()) {
        consumer.finish({ status: 502, code: 'upstream_stream_interrupted', message: `upstream stream interrupted: ${truncate(error?.message || error, 160)}` });
      }
    }
    clearInterval(pingTimer);
    const stats = consumer.stats();
    const latencyMs = Date.now() - requestStartedAt;
    const finalMessage = consumer.buildFinalMessage();
    log(
      `[Anthropic Adapter] model=${requestedModelRaw} stream=true tools=${toolsCount}`
      + ` upstream_model=${consumer.upstreamModel() || '?'} route=${routeCandidates[0] || '?'} status=200`
      + ` stop_reason=${finalMessage.stop_reason} in=${finalMessage.usage.input_tokens} out=${finalMessage.usage.output_tokens}`
      + ` latency=${latencyMs}ms`,
    );
    flog({
      event: 'anthropic.response',
      model: requestedModel,
      upstream_model: consumer.upstreamModel(),
      upstream_response_id: consumer.upstreamResponseId(),
      stream: true,
      status: 200,
      stop_reason: finalMessage.stop_reason,
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      chars: stats.emittedChars,
      latency_ms: latencyMs,
      blocks: finalMessage.content.map((block) => block.type),
    });
    return true;
  };

  const isAnthropicClient = (clientReq) => Boolean(
    clientReq.headers['anthropic-version'] || clientReq.headers['anthropic-beta'],
  );

  return async function anthropicAdapter(clientReq, clientRes) {
    const method = (clientReq.method || 'GET').toUpperCase();
    let pathname = (clientReq.url || '/').split('?')[0];

    // 路径归一（Desktop Gateway 在 base URL 后自行拼接路径）：
    //   /v1/messages           → /messages（官方拼法）
    //   /v1/v1/messages        → /messages（base URL 误带 /v1 的双拼，留痕后归一）
    //   /messages、/messages/… → 原样接受
    if (/^\/v1\/v1(\/|$)/.test(pathname)) {
      flog({ event: 'anthropic.double_v1_path', path: pathname, note: 'Gateway Base URL 多带了一层 /v1，已自动归一' });
      pathname = pathname.replace(/^\/v1(?:\/v1)+/, '');
    }
    if (/^\/v1\/messages(\/|$)/.test(pathname)) {
      pathname = pathname.replace(/^\/v1/, '');
    }
    // /v1/models 同样归一；models 分支仅在 anthropic 头在场时接管，OpenAI 客户端
    // （无 anthropic 头）原样落回 routerHandler，clientReq.url 未被改动故语义零影响。
    if (/^\/v1\/models(\/|$)/.test(pathname)) {
      pathname = pathname.replace(/^\/v1/, '');
    }

    // Desktop 遥测桩：网关模式下遥测 POST 打到本服务，200 空对象即可
    if (pathname.startsWith('/api/event_logging')) {
      flog({ event: 'anthropic.telemetry_stub', path: pathname, method });
      // 必须排空请求体再应答：keep-alive 下未消费的请求流会让 Node 在响应结束时
      // 销毁 socket，Desktop 侧表现为连接反复重建（审查 #9）
      clientReq.resume();
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end('{}');
      return true;
    }

    if (pathname === '/messages' && method === 'POST') {
      return handleMessages(clientReq, clientRes);
    }
    if (pathname === '/messages/count_tokens' && method === 'POST') {
      return handleCountTokens(clientReq, clientRes);
    }

    // Anthropic 形状模型发现（仅 anthropic 头标记的客户端；OpenAI 客户端走原 /v1/models）
    if (method === 'GET' && (pathname === '/models' || pathname === '/models/') && isAnthropicClient(clientReq)) {
      if (!authorize(clientReq, clientRes)) return true;
      const data = anthropicModelEntries();
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({
        data,
        first_id: data[0]?.id || null,
        has_more: false,
        last_id: data[data.length - 1]?.id || null,
      }));
      return true;
    }
    if (method === 'GET' && /^\/models\/[^/]+$/.test(pathname) && isAnthropicClient(clientReq)) {
      if (!authorize(clientReq, clientRes)) return true;
      const id = decodeURIComponent(pathname.split('/')[2] || '');
      const entry = anthropicModelEntries().find((model) => model.id === id);
      if (!entry) {
        writeAnthropicError(clientRes, 404, 'not_found_error', `model: ${id} not found`);
        return true;
      }
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify(entry));
      return true;
    }
    return false;
  };
}

// 测试钩子：供单元测试直接驱动 SSE 消费器（生产代码勿用）
export { createResponsesConsumer, createSsePayloadParser };
