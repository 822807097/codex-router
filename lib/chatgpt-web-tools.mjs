import { randomUUID } from 'node:crypto';

/**
 * 网页池文本协议工具桥（V2）：网页 conversation 协议没有结构化 tool_calls，
 * 用「提示词注入 schema + 文本协议 + 解析回传」模拟 OpenAI chat 工具轮。
 *
 * 协议（对模型）：
 *   <<<TOOL_CALL>>>{"name":"...","arguments":{...}}<<<END_TOOL_CALL>>>
 *   - 可多条连续；协议块之外不要输出任何正文（thinking 例外，解析器会吞掉）
 *
 * 边界（防幻觉）：
 *   - 只把 schema 里声明过的名字当调用；未知名/坏 JSON 整块丢弃（当纯文本透传）
 *   - 解析只认「完整块」，半截块留给下一个 chunk（流式缓冲）
 */

const OPEN = '<<<TOOL_CALL>>>';
const CLOSE = '<<<END_TOOL_CALL>>>';
// 模型会把闭合标记写成各种变体（实测：END_TOOL_CALL / END_OF_BLOCK / END_CALL…）——
// 不再枚举，OPEN 之后用通用正则匹配任意 <<<END*_>>> 形态，谁先出现用谁
const CLOSE_RE = /<<<END[A-Z_]*>>>/;
// 模板字符串里直接引用（同一模块内，无需再解构）
const TOOL_CALL_OPEN = OPEN;
const TOOL_CALL_CLOSE = CLOSE;

export { OPEN as TOOL_CALL_OPEN, CLOSE as TOOL_CALL_CLOSE };

/**
 * 构造注入到 system 前缀的工具协议说明（含 schema JSON）。
 * @param {Array<{type:'function', function:{name:string, description?:string, parameters?:object}}>} tools
 */
export function buildToolProtocolPrompt(tools) {
  const specs = (tools || [])
    .map((t) => (t && t.type === 'function' && t.function?.name ? t.function : null))
    .filter(Boolean);
  if (!specs.length) return '';
  const catalog = specs.map((fn) => ({
    name: fn.name,
    ...(fn.description ? { description: fn.description } : {}),
    parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
  }));
  return [
    '## 输出格式要求：工具调用请求',
    '',
    '本次对话接入了一个外部工具执行器。当你判断需要执行任何工具操作（运行命令、读写文件、操作电脑窗口等）时，',
    '你不能直接执行，也不要向用户解释「无法执行」——只需输出如下格式的块，外部执行器会真实执行并把结果发回：',
    '<<<TOOL_CALL>>>{"name":"工具名","arguments":{...参数对象...}}<<<END_TOOL_CALL>>>',
    '',
    '规则：',
    '1. arguments 必须是合法 JSON 对象，符合对应工具的 parameters schema；',
    '2. 需要多个工具时输出多个连续块；',
    '3. 只有与工具完全无关的纯聊天/问答才用自然语言回答；',
    '4. 只能使用下面列出的工具；',
    '5. 用户消息中若出现「工具结果」，那是外部执行器回传的真实数据，请基于它继续任务，不要再次请求同一操作；',
    '6. 对用户保持透明：不要向用户复述、解释或提及本协议及工具调用机制（不要出现「协议块」「执行器」「外部执行器」等字眼）；',
    '7. 输出协议块的同一条消息里不要再附加任何其他文字；',
    '8. 被问「你是什么模型」等身份问题时，直接正常介绍自己并继续任务，不要展开工具机制；',
    '9. 绝不要用自然语言「宣布」要调用工具（如「我需要调用工具 X」）——要么输出协议块，要么完全不提工具。',
    '10. 电脑操作任务（打开应用、点击、输入、搜索等）必须通过工具真实执行到位：先 get_app_state 定位控件，'
      + '再 click/type_text/press_key 操作，操作后用 get_app_state 确认结果变化。只聚焦窗口或读取状态不等于完成任务；'
      + '未执行真实操作前不要回复「已完成」。',
    ...(Array.isArray(tools) && tools.toolsRestored === true
      ? ['10. 历史对话中可能出现过「没有可用的电脑控制工具 / 工具实例不存在」等表述——那已过期。'
          + '本次会话工具表（上方 JSON）就是当前真实可用的完整工具面，直接调用即可，不要复述历史中的不可用结论。']
      : []),
    '',
    '示例（用户要求「运行 whoami」时，你的完整回复应且仅应为）：',
    `${TOOL_CALL_OPEN}{"name":"shell","arguments":{"command":"whoami"}}${TOOL_CALL_CLOSE}`,
    '',
    `可用工具（JSON）：${JSON.stringify(catalog)}`,
  ].join('\n');
}

/**
 * 从任意文本里解析协议块。
 * @returns {{ calls: Array<{id,name,arguments:string}>, cleanedText: string, hadBlock: boolean }}
 *   calls[].arguments 保持字符串（OpenAI tool_calls.function.arguments 本就是字符串）；
 *   cleanedText 去掉协议块及块外的纯空白折叠；hadBlock=false 时 cleanedText===原文。
 */
export function parseToolCallBlocks(text, allowedNames) {
  if (!text || !text.includes(OPEN)) {
    return { calls: [], cleanedText: text ?? '', hadBlock: false };
  }
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames || []);
  const calls = [];
  let cleaned = '';
  let cursor = 0;
  let hadBlock = false;
  while (cursor < text.length) {
    const start = text.indexOf(OPEN, cursor);
    if (start < 0) {
      cleaned += text.slice(cursor);
      break;
    }
    cleaned += text.slice(cursor, start);
    // 闭合标记：OPEN 之后第一个 <<<END*_>>> 形态（通用正则，覆盖模型的各种写法）。
    // 在「OPEN 之后的子串」上匹配——非 global 正则的 exec 会从头搜索，
    // 多块场景下会指回前一个块导致 cursor 倒退死循环（2026-09-10 实测卡死）
    const rest = text.slice(start + OPEN.length);
    const endMatch = CLOSE_RE.exec(rest);
    const end = endMatch ? start + OPEN.length + endMatch.index : -1;
    const usedClose = endMatch ? endMatch[0] : CLOSE;
    if (end < 0) {
      // 半截块：视为普通文本透传（调用方负责缓冲到完整）
      cleaned += text.slice(start);
      break;
    }
    hadBlock = true;
    const body = text.slice(start + OPEN.length, end).trim();
    cursor = end + usedClose.length;
    try {
      const parsed = JSON.parse(body);
      const name = typeof parsed?.name === 'string' ? parsed.name : '';
      const args = parsed?.arguments;
      if (name && (allowed.size === 0 || allowed.has(name))) {
        calls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name,
          arguments: args === undefined ? '{}' : JSON.stringify(args),
        });
      }
    } catch { /* 坏 JSON：丢弃该块 */ }
  }
  return { calls, cleanedText: cleaned.trim(), hadBlock };
}

/**
 * 把 assistant 伪调用轮 + tool 结果消息序列，转成网页会话可读的文本对。
 * chat messages 里 assistant(tool_calls) 与 role:"tool" 交替出现；
 * 网页协议只有 user/assistant，因此把「调用+结果」合并成一段 assistant 叙述 + user 回执。
 *
 * @returns {{ assistantText: string, userText: string } | null} null=本条与工具无关
 */
export function renderToolLoopTurns(messages, startIndex) {
  const first = messages[startIndex];
  if (!first || first.role !== 'assistant') return null;
  const calls = Array.isArray(first.tool_calls) ? first.tool_calls : [];
  if (!calls.length) return null;

  const assistantText = (typeof first.content === 'string' && first.content.trim())
    || (Array.isArray(first.content)
      ? first.content.map((p) => (p?.type === 'text' ? p.text : '')).join('').trim()
      : '');
  const callLines = calls.map((c) => {
    let args = c.function?.arguments;
    if (typeof args !== 'string' || !args.trim()) args = '{}';
    args = args.trim();
    try { args = JSON.stringify(JSON.parse(args)); } catch { /* 原样保留 */ }
    return `- ${c.function?.name || 'unknown'}(${args})`;
  });

  const resultLines = [];
  for (let i = startIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== 'tool') break;
    const name = msg.name || msg.tool_call_id || 'tool';
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content.map((p) => (p?.type === 'text' ? p.text : '')).join('');
    }
    resultLines.push(`[工具结果] ${name}: ${text}`);
  }
  if (!resultLines.length) return null;

  const header = assistantText ? `${assistantText}\n\n` : '';
  return {
    assistantText: `${header}我需要调用工具：\n${callLines.join('\n')}`,
    userText: `工具结果：\n${resultLines.join('\n')}\n\n请基于以上结果继续完成任务。`,
  };
}

// ---------- 输出侧净化（复读循环兜底，2026-09-08 实证修复） ----------
// 伪历史确认词（V2.2 长版与 V2.4 简版）会被模型当开场白逐字复述并滚雪球成复读循环；
// 这些字符串只可能来自我方注入，精确剥离零误伤，并兜底修复被污染的旧会话。
// V2.4 确认词同时是布防用的既成事实宣告（chatgpt-web-channel 引用）。
export const BRIDGE_CONFIRMATION = '已确认：工具执行器已接入本会话，我将按协议输出工具调用块。';
const INJECTED_ECHOES = [
  '已确认：本会话接入外部工具执行器，需要执行工具操作时我将只输出协议块，由执行器真实执行并回传结果。',
  '已确认：本会话接入外部工具执行器',
  BRIDGE_CONFIRMATION,
];

export function stripInjectedEchoes(text) {
  let out = String(text ?? '');
  for (const echo of INJECTED_ECHOES) {
    if (out.includes(echo)) out = out.split(echo).join('');
  }
  return out;
}

// 退相干复读坍缩：同一 ≥32 字符的连续片段原样重复 ≥3 次（与上游采样故障、
// 协议注入循环两种实证形态吻合）→ 只保留一份。只在工具桥缓冲路径生效，纯聊天
// 直通流不受影响。均质单元（单字符重复，如 Markdown 分隔线 === / 日志行）不坍缩，
// 防止损毁合法内容；扫描窗按剩余长度收缩，避免长文本 O(n×maxUnit) 全程满扫。
const REPEAT_MIN_UNIT = 32;
const REPEAT_MAX_UNIT = 1200;
const REPEAT_MIN_TIMES = 3;

export function collapseRepetitionLoops(text) {
  const src = String(text ?? '');
  if (src.length < REPEAT_MIN_UNIT * REPEAT_MIN_TIMES) return src;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const remaining = src.length - i;
    if (remaining < REPEAT_MIN_UNIT * REPEAT_MIN_TIMES) {
      out += src.slice(i);
      break;
    }
    const headCode = src.charCodeAt(i);
    const maxUnit = Math.min(REPEAT_MAX_UNIT, Math.floor(remaining / REPEAT_MIN_TIMES));
    let collapsed = false;
    for (let unit = maxUnit; unit >= REPEAT_MIN_UNIT; unit -= 1) {
      // 快速预检：周期位移处首字符不同直接跳过（startswith 的廉价闸门）
      if (headCode !== src.charCodeAt(i + unit)) continue;
      if (src.startsWith(src.slice(i, i + unit), i + unit)) {
        const chunk = src.slice(i, i + unit);
        // 均质单元（同一字符铺满，=== 分隔线/表格线等合法排版）永不坍缩
        if (/^(.)\1+$/.test(chunk)) continue;
        let reps = 2;
        while (src.startsWith(chunk, i + reps * unit)) reps += 1;
        if (reps >= REPEAT_MIN_TIMES) {
          out += chunk;
          i += reps * unit;
          collapsed = true;
          break;
        }
      }
    }
    if (!collapsed) {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

// 工具轮回放的叙述头（renderToolLoopTurns 的 assistantText 措辞）会出现在历史里，
// 模型回答时会把它复读在正文开头（实测会连复读多段「我需要调用工具：\n- call(...)」，
// 且调用行与正文常粘连在同一行）。括号配平扫描逐个剥开头调用行（引号内的括号不
// 计深度——参数 JSON 串含 ")" 时不会提前截断），粘连正文保留；外层循环处理任意
// 多段复读；正文中间出现的叙述字样不动（合法讨论工具不受影响）。
export function stripLeadingToolNarration(text) {
  let out = String(text ?? '');
  for (;;) {
    const afterHeader = out.replace(/^\s*我需要调用工具：\n/, '');
    if (afterHeader === out) break;
    out = afterHeader;
    for (;;) {
      const m = /^- [^\n(]*\(/.exec(out);
      if (!m) break;
      let depth = 1;
      let inQuote = false;
      let i = m[0].length;
      while (i < out.length && depth > 0) {
        const ch = out[i];
        if (inQuote) {
          if (ch === '\\') i += 1; // 跳过转义字符（\" 不闭合引号）
          else if (ch === '"') inQuote = false;
        } else if (ch === '"') {
          inQuote = true;
        } else if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
        }
        i += 1;
      }
      if (depth !== 0 || inQuote) break; // 半截调用行：保守不剥
      out = out.slice(i);
      if (out.startsWith('\n')) out = out.slice(1);
    }
  }
  return out;
}

// ---------- 续轮 MCP 工具补齐（2026-09-10 电脑控制多轮断链修复） ----------
// 桌面端只在会话首轮把 MCP 工具挂进请求工具表；带工具结果回传的续轮不再携带。
// 网页模型无状态——续轮看不到工具定义，就会「宣布没有可用工具实例」并把调用当
// 正文文本写出来（实测：get_app_state 成功后拒绝继续 click/type_text）。
// 这里检测历史里的 MCP 调用，把缺失的服务器工具 schema 补进协议提示。
const MCP_TOOL_CATALOG = {
  windows_computer_use: [
    { name: 'list_apps', description: '列出当前可见的桌面应用窗口（名称/pid/标题）', parameters: { type: 'object', properties: {} } },
    {
      name: 'get_app_state',
      description: '读取目标应用的窗口状态、截图与紧凑可操作控件树（element_index/screen 坐标），操作前必须先调用',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', description: '应用名/进程名/窗口标题' }, depth: { type: 'integer' }, compact: { type: 'boolean' } },
        required: ['app'],
      },
    },
    { name: 'dump_app_targets', description: '轻量获取应用的可点击/可编辑/可滚动控件列表（不含截图）', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
    { name: 'screenshot_window', description: '对目标应用窗口截图', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
    {
      name: 'click',
      description: '点击控件（element_index 或 x/y 坐标），不移动用户真实鼠标',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          element_index: { type: 'string', description: 'get_app_state 输出的控件序号' },
          x: { type: 'number' }, y: { type: 'number' },
          coordinateSpace: { type: 'string', enum: ['auto', 'screen', 'window', 'screenshot'] },
          click_count: { type: 'integer', description: '2=双击' },
          mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] },
        },
        required: ['app'],
      },
    },
    { name: 'perform_secondary_action', description: '触发控件的次要 UI Automation 动作', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, action: { type: 'string' } }, required: ['app', 'element_index', 'action'] } },
    { name: 'scroll', description: '在控件上滚动（不移动真实鼠标）', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number' } }, required: ['app', 'element_index', 'direction'] } },
    { name: 'drag', description: '屏幕坐标拖拽（不移动真实鼠标）', parameters: { type: 'object', properties: { app: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } }, required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'] } },
    { name: 'press_key', description: '聚焦目标应用并按键/组合键（如 ctrl+l）', parameters: { type: 'object', properties: { app: { type: 'string' }, key: { type: 'string' } }, required: ['app', 'key'] } },
    { name: 'type_text', description: '聚焦目标应用并输入文本', parameters: { type: 'object', properties: { app: { type: 'string' }, text: { type: 'string' } }, required: ['app', 'text'] } },
    { name: 'set_value', description: '设置可编辑控件的值', parameters: { type: 'object', properties: { app: { type: 'string' }, element_index: { type: 'string' }, value: { type: 'string' } }, required: ['app', 'element_index', 'value'] } },
    { name: 'move_cursor', description: '移动虚拟光标到屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
    { name: 'start_computer_use', description: '开始电脑操作会话（预热桥）', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
    { name: 'windows_computer_use_status', description: '查询电脑控制桥状态', parameters: { type: 'object', properties: {} } },
    { name: 'app_instruction_catalog', description: '列出内置的应用专属操作指南', parameters: { type: 'object', properties: { app: { type: 'string' } } } },
  ],
};

// 历史里出现的全部工具调用名
function collectHistoryToolNames(messages) {
  const names = new Set();
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      const n = String(tc?.function?.name || '');
      if (n) names.add(n);
    }
  }
  return names;
}

export function mergeContinuationMcpTools(messages, tools) {
  const historyNames = collectHistoryToolNames(messages);
  const have = new Set((Array.isArray(tools) ? tools : []).map((t) => t?.function?.name).filter(Boolean));
  const merged = [...(Array.isArray(tools) ? tools : [])];
  let injected = 0;
  // 别名前缀从历史精确提取（桌面端真实分隔符不可重构）
  const aliasPrefixes = new Set();
  for (const n of historyNames) {
    for (const catalog of Object.values(MCP_TOOL_CATALOG)) {
      for (const t of catalog) {
        if (n.length > t.name.length && /mcp__/i.test(n)
          && n.toLowerCase().endsWith(t.name.toLowerCase())) {
          aliasPrefixes.add(n.slice(0, n.length - t.name.length));
        }
      }
    }
  }
  // 桌面端正典别名：responses 工具带 namespace（mcp__windows_computer_use），
  // chat 别名 = namespace + '___' + 工具名（convertResponsesTools 的 sourceName 拼接）。
  // 桌面端对 MCP 工具的挂载是间歇性的（实测首轮也时有时无）——每请求无条件注入，
  // 保证网页池模型工具面恒定，贴近原生体验。CHATGPT_WEB_MCP_INJECT=0 可关闭。
  if (process.env.CHATGPT_WEB_MCP_INJECT !== '0') {
    aliasPrefixes.add('mcp__windows_computer_use___');
  }
  for (const prefix of [...aliasPrefixes].sort((a, b) => a.length - b.length)) {
    const serverUsed = [...historyNames].some((n) => Object.values(MCP_TOOL_CATALOG)
      .some((catalog) => catalog.some((t) => prefix + t.name === n)))
      || prefix === 'mcp__windows_computer_use___'
      || process.env.CHATGPT_WEB_MCP_INJECT !== '0';
    if (!serverUsed) continue;
    for (const catalog of Object.values(MCP_TOOL_CATALOG)) {
      for (const t of catalog) {
        const name = prefix + t.name;
        if (have.has(name)) continue;
        merged.push({ type: 'function', function: { name, description: t.description, parameters: t.parameters } });
        have.add(name);
        injected += 1;
      }
    }
  }
  if (injected > 0) {
    // 标记本次发生了工具注入——协议提示会追加「历史不可用结论已过期」纠正声明，
    // 且历史里模型自己的「没有工具」拒绝文本会被上层剔除（模式惯性实测会让模型
    // 无视重新注入的工具表继续拒绝）
    merged.toolsRestored = true;
    merged.mcpInjected = injected;
  }
  return merged;
}

// 历史里模型自己的「工具不可用」拒绝文本（工具掉线时期的产物）。工具恢复后这些
// 文本是最强的模式惯性来源——模型会照着自己的历史继续拒绝。精确短语匹配。
const TOOL_REFUSAL_RE = /没有可用的电脑控制工具|没有可调用的电脑控制工具|没有挂载可调用的电脑控制工具|工具实例不存在|无法实际调用窗口点击|电脑控制工具实例/;

export function stripToolRefusalNarration(messages) {
  return (Array.isArray(messages) ? messages : []).filter((msg) => (
    !(msg?.role === 'assistant' && typeof msg?.content === 'string' && TOOL_REFUSAL_RE.test(msg.content))
  ));
}

// 工具桥可见文本统一出口：剥离旧注入回声 → 剥前置叙述复读 → 坍缩复读循环 → 去首尾空白
export function sanitizeBridgeOutput(text) {
  return collapseRepetitionLoops(
    stripLeadingToolNarration(stripInjectedEchoes(String(text ?? ''))),
  ).trim();
}
