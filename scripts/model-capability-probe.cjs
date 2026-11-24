#!/usr/bin/env node
'use strict';

/**
 * D0 目标模型能力探测（脱敏）——Workspace-Agent 重构 §7 D0
 *
 * 目标：用一次性的最小真实请求，实测当前配置模型与目标 Flash 模型的
 *   tools / tool_calls / 多轮工具循环、多模态 content parts、tools 与 response_format 互斥、
 *   最大输出与 finish_reason=length、超时、错误体形状、直连通道与 HTTP 通道差异。
 *
 * 硬约束：
 * - 密钥只从环境变量或 server/.env 读取，绝不打印、绝不落盘；
 * - 证据只保存字段名 / 类型 / 长度 / finish_reason / 错误码等形状，不保存完整 prompt、
 *   模型正文、图片 base64 或用户隐私；
 * - 无法执行的真实调用记为 BLOCKED 并附实际错误，不用 /models 或文档推断 PASS；
 * - 不改 Workspace/Composer 主干；探针只读服务端适配器源码并转译到 .tmp 执行。
 *
 * 用法（仓库根目录）：
 *   node scripts/model-capability-probe.cjs                 # 全量
 *   node scripts/model-capability-probe.cjs --only tools    # 调用仍全量执行，只过滤输出/evidence.cases
 *   node scripts/model-capability-probe.cjs --models deepseek-chat,deepseek-flash
 *   node scripts/model-capability-probe.cjs --out .tmp/d0-probe/shapes.json
 *
 * 输出默认写 .tmp/d0-probe/shapes.json（受 DSH 沙箱限制，shell 进程只能写 .tmp；
 * 常规环境可用 --out docs/evidence/workspace-agent/d0/shapes.json 直接落证据目录）。
 * 退出码：0 = 探针完整执行（用例本身可能是 4xx/5xx，属能力结论）；2 = 环境级 BLOCKED（无密钥/网络不可用）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'evidence', 'workspace-agent', 'd0');
const TMP_DIR = path.join(ROOT, '.tmp', 'd0-probe');
let OUTPUT_PATH = path.join(TMP_DIR, 'shapes.json');
let COMPACT_OUTPUT = false;

const HTTP_TIMEOUT_MS = 60_000;
const PROXY_TARGETS = [
  { host: '127.0.0.1', port: 17863 },
  { host: '192.168.222.1', port: 17863 },
];

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { only: '', models: '', out: '', compact: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') out.only = String(argv[i + 1] || '');
    else if (arg.startsWith('--only=')) out.only = arg.slice('--only='.length);
    else if (arg === '--models') out.models = String(argv[i + 1] || '');
    else if (arg.startsWith('--models=')) out.models = arg.slice('--models='.length);
    else if (arg === '--out') out.out = String(argv[i + 1] || '');
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg === '--compact') out.compact = true;
  }
  return out;
}

function readDotEnv(filePath) {
  const values = {};
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readConfig() {
  const dotenv = readDotEnv(path.join(ROOT, 'server', '.env'));
  const pick = (envName) => {
    const fromEnv = process.env[envName];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    const fromFile = dotenv[envName];
    return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : '';
  };
  const baseUrl = (pick('DEEPSEEK_API_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: pick('DEEPSEEK_API_KEY'),
    apiKeySource: process.env.DEEPSEEK_API_KEY ? 'process.env' : 'server/.env',
    model: pick('DEEPSEEK_MODEL') || 'deepseek-chat',
    visionModel: pick('DEEPSEEK_VISION_MODEL') || 'deepseek-flash',
    timeoutMs: Number(pick('DEEPSEEK_TIMEOUT_MS')) || 30_000,
    maxTokens: Number(pick('DEEPSEEK_MAX_TOKENS')) || 1_200,
  };
}

// ---------------------------------------------------------------------------
// 脱敏形状工具
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9._-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
  /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gi,
];

function sanitize(text, maxLength) {
  let value = typeof text === 'string' ? text : '';
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[redacted]');
  if (typeof maxLength === 'number' && value.length > maxLength) {
    value = `${value.slice(0, maxLength)}…(len ${value.length})`;
  }
  return value;
}

function dataUrlShape(url) {
  const text = typeof url === 'string' ? url : '';
  const comma = text.indexOf(',');
  return {
    scheme: comma > 0 ? text.slice(0, Math.min(comma + 1, 40)) : 'unknown',
    length: text.length,
  };
}

function shapeOfWireMessage(message) {
  if (!message || typeof message !== 'object') return { invalid: true };
  const out = { role: message.role };
  if (typeof message.content === 'string') {
    out.content = { kind: 'string', length: message.content.length };
  } else if (Array.isArray(message.content)) {
    out.content = {
      kind: 'parts',
      count: message.content.length,
      parts: message.content.map((part) => {
        if (part && part.type === 'text') return { type: 'text', textLength: String(part.text || '').length };
        if (part && part.type === 'image_url') {
          const url = part.image_url && part.image_url.url;
          return {
            type: 'image_url',
            url: dataUrlShape(url),
            detail: part.image_url && part.image_url.detail ? part.image_url.detail : null,
          };
        }
        return { type: String(part && part.type) };
      }),
    };
  } else {
    out.content = { kind: message.content === null ? 'null' : typeof message.content };
  }
  if (Array.isArray(message.tool_calls)) {
    out.tool_calls = {
      count: message.tool_calls.length,
      names: message.tool_calls.map((call) => String(call && call.function && call.function.name)),
      argumentsLengths: message.tool_calls.map((call) => String((call && call.function && call.function.arguments) || '').length),
      idsPresent: message.tool_calls.every((call) => Boolean(call && call.id)),
    };
  }
  if (typeof message.tool_call_id === 'string') out.tool_call_id = { present: message.tool_call_id.length > 0 };
  return out;
}

/** 只保留 wire 字段名/类型/长度，不保留任何消息正文。 */
function shapeOfWireBody(body) {
  if (!body || typeof body !== 'object') return { invalid: true };
  const shape = {
    keys: Object.keys(body).sort(),
    model: body.model,
    stream: body.stream,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
  };
  if (body.thinking !== undefined) shape.thinking = body.thinking === null ? 'null' : body.thinking && body.thinking.type;
  if (typeof body.reasoning_effort === 'string') shape.reasoning_effort = body.reasoning_effort;
  if (body.response_format !== undefined) shape.response_format = body.response_format && body.response_format.type;
  if (Array.isArray(body.tools)) {
    shape.tools = {
      count: body.tools.length,
      types: [...new Set(body.tools.map((tool) => tool && tool.type))],
      names: body.tools.map((tool) => String(tool && tool.function && tool.function.name)),
      parameterKeyCounts: body.tools.map((tool) => {
        const parameters = tool && tool.function && tool.function.parameters;
        return parameters && parameters.properties ? Object.keys(parameters.properties).length : 0;
      }),
    };
  }
  if (body.tool_choice !== undefined) shape.tool_choice = body.tool_choice;
  if (Array.isArray(body.messages)) shape.messages = body.messages.map(shapeOfWireMessage);
  return shape;
}

function shapeOfRawResponse(status, text) {
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parsed = null;
  }
  const shape = {
    status,
    bodyBytes: Buffer.byteLength(text || '', 'utf8'),
    parseOk: parsed !== null,
  };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    shape.keys = Object.keys(parsed).sort();
    if (typeof parsed.model === 'string') shape.model = parsed.model;
    if (typeof parsed.id === 'string') shape.idPresent = true;
    if (typeof parsed.object === 'string') shape.object = parsed.object;
    if (Array.isArray(parsed.choices)) {
      shape.choicesCount = parsed.choices.length;
      const choice = parsed.choices[0] || {};
      const message = choice.message && typeof choice.message === 'object' ? choice.message : {};
      shape.choice0 = {
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        messageKeys: Object.keys(message).sort(),
        content: typeof message.content === 'string' ? { kind: 'string', length: message.content.length } : { kind: message.content === null ? 'null' : typeof message.content },
        reasoningContent: typeof message.reasoning_content === 'string' ? { present: true, length: message.reasoning_content.length } : { present: false },
        toolCalls: Array.isArray(message.tool_calls)
          ? {
            count: message.tool_calls.length,
            names: message.tool_calls.map((call) => String(call && call.function && call.function.name)),
            argumentsLengths: message.tool_calls.map((call) => String((call && call.function && call.function.arguments) || '').length),
            argumentsParseOk: message.tool_calls.map((call) => {
              try {
                JSON.parse(String(call && call.function && call.function.arguments));
                return true;
              } catch (error) {
                return false;
              }
            }),
            idsPresent: message.tool_calls.every((call) => Boolean(call && call.id)),
          }
          : null,
      };
    }
    if (parsed.usage && typeof parsed.usage === 'object') {
      shape.usage = {
        keys: Object.keys(parsed.usage).sort(),
        prompt_tokens: parsed.usage.prompt_tokens,
        completion_tokens: parsed.usage.completion_tokens,
        total_tokens: parsed.usage.total_tokens,
      };
    }
    if (parsed.error && typeof parsed.error === 'object') {
      shape.error = {
        keys: Object.keys(parsed.error).sort(),
        code: parsed.error.code === undefined ? null : parsed.error.code,
        type: parsed.error.type === undefined ? null : parsed.error.type,
        param: parsed.error.param === undefined ? null : parsed.error.param,
        messageLength: typeof parsed.error.message === 'string' ? parsed.error.message.length : 0,
        messagePreview: sanitize(parsed.error.message, 160),
      };
    }
  } else if (parsed !== null) {
    shape.bodyKind = Array.isArray(parsed) ? 'array' : typeof parsed;
  }
  return shape;
}

function safeError(error) {
  const out = {
    name: error && error.name ? String(error.name) : 'Error',
    code: error && typeof error.code === 'string' ? error.code : null,
    status: error && typeof error.status === 'number' ? error.status : null,
    retryable: error && typeof error.retryable === 'boolean' ? error.retryable : null,
    message: sanitize(error && error.message, 200),
  };
  if (error && error.cause && typeof error.cause === 'object') {
    out.cause = {
      name: error.cause.name ? String(error.cause.name) : null,
      code: typeof error.cause.code === 'string' ? error.cause.code : null,
    };
  }
  return out;
}

function resultShape(result) {
  if (!result || typeof result !== 'object') return { invalid: true };
  const message = result.message && typeof result.message === 'object' ? result.message : {};
  return {
    model: result.model,
    finishReason: result.finishReason,
    truncated: result.truncated === true,
    content: typeof message.content === 'string' ? { kind: 'string', length: message.content.length } : { kind: message.content === null ? 'null' : typeof message.content },
    toolCalls: Array.isArray(message.toolCalls)
      ? {
        count: message.toolCalls.length,
        names: message.toolCalls.map((call) => call.name),
        argumentsLengths: message.toolCalls.map((call) => String(call.argumentsText || '').length),
        argumentsParseOk: message.toolCalls.map((call) => {
          try {
            JSON.parse(String(call.argumentsText || ''));
            return true;
          } catch (error) {
            return false;
          }
        }),
      }
      : null,
    usage: result.usage || null,
    latencyMs: result.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// 图片：生成固定 64x64 纯红 PNG（不落盘、不记录 base64）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePngDataUrl(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type none
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = 220; // R
      raw[offset + 1] = 30; // G
      raw[offset + 2] = 30; // B
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, bytes: png.length };
}

// ---------------------------------------------------------------------------
// 真实 HTTP 调用（raw）与适配器调用
// ---------------------------------------------------------------------------

async function rawChat(config, caseId, purpose, body, options = {}) {
  const record = {
    id: caseId,
    purpose,
    transport: 'http-server-adapter-wire',
    request: shapeOfWireBody(body),
    startedAt: new Date().toISOString(),
  };
  const started = Date.now();
  const key = options.apiKey !== undefined ? options.apiKey : config.apiKey;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    record.response = shapeOfRawResponse(response.status, text);
    if (typeof options.derive === 'function') {
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (error) {
        parsed = null;
      }
      try {
        record.response.derived = options.derive(parsed);
      } catch (error) {
        record.response.derived = { deriveError: sanitize(error.message, 120) };
      }
    }
  } catch (error) {
    record.error = safeError(error);
  } finally {
    clearTimeout(timer);
  }
  record.latencyMs = Date.now() - started;
  record.finishedAt = new Date().toISOString();
  return record;
}

function prepareAdapter() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const adapterPath = path.join(ROOT, 'server', 'src', 'agent', 'runtime', 'adapters', 'deepseek-chat-model.ts');
  const errorsPath = path.join(ROOT, 'server', 'src', 'agent', 'runtime', 'runtime.errors.ts');
  const transpile = (source) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const adapterJs = transpile(fs.readFileSync(adapterPath, 'utf8')).replace(/\.\.\/runtime\.errors/g, './runtime-errors');
  fs.writeFileSync(path.join(TMP_DIR, 'adapter.js'), adapterJs);
  fs.writeFileSync(
    path.join(TMP_DIR, 'runtime-errors.js'),
    transpile(fs.readFileSync(errorsPath, 'utf8')),
  );
  // eslint-disable-next-line import/no-dynamic-require
  return require(path.join(TMP_DIR, 'adapter.js'));
}

async function adapterCall(adapterModule, config, caseId, purpose, request, options = {}) {
  const record = {
    id: caseId,
    purpose,
    transport: 'http-server-adapter',
    request: null,
    startedAt: new Date().toISOString(),
  };
  const capturedBodies = [];
  const logs = [];
  const settings = {
    baseUrl: config.baseUrl,
    apiKey: options.apiKey !== undefined ? options.apiKey : config.apiKey,
    model: options.model || config.model,
    visionModel: options.visionModel || config.visionModel,
    timeoutMs: options.settingsTimeoutMs || config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: 0.2,
    reasoningEffort: '',
  };
  const model = new adapterModule.DeepseekChatModel({
    fetch: async (url, init) => {
      try {
        capturedBodies.push(shapeOfWireBody(JSON.parse(String(init && init.body))));
      } catch (error) {
        capturedBodies.push({ unparsed: true });
      }
      return fetch(url, init);
    },
    settings,
    logger: {
      log: (event) => {
        logs.push({
          event: event && event.event,
          level: event && event.level,
          model: event && event.model,
          latencyMs: event && event.latencyMs,
          finishReason: event && event.finishReason,
          hasToolCalls: event && event.hasToolCalls,
          toolCallCount: event && event.toolCallCount,
          promptTokens: event && event.promptTokens,
          completionTokens: event && event.completionTokens,
          status: event && event.status,
        });
      },
    },
  });
  const started = Date.now();
  try {
    const result = await model.complete(request, options.callOptions || {});
    record.response = resultShape(result);
    record.resultRef = result;
  } catch (error) {
    record.error = safeError(error);
  }
  record.latencyMs = Date.now() - started;
  record.wireBodies = capturedBodies;
  record.loggerEvents = logs;
  record.finishedAt = new Date().toISOString();
  return record;
}

// ---------------------------------------------------------------------------
// 直连通道（desktop/model-credentials.cjs 的 settings:model:chat 代码路径）
// ---------------------------------------------------------------------------

function createDirectChannel(config) {
  const userDataDir = path.join(TMP_DIR, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  // 只写占位密文；decrypt 由桩返回真实 key，密钥不落盘。
  fs.writeFileSync(path.join(userDataDir, 'model-key.bin'), Buffer.from('d0-probe-placeholder'));
  // eslint-disable-next-line import/no-dynamic-require
  const credentialsModule = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
  const safeStorage = {
    encryptString: () => Buffer.from('d0-probe-placeholder'),
    decryptString: () => config.apiKey,
    isEncryptionAvailable: () => true,
  };
  const captured = [];
  const credentials = credentialsModule.createModelCredentials({
    userDataDir,
    safeStorage,
    fetchImpl: async (url, init) => {
      try {
        captured.push({ urlPath: new URL(url).pathname, body: shapeOfWireBody(JSON.parse(String(init && init.body))) });
      } catch (error) {
        captured.push({ unparsed: true });
      }
      return fetch(url, init);
    },
  });
  return { credentials, credentialsModule, captured, userDataDir };
}

async function directChat(direct, config, caseId, purpose, payload) {
  const record = {
    id: caseId,
    purpose,
    transport: 'direct-main-modelChat',
    request: null,
    startedAt: new Date().toISOString(),
  };
  const before = direct.captured.length;
  const started = Date.now();
  try {
    const result = await direct.credentials.chat(Object.assign({
      baseUrl: config.baseUrl,
    }, payload));
    record.response = {
      keys: Object.keys(result || {}).sort(),
      model: result && result.model,
      content: typeof (result && result.content) === 'string'
        ? { kind: 'string', length: result.content.length }
        : { kind: typeof (result && result.content) },
      toolCalls: Array.isArray(result && result.toolCalls)
        ? {
          count: result.toolCalls.length,
          names: result.toolCalls.map((call) => call.name),
          argumentsLengths: result.toolCalls.map((call) => String(call.arguments || '').length),
          argumentsParseOk: result.toolCalls.map((call) => {
            try {
              JSON.parse(String(call.arguments || ''));
              return true;
            } catch (error) {
              return false;
            }
          }),
          idsPresent: result.toolCalls.every((call) => typeof call.id === 'string' && call.id.length > 0),
        }
        : null,
      usage: result && result.usage,
    };
    // 主进程直连返回体没有 finish_reason / truncated，这里显式记下来（D1 截断检测依赖）。
    record.response.finishReasonPresent = Boolean(result && Object.prototype.hasOwnProperty.call(result, 'finishReason'));
    record.response.truncatedPresent = Boolean(result && Object.prototype.hasOwnProperty.call(result, 'truncated'));
    record.resultRef = result;
  } catch (error) {
    record.error = safeError(error);
  }
  record.latencyMs = Date.now() - started;
  record.wireBodies = direct.captured.slice(before).map((item) => item.body || item);
  record.finishedAt = new Date().toISOString();
  return record;
}

// ---------------------------------------------------------------------------
// 本地代理透传探测（只证明可达性/错误形状，不伪造 PASS）
// ---------------------------------------------------------------------------

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (error) { /* ignore */ }
      resolve(Object.assign({ host, port, latencyMs: Date.now() - started }, payload));
    };
    socket.setTimeout(timeoutMs, () => finish({ connected: false, error: { name: 'Timeout', code: 'ETIMEDOUT' } }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (error) => finish({ connected: false, error: { name: error.name, code: error.code, message: sanitize(error.message, 160) } }));
  });
}

async function probeProxy(config) {
  const result = { targets: [] };
  for (const target of PROXY_TARGETS) {
    const connectivity = await tcpConnect(target.host, target.port, 1500);
    const entry = { target, connectivity };
    if (connectivity.connected) {
      const record = await rawChat(config, `proxy_${target.host}_${target.port}`, 'proxy passthrough probe', {
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }, {});
      entry.httpChat = record;
    } else if (target.host === '127.0.0.1') {
      // 端口不可达时也记录一次 HTTP 层错误形状（BLOCKED 证据）。
      try {
        const response = await fetch(`http://${target.host}:${target.port}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        });
        entry.httpModels = { status: response.status };
      } catch (error) {
        entry.httpModels = {
          error: {
            name: error && error.name ? String(error.name) : 'Error',
            code: error && error.cause && typeof error.cause.code === 'string' ? error.cause.code : null,
            message: sanitize(error && error.message, 120),
          },
        };
      }
    }
    result.targets.push(entry);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const TOOL = {
  name: 'probe_echo',
  description: 'Echo back the provided text. Use this tool when the user asks to echo text.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', minLength: 1, maxLength: 20 } },
    required: ['text'],
  },
};

function filterCases(records, only) {
  if (!only) return records;
  return records.filter((record) => String(record.id).startsWith(only));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.out) OUTPUT_PATH = path.resolve(ROOT, args.out);
  if (args.compact) {
    COMPACT_OUTPUT = true;
    if (!args.out) OUTPUT_PATH = path.join(TMP_DIR, 'shapes-compact.json');
  }
  const config = readConfig();
  const startedAt = new Date().toISOString();
  const evidence = {
    contract: 'workspace-agent-d0-capability-probe.v1',
    startedAt,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    targetBaseUrlHost: (() => {
      try { return new URL(config.baseUrl).host; } catch (error) { return config.baseUrl; }
    })(),
    configuredModel: config.model,
    configuredVisionModel: config.visionModel,
    credentialSource: config.apiKey ? config.apiKeySource : null,
    credentialPresent: Boolean(config.apiKey),
    cases: [],
    staticContract: {},
    proxy: null,
    limitations: [],
    blocked: null,
  };

  if (!config.apiKey) {
    evidence.blocked = {
      reason: 'DEEPSEEK_API_KEY 未配置（进程环境与 server/.env 都没有）',
      code: 'BLOCKED_NO_CREDENTIAL',
    };
    evidence.limitations.push('无密钥：未执行任何真实模型调用；能力结论一律 BLOCKED，不得凭 /models 或文档推断 PASS。');
    finish(evidence, 2);
    return;
  }

  // ---- 静态契约（从真实源码读取的形状，不含任何密钥） ----------------------
  evidence.staticContract = {
    adapterSource: 'server/src/agent/runtime/adapters/deepseek-chat-model.ts',
    directSource: 'desktop/model-credentials.cjs',
    directUserDataConfig: (() => {
      try {
        const configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'smart-store-generator', 'config.json');
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          modelChannel: parsed.modelChannel,
          modelApiBaseUrl: parsed.modelApiBaseUrl,
          modelName: parsed.modelName,
          modelTimeoutMs: parsed.modelTimeoutMs,
          agentTransport: parsed.agentTransport,
        };
      } catch (error) {
        return { readError: sanitize(error.message, 120) };
      }
    })(),
    adapterNotes: [
      '带图请求自动切到 DEEPSEEK_VISION_MODEL；无图沿用 DEEPSEEK_MODEL',
      'max_tokens clamp 100–8000；调用方显式值优先',
      'tools → tools + tool_choice=auto；responseFormat=json_object 时才发 response_format',
      'finish_reason=length 或字符裁剪 → truncated=true',
      '错误映射 401/403→DEEPSEEK_AUTH_FAILED，429→RATE_LIMITED，>=500→UPSTREAM_ERROR，其它→REQUEST_REJECTED',
    ],
    directNotes: [
      'body 固定 model/messages/stream/max_tokens/temperature，可选 thinking；不发送 response_format / reasoning_effort',
      'max_tokens 只接受 1–4096 的整数，否则回退 1200（非 clamp，是整体回退）',
      'tools 上限 8；messages 上限 40；单条内容 24000 字符',
      '图片只接受内联 data URL；单张 ≤400 KiB、合计 ≤1 MiB、最多 3 张',
      '返回体只有 model/content/toolCalls/usage，没有 finish_reason / truncated',
      '错误映射 401/403→AUTH_FAILED，402/429→RATE_LIMITED，400/404/422→REQUEST_REJECTED，>=500→UPSTREAM_ERROR',
    ],
  };

  // ---- 直连通道静态 normalize 行为（真实调用前先验证边界） ------------------
  const direct = createDirectChannel(config);
  const directStatic = [];
  try {
    const normalized = direct.credentialsModule.normalizeChatPayload({
      model: config.model,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8000,
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    });
    directStatic.push({
      case: 'direct_normalize_maxTokens_and_unknown_fields',
      requestedMaxTokens: 8000,
      effectiveMaxTokens: normalized.body.max_tokens,
      bodyKeys: Object.keys(normalized.body).sort(),
      responseFormatPresent: Object.prototype.hasOwnProperty.call(normalized.body, 'response_format'),
      reasoningEffortPresent: Object.prototype.hasOwnProperty.call(normalized.body, 'reasoning_effort'),
      thinking: normalized.body.thinking,
    });
  } catch (error) {
    directStatic.push({ case: 'direct_normalize_maxTokens_and_unknown_fields', error: safeError(error) });
  }
  try {
    const tools = Array.from({ length: 9 }, (unused, index) => ({
      type: 'function',
      function: { name: `probe_tool_${index}`, description: 'probe', parameters: { type: 'object', properties: {} } },
    }));
    direct.credentialsModule.normalizeChatPayload({
      model: config.model,
      messages: [{ role: 'user', content: 'ping' }],
      tools,
    });
    directStatic.push({ case: 'direct_normalize_tools_9', accepted: true });
  } catch (error) {
    directStatic.push({ case: 'direct_normalize_tools_9', accepted: false, error: safeError(error) });
  }
  try {
    direct.credentialsModule.normalizeChatPayload({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      }],
    });
    directStatic.push({ case: 'direct_normalize_external_image_url', accepted: true });
  } catch (error) {
    directStatic.push({ case: 'direct_normalize_external_image_url', accepted: false, error: safeError(error) });
  }
  try {
    const image = makePngDataUrl(64, 64);
    const normalized = direct.credentialsModule.normalizeChatPayload({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ],
      }],
    });
    directStatic.push({
      case: 'direct_normalize_inline_png',
      accepted: true,
      pngBytes: image.bytes,
      dataUrlLength: image.dataUrl.length,
      partTypes: normalized.body.messages[0].content.map((part) => part.type),
    });
  } catch (error) {
    directStatic.push({ case: 'direct_normalize_inline_png', accepted: false, error: safeError(error) });
  }
  evidence.directStatic = directStatic;

  // ---- 适配器转译（只读源码 → .tmp，不改 server/） --------------------------
  let adapterModule = null;
  try {
    adapterModule = prepareAdapter();
  } catch (error) {
    evidence.limitations.push(`适配器转译失败：${sanitize(error.message, 160)}`);
  }

  const image = makePngDataUrl(64, 64);
  evidence.imageProbe = { format: 'png', width: 64, height: 64, pngBytes: image.bytes, dataUrlLength: image.dataUrl.length };

  const records = [];

  // ===== A. 基线：模型/鉴权/命名 ============================================
  const models = (args.models ? args.models.split(',').map((item) => item.trim()).filter(Boolean) : [config.model, config.visionModel]);
  const uniqueModels = [...new Set(models)];
  for (const model of uniqueModels) {
    if (adapterModule) {
      records.push(await adapterCall(adapterModule, config, `baseline:${model}`, '最小纯文本调用，验证模型名与鉴权', {
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        maxTokens: 8,
      }, { model }));
    } else {
      records.push(await rawChat(config, `baseline:${model}`, '最小纯文本调用，验证模型名与鉴权', {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        max_tokens: 8,
        temperature: 0.2,
        stream: false,
      }));
    }
  }

  // 目标 Flash 的候选命名（官方网关 vs 本地代理命名）
  for (const candidate of ['deepseek-v4.1-flash', 'cn:deepseek-v4.1-flash']) {
    if (uniqueModels.includes(candidate)) continue;
    records.push(await rawChat(config, `model-naming:${candidate}`, '目标 Flash 候选模型名在官方网关的接受度（命名证据，非能力证据）', {
      model: candidate,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
      temperature: 0,
      stream: false,
    }));
  }
  // 官方 /models 仅作模型清单旁证，不据此推断任何能力
  try {
    const modelsResponse = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await modelsResponse.text();
    let ids = null;
    try {
      const parsed = JSON.parse(text);
      ids = Array.isArray(parsed.data) ? parsed.data.map((item) => item.id) : null;
    } catch (error) { /* keep null */ }
    evidence.modelsEndpoint = {
      status: modelsResponse.status,
      bodyBytes: Buffer.byteLength(text, 'utf8'),
      modelIds: ids,
      note: '仅作清单旁证；不用于推断 tools/多模态/截断能力',
    };
  } catch (error) {
    evidence.modelsEndpoint = { error: safeError(error) };
  }

  const baselineRecords = records.filter((record) => record.id.startsWith('baseline:'));
  const baselineAllError = baselineRecords.length > 0 && baselineRecords.every((record) => Boolean(record.error));
  const baselineAuthFailed = baselineAllError
    && baselineRecords.every((record) => ['DEEPSEEK_AUTH_FAILED', 'DEEPSEEK_NOT_CONFIGURED'].includes(record.error.code));
  const baselineUnreachable = baselineAllError
    && baselineRecords.every((record) => ['DEEPSEEK_UNAVAILABLE', 'DEEPSEEK_TIMEOUT'].includes(record.error.code));
  if (baselineAuthFailed || baselineUnreachable) {
    evidence.blocked = {
      reason: baselineAuthFailed
        ? '真实基线调用全部鉴权失败（密钥无效/过期）'
        : '真实基线调用全部不可达/超时（网络或代理不可用）',
      code: baselineAuthFailed ? 'BLOCKED_AUTH_FAILED' : 'BLOCKED_NETWORK',
      sample: baselineRecords[0],
    };
    evidence.limitations.push('环境阻塞：不得用 mock、/models 或文档补位；tools/多模态/截断/代理结论均 BLOCKED。');
    // 仍执行代理可达性探测，便于给出环境证据
    evidence.proxy = await probeProxy(config);
    evidence.cases = filterCases(records, args.only);
    finish(evidence, 2);
    return;
  }

  // ===== B. tools / tool_calls / 多轮工具循环 ==============================
  for (const model of uniqueModels) {
    if (adapterModule) {
      const toolsCall = await adapterCall(adapterModule, config, `tools:${model}`, '单轮 tools → tool_calls', {
        messages: [
          { role: 'system', content: 'You are a capability probe. Always call the provided tool when asked.' },
          { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
        ],
        tools: [TOOL],
        maxTokens: 200,
      }, { model });
      records.push(toolsCall);
      const toolCalls = toolsCall.resultRef && toolsCall.resultRef.message && toolsCall.resultRef.message.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const first = toolCalls[0];
        records.push(await adapterCall(adapterModule, config, `tool-loop:${model}`, '回填 assistant tool_calls + tool 结果，验证多轮工具循环', {
          messages: [
            { role: 'system', content: 'You are a capability probe.' },
            { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
            { role: 'assistant', content: null, toolCalls },
            { role: 'tool', toolCallId: first.id, content: '{"ok":true,"result":"ok"}' },
            { role: 'user', content: 'Now answer with exactly: done' },
          ],
          tools: [TOOL],
          maxTokens: 100,
        }, { model }));
      } else {
        records.push({
          id: `tool-loop:${model}`,
          purpose: '多轮工具循环',
          skipped: true,
          reason: '首轮未返回 tool_calls，无法构造第二轮；不伪造循环证据',
        });
      }
    } else {
      records.push(await rawChat(config, `tools:${model}`, '单轮 tools → tool_calls', {
        model,
        messages: [
          { role: 'system', content: 'You are a capability probe. Always call the provided tool when asked.' },
          { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
        ],
        tools: [{ type: 'function', function: TOOL }],
        tool_choice: 'auto',
        max_tokens: 200,
        temperature: 0.2,
        stream: false,
      }));
    }
  }

  // ===== C. 多模态 content parts ==========================================
  const imageMessages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'What color is this square? Answer with one word.' },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ],
  }];
  // 适配器的 ChatMessage 用 imageUrl（camelCase）；raw wire 用 image_url。
  const adapterImageMessages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'What color is this square? Answer with one word.' },
      { type: 'image_url', imageUrl: { url: image.dataUrl } },
    ],
  }];
  for (const model of uniqueModels) {
    records.push(await rawChat(config, `multimodal-raw:${model}`, '原始 wire：同一模型是否接受 image_url content parts', {
      model,
      messages: imageMessages,
      max_tokens: 30,
      temperature: 0.2,
      stream: false,
    }));
  }
  // 正确性旁证：只记录“答案是否 red / blue”的布尔值，不保存模型正文。
  const visionQuestion = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Is this square red or blue? Answer with exactly one word: red or blue.' },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ],
  }];
  const deriveColorAnswer = (parsed) => {
    const rawContent = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content
      : null;
    const answer = typeof rawContent === 'string' ? rawContent.trim().toLowerCase() : '';
    return { answerIsRed: answer === 'red', answerIsBlue: answer === 'blue', answerLength: answer.length };
  };
  for (const model of uniqueModels) {
    records.push(await rawChat(config, `multimodal-answer:${model}`, '图文问答正确性：红色方块是否被识别为 red（预算 800）', {
      model,
      messages: visionQuestion,
      max_tokens: 800,
      temperature: 0.2,
      stream: false,
    }, { derive: deriveColorAnswer }));
  }
  if (adapterModule) {
    records.push(await adapterCall(adapterModule, config, 'multimodal-adapter:routing', '适配器带图路由：请求应切到 vision model', {
      messages: adapterImageMessages,
      maxTokens: 30,
    }, { model: config.model }));
    records.push(await adapterCall(adapterModule, config, 'multimodal-adapter:vision-model', '显式以 vision model 为基础模型再带图', {
      messages: adapterImageMessages,
      maxTokens: 300,
    }, { model: config.visionModel }));
  }
  records.push(await directChat(direct, config, 'multimodal-direct:config-model', '直连通道带图（当前配置 modelName）', {
    model: config.model,
    messages: imageMessages,
    maxTokens: 300,
    timeoutMs: 60_000,
  }));

  // 推理预算：带图 + 长回答要求 + 小预算 => 推理吃满预算、正文为空、finish_reason=length。
  // 这条用于验证适配器在“空正文 + length”下会抛 DEEPSEEK_RESPONSE_INVALID（丢失 truncated 信号）。
  const longImagePrompt = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe every visual detail of this image in at least 500 words.' },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ],
  }];
  const adapterLongImagePrompt = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe every visual detail of this image in at least 500 words.' },
      { type: 'image_url', imageUrl: { url: image.dataUrl } },
    ],
  }];
  records.push(await rawChat(config, 'vision-budget:raw_100', '推理预算：带图 + 500 词要求 + max_tokens=100，确认空正文 + length', {
    model: config.visionModel,
    messages: longImagePrompt,
    max_tokens: 100,
    temperature: 0.2,
    stream: false,
  }));
  if (adapterModule) {
    records.push(await adapterCall(adapterModule, config, 'vision-budget:adapter_100', '适配器在空正文 + length 下的错误形状（预期 DEEPSEEK_RESPONSE_INVALID）', {
      messages: adapterLongImagePrompt,
      maxTokens: 100,
    }, { model: config.visionModel }));
    records.push(await adapterCall(adapterModule, config, 'vision-budget:adapter_2000', 'P5b 建议的视觉预算 2000 是否拿到非空正文', {
      messages: adapterLongImagePrompt,
      maxTokens: 2000,
    }, { model: config.visionModel }));
  }

  // ===== D. tools 与 response_format 互斥 =================================
  for (const model of uniqueModels) {
    if (adapterModule) {
      records.push(await adapterCall(adapterModule, config, `tools+response_format:${model}`, '同一请求同时给 tools 与 response_format=json_object', {
        messages: [
          { role: 'system', content: 'You are a capability probe. Call probe_echo when asked.' },
          { role: 'user', content: 'Call probe_echo with text "ok" and return the result as JSON.' },
        ],
        tools: [TOOL],
        responseFormat: 'json_object',
        maxTokens: 300,
      }, { model }));
      records.push(await adapterCall(adapterModule, config, `response_format:${model}`, '仅 response_format=json_object（tools 退路的基线）', {
        messages: [{ role: 'user', content: 'Return exactly this JSON: {"ok":true}' }],
        responseFormat: 'json_object',
        maxTokens: 40,
      }, { model }));
    } else {
      records.push(await rawChat(config, `tools+response_format:${model}`, '同一请求同时给 tools 与 response_format', {
        model,
        messages: [{ role: 'user', content: 'Call probe_echo with text "ok".' }],
        tools: [{ type: 'function', function: TOOL }],
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        max_tokens: 300,
        stream: false,
      }));
    }
  }

  // ===== E. 最大输出 / 截断 / finish_reason=length ========================
  if (adapterModule) {
    records.push(await adapterCall(adapterModule, config, 'truncation:max_tokens_16', 'max_tokens=16 强制截断，检查 finish_reason=length 与 truncated 标记', {
      messages: [{ role: 'user', content: 'Write a 200-word story about a cat.' }],
      maxTokens: 16,
    }));
    records.push(await adapterCall(adapterModule, config, 'max-output:adapter_8000', '适配器 max_tokens 硬上限 8000 是否被上游接受', {
      messages: [{ role: 'user', content: 'Say hi.' }],
      maxTokens: 8000,
    }));
  }
  for (const model of uniqueModels) {
    records.push(await rawChat(config, `max-output:raw_8192:${model}`, '原始 wire：max_tokens=8192 是否被接受', {
      model,
      messages: [{ role: 'user', content: 'Say hi.' }],
      max_tokens: 8192,
      temperature: 0.2,
      stream: false,
    }));
  }
  if (uniqueModels.includes(config.model)) {
    records.push(await rawChat(config, `max-output:raw_16384:${config.model}`, '原始 wire：max_tokens=16384 是否被接受（探测官方上限）', {
      model: config.model,
      messages: [{ role: 'user', content: 'Say hi.' }],
      max_tokens: 16384,
      temperature: 0.2,
      stream: false,
    }));
  }
  for (const maxTokens of [32768, 65536, 131072, 262144]) {
    records.push(await rawChat(config, `max-output:raw_${maxTokens}:${config.visionModel}`, `原始 wire：max_tokens=${maxTokens} 是否被接受（输出上限边界）`, {
      model: config.visionModel,
      messages: [{ role: 'user', content: 'Say hi.' }],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }));
  }

  // ===== F. 错误形状 / 超时 ===============================================
  if (adapterModule) {
    records.push(await adapterCall(adapterModule, config, 'error:invalid_model', '错误映射：不存在的模型名', {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 4,
    }, { model: 'deepseek-model-does-not-exist' }));
    records.push(await adapterCall(adapterModule, config, 'error:invalid_key', '错误映射：无效密钥（401）', {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 4,
    }, { apiKey: 'sk-d0-probe-invalid-key-000000000000' }));
    records.push(await adapterCall(adapterModule, config, 'timeout:local_1ms', '本地超时路径（timeoutMs=1ms；非上游慢响应）', {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 4,
    }, { settingsTimeoutMs: 1 }));
  }
  records.push(await rawChat(config, 'error:invalid_key_raw', '原始 401 错误体形状（无效密钥）', {
    model: config.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 4,
    stream: false,
  }, { apiKey: 'sk-d0-probe-invalid-key-000000000000' }));

  // ===== G. 直连通道真实调用（与 HTTP 通道对比） ===========================
  const directToolCall = await directChat(direct, config, 'direct:baseline', '直连通道最小纯文本调用', {
    model: config.model,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    maxTokens: 8,
  });
  records.push(directToolCall);

  const directTools = await directChat(direct, config, 'direct:tools', '直连通道 tools → toolCalls 形状', {
    model: config.model,
    messages: [
      { role: 'system', content: 'You are a capability probe. Always call the provided tool when asked.' },
      { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
    ],
    tools: [{ type: 'function', function: TOOL }],
    maxTokens: 200,
  });
  records.push(directTools);

  if (directTools.resultRef && Array.isArray(directTools.resultRef.toolCalls) && directTools.resultRef.toolCalls.length > 0) {
    const first = directTools.resultRef.toolCalls[0];
    records.push(await directChat(direct, config, 'direct:tool-loop', '直连通道回填 assistant tool_calls + tool 结果', {
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a capability probe.' },
        { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: first.id, type: 'function', function: { name: first.name, arguments: first.arguments } }],
        },
        { role: 'tool', tool_call_id: first.id, content: '{"ok":true,"result":"ok"}' },
        { role: 'user', content: 'Now answer with exactly: done' },
      ],
      tools: [{ type: 'function', function: TOOL }],
      maxTokens: 100,
    }));
  } else {
    records.push({ id: 'direct:tool-loop', purpose: '直连通道多轮工具循环', skipped: true, reason: '首轮未返回 toolCalls；不伪造循环证据' });
  }

  // 直连通道刻意传 response_format，记录它是否真的进了 wire（源码预期：被丢弃）
  records.push(await directChat(direct, config, 'direct:response_format_dropped', '直连通道无法发送 response_format：传了也不进 body', {
    model: config.model,
    messages: [{ role: 'user', content: 'Return exactly this JSON: {"ok":true}' }],
    maxTokens: 40,
    response_format: { type: 'json_object' },
  }));

  // 直连通道截断盲区：返回体没有 finish_reason / truncated。
  records.push(await directChat(direct, config, 'direct:truncation', '直连通道截断：maxTokens=20 长故事，返回体是否带 finish_reason/truncated', {
    model: config.model,
    messages: [{ role: 'user', content: 'Write a 200-word story about a cat.' }],
    maxTokens: 20,
  }));

  // ===== I. 稳定性抽样（暴露推理预算造成的 finish_reason 抖动） ==========
  if (adapterModule) {
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      records.push(await adapterCall(adapterModule, config, `stability:tools-flash:${repeat}`, '重复抽样：flash 单轮 tools（finish_reason / 截断是否会抖）', {
        messages: [
          { role: 'system', content: 'You are a capability probe. Always call the provided tool when asked.' },
          { role: 'user', content: 'Call probe_echo with text "ok". Do not answer with plain text.' },
        ],
        tools: [TOOL],
        maxTokens: 200,
      }, { model: config.visionModel }));
    }
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      records.push(await adapterCall(adapterModule, config, `stability:image-adapter:${repeat}`, '重复抽样：带图走适配器（maxTokens=30 被 clamp 到 100 下限）', {
        messages: adapterImageMessages,
        maxTokens: 30,
      }, { model: config.model }));
    }
  }

  // ===== H. 本地代理透传（不可达则 BLOCKED） ==============================
  evidence.proxy = await probeProxy(config);
  const proxyReachable = evidence.proxy.targets.some((target) => target.connectivity.connected);
  if (!proxyReachable) {
    evidence.limitations.push(
      '本地模型代理 127.0.0.1:17863 与局域网 192.168.222.1:17863 均不可达：代理是否原样透传 tools 无法实测，记 BLOCKED（不以官方 API 结果代替代理结论）。',
    );
  } else {
    evidence.limitations.push('代理可达但只做了最小 chat 探测；tools 透传需在代理上跑同一 tools 用例后才可下结论。');
  }

  // ===== 汇总 ============================================================
  evidence.cases = records;
  evidence.finishedAt = new Date().toISOString();
  finish(evidence, 0);
}

function compactCase(record) {
  const out = {
    id: record.id,
    transport: record.transport || null,
    purpose: record.purpose,
    latencyMs: record.latencyMs,
  };
  if (record.skipped) out.skipped = record.reason;
  if (record.error) out.error = record.error;
  const wire = record.wireBodies && record.wireBodies[0] ? record.wireBodies[0] : record.request;
  if (wire && !wire.unparsed) {
    out.request = {
      model: wire.model,
      max_tokens: wire.max_tokens,
      keys: wire.keys,
      tool_count: wire.tools ? wire.tools.count : 0,
      tool_choice: wire.tool_choice || null,
      response_format: wire.response_format || null,
      thinking: wire.thinking || null,
      reasoning_effort: wire.reasoning_effort || null,
      messages: Array.isArray(wire.messages)
        ? wire.messages.map((message) => ({
          role: message.role,
          contentKind: message.content && message.content.kind,
          parts: message.content && message.content.parts ? message.content.parts.map((part) => part.type) : undefined,
          contentLength: message.content && message.content.length,
          toolCalls: message.tool_calls ? message.tool_calls.count : undefined,
          toolCallArgsParseOk: message.tool_calls ? message.tool_calls.argumentsParseOk : undefined,
        }))
        : undefined,
    };
  }
  const response = record.response;
  if (response) {
    if (response.status !== undefined) {
      out.response = {
        status: response.status,
        bodyBytes: response.bodyBytes,
        finish_reason: response.choice0 ? response.choice0.finish_reason : null,
        content: response.choice0 ? response.choice0.content : null,
        reasoning: response.choice0 ? response.choice0.reasoningContent : null,
        toolCalls: response.choice0 && response.choice0.toolCalls
          ? {
            count: response.choice0.toolCalls.count,
            names: response.choice0.toolCalls.names,
            argumentsParseOk: response.choice0.toolCalls.argumentsParseOk,
            argumentsLengths: response.choice0.toolCalls.argumentsLengths,
          }
          : null,
        usage: response.usage
          ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
          : undefined,
        error: response.error || undefined,
        derived: response.derived || undefined,
      };
    } else if (Array.isArray(response.keys)) {
      out.response = {
        keys: response.keys,
        model: response.model,
        content: response.content,
        toolCalls: response.toolCalls,
        usage: response.usage,
        finishReasonPresent: response.finishReasonPresent,
        truncatedPresent: response.truncatedPresent,
      };
    } else {
      out.response = {
        model: response.model,
        finishReason: response.finishReason,
        truncated: response.truncated,
        content: response.content,
        toolCalls: response.toolCalls
          ? {
            count: response.toolCalls.count,
            names: response.toolCalls.names,
            argumentsParseOk: response.toolCalls.argumentsParseOk,
            argumentsLengths: response.toolCalls.argumentsLengths,
          }
          : null,
        usage: response.usage,
      };
    }
  }
  return out;
}

function compactEvidence(evidence) {
  const compact = {
    contract: evidence.contract,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    node: evidence.node,
    platform: evidence.platform,
    targetBaseUrlHost: evidence.targetBaseUrlHost,
    configuredModel: evidence.configuredModel,
    configuredVisionModel: evidence.configuredVisionModel,
    credentialSource: evidence.credentialSource,
    credentialPresent: evidence.credentialPresent,
    imageProbe: evidence.imageProbe,
    modelsEndpoint: evidence.modelsEndpoint,
    staticContract: evidence.staticContract,
    directStatic: evidence.directStatic,
    proxy: evidence.proxy,
    blocked: evidence.blocked,
    limitations: evidence.limitations,
    cases: (evidence.cases || []).map(compactCase),
  };
  return compact;
}

function finish(evidence, exitCode) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  // resultRef 只用于同一次进程内构造下一轮消息；落盘前剔除，避免写入模型正文/工具参数正文。
  const payload = COMPACT_OUTPUT ? compactEvidence(evidence) : evidence;
  const serialized = JSON.stringify(payload, (key, value) => (key === 'resultRef' ? undefined : value), 2);
  fs.writeFileSync(OUTPUT_PATH, `${serialized}\n`, 'utf8');

  const lines = [];
  lines.push(`evidence: ${path.relative(ROOT, OUTPUT_PATH)}`);
  lines.push(`baseUrlHost: ${evidence.targetBaseUrlHost || '-'}  configuredModel: ${evidence.configuredModel}  visionModel: ${evidence.configuredVisionModel}`);
  lines.push(`credential: ${evidence.credentialPresent ? `present (${evidence.credentialSource})` : 'MISSING'}`);
  if (evidence.blocked) lines.push(`BLOCKED: ${evidence.blocked.code} — ${evidence.blocked.reason}`);
  lines.push('');
  lines.push('case | transport | result');
  lines.push('--- | --- | ---');
  for (const record of evidence.cases || []) {
    if (record.skipped) {
      lines.push(`${record.id} | - | SKIPPED: ${record.reason}`);
      continue;
    }
    let outcome = '';
    if (record.error) {
      outcome = `ERR ${record.error.code || record.error.name}${record.error.status ? ` status=${record.error.status}` : ''}`;
    } else if (record.response) {
      if (record.response.status !== undefined) {
        const finishReason = record.response.choice0 ? record.response.choice0.finish_reason : null;
        const errorCode = record.response.error ? record.response.error.code : null;
        outcome = `HTTP ${record.response.status}${finishReason ? ` finish=${finishReason}` : ''}${errorCode ? ` error=${errorCode}` : ''}`;
      } else {
        outcome = `ok finish=${record.response.finishReason || '-'} tools=${record.response.toolCalls ? record.response.toolCalls.count : 0} contentLen=${record.response.content ? record.response.content.length : 0}`;
      }
    } else {
      outcome = 'no-response';
    }
    lines.push(`${record.id} | ${record.transport || '-'} | ${outcome} (${record.latencyMs}ms)`);
  }
  if (evidence.limitations.length > 0) {
    lines.push('');
    for (const limitation of evidence.limitations) lines.push(`LIMITATION: ${limitation}`);
  }
  console.log(lines.join('\n'));
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error('probe crashed:', sanitize(error && error.stack, 800));
  process.exitCode = 1;
});
