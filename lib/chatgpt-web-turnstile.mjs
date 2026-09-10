import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Node 24 全局可用 Buffer/base64；json stable 序列化用原生
const b64decode = (text) => Buffer.from(String(text || ''), 'base64').toString('utf8');
const b64encode = (text) => Buffer.from(String(text || ''), 'utf8').toString('base64');

/**
 * Cloudflare turnstile 求解器（对照参考实现 docs/reference/chatgpt2api/turnstile.py 逐函数移植）。
 *
 * 原理：sentinel prepare 响应里的 turnstile.dx 是一段 base64(xor(指令列表, p)) 的
 * 虚拟机字节码；本模块实现同一台 VM（有序 Map、字符串化规则、24 个操作码语义），
 * 在 Node 侧执行指令流拿到最终 base64 结果作为 OpenAI-Sentinel-Turnstile-Token。
 *
 * 与 Python 版的既定差异（均为不可观测行为）：
 * - performance.now 用 process.hrtime 计时 + Math.random 抖动（同参考的语义）；
 * - Math.random / 抖动源用crypto 随机 —— turnstile 校验端只认「0..1 浮点」形态。
 */

const SPECIAL_STRINGS = new Map([
  ['window.Math', '[object Math]'],
  ['window.Reflect', '[object Reflect]'],
  ['window.performance', '[object Performance]'],
  ['window.localStorage', '[object Storage]'],
  ['window.Object', 'function Object() { [native code] }'],
  ['window.Reflect.set', 'function set() { [native code] }'],
  ['window.performance.now', 'function () { [native code] }'],
  ['window.Object.create', 'function create() { [native code] }'],
  ['window.Object.keys', 'function keys() { [native code] }'],
  ['window.Math.random', 'function random() { [native code] }'],
]);

class OrderedMap {
  constructor() {
    this.keys = [];
    this.values = new Map();
  }

  add(key, value) {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }
}

function numberToStr(value) {
  // 逐字符对齐 Python str(float)：JS 与 Python 的差异点
  //  1) 整值浮点：Python str(2.0)='2.0'，JS String(2.0)='2'
  //  2) 小数指数：Python str(1e-7)='1e-07'，JS String(1e-7)='1e-7'（指数两位补零）
  // VM 的浮点来自 performance.now()/1e6 与随机数，op20 相等比较以字符串形态进行，
  // 任何形态差异都会让条件分支断裂、result 永不设置（30KB 真实流实测踩中）。
  if (Number.isInteger(value)) return `${value}.0`;
  let text = String(value);
  const expMatch = /^(-?\d)e([+-])(\d)$/.exec(text);
  if (expMatch) {
    text = `${expMatch[1]}e${expMatch[2]}0${expMatch[3]}`;
  }
  return text;
}

function toStr(value) {
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'number') return numberToStr(value);
  if (typeof value === 'string') return SPECIAL_STRINGS.get(value) ?? value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(',');
  }
  return String(value);
}

function xorString(text, key) {
  if (!key) return text;
  const out = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out.join('');
}

function random01() {
  const buf = require('node:crypto').randomBytes(4);
  return buf.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * @param {string} dx sentinel prepare 响应中的 turnstile.dx
 * @param {string} p prepare 请求里上送的 legacy p token（与 dx 的 xor 密钥同源）
 * @returns {string|null} turnstile token（失败返回 null，调用方回退快速失败路径）
 */
export function solveTurnstileToken(dx, p) {
  let tokenList;
  try {
    const decoded = b64decode(dx);
    tokenList = JSON.parse(xorString(decoded, String(p || '')));
  } catch {
    return null;
  }
  if (!Array.isArray(tokenList)) return null;

  const vars = new Map();
  const startTime = process.hrtime.bigint();
  let result = '';

  const get = (key) => vars.get(key);
  const set = (key, value) => vars.set(key, value);

  const op1 = (e, t) => set(e, xorString(toStr(get(e)), toStr(get(t))));
  const op2 = (e, t) => set(e, t);
  const op3 = (e) => { result = b64encode(typeof e === 'string' ? e : toStr(e)); };
  const op5 = (e, t) => {
    const current = get(e);
    const incoming = get(t);
    if (Array.isArray(current)) {
      set(e, [...current, incoming]);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number'
      || typeof incoming === 'string' || typeof incoming === 'number') {
      set(e, toStr(current) + toStr(incoming));
      return;
    }
    set(e, 'NaN');
  };
  const op6 = (e, t, n) => {
    const tv = get(t);
    const nv = get(n);
    if (typeof tv === 'string' && typeof nv === 'string') {
      const value = `${tv}.${nv}`;
      set(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value);
    }
  };
  const op7 = (e, ...rest) => {
    const target = get(e);
    const values = rest.map(get);
    if (typeof target === 'string' && target === 'window.Reflect.set') {
      const [obj, keyName, val] = values;
      if (obj instanceof OrderedMap) obj.add(String(keyName), val);
      return;
    }
    if (typeof target === 'function') target(...values);
  };
  const op8 = (e, t) => set(e, get(t));
  const op14 = (e, t) => {
    try { set(e, JSON.parse(get(t))); } catch { /* 指令级容错，与参考一致 */ }
  };
  const op15 = (e, t) => set(e, JSON.stringify(get(t)));
  const op17 = (e, t, ...rest) => {
    const callArgs = rest.map(get);
    const target = get(t);
    if (target === 'window.performance.now') {
      const elapsedNs = Number(process.hrtime.bigint() - startTime);
      set(e, (elapsedNs + random01()) / 1e6);
    } else if (target === 'window.Object.create') {
      set(e, new OrderedMap());
    } else if (target === 'window.Object.keys') {
      if (callArgs[0] === 'window.localStorage') {
        set(e, [
          'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
          'STATSIG_LOCAL_STORAGE_STABLE_ID',
          'client-correlated-secret',
          'oai/apps/capExpiresAt',
          'oai-did',
          'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
          'UiState.isNavigationCollapsed.1',
        ]);
      }
    } else if (target === 'window.Math.random') {
      set(e, random01());
    } else if (typeof target === 'function') {
      set(e, target(...callArgs));
    }
  };
  const op18 = (e) => {
    try { set(e, b64decode(toStr(get(e)))); } catch { /* 容错 */ }
  };
  const op19 = (e) => set(e, b64encode(toStr(get(e))));
  const op20 = (e, t, n, ...rest) => {
    if (get(e) === get(t)) {
      const target = get(n);
      if (typeof target === 'function') target(...rest.map(get));
    }
  };
  const op21 = () => {};
  const op23 = (e, t, ...rest) => {
    const target = get(t);
    if (get(e) !== null && get(e) !== undefined && typeof target === 'function') target(...rest);
  };
  const op24 = (e, t, n) => {
    const tv = get(t);
    const nv = get(n);
    if (typeof tv === 'string' && typeof nv === 'string') set(e, `${tv}.${nv}`);
  };

  const OPS = new Map([
    [1, op1], [2, op2], [3, op3], [5, op5], [6, op6], [7, op7], [8, op8],
    [14, op14], [15, op15], [17, op17], [18, op18], [19, op19], [20, op20],
    [21, op21], [23, op23], [24, op24],
  ]);

  // 与参考一致：操作码函数本身也存进槽位（op17/op20/op23 靠槽号找到 func_3 等间接调用）
  for (const [id, fn] of OPS) set(id, fn);
  set(9, tokenList);
  set(10, 'window');
  set(16, String(p || ''));

  // 执行循环（两段式自举，2026-09 真实 dx 实测）：
  // 第一段指令流是加载器——把操作码函数复制到大浮点槽位并在 9 号槽生成第二段程序；
  // 真程序在第二段里计算并触发 result。因此循环体每次都从 vars 动态取操作码
  // （加载器会安装新函数到浮点槽），跑完检查 9 号槽是否被替换，替换则再执行一遍。
  // 参考实现 chatgpt2api/turnstile.py 只跑入口列表，在该代际数据上返回 NULL（已实测）。
  let program = tokenList;
  for (let pass = 0; pass < 8 && Array.isArray(program); pass += 1) {
    for (const instruction of program) {
      try {
        if (!Array.isArray(instruction)) continue;
        const fn = vars.get(instruction[0]);
        if (typeof fn === 'function') fn(...instruction.slice(1));
      } catch { /* 单条指令失败不中断整体（与参考一致） */ }
    }
    const next = vars.get(9);
    if (!Array.isArray(next) || next === program) break;
    program = next;
  }
  return result || null;
}
