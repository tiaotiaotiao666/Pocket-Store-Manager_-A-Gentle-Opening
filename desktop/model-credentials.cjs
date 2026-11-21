'use strict';

/**
 * 模型 API 凭证（Electron 主进程）。
 *
 * 设计边界（与仓库既有约束一致）：
 * - API Key 只存在主进程：渲染进程只能拿到「是否已配置」和更新时间，永远拿不到明文；
 * - 落盘前必须经 Electron safeStorage 加密；加密不可用时**拒绝保存**，绝不退化成明文；
 * - 日志、错误体、诊断快照里不出现 Key，也不回显上游返回的请求头；
 * - 只支持 DeepSeek 官方 API（OpenAI 兼容的 /chat/completions），不接受任意协议。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_FILE = 'model-key.bin';
const KEY_MIN_LENGTH = 16;
const KEY_MAX_LENGTH = 200;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,199}$/;
const BASE_URL_MAX_LENGTH = 200;
const MAX_MESSAGES = 40;
// 工具结果由 app-assistant 截到 20000 字符，这里必须不小于它，否则会产生只在本机失败的死角。
const MAX_MESSAGE_CHARS = 24000;
const MAX_TEXT_PART_CHARS = 16000;
// 3 张 400 KiB 图片转 base64 约 1.6 MiB；官方请求体上限 48 MiB，这里收敛到 8 MiB。
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PARTS = 3;
const MAX_IMAGE_BYTES_PER_IMAGE = 409600;
const MAX_IMAGE_BYTES_TOTAL = 1048576;
const MAX_TOOLS = 8;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;
/** DeepSeek 官方模型名：DeepSeek-V4.1-Flash-1017，支持图像理解与 Tool Calls。 */
const DEFAULT_MODEL = 'deepseek-flash';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** 只接受内联 JPEG/PNG/WebP，拒绝外部 URL 与任意协议。 */
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

class ModelCredentialError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ModelCredentialError';
    this.code = code;
    this.details = details || null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 规范化 API 地址：只允许干净的 http(s) 基址，不带账号、查询串或片段。 */
function normalizeBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, url: 'https://api.deepseek.com' };
  if (text.length > BASE_URL_MAX_LENGTH) {
    return { ok: false, code: 'MODEL_BASE_URL_INVALID', message: 'API 地址太长了，请填写不超过 200 个字符的地址。' };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    return { ok: false, code: 'MODEL_BASE_URL_INVALID', message: 'API 地址格式不正确，例如 https://api.deepseek.com 。' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, code: 'MODEL_BASE_URL_INVALID', message: 'API 地址必须以 http:// 或 https:// 开头。' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'MODEL_BASE_URL_INVALID', message: 'API 地址里不能带账号密码。' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, code: 'MODEL_BASE_URL_INVALID', message: 'API 地址里不要带查询参数。' };
  }
  const trimmed = text.replace(/\/+$/, '');
  return { ok: true, url: trimmed };
}

/** DeepSeek 的对话端点是 `${base}/chat/completions`；用户已填全路径时不重复拼接。 */
function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function normalizeModel(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(text)) {
    throw new ModelCredentialError('MODEL_NAME_INVALID', '模型名称只能用字母、数字、点、横线、冒号或下划线。');
  }
  return text;
}

function normalizeTimeout(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return value;
}

/** 纯算术估算 base64 解码后的字节数；调用前应先通过格式校验。 */
function estimateBase64Bytes(data) {
  if (typeof data !== 'string' || data.length === 0) return 0;
  let padding = 0;
  if (data[data.length - 1] === '=') padding += 1;
  if (data.length > 1 && data[data.length - 2] === '=') padding += 1;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * 消息内容：纯文本，或 OpenAI 多模态内容块数组（`text` + `image_url`）。
 *
 * 边界（与 DeepSeek 官方「图像理解」文档一致）：
 * - 只有 user / system 可以携带图片，assistant 带图会被上游判 400；
 * - tool 结果必须是字符串；
 * - 图片只接受内联 data URL（JPEG/PNG/WebP），不接受外部链接与其它协议；
 * - 单张 ≤ 400 KiB、合计 ≤ 1 MiB、最多 3 张，与 `AGENT_IMAGE_LIMITS` 对齐。
 */
function normalizeMessageContent(content, role) {
  if (typeof content === 'string') {
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '单条对话内容过长。');
    }
    return content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '对话内容格式不正确。');
  }
  if (role !== 'user' && role !== 'system') {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '只有用户或系统消息可以携带图片。');
  }

  let imageCount = 0;
  let imageBytesTotal = 0;
  return content.map((part) => {
    if (!isPlainObject(part)) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '图片内容块格式不正确。');
    }
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (!text || text.length > MAX_TEXT_PART_CHARS) {
        throw new ModelCredentialError('MODEL_REQUEST_INVALID', '文本内容块为空或过长。');
      }
      return { type: 'text', text };
    }
    if (part.type !== 'image_url') {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '只支持 text / image_url 两种内容块。');
    }

    const imageUrl = isPlainObject(part.image_url) ? part.image_url : null;
    const url = imageUrl && typeof imageUrl.url === 'string' ? imageUrl.url : '';
    if (!IMAGE_DATA_URL_PATTERN.test(url)) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '图片只接受内联 JPEG/PNG/WebP 的 data URL。');
    }
    const base64 = url.slice(url.indexOf(',') + 1);
    const bytes = estimateBase64Bytes(base64);
    imageCount += 1;
    imageBytesTotal += bytes;
    if (imageCount > MAX_IMAGE_PARTS) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', `最多 ${MAX_IMAGE_PARTS} 张图片。`);
    }
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES_PER_IMAGE) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '单张图片超过 400 KiB 或内容为空。');
    }
    if (imageBytesTotal > MAX_IMAGE_BYTES_TOTAL) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '图片合计超过 1 MiB。');
    }

    const normalizedUrl = { url };
    if (['low', 'high', 'original', 'auto'].includes(imageUrl.detail)) {
      normalizedUrl.detail = imageUrl.detail;
    }
    return { type: 'image_url', image_url: normalizedUrl };
  });
}

/**
 * 思考模式开关：默认关闭。
 *
 * `enabled` 被拒绝是刻意的：官方要求携带 tools 的请求在后续轮次完整回传
 * `reasoning_content`，而本通道只保存 `content` 与 `tool_calls`，开启后必然 400。
 */
function normalizeThinking(raw) {
  if (raw === null) return null;
  if (raw === undefined) return { type: 'disabled' };
  if (!isPlainObject(raw)) {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', 'thinking 字段格式不正确。');
  }
  if (raw.type === 'disabled') return { type: 'disabled' };
  if (raw.type === 'enabled') {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '这条通道暂不支持思考模式。');
  }
  throw new ModelCredentialError('MODEL_REQUEST_INVALID', 'thinking.type 只能是 enabled / disabled。');
}

/** 只接受 DeepSeek/OpenAI 兼容的 messages + tools 形状，拒绝任意 JSON 透传。 */
function normalizeChatPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '请求格式不正确。');
  }
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  if (rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '对话内容为空或过长。');
  }
  const messages = rawMessages.map((message) => {
    if (!isPlainObject(message)) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '对话内容格式不正确。');
    }
    const role = message.role;
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '对话角色不受支持。');
    }
    const content = normalizeMessageContent(message.content, role);
    const normalized = { role, content };
    if (role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!toolCallId) throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具结果缺少调用标识。');
      normalized.tool_call_id = toolCallId;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      normalized.tool_calls = message.tool_calls.slice(0, MAX_TOOLS).map((call) => ({
        id: String(call && call.id ? call.id : ''),
        type: 'function',
        function: {
          name: String(call && call.function && call.function.name ? call.function.name : ''),
          arguments: typeof (call && call.function && call.function.arguments) === 'string'
            ? call.function.arguments
            : JSON.stringify((call && call.function && call.function.arguments) || {}),
        },
      }));
    }
    return normalized;
  });

  let tools;
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    if (payload.tools.length > MAX_TOOLS) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具数量超过上限。');
    }
    tools = payload.tools.map((tool) => {
      if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
        throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具定义格式不正确。');
      }
      const name = typeof tool.function.name === 'string' ? tool.function.name : '';
      if (!MODEL_PATTERN.test(name)) {
        throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具名称不合法。');
      }
      return {
        type: 'function',
        function: {
          name,
          description: typeof tool.function.description === 'string' ? tool.function.description.slice(0, 500) : '',
          parameters: isPlainObject(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
        },
      };
    });
  }

  const maxTokensRaw = Number(payload.maxTokens);
  const maxTokens = Number.isInteger(maxTokensRaw) && maxTokensRaw >= 1 && maxTokensRaw <= 4096
    ? maxTokensRaw
    : 1200;
  const temperatureRaw = Number(payload.temperature);
  const temperature = Number.isFinite(temperatureRaw) && temperatureRaw >= 0 && temperatureRaw <= 2
    ? temperatureRaw
    : 0.2;

  const body = {
    model: normalizeModel(payload.model),
    messages,
    stream: false,
    max_tokens: maxTokens,
    temperature,
  };
  // DeepSeek 思考模式默认开启，且带 tools 时必须回传 reasoning_content（否则 400）。
  // 本通道没有回传思维链，所以默认显式关闭；传 null 表示完全不发这个字段（兼容第三方网关）。
  const thinking = normalizeThinking(payload.thinking);
  if (thinking) body.thinking = thinking;
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return { body, timeoutMs: normalizeTimeout(payload.timeoutMs), baseUrl: normalizeBaseUrl(payload.baseUrl) };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'DEEPSEEK_AUTH_FAILED';
  if (status === 402 || status === 429) return 'DEEPSEEK_RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) return 'DEEPSEEK_REQUEST_REJECTED';
  if (status >= 500) return 'DEEPSEEK_UPSTREAM_ERROR';
  return 'DEEPSEEK_UPSTREAM_ERROR';
}

function messageForCode(code) {
  switch (code) {
    case 'DEEPSEEK_AUTH_FAILED':
      return 'API Key 无效或已过期，请在设置里重新填写。';
    case 'DEEPSEEK_RATE_LIMITED':
      return '模型服务繁忙或额度不足，请稍后重试。';
    case 'DEEPSEEK_REQUEST_REJECTED':
      return '模型服务拒绝了这次请求，请检查模型名称与 API 地址。';
    case 'DEEPSEEK_TIMEOUT':
      return '模型响应超时，请重试或换用更短的描述。';
    case 'DEEPSEEK_UNREACHABLE':
      return '连不上模型服务，请检查网络与 API 地址。';
    case 'DEEPSEEK_RESPONSE_INVALID':
      return '模型返回内容无法解析，请重试。';
    case 'DEEPSEEK_NOT_CONFIGURED':
      return '还没有填写 API Key，请先在「模型与 API」里保存密钥。';
    default:
      return '模型服务暂时不可用，请稍后重试。';
  }
}

function createModelCredentials(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || !opts.userDataDir) {
    throw new Error('createModelCredentials 需要 userDataDir');
  }
  const userDataDir = path.resolve(opts.userDataDir);
  const keyPath = path.join(userDataDir, KEY_FILE);
  const safeStorage = opts.safeStorage || null;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  function assertEncryptionAvailable() {
    if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
      throw new ModelCredentialError('MODEL_KEY_UNAVAILABLE', '这台电脑的加密能力不可用，无法安全保存 API Key。');
    }
    if (typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable() !== true) {
      throw new ModelCredentialError('MODEL_KEY_UNAVAILABLE', '这台电脑的加密能力不可用，无法安全保存 API Key。');
    }
  }

  async function readKey() {
    let buffer;
    try {
      buffer = await fsp.readFile(keyPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ModelCredentialError('MODEL_KEY_UNREADABLE', '保存好的 API Key 读不出来，请重新填写一次。');
    }
    try {
      assertEncryptionAvailable();
      const text = safeStorage.decryptString(buffer);
      return typeof text === 'string' && text ? text : null;
    } catch (error) {
      throw new ModelCredentialError('MODEL_KEY_UNREADABLE', '保存好的 API Key 读不出来，请重新填写一次。');
    }
  }

  async function status() {
    let stat = null;
    try {
      stat = await fsp.stat(keyPath);
    } catch (error) {
      stat = null;
    }
    if (!stat) return { configured: false, updatedAt: null };
    let readable = true;
    try {
      await readKey();
    } catch (error) {
      readable = false;
    }
    return {
      configured: readable,
      updatedAt: stat.mtime instanceof Date ? stat.mtime.toISOString() : null,
    };
  }

  async function setKey(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length < KEY_MIN_LENGTH || text.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(text)) {
      throw new ModelCredentialError('MODEL_KEY_INVALID', 'API Key 格式不正确，请粘贴完整的 Key。');
    }
    assertEncryptionAvailable();
    const encrypted = safeStorage.encryptString(text);
    const tempPath = `${keyPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.writeFile(tempPath, encrypted, { mode: 0o600 });
      await fsp.rename(tempPath, keyPath);
    } catch (error) {
      try {
        await fsp.unlink(tempPath);
      } catch (cleanupError) {
        /* 清理失败不影响返回 */
      }
      throw new ModelCredentialError('MODEL_KEY_WRITE_FAILED', 'API Key 保存失败，请检查磁盘空间或权限。');
    }
    return { configured: true, updatedAt: now().toISOString() };
  }

  async function clearKey() {
    try {
      await fsp.unlink(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new ModelCredentialError('MODEL_KEY_WRITE_FAILED', 'API Key 清除失败，请稍后重试。');
      }
    }
    return { configured: false, updatedAt: null };
  }

  async function requestChat(rawPayload) {
    const normalized = normalizeChatPayload(rawPayload);
    if (!normalized.baseUrl.ok) {
      throw new ModelCredentialError(normalized.baseUrl.code, normalized.baseUrl.message);
    }
    const apiKey = await readKey();
    if (!apiKey) {
      throw new ModelCredentialError('DEEPSEEK_NOT_CONFIGURED', messageForCode('DEEPSEEK_NOT_CONFIGURED'));
    }
    if (typeof fetchImpl !== 'function') {
      throw new ModelCredentialError('DEEPSEEK_UNREACHABLE', messageForCode('DEEPSEEK_UNREACHABLE'));
    }

    const bodyText = JSON.stringify(normalized.body);
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '这次请求内容过大，请减少描述或图片。');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, normalized.timeoutMs);

    let response;
    try {
      response = await fetchImpl(chatCompletionsUrl(normalized.baseUrl.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: bodyText,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ModelCredentialError('DEEPSEEK_TIMEOUT', messageForCode('DEEPSEEK_TIMEOUT'));
      }
      throw new ModelCredentialError('DEEPSEEK_UNREACHABLE', messageForCode('DEEPSEEK_UNREACHABLE'));
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const code = classifyHttpStatus(Number(response.status));
      throw new ModelCredentialError(code, messageForCode(code));
    }
    if (!isPlainObject(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      throw new ModelCredentialError('DEEPSEEK_RESPONSE_INVALID', messageForCode('DEEPSEEK_RESPONSE_INVALID'));
    }
    const choice = payload.choices[0];
    const message = isPlainObject(choice && choice.message) ? choice.message : {};
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return {
      model: typeof payload.model === 'string' ? payload.model : normalized.body.model,
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: rawToolCalls.slice(0, MAX_TOOLS).map((call) => ({
        id: typeof call?.id === 'string' ? call.id : '',
        name: typeof call?.function?.name === 'string' ? call.function.name : '',
        arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}',
      })),
      usage: isPlainObject(payload.usage) ? {
        promptTokens: Number.isInteger(payload.usage.prompt_tokens) ? payload.usage.prompt_tokens : null,
        completionTokens: Number.isInteger(payload.usage.completion_tokens) ? payload.usage.completion_tokens : null,
      } : null,
    };
  }

  /** 设置页「测试连接」：只发一句最小请求，验证地址、模型与 Key 是否可用。 */
  async function test(rawPayload) {
    const source = isPlainObject(rawPayload) ? rawPayload : {};
    const startedAt = Date.now();
    try {
      const result = await requestChat({
        baseUrl: source.baseUrl,
        model: source.model,
        timeoutMs: 20000,
        maxTokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return {
        ok: true,
        model: result.model,
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      const code = error instanceof ModelCredentialError ? error.code : 'DEEPSEEK_UPSTREAM_ERROR';
      return {
        ok: false,
        code,
        message: error instanceof ModelCredentialError ? error.message : messageForCode('DEEPSEEK_UPSTREAM_ERROR'),
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  return {
    status,
    setKey,
    clearKey,
    chat: requestChat,
    test,
    keyPath,
  };
}

module.exports = {
  createModelCredentials,
  ModelCredentialError,
  normalizeBaseUrl,
  normalizeChatPayload,
  chatCompletionsUrl,
  messageForCode,
  KEY_FILE,
};
