// ---------- 网页池文件桥：截图回注（治根改造 P4.1） ----------
// 网页模型此前只能拿 UIA 文本树「盲操作」；本模块把工具结果里的截图上传到会话文件
// 存储并以 image_asset_pointer 注入 user 轮，让模型真正「看见」屏幕。
// 三步上传（参考实现协议笔记 docs/reference/chatgpt2api，2026-09 实测形态）：
//   ① POST /backend-api/files            → {file_id, upload_url}
//   ② PUT  upload_url（原始字节）
//   ③ POST /backend-api/files/{id}/uploaded {file_name, file_size} → status uploaded
// 安全（Mimosa 约束落点）：
//   - upload_url 仅 https，且拒绝 localhost/环回/私有/保留地址（防被上游响应重定向到内网）；
//   - 不落任何凭据：Authorization 只进请求头（accessToken 由调用方从 vault 传入）。
// 失败语义（绝不打穿主链路）：任何一步失败 → 该图片回退为文本占位（模型继续工作，
// 只是看不见这张图），并落 chatgpt_web.upload_failed 诊断事件。

import { createHash } from 'node:crypto';
import { rawHttpsRequest } from './transport.mjs';

const UPLOAD_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 64;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 上传目标闸门：仅 https；拒 IP 字面量与 localhost/环回/私有/保留网段。 */
export function validateUploadTarget(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'URL 非法' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `仅允许 https（${url.protocol}）` };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: '拒绝 localhost' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = [Number(host.split('.')[0]), Number(host.split('.')[1])];
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return { ok: false, reason: '拒绝环回/私有地址' };
    }
  }
  // IPv6 常见环回/私有形态（::1、fc/fd ULA、fe80 link-local）
  if (/^::1$|^f[cd][0-9a-f]{2}:|^fe80:/i.test(host)) return { ok: false, reason: '拒绝 IPv6 环回/私有地址' };
  return { ok: true, url };
}

/** 从 PNG/JPEG/GIF/WebP 字节头解析宽高（无依赖）。返回 {width,height} 或 null。 */
export function readImageDimensions(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) return null;
  // PNG: 89 50 4E 47 | IHDR at 12: width(4) height(4) BE
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    return { width: dv32(b, 16), height: dv32(b, 20) };
  }
  // GIF: 'GIF8'a/b LE width@6 height@8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    if (b.length < 10) return null;
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  // JPEG: 扫描 SOF0/1/2/3.. 段
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP VP8X/VP8L/VP8 尺寸编码各异，覆盖 VP8X（含扩展）与有损 VP8
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

function dv32(b, off) {
  return (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
}

/** data: URL 解析 → {mime, bytes}；只收 image/*，非法返回 null。 */
export function parseDataUrl(value) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(value || '').trim());
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    return { mime: m[1].toLowerCase(), bytes };
  } catch { return null; }
}

/**
 * 创建文件桥（每账号一个；调用方经 getValidCredentials 提供 token）。
 * upload({bytes, mime}) → {fileId, width, height, fromCache}；失败抛错由上层吞。
 */
export function createWebpoolFileBridge({
  accessToken,
  fp,
  proxy = null,
  request = rawHttpsRequest,
  log = () => {},
  timeoutMs = UPLOAD_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // sha256 -> {fileId, width, height, expiresAt}

  function headers(extra = {}) {
    return {
      'user-agent': fp?.userAgent || 'Mozilla/5.0',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...extra,
    };
  }

  async function callJson({ path, method = 'POST', body = null, timeout }) {
    const outcome = await request({
      protocol: 'https', host: 'chatgpt.com', path, method,
      viaProxy: Boolean(proxy), proxy,
      headers: headers(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeouts: { connectMs: 10_000, responseHeaderMs: timeout, requestMs: timeout },
      maxResponseBytes: 256 * 1024,
    });
    const text = typeof outcome.bodyText === 'string' ? outcome.bodyText : '';
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 畸形走失败 */ }
    if (outcome.status < 200 || outcome.status >= 300) {
      const error = new Error(`files ${method} ${path} HTTP ${outcome.status}`);
      error.status = outcome.status;
      throw error;
    }
    return parsed || {};
  }

  async function putBlob(uploadUrl, bytes, mime) {
    const gate = validateUploadTarget(uploadUrl);
    if (!gate.ok) throw new Error(`upload_url 未过安全闸门：${gate.reason}`);
    const outcome = await request({
      protocol: 'https',
      host: gate.url.host,
      path: gate.url.pathname + gate.url.search,
      method: 'PUT',
      viaProxy: Boolean(proxy), proxy,
      headers: { 'content-type': mime, 'content-length': String(bytes.length) },
      body: bytes,
      timeouts: { connectMs: 10_000, responseHeaderMs: timeoutMs, requestMs: timeoutMs },
      maxResponseBytes: 16 * 1024,
    });
    if (outcome.status < 200 || outcome.status >= 300) {
      const error = new Error(`blob PUT HTTP ${outcome.status}`);
      error.status = outcome.status;
      throw error;
    }
  }

  async function upload({ bytes, mime }) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const hit = cache.get(sha);
    if (hit && hit.expiresAt > now()) return { ...hit, fromCache: true, sha };
    const dims = readImageDimensions(bytes);
    const started = callJson({ path: '/backend-api/files', body: { file_name: `shot-${sha.slice(0, 12)}.png`, file_size: bytes.length }, timeout: timeoutMs });
    const { file_id: fileId, upload_url: uploadUrl } = await started;
    if (!fileId || !uploadUrl) throw new Error('files 响应缺少 file_id/upload_url');
    await putBlob(uploadUrl, bytes, mime || 'image/png');
    await callJson({
      path: `/backend-api/files/${encodeURIComponent(fileId)}/uploaded`,
      body: { file_name: `shot-${sha.slice(0, 12)}.png`, file_size: bytes.length },
      timeout: timeoutMs,
    });
    const entry = { fileId, width: dims?.width || 0, height: dims?.height || 0, expiresAt: now() + CACHE_TTL_MS };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(sha, entry);
    log({ event: 'chatgpt_web.file_uploaded', outcome: 'ok', message: `file=${String(fileId).slice(0, 40)} ${entry.width}x${entry.height}` });
    return { ...entry, fromCache: false, sha };
  }

  return {
    upload,
    validateUploadTarget,
    _cacheSize: () => cache.size,
  };
}

/** 会话消息用的 image_asset_pointer part（宽高必须携带，缺尺寸给保守默认）。 */
export function buildAssetPointerPart({ fileId, width, height, sizeBytes = 0 }) {
  return {
    content_type: 'image_asset_pointer',
    asset_pointer: `file-service://${fileId}`,
    size_bytes: sizeBytes,
    width: Number(width) > 0 ? Number(width) : 1280,
    height: Number(height) > 0 ? Number(height) : 720,
    fuzzy_object_factors: null,
    uses_original_asset: null,
    media_duration_seconds: null,
    download_code: null,
    is_queued: false,
  };
}
