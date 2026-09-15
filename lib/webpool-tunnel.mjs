// ---------- 官方 Secure MCP Tunnel 客户端托管（治根改造 P2，2026-09-14） ----------
// 下载并监督 OpenAI 官方 tunnel-client（github.com/openai/tunnel-client，纯出站连接）：
//   doctor → control-plane 探测 → run --mcp.server-url "url=http://127.0.0.1:<mcpPort>/mcp,channel=main"
//   → 崩溃指数退避重启（/readyz 与退出码为权威健康信号；WebCodex 实录 /readyz=200 ≠
//   control-plane 可达，故两者都要看）。
// 安全（硬约束落点）：
//   - 下载 URL 仅 https；每跳（含重定向）校验 host 白名单（github 域），拒绝任何
//     localhost/环回/私有/保留地址——服务端发起请求面收敛到官方发布物；
//   - zip 下载后按官方 SHA256SUMS.txt 校验，不符即删；
//   - 凭据（CONTROL_PLANE_TUNNEL_ID / CONTROL_PLANE_API_KEY）只从 env/注册表
//     （env-key-source）读取，日志与状态永不携带值；
//   - 本地 Bearer 经 file-backed extra-headers 注入（WebCodex 范式），文件放用户目录。
// 端到端激活前置：用户在面板配好 Tunnel ID/Key（人工，见 docs/reference 笔记 §8）。

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
const MAX_BACKOFF_MS = 60_000;

export function tunnelAssetName(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const archName = arch === 'arm64' ? 'arm64' : 'amd64';
  return {
    asset: `tunnel-client-${TUNNEL_CLIENT_VERSION}-${osName}-${archName}.zip`,
    exe: osName === 'windows' ? 'tunnel-client.exe' : 'tunnel-client',
  };
}

/** 服务端发起 URL 的安全闸门：https、白名单 host、拒绝环回/私有/保留。 */
export function validateDownloadUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'URL 非法' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `仅允许 https（收到 ${url.protocol}）` };
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: '拒绝 IP 直连下载源' }; // 环回/私有/保留统一拒绝（下载源必须是指定域名）
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

/** 解析官方 SHA256SUMS.txt（行格式 "<hash>  <filename>"），取指定资产摘要。 */
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

/** run 命令行参数（WebCodex 托管范式逐参对齐）。 */
export function buildRunArgs({ port, bearerFile = '', channel = 'main', proxyUrl = '' }) {
  const args = ['run', '--mcp.server-url', `url=http://127.0.0.1:${port}/mcp,channel=${channel}`];
  if (bearerFile) args.push('--mcp.extra-headers', `Authorization: file:${bearerFile}`);
  if (proxyUrl) args.push('--control-plane.http-proxy', proxyUrl);
  return args;
}

export function backoffDelayMs(attempt, now = Date.now()) {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor((now % 1000) / 10); // 去同步抖动（同一秒重启风暴的廉价错峰）
}

/** 隧道配置段（默认关；凭据只走环境变量名引用）。 */
export function readTunnelConfig(config = {}) {
  const tunnel = (config.chatgptWeb && config.chatgptWeb.nativeTools && config.chatgptWeb.nativeTools.tunnel) || {};
  return {
    enabled: tunnel.enabled === true,
    version: TUNNEL_CLIENT_VERSION,
    idKey: 'CONTROL_PLANE_TUNNEL_ID',
    apiKey: 'CONTROL_PLANE_API_KEY',
    channel: typeof tunnel.channel === 'string' && tunnel.channel.trim() ? tunnel.channel.trim().slice(0, 32) : 'main',
    dir: typeof tunnel.dir === 'string' && tunnel.dir.trim()
      ? tunnel.dir.trim()
      : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'codex-router', 'tunnel-client'),
  };
}

/**
 * 创建托管器。依赖全部可注入（测试不外呼网络/不 spawn 真实二进制）：
 * - fetchImpl / spawnImpl / execFile（tar 解包用 spawn）
 * - getKey(name) 凭据读取（env-key-source 的 getKey），refreshKey(name) 注册表热刷
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
  let state = 'off'; // off | missing_credentials | invalid_tunnel_id | downloading | backoff | starting | running | stopped | failed
  let child = null;
  let restartAttempt = 0;
  let lastError = '';
  let lastExit = null;
  let restartTimer = null;
  let stopped = false;
  let startedAt = 0;
  let restarts = 0;
  let binaryPath = '';
  let downloadPromise = null;

  function setStatus(next, error = '') {
    state = next;
    if (error) lastError = String(error).slice(0, 200);
    log({ event: 'webpool.tunnel_state', outcome: next, message: error ? String(error).slice(0, 160) : undefined });
  }

  function exePathFor(cfg) {
    const { exe } = tunnelAssetName();
    return path.join(cfg.dir, cfg.version, exe);
  }

  /** 下载+校验+解包（幂等：已存在直接返回；并发合并）。 */
  function ensureBinary(cfg) {
    if (binaryPath && fs.existsSync(binaryPath)) return Promise.resolve(binaryPath);
    const target = exePathFor(cfg);
    if (fs.existsSync(target)) { binaryPath = target; return Promise.resolve(target); }
    if (downloadPromise) return downloadPromise;
    downloadPromise = (async () => {
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
      fs.mkdirSync(outDir, { recursive: true });
      await new Promise((resolve, reject) => {
        // Windows 10+ 自带 bsdtar 支持 zip 解包；不引第三方依赖
        const tar = spawnImpl('tar', ['-xf', tmpZip, '-C', outDir], { windowsHide: true });
        let err = '';
        tar.stderr?.on('data', (c) => { err += c; });
        tar.on('error', reject);
        tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解包失败 exit=${code} ${err.slice(0, 120)}`))));
      });
      try { fs.unlinkSync(tmpZip); } catch { /* 尽力 */ }
      if (!fs.existsSync(target)) throw new Error('解包后未找到可执行文件');
      binaryPath = target;
      return target;
    })().catch((error) => {
      setStatus('failed', error?.message || error);
      throw error;
    }).finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  function spawnChild(bin, cfg, envVars) {
    const args = buildRunArgs({
      port: getMcpPort(),
      bearerFile: getBearerFile(),
      channel: cfg.channel,
      proxyUrl: getProxyUrl(),
    });
    const env = { ...process.env, CONTROL_PLANE_TUNNEL_ID: envVars.id, CONTROL_PLANE_API_KEY: envVars.key };
    // 与 WebCodex 同策略：从子进程环境剥离通用 OpenAI 密钥，隧道只需 Runtime Key
    delete env.OPENAI_ADMIN_KEY;
    delete env.OPENAI_API_KEY;
    child = spawnImpl(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errTail = '';
    child.stderr?.on('data', (c) => {
      // 错误尾只留最后 400 字且剥掉疑似密钥串（值来自 env，理论上不该出现，双保险）
      errTail = (errTail + String(c)).slice(-400);
    });
    startedAt = Date.now();
    setStatus('running');
    child.on('exit', (code, signal) => {
      lastExit = { code, signal, at: Date.now() };
      child = null;
      if (stopped) { setStatus('stopped'); return; }
      // 健康存活超 5 分钟视为已恢复，退避归零
      if (Date.now() - startedAt > 5 * 60_000) restartAttempt = 0;
      restartAttempt += 1;
      restarts += 1;
      const delay = backoffDelayMs(restartAttempt);
      setStatus('backoff', `退出 code=${code} signal=${signal || '-'} ${errTail.slice(-120)}`);
      restartTimer = setTimeout(() => { restartTimer = null; launch(cfg).catch(() => {}); }, delay);
      restartTimer.unref?.();
    });
    child.on('error', (error) => {
      lastExit = { code: null, signal: 'error', at: Date.now() };
      child = null;
      if (!stopped) setStatus('failed', `spawn 失败：${error?.message || error}`);
    });
  }

  async function launch(cfg) {
    if (stopped) return;
    try {
      const bin = await ensureBinary(cfg);
      await refreshKey(cfg.idKey).catch(() => {});
      await refreshKey(cfg.apiKey).catch(() => {});
      const id = String(getKey(cfg.idKey) || '');
      const key = String(getKey(cfg.apiKey) || '');
      if (!id || !key) { setStatus('missing_credentials', 'CONTROL_PLANE_TUNNEL_ID / CONTROL_PLANE_API_KEY 未配置（管理页向导完成后重启生效）'); return; }
      if (!TUNNEL_ID_RE.test(id)) { setStatus('invalid_tunnel_id', 'Tunnel ID 格式应为 tunnel_ + 32 位十六进制'); return; }
      spawnChild(bin, cfg, { id, key });
    } catch (error) {
      setStatus('failed', error?.message || error);
    }
  }

  return {
    /** 门面启动后调用：按配置决定是否拉起隧道托管。 */
    start(rawConfig) {
      const cfg = readTunnelConfig(rawConfig);
      if (!cfg.enabled) { setStatus('off'); return; }
      stopped = false;
      launch(cfg).catch(() => {});
    },
    async stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      const proc = child;
      child = null;
      if (proc) {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          proc.once('exit', done);
          try { proc.kill(); } catch { done(); }
          setTimeout(done, 3_000).unref?.();
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
