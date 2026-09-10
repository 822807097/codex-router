// ---------- ChatGPT 网页通道 sentinel PoW（W3，2026-09-08） ----------
// 移植自 docs/reference/chatgpt2api/pow.py（MIT）：浏览器指纹数组 + sha3-512
// 工作量证明。与上游对照的关键等价点：
// - JSON 紧凑序列化：JSON.stringify ≡ json.dumps(separators=(",",":"), ensure_ascii=False)
// - 迭代器拼位：static_1 去尾括号补逗号、static_2 去首尾括号、static_3 去首括号
// - 时间串：UTC-5 的 "%a %b %d %Y %H:%M:%S" + " GMT-0500 (Eastern Standard Time)"
// 难度正常时迭代 < 数千次；上限 500k 兜底（与参考一致），超出按求解失败抛错。

import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';

const POW_LIMIT = 500_000;
const CORES = [8, 16, 24, 32];
const DOCUMENT_KEYS = ['__reactContainer$fzelfjyxej8', '_reactListening5dehydibo78', 'location'];
const SCREEN_RESOLUTIONS = [[1920, 1080], [1440, 900], [2560, 1440], [3840, 2160]];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const NAVIGATOR_KEYS = [
  'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
  'storage−[object StorageManager]',
  'locks−[object LockManager]',
  'appCodeName−Mozilla',
  'permissions−[object Permissions]',
  'share−function share() { [native code] }',
  'webdriver−false',
  'managed−[object NavigatorManagedData]',
  'canShare−function canShare() { [native code] }',
  'vendor−Google Inc.',
  'mediaDevices−[object MediaDevices]',
  'vibrate−function vibrate() { [native code] }',
  'storageBuckets−[object StorageBucketManager]',
  'mediaCapabilities−[object MediaCapabilities]',
  'cookieEnabled−true',
  'virtualKeyboard−[object VirtualKeyboard]',
  'product−Gecko',
  'presentation−[object Presentation]',
  'onLine−true',
  'mimeTypes−[object MimeTypeArray]',
  'credentials−[object CredentialsContainer]',
  'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]',
  'gpu−[object GPU]',
  'doNotTrack',
  'serial−[object Serial]',
  'pdfViewerEnabled−true',
  'language−zh-CN',
  'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]',
  'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }',
  'hardwareConcurrency−32',
  'windowControlsOverlay−[object WindowControlsOverlay]',
];

const WINDOW_KEYS = [
  '0', 'window', 'self', 'document', 'name', 'location', 'customElements', 'history',
  'navigation', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'visualViewport',
  'screenX', 'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'screen',
  'chrome', 'navigator', 'onresize', 'performance', 'crypto', 'indexedDB',
  'sessionStorage', 'localStorage', 'scheduler', 'alert', 'atob', 'btoa', 'fetch',
  'matchMedia', 'postMessage', 'queueMicrotask', 'requestAnimationFrame', 'setInterval',
  'setTimeout', 'caches', '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Python: datetime.now(timezone(-5h)).strftime("%a %b %d %Y %H:%M:%S") + " GMT-0500 (Eastern Standard Time)"
function legacyParseTime(now = Date.now()) {
  const shifted = new Date(now - 5 * 3600_000);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${DAY_NAMES[shifted.getUTCDay()]} ${MONTH_NAMES[shifted.getUTCMonth()]} `
    + `${pad2(shifted.getUTCDate())} ${shifted.getUTCFullYear()} `
    + `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`
    + ' GMT-0500 (Eastern Standard Time)';
}

export function buildPowConfig(userAgent, { scriptSources = null, dataBuild = '' } = {}, now = Date.now()) {
  const scriptSource = (Array.isArray(scriptSources) && scriptSources.length)
    ? pick(scriptSources)
    : DEFAULT_POW_SCRIPT;
  const [w, h] = pick(SCREEN_RESOLUTIONS);
  const perfMs = performance.now();
  return [
    w + h,
    legacyParseTime(now),
    4294705152,
    1,
    String(userAgent || ''),
    scriptSource,
    String(dataBuild || ''),
    'en-US',
    'en-US,es-US,en,es',
    Math.random(),
    pick(NAVIGATOR_KEYS),
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    perfMs,
    randomUUID(),
    '',
    pick(CORES),
    now - perfMs,
    0, 0, 0, 0, 0, 0,
    0,
  ];
}

// 最终 JSON = [c0,c1,c2, i, c4..c8, i>>1, c10..c24]（i 为迭代计数器，两个槽位）
// 异步求解：每 8192 次 setImmediate 让路事件循环（并发长流不被 PoW 卡顿；
// 正常难度数千次内出解，上限仅兜底）。
export async function solvePow(seed, difficulty, config, limit = POW_LIMIT) {
  const seedBytes = Buffer.from(String(seed || ''), 'utf8');
  const target = Buffer.from(String(difficulty || ''), 'hex');
  if (!target.length) throw new Error('proofofwork difficulty 非法（空 hex）');
  const static1 = Buffer.from(JSON.stringify(config.slice(0, 3)).slice(0, -1) + ',');
  const static2 = Buffer.from(',' + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ',');
  const static3 = Buffer.from(',' + JSON.stringify(config.slice(10)).slice(1));
  for (let i = 0; i < limit; i++) {
    if ((i & 8191) === 8191) await new Promise((resolve) => setImmediate(resolve));
    const finalJson = Buffer.concat([
      static1,
      Buffer.from(String(i)),
      static2,
      Buffer.from(String(i >> 1)),
      static3,
    ]);
    const encoded = finalJson.toString('base64');
    const digest = createHash('sha3-512').update(seedBytes).update(encoded).digest();
    if (digest.subarray(0, target.length).compare(target) <= 0) return encoded;
  }
  throw new Error(`proof of work 求解失败: difficulty=${difficulty}`);
}

export async function buildProofToken(seed, difficulty, userAgent, opts = {}, limit = POW_LIMIT) {
  const config = buildPowConfig(userAgent, opts);
  return 'gAAAAAB' + await solvePow(seed, difficulty, config, limit);
}

export function buildLegacyRequirementsToken(userAgent, opts = {}) {
  const config = buildPowConfig(userAgent, opts);
  return 'gAAAAAC' + Buffer.from(JSON.stringify(config)).toString('base64');
}

// 从首页 HTML 提取 PoW 脚本引用与 data-build（失败回退默认脚本，调用方无需判空）
// src 属性兼容双引号与单引号两种形态（Python HTMLParser 两者都收）。
export function parsePowResources(html) {
  const scriptSources = [];
  let dataBuild = '';
  const scriptRe = /<script[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')/g;
  for (const match of String(html || '').matchAll(scriptRe)) {
    const src = match[1] || match[2];
    scriptSources.push(src);
    const buildMatch = src.match(/c\/[^/]*\/_/);
    if (buildMatch) dataBuild = buildMatch[0];
  }
  if (!dataBuild) {
    const htmlBuild = String(html || '').match(/<html[^>]*data-build="([^"]*)"/);
    if (htmlBuild) dataBuild = htmlBuild[1];
  }
  return {
    scriptSources: scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT],
    dataBuild,
  };
}
