'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { fail, ok } = require('./schema.cjs');
const { sha256 } = require('./digest.cjs');

const MEDIA_IDS = ['homeBackground', 'homeMark'];
const MEDIA_OUTPUTS = Object.freeze({
  homeBackground: Object.freeze({ path: 'assets/media/home-background.png', mime: 'image/png', maxBytes: 5 * 1024 * 1024 }),
  homeMark: Object.freeze({ path: 'assets/media/home-mark.svg', mime: 'image/svg+xml', maxBytes: 256 * 1024 }),
});
const SOURCE_KINDS = new Set(['ai-generated', 'agent-local-svg', 'user-provided', 'local-placeholder']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function unsafeSourceText(value) {
  return /[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || /(?:data|file):/i.test(value)
    || /[A-Za-z]:[\\/]/.test(value)
    || /\\\\/.test(value)
    || /^\//.test(value)
    || /[\u0000-\u001f]/.test(value)
    || /base64\s*,/i.test(value);
}

function normalizeSource(source, basePath) {
  if (!isObject(source) || !hasOnlyKeys(source, ['kind', 'provider', 'model'])) {
    return fail('MEDIA_SOURCE_INVALID', basePath, '媒体来源字段不合法');
  }
  if (typeof source.kind !== 'string' || !SOURCE_KINDS.has(source.kind)) {
    return fail('MEDIA_SOURCE_INVALID', basePath + '.kind', '媒体来源 kind 不受支持');
  }
  if (typeof source.provider !== 'string' || !source.provider.trim()) {
    return fail('MEDIA_SOURCE_INVALID', basePath + '.provider', '媒体来源 provider 必填');
  }
  const provider = source.provider.trim();
  if (unsafeSourceText(provider)) {
    return fail('MEDIA_SOURCE_INVALID', basePath + '.provider', '媒体来源 provider 不得包含路径、URL 或 base64');
  }
  if (source.kind === 'ai-generated' && provider.toLowerCase() === 'local-demo') {
    return fail('MEDIA_SOURCE_INVALID', basePath + '.provider', 'local-demo 不得声明为 ai-generated');
  }
  const normalized = { kind: source.kind, provider };
  if (source.model !== undefined) {
    if (typeof source.model !== 'string' || !source.model.trim()) {
      return fail('MEDIA_SOURCE_INVALID', basePath + '.model', '媒体来源 model 必须是非空字符串');
    }
    const model = source.model.trim();
    if (unsafeSourceText(model)) {
      return fail('MEDIA_SOURCE_INVALID', basePath + '.model', '媒体来源 model 不得包含路径、URL 或 base64');
    }
    normalized.model = model;
  }
  return { ...ok(), value: normalized };
}

function inspectPng(data, basePath) {
  if (!Buffer.isBuffer(data) || data.length < 45) {
    return fail('MEDIA_PNG_INVALID', basePath, 'PNG 文件不完整');
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!data.subarray(0, 8).equals(signature)) {
    return fail('MEDIA_PNG_INVALID', basePath, 'PNG 魔数不匹配');
  }
  let offset = 8;
  let width = null;
  let height = null;
  let sawImageData = false;
  let sawEnd = false;
  let first = true;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return fail('MEDIA_PNG_INVALID', basePath, 'PNG 数据块越界');
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (first && type !== 'IHDR') return fail('MEDIA_PNG_INVALID', basePath, 'PNG 首个数据块必须是 IHDR');
    if (type === 'IHDR') {
      if (!first || length !== 13 || width !== null) return fail('MEDIA_PNG_INVALID', basePath, 'PNG IHDR 不合法');
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || end !== data.length) return fail('MEDIA_PNG_INVALID', basePath, 'PNG IEND 不合法');
      sawEnd = true;
    }
    first = false;
    offset = end;
    if (sawEnd) break;
  }
  if (width === null || height === null || !sawImageData || !sawEnd) {
    return fail('MEDIA_PNG_INVALID', basePath, 'PNG 缺少 IHDR、IDAT 或 IEND');
  }
  return { ...ok(), width, height };
}

function cssIsSafe(value) {
  if (/@import|expression\s*\(|javascript\s*:|-moz-binding/i.test(value)) return false;
  const pattern = /url\s*\(\s*([^)]*?)\s*\)/gi;
  let match = pattern.exec(value);
  while (match) {
    const target = match[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(target)) return false;
    match = pattern.exec(value);
  }
  const withoutMatches = value.replace(pattern, '');
  return !/url\s*\(/i.test(withoutMatches);
}

function decodeEntitiesForDimension(value) {
  return value.replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCharCode(parseInt(number, 16)));
}

function numberDimension(value) {
  if (typeof value !== 'string') return null;
  const match = /^\+?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.exec(decodeEntitiesForDimension(value.trim()));
  if (!match) return null;
  const result = Number(match[0].replace(/px$/i, '').replace(/^\+/, ''));
  return Number.isFinite(result) && result > 0 && result <= 4096 ? result : null;
}

function svgDimensions(attributes) {
  const explicitWidth = numberDimension(attributes.get('width'));
  const explicitHeight = numberDimension(attributes.get('height'));
  if (explicitWidth !== null && explicitHeight !== null) {
    return { ...ok(), width: explicitWidth, height: explicitHeight };
  }
  const viewBox = attributes.get('viewbox');
  if (typeof viewBox !== 'string') return fail('MEDIA_SVG_INVALID', 'homeMark', 'SVG 缺少真实 width/height 或 viewBox');
  const values = decodeEntitiesForDimension(viewBox).trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] > 4096 || values[2] > 4096 || values[3] <= 0) {
    return fail('MEDIA_SVG_INVALID', 'homeMark.viewBox', 'SVG viewBox 尺寸不合法');
  }
  return { ...ok(), width: values[2], height: values[3] };
}

function inspectSvg(data, basePath) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
  } catch (error) {
    return fail('MEDIA_SVG_INVALID', basePath, 'SVG 必须是有效 UTF-8');
  }
  const stack = [];
  const rootAttributes = new Map();
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    const textEnd = open < 0 ? source.length : open;
    const textValue = source.slice(cursor, textEnd);
    if (stack.length === 0 && textValue.trim()) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 根元素外存在文本');
    if (stack.length && stack[stack.length - 1].local === 'style' && !cssIsSafe(textValue)) {
      return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG style 含外部或动态引用');
    }
    if (open < 0) {
      cursor = source.length;
      break;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end < 0) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 注释未闭合');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end < 0 || stack.length === 0) return fail('MEDIA_SVG_INVALID', basePath, 'SVG CDATA 不合法');
      const cdata = source.slice(open + 9, end);
      if (stack[stack.length - 1].local === 'style' && !cssIsSafe(cdata)) {
        return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG style 含外部或动态引用');
      }
      cursor = end + 3;
      continue;
    }
    if (/^<!(?:doctype|entity)\b/i.test(source.slice(open))) {
      return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止 doctype 与 entity');
    }
    if (source.startsWith('<!', open)) return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 声明不受支持');
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end < 0) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 处理指令未闭合');
      if (rootSeen || !/^<\?xml(?:\s|\?>)/i.test(source.slice(open, end + 2))) {
        return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止外部处理指令');
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('</', open)) {
      const match = /^<\/\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)\s*>/.exec(source.slice(open));
      if (!match || stack.length === 0) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 闭合标签不合法');
      const current = stack.pop();
      if (current.name !== match[1].toLowerCase()) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 标签嵌套不匹配');
      if (stack.length === 0) rootClosed = true;
      cursor = open + match[0].length;
      continue;
    }
    if (rootClosed) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 存在多个根元素');
    const nameMatch = NAME_PATTERN.exec(source.slice(open + 1));
    if (!nameMatch) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 标签名不合法');
    const name = nameMatch[0];
    const local = name.split(':').pop().toLowerCase();
    if (['script', 'foreignobject', 'image'].includes(local)) {
      return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止 script、foreignObject 与 image');
    }
    if (!rootSeen && local !== 'svg') return fail('MEDIA_SVG_INVALID', basePath, 'SVG 根元素必须是 svg');
    let index = open + 1 + name.length;
    let selfClosing = false;
    let closed = false;
    const attributes = new Map();
    const attributeNames = new Set();
    while (index < source.length) {
      while (/\s/.test(source[index])) index += 1;
      if (source.startsWith('/>', index)) {
        selfClosing = true;
        closed = true;
        index += 2;
        break;
      }
      if (source[index] === '>') {
        closed = true;
        index += 1;
        break;
      }
      const attributeMatch = NAME_PATTERN.exec(source.slice(index));
      if (!attributeMatch) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 属性名不合法');
      const attributeName = attributeMatch[0];
      const attributeKey = attributeName.toLowerCase();
      if (attributeNames.has(attributeKey)) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 属性重复');
      attributeNames.add(attributeKey);
      index += attributeName.length;
      while (/\s/.test(source[index])) index += 1;
      if (source[index] !== '=') return fail('MEDIA_SVG_INVALID', basePath, 'SVG 属性缺少等号');
      index += 1;
      while (/\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") return fail('MEDIA_SVG_INVALID', basePath, 'SVG 属性值必须加引号');
      const valueStart = index + 1;
      const valueEnd = source.indexOf(quote, valueStart);
      if (valueEnd < 0) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 属性值未闭合');
      const value = source.slice(valueStart, valueEnd);
      const attributeLocal = attributeName.split(':').pop().toLowerCase();
      const namespaceDeclaration = attributeKey === 'xmlns' || attributeKey.startsWith('xmlns:');
      if (!namespaceDeclaration && /^on/i.test(attributeLocal)) return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止事件属性');
      if (!namespaceDeclaration && attributeLocal === 'href' && !/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value.trim())) {
        return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG href 仅允许本地片段');
      }
      if (!namespaceDeclaration && attributeLocal === 'src') return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止 src 外部资源');
      if (!namespaceDeclaration && /(?:javascript\s*:|[a-z][a-z0-9+.-]*:\/\/|(?:data|file):)/i.test(value)) {
        return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 禁止外部 URL');
      }
      if (!namespaceDeclaration && !cssIsSafe(value)) return fail('MEDIA_SVG_UNSAFE', basePath, 'SVG 属性含外部或动态引用');
      attributes.set(attributeKey, value);
      index = valueEnd + 1;
    }
    if (!closed) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 标签未闭合');
    if (!rootSeen) {
      rootSeen = true;
      attributes.forEach((value, key) => rootAttributes.set(key, value));
    }
    if (!selfClosing) stack.push({ name: name.toLowerCase(), local });
    else if (stack.length === 0) rootClosed = true;
    cursor = index;
  }
  if (!rootSeen || stack.length !== 0 || !rootClosed) return fail('MEDIA_SVG_INVALID', basePath, 'SVG 根元素未完整闭合');
  const dimensions = svgDimensions(rootAttributes);
  if (!dimensions.ok) return { ...dimensions, path: basePath };
  return dimensions;
}

function validateEntry(id, entry) {
  const basePath = id;
  if (!isObject(entry) || !hasOnlyKeys(entry, ['file', 'mime', 'sha256', 'width', 'height', 'source', 'data'])) {
    return fail('MEDIA_MANIFEST_INVALID', basePath, '媒体项字段不合法');
  }
  if (!Buffer.isBuffer(entry.data)) return fail('MEDIA_FILE_REQUIRED', basePath + '.data', '媒体内容必须以 Buffer 提供');
  const output = MEDIA_OUTPUTS[id];
  if (entry.mime !== output.mime) return fail('MEDIA_MIME_INVALID', basePath + '.mime', id + ' 的 MIME 必须为 ' + output.mime);
  if (dataLength(entry.data) < 1 || dataLength(entry.data) > output.maxBytes) {
    return fail('MEDIA_SIZE_INVALID', basePath, id + ' 文件大小超出限制');
  }
  const inspected = id === 'homeBackground' ? inspectPng(entry.data, basePath) : inspectSvg(entry.data, basePath);
  if (!inspected.ok) return inspected;
  if (id === 'homeBackground' && (inspected.width < 16 || inspected.height < 16 || inspected.width > 4096 || inspected.height > 4096)) {
    return fail('MEDIA_DIMENSION_INVALID', basePath, 'homeBackground 实际尺寸必须在 16–4096 之间');
  }
  if (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width !== inspected.width || entry.height !== inspected.height) {
    return fail('MEDIA_DIMENSION_MISMATCH', basePath, '声明尺寸与媒体实际尺寸不一致', { actual: { width: inspected.width, height: inspected.height } });
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
    return fail('MEDIA_HASH_INVALID', basePath + '.sha256', 'sha256 必须为 sha256:<64hex>');
  }
  if (sha256(entry.data) !== entry.sha256) return fail('MEDIA_HASH_MISMATCH', basePath + '.sha256', '声明摘要与媒体字节不一致');
  const source = normalizeSource(entry.source, basePath + '.source');
  if (!source.ok) return source;
  return {
    ...ok(),
    value: {
      mime: entry.mime,
      sha256: entry.sha256,
      width: entry.width,
      height: entry.height,
      source: source.value,
      data: entry.data,
    },
  };
}

function dataLength(data) {
  return data.length;
}

function validateMedia(media) {
  if (!isObject(media) || !hasOnlyKeys(media, MEDIA_IDS)) {
    return fail('MEDIA_MANIFEST_INVALID', 'media', '媒体清单只能包含 homeBackground 与 homeMark');
  }
  const present = MEDIA_IDS.filter((id) => Object.prototype.hasOwnProperty.call(media, id));
  if (present.length === 0) return fail('MEDIA_MANIFEST_EMPTY', 'media', '媒体清单至少需要一项');
  const normalized = {};
  for (const id of present) {
    const result = validateEntry(id, media[id]);
    if (!result.ok) return result;
    normalized[id] = result.value;
  }
  return { ...ok(), media: normalized };
}

function containedPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function readMediaFile(root, file, id) {
  if (typeof file !== 'string' || !file.trim() || /[\u0000-\u001f]/.test(file)) {
    return fail('MEDIA_PATH_INVALID', id + '.file', '媒体 file 必须是安全的相对路径');
  }
  if (path.isAbsolute(file) || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || /^[a-z][a-z0-9+.-]*:/i.test(file) || /^[\\/]{2}/.test(file)) {
    return fail('MEDIA_PATH_INVALID', id + '.file', '媒体 file 禁止绝对路径与 URL');
  }
  const target = path.resolve(root, file);
  if (!containedPath(root, target)) return fail('MEDIA_PATH_INVALID', id + '.file', '媒体 file 不得逃出清单目录');
  let realTarget;
  let stat;
  try {
    realTarget = fs.realpathSync(target);
    if (!containedPath(root, realTarget)) return fail('MEDIA_PATH_INVALID', id + '.file', '媒体符号链接不得逃出清单目录');
    stat = fs.statSync(realTarget);
    if (!stat.isFile()) return fail('MEDIA_PATH_INVALID', id + '.file', '媒体 file 必须指向普通文件');
    if (stat.size < 1 || stat.size > MEDIA_OUTPUTS[id].maxBytes) return fail('MEDIA_SIZE_INVALID', id + '.file', '媒体文件大小超出限制');
    return { ...ok(), data: fs.readFileSync(realTarget) };
  } catch (error) {
    if (error && error.ok === false) return error;
    return fail('MEDIA_FILE_READ_FAILED', id + '.file', '媒体文件读取失败：' + error.message);
  }
}

function loadMedia(manifestFile) {
  let document;
  let root;
  try {
    const resolved = path.resolve(manifestFile);
    document = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    root = fs.realpathSync(path.dirname(resolved));
  } catch (error) {
    return fail('MEDIA_MANIFEST_READ_FAILED', 'media', 'media.json 读取失败：' + error.message);
  }
  if (!isObject(document) || !hasOnlyKeys(document, MEDIA_IDS)) {
    return fail('MEDIA_MANIFEST_INVALID', 'media', 'media.json 只能包含 homeBackground 与 homeMark');
  }
  const withData = {};
  for (const id of MEDIA_IDS) {
    if (!Object.prototype.hasOwnProperty.call(document, id)) continue;
    const entry = document[id];
    if (!isObject(entry)) return fail('MEDIA_MANIFEST_INVALID', id, '媒体项必须是对象');
    const loaded = readMediaFile(root, entry.file, id);
    if (!loaded.ok) return loaded;
    withData[id] = { ...entry, data: loaded.data };
  }
  return validateMedia(withData);
}

function buildMediaManifest(media) {
  return {
    schemaVersion: 'media.v1',
    items: MEDIA_IDS.filter((id) => media[id]).map((id) => ({
      id,
      path: MEDIA_OUTPUTS[id].path,
      mime: media[id].mime,
      bytes: media[id].data.length,
      sha256: media[id].sha256,
      width: media[id].width,
      height: media[id].height,
      source: { ...media[id].source },
    })),
  };
}

module.exports = {
  MEDIA_IDS,
  MEDIA_OUTPUTS,
  SOURCE_KINDS,
  loadMedia,
  readMediaFile,
  validateMedia,
  inspectPng,
  inspectSvg,
  buildMediaManifest,
};