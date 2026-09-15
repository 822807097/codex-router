// ---------- 官方 Secure MCP Tunnel 客户端托管（治根改造 P2；P7 对抗审查修复轮） ----------
// 下载并监督 OpenAI 官方 tunnel-client（github.com/openai/tunnel-client，纯出站连接）：
//   run --mcp.server-url "url=http://127.0.0.1:<mcpPort>/mcp,channel=main"
//   → 崩溃指数退避重启。/readyz 与退出码为权威健康信号。
// 安全（硬约束 + 审查修复落点）：
//   - 下载 URL 仅 https；每跳（含重定向）过 host 白名单闸门，拒绝 localhost/环回/私有/保留；
//   - zip 按官方 SHA256SUMS.txt 校验；解包后记 exe 哈希 sidecar，缓存命中复算比对
//     （P1-4：被篡改/预置的二进制绝不被信任，缺失或不符一律重新完整校验）；
//   - 子进程 stderr 一律经密钥剥离正则再入状态/日志（P1-3：宣称即实现）；
//   - stop 与在途 launch 竞态闭合（P1-2：stop 等在途启动完成后再杀，spawn 前重查 stopped）；
//   - 配置值拼 argv 前全部格式白名单化（P1-5：channel/proxyUrl/port 防参数语义注入）；
//   - 凭据只从 env/注册表（env-key-source）读取，日志与状态永不携带值。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const TUNNEL_CLIENT_VERSION = 'v0.0.14';
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/${TUNNEL_CLIENT_VERSION}`;
const ALLOWED_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'codeload.github.com', 'release-assets.githubusercontent.com']);
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const TUNNEL_ID_RE = /^tunnel_[0-9a-f]{32}$/;
const CHANNEL_RE = /^[\w.-]{1,32}$/;
const PROXY_URL_RE = /^https?:\/\/[^\s,=]+$/; // 禁空格/逗号/=：不破坏 CLI 参数语义
const MAX_BACKOFF_MS = 60_000;

export function tunnelAssetName(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const archName = arch === 'arm64' ? 'arm64' : 'amd64';
  return {
    asset: `tunnel-client-${TUNNEL_CLIENT_VERSION}-${osName}-${archName}.zip`,
    exe: osName === 'windows' ? 'tunnel-client.exe' : 'tunnel-client',
  };
}

/** 服务端发起 URL 的安全闸门：https、白名单 host、拒绝 IP 字面量（含环回/私有/保留）。 */
export function validateDownloadUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'URL 非法' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `仅允许 https（收到 ${url.protocol}）` };
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
    return { ok: false, reason: '拒绝 IP 直连下载源' }; // IPv4 字面量与 IPv6 括号形统一拒（下载源必须是指定域名）
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) return { ok: false, reason: `host 不在白名单：${host}` };
  return { ok: true, url };
}

/** 跟随重定向但每一跳都重新过安全闸门（fetch 手动重定向模式）。 */
export async function safeFetch(urlString, { fetchImpl = fetch, maxRedirects = 5, headers = {}, signal } = {}) {
  let current = String(urlString);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = validateDownloadUrl(current);
    if (!check.ok) throw new Error(`下载被安全闸门拒绝（${check.reason}）：${current.slice(0, 80)}`);
    const res = await fetchImpl(current, { redirect: 'manual', headers, signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('重定向次数超限');
}

/** 解析官方 SHA256SUMS.txt（行格式 "<hash>  <filename>"，兼容 *二进制模式），取指定资产摘要。 */
export function parseSha256Sums(text, assetName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && path.basename(m[2].trim()) === assetName) return m[1].toLowerCase();
  }
  return null;
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function safeChannel(value) {
  const channel = String(value ?? '').trim();
  return CHANNEL_RE.test(channel) ? channel : 'main';
}

export function safeProxyUrl(value) {
  const url = String(value ?? '').trim();
  return PROXY_URL_RE.test(url) ? url : '';
}

/** run 命令行参数（WebCodex 托管范式逐参对齐；port 经强校验）。 */
export function buildRunArgs({ port, bearerFile = '', channel = 'main', proxyUrl = '' }) {
  const args = ['run', '--mcp.server-url', `url=http://127.0.0.1:${safePortArg(port)}/mcp,channel=${safeChannel(channel)}`];
  if (bearerFile) args.push('--mcp.extra-headers', `Authorization: file:${bearerFile}`);
  const proxy = safeProxyUrl(proxyUrl);
  if (proxy) args.push('--control-plane.http-proxy', proxy);
  return args;
}

function safePortArg(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 15731;
}

export function backoffDelayMs(attempt, now = Date.now()) {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor((now % 1000) / 10); // 去同步抖动
}

// 子进程 stderr 可能回显 env/文件内容：入任何状态或日志前强制剥离凭据形态
// （Bearer 值、sk- 密钥、CONTROL_PLANE_API_KEY= 行、URL key= 段、≥40 位 base64 长串）。
const SECRET_SCRUB_RES = [
  /(Bearer\s+)[A-Za-z0-9._~+\/-]{6,}=*/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(CONTROL_PLANE_API_KEY\s*=\s*)\S+/g,
  /([?&]key=)[^&\s"']{6,}/gi,
  /[A-Za-z0-9+\/]{40,}={0,2}/g,
];
export function scrubSecrets(value) {
  let text = String(value ?? '');
  for (const re of SECRET_SCRUB_RES) {
    text = text.replace(re, (match, head) => (head ? `${head}[redacted]` : '[redacted]'));
  }
  return text;
}

/** 隧道配置段（默认关；凭据只走环境变量名引用）。 */
export function readTunnelConfig(config = {}) {
  const tunnel = (config.chatgptWeb && config.chatgptWeb.nativeTools && config.chatgptWeb.nativeTools.tunnel) || {};
  return {
    enabled: tunnel.enabled === true,
    version: TUNNEL_CLIENT_VERSION,
    idKey: 'CONTROL_PLANE_TUNNEL_ID',
    apiKey: 'CONTROL_PLANE_API_KEY',
    channel: safeChannel(tunnel.channel),
    dir: typeof tunnel.dir === 'string' && tunnel.dir.trim()
      ? tunnel.dir.trim()
      : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'codex-router', 'tunnel-client'),
  };
}

/**
 * 创建托管器。依赖全部可注入（测试不外呼网络/不 spawn 真实二进制）：
 * - fetchImpl / spawnImpl
 * - getKey(name) 凭据读取（env-key-source），refreshKey(name) 注册表热刷
 * - log 诊断事件
 */
export function createWebpoolTunnel({
  log = () => {},
  getKey = () => '',
  refreshKey = async () => {},
  fetchImpl = fetch,
  spawnImpl = spawn,
  getMcpPort = () => 15731,
  getBearerFile = () => '',
  getProxyUrl = () => '',
} = {}) {
  let state = 'off'; // off | missing_credentials | invalid_tunnel_id | downloading | backoff | running | stopped | failed
  let child = null;
  let restartAttempt = 0;
  let lastError = '';
  let lastExit = null;
  let restartTimer = null;
  let launchPromise = null;
  let stopped = true;
  let startedAt = 0;
  let restarts = 0;
  let binaryPath = '';
  let downloadPromise = null;

  function setStatus(next, error = '') {
    if (stopped && next !== 'stopped' && next !== 'off') return; // 停止后状态不倒挂（P1-2）
    state = next;
    if (error) lastError = scrubSecrets(error).slice(0, 200);
    log({ event: 'webpool.tunnel_state', outcome: next, message: error ? scrubSecrets(error).slice(0, 160) : undefined });
  }

  function exePathFor(cfg) {
    const { exe } = tunnelAssetName();
    return path.join(cfg.dir, cfg.version, exe);
  }

  /** 下载+校验+解包（幂等；缓存命中经 sidecar 复算完整性，不符即重下——P1-4）。 */
  function ensureBinary(cfg) {
    const target = exePathFor(cfg);
    if (binaryPath && !fs.existsSync(binaryPath)) binaryPath = '';
    const verifyCached = async () => {
      if (!fs.existsSync(target)) return null;
      const sidecar = `${target}.sha256`;
      if (!fs.existsSync(sidecar)) {
        // 无校验凭据的缓存不可信：清掉走完整下载校验
        try { fs.unlinkSync(target); } catch { /* 尽力 */ }
        return null;
      }
      const want = String(fs.readFileSync(sidecar, 'utf8')).trim().toLowerCase();
      const got = await sha256File(target);
      if (got === want) return target;
      try { fs.unlinkSync(target); fs.unlinkSync(sidecar); } catch { /* 尽力 */ }
      return null;
    };
    if (binaryPath && fs.existsSync(binaryPath)) return Promise.resolve(binaryPath);
    if (downloadPromise) return downloadPromise;
    downloadPromise = (async () => {
      const cached = await verifyCached();
      if (cached) { binaryPath = cached; return cached; }
      const { asset } = tunnelAssetName();
      setStatus('downloading');
      const sumsRes = await safeFetch(`${RELEASE_BASE}/SHA256SUMS.txt`, { fetchImpl });
      if (!sumsRes.ok) throw new Error(`SHA256SUMS 拉取失败 HTTP ${sumsRes.status}`);
      const expected = parseSha256Sums(await sumsRes.text(), asset);
      if (!expected) throw new Error('SHA256SUMS 中无本平台资产（可能平台不支持或版本变更）');
      const zipRes = await safeFetch(`${RELEASE_BASE}/${asset}`, { fetchImpl });
      if (!zipRes.ok) throw new Error(`资产下载失败 HTTP ${zipRes.status}`);
      const buf = await zipRes.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('下载超过体积上限');
      const actual = crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
      if (actual !== expected) throw new Error(`SHA256 校验失败（期望 ${expected.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…），文件已拒收`);
      fs.mkdirSync(cfg.dir, { recursive: true });
      const tmpZip = path.join(cfg.dir, `${asset}.part`);
      fs.writeFileSync(tmpZip, Buffer.from(buf));
      const outDir = path.join(cfg.dir, cfg.version);
      fs.rmSync(outDir, { recursive: true, force: true }); // 陈旧解包内容一律清除
      fs.mkdirSync(outDir, { recursive: true });
      await new Promise((resolve, reject) => {
        const tar = spawnImpl('tar', ['-xf', tmpZip, '-C', outDir], { windowsHide: true });
        let err = '';
        tar.stderr?.on('data', (c) => { err += c; });
        tar.on('error', reject);
        tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解包失败 exit=${code} ${scrubSecrets(err).slice(0, 120)}`))));
      });
      try { fs.unlinkSync(tmpZip); } catch { /* 尽力 */ }
      if (!fs.existsSync(target)) throw new Error('解包后未找到可执行文件');
      fs.writeFileSync(`${target}.sha256`, `${await sha256File(target)}\n`, { encoding: 'utf8' });
      binaryPath = target;
      return target;
    })().catch((error) => {
      setStatus('failed', error?.message || error);
      throw error;
    }).finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  function spawnChild(bin, cfg, envVars) {
    if (stopped) return; // P1-2：spawn 前最后闸门
    const args = buildRunArgs({
      port: getMcpPort(),
      bearerFile: getBearerFile(),
      channel: cfg.channel,
      proxyUrl: getProxyUrl(),
    });
    const env = { ...process.env, CONTROL_PLANE_TUNNEL_ID: envVars.id, CONTROL_PLANE_API_KEY: envVars.key };
    delete env.OPENAI_ADMIN_KEY; // 与 WebCodex 同策略：隧道只需 Runtime Key
    delete env.OPENAI_API_KEY;
    child = spawnImpl(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errTail = '';
    let finalized = false; // exit/error 双事件 latch（P2-2）
    child.stderr?.on('data', (c) => {
      errTail = (errTail + scrubSecrets(String(c))).slice(-400);
    });
    startedAt = Date.now();
    setStatus('running');
    const finalize = (info) => {
      if (finalized) return;
      finalized = true;
      lastExit = { ...info, at: Date.now() };
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt > 5 * 60_000) restartAttempt = 0;
      restartAttempt += 1;
      restarts += 1;
      const delay = backoffDelayMs(restartAttempt);
      setStatus('backoff', `退出 ${info.code ?? '-'} ${info.signal || info.error || ''} ${errTail.slice(-120)}`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopped) {
          launchPromise = launch(cfg).catch(() => {});
          launchPromise.finally?.(() => {});
        }
      }, delay);
      restartTimer.unref?.();
    };
    child.on('exit', (code, signal) => finalize({ code, signal }));
    child.on('error', (error) => finalize({ code: null, signal: 'error', error: String(error?.message || error).slice(0, 80) }));
  }

  async function launch(cfg) {
    if (stopped) return;
    try {
      const bin = await ensureBinary(cfg);
      await refreshKey(cfg.idKey).catch(() => {});
      await refreshKey(cfg.apiKey).catch(() => {});
      if (stopped) return; // P1-2：下载/刷新后重查
      const id = String(getKey(cfg.idKey) || '');
      const key = String(getKey(cfg.apiKey) || '');
      if (!id || !key) { setStatus('missing_credentials', 'CONTROL_PLANE_TUNNEL_ID / CONTROL_PLANE_API_KEY 未配置（管理页向导完成后重启生效）'); return; }
      if (!TUNNEL_ID_RE.test(id)) { setStatus('invalid_tunnel_id', 'Tunnel ID 格式应为 tunnel_ + 32 位十六进制'); return; }
      spawnChild(bin, cfg, { id, key });
    } catch {
      /* ensureBinary 失败路径已 setStatus('failed') */
    }
  }

  return {
    /** 门面启动后调用：按配置决定是否拉起隧道托管。 */
    start(rawConfig) {
      const cfg = readTunnelConfig(rawConfig);
      if (!cfg.enabled) { stopped = true; setStatus('off'); return; }
      stopped = false;
      launchPromise = launch(cfg).catch(() => {});
    },
    async stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (launchPromise) {
        try { await launchPromise; } catch { /* 已在任务内消化 */ }
        launchPromise = null;
      }
      const proc = child;
      child = null;
      if (proc) {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          proc.once('exit', done);
          try { proc.kill(); } catch { done(); }
          const t = setTimeout(done, 3_000);
          t.unref?.();
        });
      }
      setStatus('stopped');
    },
    status: () => ({
      state,
      version: TUNNEL_CLIENT_VERSION,
      binary: binaryPath ? path.basename(binaryPath) : '',
      pid: child?.pid || 0,
      restarts,
      restartAttempt,
      lastExit,
      lastError,
    }),
  };
}
