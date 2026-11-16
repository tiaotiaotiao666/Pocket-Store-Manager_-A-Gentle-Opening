/**
 * 对话消息的 Markdown 白名单渲染（W4）。
 *
 * 约束：
 * 1. 输出是纯数据 AST，由 `MarkdownView.jsx` 映射成 React 元素；
 *    **全程不使用 dangerouslySetInnerHTML**，因此原始 HTML 永远只是文本。
 * 2. 支持：标题、粗体、斜体、列表、引用、行内代码、代码块、普通链接。
 * 3. 链接只允许 http/https；javascript:/data:/file:/vbscript: 等一律降级成普通文本，
 *    点击交给桌面端受控通道（`window.smartStore.openExternalLink`），页面自己不做导航。
 */

export const ALLOWED_LINK_PROTOCOLS = Object.freeze(['http:', 'https:']);
export const MAX_MARKDOWN_CHARS = 20000;
export const MAX_LINK_CHARS = 2048;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '-', '>', '+', '!']);
// 协议伪装常用字符：控制字符、各类空白与零宽字符。
const PROTOCOL_NOISE = /[\u0000-\u0020\u007f\u200b-\u200f\u2028\u2029\ufeff]+/g;

/** 只接受绝对 http/https URL；解析不出或含账号密码的一律返回 null。 */
export function sanitizeExternalUrl(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_LINK_CHARS) return null;
  const cleaned = raw.replace(PROTOCOL_NOISE, '');
  if (!cleaned) return null;
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (error) {
    return null;
  }
  if (!ALLOWED_LINK_PROTOCOLS.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // http://user:pass@host 这类伪装直接拒绝，避免把凭据部分展示给用户。
  if (parsed.username || parsed.password) return null;
  if (parsed.href.length > MAX_LINK_CHARS) return null;
  return parsed.href;
}

/**
 * 点击链接时的动作判定（纯函数，便于行为测试）。
 * `openExternal` 由调用方注入桌面桥；没有桥就什么都不做——绝不退回 window.open。
 */
export function resolveLinkAction(rawUrl, options = {}) {
  const url = sanitizeExternalUrl(rawUrl);
  if (!url) return { kind: 'blocked', url: null, reason: 'UNSAFE_URL' };
  if (typeof options.openExternal !== 'function') {
    return { kind: 'blocked', url, reason: 'NO_DESKTOP_BRIDGE' };
  }
  return { kind: 'external', url, reason: null };
}

/** 模型输出里偶尔混进来的堆栈/密钥，渲染前先抹掉，不当正文展示。 */
export function stripInternalNoise(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '［已隐去密钥］')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '［已隐去密钥］')
    // Node/JS 堆栈行：at fn (/a/b.js:12:34)
    .replace(/^[ \t]*at\s+[^\n]*\([^()\n]*:\d+:\d+\)[ \t]*$/gm, '')
    // 纯位置行：at /a/b.js:12:34
    .replace(/^[ \t]*at\s+[^\n]*:\d+:\d+[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function mergeText(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'text' && node.text === '') continue;
    const last = out[out.length - 1];
    if (node.type === 'text' && last && last.type === 'text') {
      last.text += node.text;
      continue;
    }
    out.push(node);
  }
  return out;
}

function makeLinkNode(label, rawUrl) {
  const url = sanitizeExternalUrl(rawUrl);
  if (!url) {
    // 不安全协议：原样当文本，既不可点也不隐藏（避免用户以为链接生效）。
    return { type: 'text', text: `[${label}](${rawUrl})` };
  }
  return { type: 'link', href: url, children: parseInline(label) };
}

export function parseInline(source) {
  const src = String(source ?? '');
  const nodes = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        nodes.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i + 1 && src[close + 1] === '(') {
        const parenEnd = src.indexOf(')', close + 2);
        if (parenEnd > close + 2) {
          const label = src.slice(i + 1, close);
          const rawUrl = src.slice(close + 2, parenEnd);
          flush();
          nodes.push(makeLinkNode(label, rawUrl));
          i = parenEnd + 1;
          continue;
        }
      }
    }

    if (ch === '*' || ch === '_') {
      const doubled = src[i + 1] === ch;
      const marker = doubled ? ch + ch : ch;
      const end = src.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        flush();
        const inner = src.slice(i + marker.length, end);
        nodes.push({ type: doubled ? 'strong' : 'em', children: parseInline(inner) });
        i = end + marker.length;
        continue;
      }
    }

    if (ch === '\n') {
      flush();
      nodes.push({ type: 'br' });
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return mergeText(nodes);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/**
 * 解析成块级 AST。
 * @returns {{blocks: Array<object>}}
 */
export function parseMarkdown(input) {
  const text = stripInternalNoise(String(input ?? '').slice(0, MAX_MARKDOWN_CHARS)).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过收尾围栏
      blocks.push({ type: 'codeBlock', lang, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
      continue;
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items = [];
      while (i < lines.length) {
        const match = ordered ? ORDERED.exec(lines[i]) : UNORDERED.exec(lines[i]);
        if (!match) break;
        items.push({
          children: parseInline(ordered ? match[2] : match[1]),
        });
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !QUOTE.test(lines[i])
      && !UNORDERED.test(lines[i]) && !ORDERED.test(lines[i]) && !FENCE.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (!paragraph.length) {
      // 兜底：避免某一行同时匹配不上任何规则时死循环。
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return { blocks };
}

/** 把 AST 展平成纯文本（用于无障碍标签/测试断言，不改变渲染）。 */
export function toPlainText(blocks) {
  const join = (nodes) => nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text;
    if (node.type === 'br') return '\n';
    if (Array.isArray(node.children)) return join(node.children);
    return '';
  }).join('');
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block.type === 'codeBlock') return block.text;
    if (block.type === 'list') return block.items.map((item) => join(item.children)).join('\n');
    return join(block.children ?? []);
  }).join('\n');
}
