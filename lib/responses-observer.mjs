import { Transform } from 'node:stream';
import { createSseDecoder } from './sse-decoder.mjs';

// ---------- 原生 Responses SSE 旁路观察器 ----------
// 数据逐字节原样透传，仅从终态事件提取完整 response，供路由记录供应商亲和与工具调用。
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

function observerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ResponsesSseObserver extends Transform {
  constructor(options = {}) {
    super();
    this.maxEventBytes = Math.max(1, Number(options.maxEventBytes) || DEFAULT_MAX_EVENT_BYTES);
    this.decoder = createSseDecoder({ maxEventBytes: this.maxEventBytes });
    this.terminalObserved = false;
  }

  inspectEvent(decodedEvent) {
    const eventType = decodedEvent.event;
    const data = decodedEvent.data;
    if (!data || data === '[DONE]') return;
    if (this.terminalObserved) {
      // 终态事件已完整送达客户端：个别第三方上游会在 response.completed 之后再补发
      // 非标准事件（心跳/统计等），此时销毁响应只会伤害用户，数据完整性已无增益——
      // 容忍并忽略（2026-09-13 审计：零容忍策略可被宽松上游误触）。
      return;
    }

    let payload = null;
    const mustParse = TERMINAL_EVENT_TYPES.has(eventType) || /^[\s]*[\[{]/.test(data);
    if (!mustParse) return;
    try {
      payload = JSON.parse(data);
    } catch {
      if (!TERMINAL_EVENT_TYPES.has(eventType)) return;
      throw observerError('invalid_responses_sse_json', `无法解析 ${eventType} 的 JSON 数据`);
    }

    const payloadType = typeof payload?.type === 'string' ? payload.type : '';
    const terminalType = TERMINAL_EVENT_TYPES.has(eventType) ? eventType : payloadType;
    if (!TERMINAL_EVENT_TYPES.has(terminalType)) return;
    if (eventType && payloadType && eventType !== payloadType) {
      throw observerError('invalid_responses_sse_terminal', 'Responses SSE 终态事件名称与数据类型不一致');
    }
    if (!payload?.response || typeof payload.response !== 'object' || typeof payload.response.id !== 'string') {
      throw observerError('invalid_responses_sse_terminal', `${terminalType} 缺少有效 response`);
    }
    const expectedStatus = {
      'response.completed': 'completed',
      'response.failed': 'failed',
      'response.incomplete': 'incomplete',
    }[terminalType];
    if (payload.response.status !== expectedStatus) {
      throw observerError('invalid_responses_sse_terminal', `${terminalType} 与 response.status 不一致`);
    }
    this.terminalObserved = true;
    this.emit('response', payload.response);
  }

  mapDecoderError(error) {
    if (error.code === 'invalid_sse_utf8') {
      return observerError('invalid_responses_sse_utf8', 'Responses SSE 包含非法 UTF-8 数据');
    }
    if (error.code === 'sse_event_too_large') {
      return observerError(
        'responses_sse_event_too_large',
        `Responses SSE 单事件超过 ${this.maxEventBytes} 字节`,
      );
    }
    return error;
  }

  _transform(chunk, encoding, callback) {
    const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      for (const event of this.decoder.push(rawChunk)) this.inspectEvent(event);
      this.push(rawChunk);
      callback();
    } catch (error) {
      callback(this.mapDecoderError(error));
    }
  }

  _flush(callback) {
    try {
      for (const event of this.decoder.finish()) this.inspectEvent(event);
      if (!this.terminalObserved) {
        throw observerError('responses_sse_truncated', 'Responses SSE 在终态事件前结束');
      }
      callback();
    } catch (error) {
      callback(this.mapDecoderError(error));
    }
  }
}

export function createResponsesSseObserver(options) {
  return new ResponsesSseObserver(options);
}
