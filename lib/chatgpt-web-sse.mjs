// ---------- ChatGPT 网页 conversation SSE → OpenAI chat 格式转换（W3） ----------
// 状态机依据 docs/reference/chatgpt2api 协议文档（upstream-sse-conversation.md）形态表：
//   "v1" 版本标记 / [DONE] 结束 / JSON patch（p/o/v）：
//   - {"p":"/message/content/parts/0","o":"append","v":"..."}  文本增量
//   - {"p":"","o":"add","v":{message}}                          完整消息（切活跃角色）
//   - {"v":"..."}（省略路径字符串）                              结合活跃角色的文本增量
//   - {"p":"","o":"patch","v":[...]}                             批量 patch（按序应用）
//   - {"p":"/message/author/role","v":"assistant"}               活跃角色切换
//   - {"p":"/message/status"...} / {"p":"/message/end_turn"...}  收尾信号
//   - {"type":"moderation","moderation_response":{"blocked":true}} → 策略拦截
//   - title_generation / message_marker / server_ste_metadata /
//     resume_conversation_token / input_message                 → 忽略
// 解析器永不抛错：畸形 payload 跳过，不中断流（手写解析器对抗性要求）。

import { Transform } from 'node:stream';
import {
  parseToolCallBlocks,
  sanitizeBridgeOutput,
  stripInjectedEchoes,
  stripLeadingToolNarration,
} from './chatgpt-web-tools.mjs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export function createConversationTextExtractor() {
  let conversationId = '';
  let assistantActive = false;
  let sawAssistantText = false;
  // 全量快照形态：记录上次累积全文，求差得增量
  let lastSnapshot = '';
  let blocked = false;
  let endTurn = false;
  let done = false;
  const pending = [];

  function processPayload(payload, depth = 0) {
    if (depth > 4) return;
    if (typeof payload === 'string') {
      // 省略路径的文本增量：结合活跃角色（协议文档要求）
      if (assistantActive && payload) {
        pending.push(payload);
        sawAssistantText = true;
      }
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (payload.conversation_id && !conversationId) conversationId = String(payload.conversation_id);
    if (payload.type === 'moderation') {
      if (payload.moderation_response?.blocked === true) blocked = true;
      return;
    }
    // 全量快照形态（2026-09 真实抓包：上游已废弃 patch 增量，改发累积全文）：
    // {"message": {...author.role=assistant, content.parts=["累积文本"...]}}——
    // 与上次快照求差得增量；非前缀延续（重写/换道）时整段重发。
    // 同形态也以 {"v":{message}} 包裹出现（下方裸 v 分支处理）。
    const snapshot = payload.message && typeof payload.message === 'object' ? payload.message : null;
    if (snapshot) {
      const role = snapshot.author?.role;
      if (role) assistantActive = role === 'assistant';
      if (payload.v?.conversation_id && !conversationId) conversationId = String(payload.v.conversation_id);
      if (assistantActive) {
        const parts = snapshot.content?.parts;
        const text = Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : '';
        if (text && text.length > lastSnapshot.length && text.startsWith(lastSnapshot)) {
          const delta = text.slice(lastSnapshot.length);
          lastSnapshot = text;
          if (delta) {
            pending.push(delta);
            sawAssistantText = true;
          }
        } else if (text && text !== lastSnapshot) {
          // 非前缀延续（重写/换道）：整段按新文本处理
          lastSnapshot = text;
          pending.push(text);
          sawAssistantText = true;
        }
      }
      return;
    }
    // 批量 patch：按数组顺序逐条应用
    if (payload.o === 'patch' && Array.isArray(payload.v)) {
      for (const sub of payload.v) processPayload(sub, depth + 1);
      return;
    }
    // 省略 p/o 的裸形态（协议文档：{"v":"文本增量"} / {"v":{message}}）：
    // 图片工具成功事件即以 {"v":{message}} 形态出现
    if (payload.p === undefined && payload.o === undefined && payload.type === undefined) {
      const bare = payload.v;
      if (typeof bare === 'string') {
        if (assistantActive && bare) {
          pending.push(bare);
          sawAssistantText = true;
        }
        return;
      }
      if (bare && typeof bare === 'object' && bare.message) {
        assistantActive = bare.message.author?.role === 'assistant';
      }
      return;
    }
    if (payload.type === 'title_generation' || payload.type === 'message_marker'
      || payload.type === 'server_ste_metadata' || payload.type === 'resume_conversation_token'
      || payload.type === 'input_message') {
      return;
    }
    // 完整消息 add：切换活跃角色（assistant 出现才接文本）
    const message = (payload.o === 'add' && payload.p === '' && payload.v && typeof payload.v === 'object'
      && payload.v.message && typeof payload.v.message === 'object')
      ? payload.v.message
      : null;
    if (message) {
      assistantActive = message.author?.role === 'assistant';
      if (payload.v.conversation_id && !conversationId) conversationId = String(payload.v.conversation_id);
      return;
    }
    // 角色补丁
    if (payload.p === '/message/author/role') {
      assistantActive = payload.v === 'assistant';
      return;
    }
    // 文本增量（显式路径）
    if (payload.p === '/message/content/parts/0' && payload.o === 'append'
      && typeof payload.v === 'string') {
      if (assistantActive && payload.v) {
        pending.push(payload.v);
        sawAssistantText = true;
      }
      return;
    }
    // 收尾信号
    if (payload.p === '/message/status' && payload.v === 'finished_successfully') return;
    if (payload.p === '/message/end_turn' && payload.v === true) {
      endTurn = true;
      return;
    }
  }

  return {
    // 输入一段 SSE 文本（可跨事件/半行），返回本轮新增文本增量数组
    feed(chunkText) {
      for (const rawLine of String(chunkText).split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { done = true; continue; }
        if (data === '"v1"' || data === 'stream-json') continue;
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            for (const item of parsed) processPayload(item, 0);
          } else {
            processPayload(parsed, 0);
          }
        } catch { /* 非 JSON 载荷：按协议视为 raw 事件，不影响文本流 */ }
      }
      const flushed = pending.slice();
      pending.length = 0;
      return flushed;
    },
    result() {
      return { conversationId, blocked, sawAssistantText, endTurn, done };
    },
  };
}

function chatChunkFrame({ id, model, created, content, finishReason, role, toolCalls }) {
  const delta = {};
  if (role) delta.role = role;
  if (content) delta.content = content;
  if (toolCalls) delta.tool_calls = toolCalls;
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

// conversation SSE 字节流 → OpenAI chat completions SSE 字节流（流式）
export function createConversationToChatTransform({ model, tools = null } = {}) {
  const extractor = createConversationTextExtractor();
  const id = `chatcmpl-web-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const allowedNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((t) => (t?.type === 'function' && t.function?.name ? t.function.name : null))
      .filter(Boolean),
  );
  const hasTools = allowedNames.size > 0;
  let roleEmitted = false;
  // 工具桥：完整文本累计（增量直通，协议块只在流末判定——协议块必然完整出现在
  // 单一 delta 序列末尾，且逐 delta 转发可见文本时半截块不会被误发给客户端）
  let fullText = '';
  let toolCallsEmitted = false;
  // StringDecoder 缓冲跨 chunk 的多字节 UTF-8 序列（中文流主力场景，
  // 逐 chunk toString 会把被 TCP 分界切开的汉字打成 U+FFFD 乱码）
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  return new Transform({
    transform(chunk, enc, cb) {
      buffer += decoder.write(chunk);
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline < 0) return cb();
      const complete = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      try {
        for (const delta of extractor.feed(complete)) {
          fullText += delta;
          // 工具模式下缓冲可见文本：协议块可能横跨多个 delta，只有流末才能安全判定
          if (hasTools) continue;
          if (!roleEmitted) {
            roleEmitted = true;
            this.push(chatChunkFrame({ id, model, created, role: 'assistant' }));
          }
          this.push(chatChunkFrame({ id, model, created, content: delta }));
        }
      } catch { /* 解析器不抛错，双保险 */ }
      cb();
    },
    flush(cb) {
      try {
        for (const delta of extractor.feed(buffer + decoder.end() + '\n')) {
          fullText += delta;
        }
        const { blocked, sawAssistantText } = extractor.result();
        // 工具桥：流末对全文跑一次协议解析；命中→吞正文发伪 tool_calls
        if (hasTools) {
          const { calls, cleanedText } = parseToolCallBlocks(fullText, allowedNames);
          if (calls.length) {
            if (!roleEmitted) {
              roleEmitted = true;
              this.push(chatChunkFrame({ id, model, created, role: 'assistant' }));
            }
            calls.forEach((call, index) => {
              this.push(chatChunkFrame({
                id, model, created,
                toolCalls: [{
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                }],
              }));
            });
            toolCallsEmitted = true;
            this.push(chatChunkFrame({ id, model, created, finishReason: 'tool_calls' }));
            this.push('data: [DONE]\n\n');
            cb();
            return;
          }
          // 没调工具：把缓冲的可见文本（若有）正常放出。
          // 出口过一遍净化：剥离旧注入确认词回声 + 坍缩复读循环（历史污染旧会话兜底）
          const visible = sanitizeBridgeOutput(cleanedText);
          if (visible) {
            if (!roleEmitted) {
              roleEmitted = true;
              this.push(chatChunkFrame({ id, model, created, role: 'assistant' }));
            }
            this.push(chatChunkFrame({ id, model, created, content: visible }));
          }
        }
        if (!roleEmitted) {
          this.push(chatChunkFrame({ id, model, created, role: 'assistant' }));
        }
        if (!toolCallsEmitted) {
          if (blocked && !sawAssistantText && !hasTools) {
            this.push(chatChunkFrame({
              id, model, created,
              content: '\n\n[上游内容策略拦截了本次请求（moderation blocked）]',
            }));
          }
          this.push(chatChunkFrame({ id, model, created, finishReason: 'stop' }));
          this.push('data: [DONE]\n\n');
        }
      } catch { /* 兜底：解析器永不中断流 */ }
      cb();
    },
  });
}

// 非流式：从完整 conversation SSE 文本聚合 chat.completion JSON
export function conversationSseToChatCompletion(bodyText, { model, tools = null } = {}) {
  const collector = createConversationTextCollector();
  collector.feed(String(bodyText || ''));
  collector.feed('\n');
  const { blocked } = collector.result();
  let content = collector.text();
  if (blocked && !content) {
    content = '[上游内容策略拦截了本次请求（moderation blocked）]';
  }
  const allowedNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((t) => (t?.type === 'function' && t.function?.name ? t.function.name : null))
      .filter(Boolean),
  );
  const base = {
    id: `chatcmpl-web-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _blocked: blocked,
  };
  if (allowedNames.size) {
    const { calls, cleanedText } = parseToolCallBlocks(content, allowedNames);
    if (calls.length) {
      return {
        ...base,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: sanitizeBridgeOutput(cleanedText) || null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments },
            })),
          },
          finish_reason: 'tool_calls',
        }],
      };
    }
    content = sanitizeBridgeOutput(cleanedText);
  } else {
    // 无 tools 声明的请求也可能携带工具轮回放历史（历史轮被渲染成叙述文本），
    // 模型会复读这些措辞——与工具模式同一套剥离器（注入回声 + 前置叙述头，
    // 均零误伤）；只跳过复读坍缩（纯聊天里连续重复片段可能是合法内容如日志摘录）
    content = stripLeadingToolNarration(stripInjectedEchoes(content)).trim();
  }
  return {
    ...base,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  };
}

// 全量文本收集器（非流式用；与增量解析器同一状态机，累计而非逐段吐出）
export function createConversationTextCollector() {
  const extractor = createConversationTextExtractor();
  let full = '';
  return {
    feed(text) {
      for (const delta of extractor.feed(text)) full += delta;
    },
    text() {
      return full;
    },
    result: () => extractor.result(),
  };
}
