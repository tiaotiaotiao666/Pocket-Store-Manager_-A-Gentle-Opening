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
const {
  createModelCallScheduler,
  ModelSchedulerError,
} = require('./model-call-scheduler.cjs');

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

/**
 * 工具数上限的**唯一来源**：rev15 §14.3 的模型可见工具清单。
 *
 * 清单的唯一出处是 `agent-workspace/run-coordinator.cjs` 的 `MODEL_TOOL_NAMES`，
 * 由 `agent-runtime/constants.cjs` 转出（那边已经声明“本模块不复制第二份名单”）。
 * 这里既不写死数字（旧的 `MAX_TOOLS = 8` 与 §14.3 的 11 个工具冲突，会在发图之前
 * 直接把真实 direct 回合拒掉），也不再留第二份工具名常量。
 *
 * 超限拒绝能力保留：`payload.tools.length > maxToolCount()` 仍然报
 * `MODEL_REQUEST_INVALID`「工具数量超过上限」。
 *
 * 惰性 require 是必须的：`agent-runtime/constants.cjs` 反过来 require 本模块
 * （maxTokens 单一出口），放在加载期 require 会成环。
 */
function maxToolCount() {
  const { MODEL_TOOL_NAMES } = require('./agent-runtime/constants.cjs');
  const count = Array.isArray(MODEL_TOOL_NAMES) ? MODEL_TOOL_NAMES.length : 0;
  if (count <= 0) {
    // 清单不可用属于构建/接线错误：明确报错，绝不退化成“无上限”。
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '模型工具清单不可用，已拒绝发送工具定义。');
  }
  return count;
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
      normalized.tool_calls = message.tool_calls.slice(0, maxToolCount()).map((call) => ({
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
    if (payload.tools.length > maxToolCount()) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具数量超过上限（最多 '
        + maxToolCount() + ' 个，等于 §14.3 的模型工具清单长度）。');
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

  // X8（rev15 §14.7）：`maxTokens` 非法时**不再**静默回退 1200；超出上限明确报错。
  const tokenBudget = resolveMaxTokens(payload);
  if (!tokenBudget.ok) {
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', tokenBudget.message);
  }
  const maxTokens = tokenBudget.maxTokens;
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
  return {
    body,
    timeoutMs: normalizeTimeout(payload.timeoutMs),
    baseUrl: normalizeBaseUrl(payload.baseUrl),
    profile: tokenBudget.profile,
    maxTokensRaised: tokenBudget.raised,
  };
}

/**
 * §14.7 预算口径（唯一来源；`desktop/agent-runtime` 只转出口这两个数字）：
 * - direct 源码编辑：默认 **6000**、硬上限 **8000**；显式给更小的值会被抬到 6000（不是静默裁剪，
 *   结果里带 `maxTokensRaised`），**任何路径都不会退回 1200**。
 * - 通用对话（设置页测试/问答）：默认 1200、上限 4096（原有行为），非法值改为明确报错。
 */
const DIRECT_EDIT_MAX_TOKENS = Object.freeze({ default: 6000, max: 8000 });
const CHAT_MAX_TOKENS = Object.freeze({ default: 1200, max: 4096 });

/**
 * 解析本次请求的 max_tokens。
 * 返回 `{ ok:true, maxTokens, profile, raised }` 或 `{ ok:false, message }`（调用方抛 MODEL_REQUEST_INVALID）。
 */
function resolveMaxTokens(payload) {
  const source = isPlainObject(payload) ? payload : {};
  const directEdit = source.profile === 'direct-edit';
  const profile = directEdit ? 'direct-edit' : 'chat';
  const budget = directEdit ? DIRECT_EDIT_MAX_TOKENS : CHAT_MAX_TOKENS;

  if (source.maxTokens === undefined || source.maxTokens === null) {
    return { ok: true, maxTokens: budget.default, profile, raised: false };
  }
  const raw = Number(source.maxTokens);
  if (!Number.isInteger(raw) || raw < 1) {
    return { ok: false, message: 'maxTokens 必须是正整数（不接受 0、负数或小数）。' };
  }
  if (raw > budget.max) {
    return {
      ok: false,
      message: directEdit
        ? 'maxTokens 超过源码编辑上限 8000，请调小后再试。'
        : 'maxTokens 超过上限 4096，请调小后再试。',
    };
  }
  if (directEdit && raw < budget.default) {
    // 源码编辑低于 6000 必然截断（D-RT-1），这里抬到默认值并标记，绝不静默降到 1200。
    return { ok: true, maxTokens: budget.default, profile, raised: true };
  }
  return { ok: true, maxTokens: raw, profile, raised: false };
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
    // 调度器族（rev15 §14.6）：排队超时不是上游超时、也不是 429。
    case 'MODEL_QUEUE_TIMEOUT':
      return '模型请求排队太久（同一时间最多 3 次），请稍后重试。';
    case 'MODEL_BUSY':
      return '模型请求通道繁忙，请稍后重试。';
    case 'MODEL_ABORTED':
      return '模型请求已取消。';
    case 'MODEL_CONFIG_INVALID':
      return '模型并发配置不合法，请检查设置。';
    default:
      return '模型服务暂时不可用，请稍后重试。';
  }
}

/** 外部取消信号（用户取消 / 项目切换 / run abort）只接受 AbortSignal 形状，其它一律忽略。 */
function isAbortSignalLike(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function';
}

function resolveCallSignal(callOptions, rawPayload) {
  if (isPlainObject(callOptions) && isAbortSignalLike(callOptions.signal)) return callOptions.signal;
  if (isPlainObject(rawPayload) && isAbortSignalLike(rawPayload.signal)) return rawPayload.signal;
  return null;
}

/** 调度器错误 → 同一套 ModelCredentialError，IPC 层不需要认第二种错误类型。 */
function toCredentialError(error) {
  if (error instanceof ModelCredentialError) return error;
  if (error instanceof ModelSchedulerError || (error && typeof error.code === 'string' && error.code.startsWith('MODEL_'))) {
    const code = error.code;
    return new ModelCredentialError(code, messageForCode(code), isPlainObject(error.details) ? error.details : null);
  }
  return new ModelCredentialError('DEEPSEEK_UPSTREAM_ERROR', messageForCode('DEEPSEEK_UPSTREAM_ERROR'));
}

/**
 * 模块级单例：`settings:model:test`、`settings:model:chat`、direct workspace 调用共享同一套
 * 「进程内 3 槽 + 跨进程全局令牌」调度器。
 *
 * 环境变量（冻结主名，`AGENT_MAX_CONCURRENT` **不读**——那是 Agent HTTP 入口门槛）：
 * - `MODEL_MAX_CONCURRENT`（1–3，>3/非法 → clamp 到 3 + 可见警告）
 * - `MODEL_QUEUE_WAIT_MS`（30s–600s；`MODEL_QUEUE_TIMEOUT_MS` 仅兼容别名）
 * - `MODEL_UPSTREAM_TOKEN_DIR`（跨进程令牌目录，默认 `<系统临时目录>/smart-store-model-slots`）
 *
 * 首次创建后不再读环境变量，避免运行期"看起来改大了其实变大了"的不确定行为。
 */
let sharedScheduler = null;

function getSharedModelCallScheduler(options) {
  if (!sharedScheduler) {
    const opts = isPlainObject(options) ? options : {};
    const env = isPlainObject(opts.env) ? opts.env : process.env;
    sharedScheduler = createModelCallScheduler({
      env,
      onWarn: typeof opts.onWarn === 'function' ? opts.onWarn : undefined,
    });
  }
  return sharedScheduler;
}

/** 仅供测试/诊断使用：关闭并丢弃单例（主进程不调用）。 */
function resetSharedModelCallScheduler() {
  if (sharedScheduler) {
    try {
      sharedScheduler.close();
    } catch (error) {
      /* 关闭失败不影响丢弃 */
    }
  }
  sharedScheduler = null;
  return null;
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
  // 默认走模块级单例：同一进程里设置页测试、直连对话、direct workspace 共享同一组 3 个槽位。
  const scheduler = opts.scheduler && typeof opts.scheduler.run === 'function'
    ? opts.scheduler
    : getSharedModelCallScheduler({ env: opts.env, onWarn: opts.onWarn });

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

  /**
   * 真正发上游请求的那一步：**只在调度器槽位里执行**。
   * - 请求自身 timeout 在这里才启动（= 拿到槽位之后，排队时间不消耗请求 timeout，§14.6-4）；
   * - 响应体必须读完（或明确失败/超时/取消）才返回，槽位由调度器在 Promise settle 后释放（§14.6-5）。
   */
  async function performChat(normalized, apiKey, bodyText, slotSignal) {
    const controller = new AbortController();
    let timedOut = false;
    let slotAborted = false;
    const onSlotAbort = () => {
      slotAborted = true;
      controller.abort();
    };
    if (slotSignal && typeof slotSignal.addEventListener === 'function') {
      slotSignal.addEventListener('abort', onSlotAbort, { once: true });
    }
    if (slotSignal && slotSignal.aborted) onSlotAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, normalized.timeoutMs);

    try {
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
        if (slotAborted) {
          throw new ModelCredentialError('MODEL_ABORTED', messageForCode('MODEL_ABORTED'));
        }
        throw new ModelCredentialError('DEEPSEEK_UNREACHABLE', messageForCode('DEEPSEEK_UNREACHABLE'));
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      // 读 body 阶段也可能被超时/取消打断：先按超时/取消定性，避免误报成"响应无法解析"。
      if (timedOut) {
        throw new ModelCredentialError('DEEPSEEK_TIMEOUT', messageForCode('DEEPSEEK_TIMEOUT'));
      }
      if (slotAborted) {
        throw new ModelCredentialError('MODEL_ABORTED', messageForCode('MODEL_ABORTED'));
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
      // §14.7：finish_reason 必须回传，`length` 一律记为 truncated（空正文 + length 也算，
      // 不得当成“无响应”）。既有字段（model/content/toolCalls/usage）保持不变。
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
      const content = typeof message.content === 'string' ? message.content : '';
      const toolCalls = rawToolCalls.slice(0, maxToolCount()).map((call) => ({
        id: typeof call?.id === 'string' ? call.id : '',
        name: typeof call?.function?.name === 'string' ? call.function.name : '',
        arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}',
      }));
      return {
        model: typeof payload.model === 'string' ? payload.model : normalized.body.model,
        content,
        toolCalls,
        usage: isPlainObject(payload.usage) ? {
          promptTokens: Number.isInteger(payload.usage.prompt_tokens) ? payload.usage.prompt_tokens : null,
          completionTokens: Number.isInteger(payload.usage.completion_tokens) ? payload.usage.completion_tokens : null,
        } : null,
        finishReason,
        truncated: finishReason === 'length',
        maxTokens: normalized.body.max_tokens,
        profile: normalized.profile === 'direct-edit' ? 'direct-edit' : 'chat',
        maxTokensRaised: Boolean(normalized.maxTokensRaised),
      };
    } finally {
      clearTimeout(timer);
      if (slotSignal && typeof slotSignal.removeEventListener === 'function') {
        slotSignal.removeEventListener('abort', onSlotAbort);
      }
    }
  }

  /**
   * 唯一上游出口：**每一次 chat/completions 实际请求**都先经 ModelCallScheduler 拿槽位。
   *
   * `settings:model:test` / `settings:model:chat` / direct workspace 生成都走这里，
   * 因此不变量是"进程内同时在飞的上游请求 ≤ 3"（rev15 §14.6-1/2）。
   * 取消：`chat(payload, { signal })` 或 `payload.signal`。
   */
  async function requestChat(rawPayload, callOptions) {
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

    const signal = resolveCallSignal(callOptions, rawPayload);
    try {
      return await scheduler.run(
        ({ signal: slotSignal }) => performChat(normalized, apiKey, bodyText, slotSignal),
        { signal, label: 'chat' },
      );
    } catch (error) {
      throw toCredentialError(error);
    }
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
    /** 只读槽位计数（active/queued/…），不含 prompt/源码/图片/Key；供诊断页显示 3 个槽位状态。 */
    schedulerStats: () => scheduler.stats(),
    /** 跨进程全局令牌状态（目录 / 占用数 / 降级原因），同样不含用户内容。 */
    schedulerGlobalStats: () => (typeof scheduler.globalStats === 'function' ? scheduler.globalStats() : null),
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
  /** §14.7 预算常量（direct runtime 只转出口，不另写一份数字）。 */
  DIRECT_EDIT_MAX_TOKENS,
  CHAT_MAX_TOKENS,
  resolveMaxTokens,
  /** 模块级调度器单例（诊断/测试用）；生产路径通过 credentials.chat 隐式共享。 */
  getSharedModelCallScheduler,
  resetSharedModelCallScheduler,
};
