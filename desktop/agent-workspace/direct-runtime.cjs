'use strict';

/**
 * E0-W2（X4 交付锁）：direct 通道的**惰性**运行时装配。
 *
 * 背景：`WorkspaceRunCoordinator` 是桌面侧唯一执行所有者；`directRuntime` 只是它内部
 * `invokeDirect()` 的一个可选下游（模型直连通道）。本模块只做三件事：
 *
 * 1. **惰性**：`coordinator` 可以是 getter（`() => workspaceRunCoordinator`），每次调用才解析，
 *    避免 main.cjs 里的单例创建顺序问题；
 * 2. **凭据只在主进程**：默认传输实现就是 `createModelCredentials(...).chat`（内含 safeStorage 解密、
 *    ≤3 槽位调度、超时与错误码映射）；未接线/未配置时**显式**返回 `AGENT_RUNTIME_TOOL_MISSING`，
 *    绝不静默降级成“假成功”；
 * 3. **有界**：请求只接受有界 chat 载荷（messages 数组 + 纯文本 content），拒绝对路径/base64 data URI/
 *    任意命令；返回只回 `content/finishReason/usage/model`，不回密钥、不回原样请求。
 *
 * 不属于本模块的：真实 Flash 话术与工具循环（E0-R1/t8 验收），以及把 direct 结果写进候选树
 * （写入永远只能经 coordinator 的 write_files）。
 */

const path = require('node:path');

const { CODES } = require('./constants.cjs');

const LIMITS = Object.freeze({
  maxMessages: 24,
  maxMessageChars: 20000,
  maxTotalChars: 60000,
  maxContentChars: 24000,
  maxMessageCharsInError: 240,
});

const DIRECT_CODES = Object.freeze({
  RUNTIME_TOOL_MISSING: 'AGENT_RUNTIME_TOOL_MISSING',
  PAYLOAD_INVALID: 'AGENT_PAYLOAD_INVALID',
  TXN_ABORTED: CODES.TXN_ABORTED,
});

function failure(code, message) {
  return {
    ok: false,
    code: code || DIRECT_CODES.TXN_ABORTED,
    message: String(message || '').slice(0, LIMITS.maxMessageCharsInError),
    issues: [],
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 请求里不得出现绝对路径 / 盘符 / base64 data URI（模型输入只应有文本与既有 assetId 引用）。 */
function payloadLooksClean(text) {
  if (/[A-Za-z]:[\\/]/.test(text)) return false;
  if (/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(text)) return false;
  if (/\bsk-[A-Za-z0-9]{8,}\b/.test(text)) return false;
  return true;
}

/** 归一 + 校验 direct 请求（有界，纯文本）。 */
function normalizeRequest(raw) {
  if (!isPlainObject(raw)) return failure(DIRECT_CODES.PAYLOAD_INVALID, 'direct 请求必须是对象');
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return failure(DIRECT_CODES.PAYLOAD_INVALID, 'direct 请求缺少 messages');
  }
  if (messages.length > LIMITS.maxMessages) {
    return failure(DIRECT_CODES.PAYLOAD_INVALID, 'messages 数量超过 ' + LIMITS.maxMessages);
  }
  let total = 0;
  const normalized = [];
  for (const message of messages) {
    if (!isPlainObject(message)) return failure(DIRECT_CODES.PAYLOAD_INVALID, 'messages 项必须是对象');
    const role = message.role;
    if (!['system', 'user', 'assistant'].includes(role)) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'role 只接受 system/user/assistant');
    }
    if (typeof message.content !== 'string') {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'content 必须是字符串（图片走既有 assetId 通道）');
    }
    if (message.content.length > LIMITS.maxMessageChars) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'content 超过 ' + LIMITS.maxMessageChars + ' 字');
    }
    if (!payloadLooksClean(message.content)) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'content 不得包含绝对路径/base64/密钥');
    }
    total += message.content.length;
    normalized.push({ role, content: message.content });
  }
  if (total > LIMITS.maxTotalChars) {
    return failure(DIRECT_CODES.PAYLOAD_INVALID, '请求总长度超过 ' + LIMITS.maxTotalChars + ' 字');
  }
  const out = { messages: normalized };
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model.length === 0 || raw.model.length > 64) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'model 必须是有界字符串');
    }
    out.model = raw.model;
  }
  // 只有白名单字段能进网络请求：temperature/max_tokens 等由凭据层 normalizeChatPayload 兜底。
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature)
      || raw.temperature < 0 || raw.temperature > 2) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'temperature 必须在 0..2');
    }
    out.temperature = raw.temperature;
  }
  return { ok: true, request: out, chars: total };
}

function createDirectWorkspaceRuntime(options) {
  const opts = isPlainObject(options) ? options : {};
  const coordinatorRef = opts.coordinator;
  const credentials = opts.credentials || null;
  const setTimeoutImpl = typeof opts.setTimeoutImpl === 'function' ? opts.setTimeoutImpl : null;

  /** 显式传输：测试可注入；生产默认用凭据层的 chat（含调度器、超时、错误码映射）。 */
  const transport = typeof opts.transport === 'function'
    ? opts.transport
    : (credentials && typeof credentials.chat === 'function'
      ? (request, callOptions) => credentials.chat(request, callOptions)
      : null);

  function resolveCoordinator() {
    if (typeof coordinatorRef === 'function') {
      try {
        return coordinatorRef() || null;
      } catch (error) {
        return null;
      }
    }
    return coordinatorRef || null;
  }

  /** 只读自检描述：不含密钥、不含路径。 */
  function describe() {
    return {
      ready: Boolean(resolveCoordinator() && transport),
      hasCoordinator: Boolean(resolveCoordinator()),
      hasTransport: Boolean(transport),
      defaultTransport: Boolean(credentials && typeof credentials.chat === 'function'),
    };
  }

  async function invoke(input) {
    const payload = isPlainObject(input) ? input : {};
    const context = isPlainObject(payload.context) ? payload.context : {};
    // 1) 主体必须由平台给（attempt 上下文），模型不能自带 projectId/runId。
    for (const key of ['projectId', 'runId', 'turnId', 'attemptId']) {
      if (typeof context[key] !== 'string' || context[key] === '') {
        return failure(DIRECT_CODES.PAYLOAD_INVALID, 'direct 上下文缺少 ' + key);
      }
    }
    if (!isPlainObject(context.subject) || context.subject.kind !== 'attempt') {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'direct 上下文主体必须是 attempt');
    }
    if (context.subject.attemptId !== context.attemptId) {
      return failure(DIRECT_CODES.PAYLOAD_INVALID, 'direct 上下文的 attemptId 与 subject 不一致');
    }
    // 2) 接线检查：缺 coordinator / 缺传输 → 显式 RUNTIME_TOOL_MISSING（不静默降级）。
    const coordinator = resolveCoordinator();
    if (!coordinator) {
      return failure(DIRECT_CODES.RUNTIME_TOOL_MISSING, 'direct 通道缺少 WorkspaceRunCoordinator');
    }
    if (!transport) {
      return failure(DIRECT_CODES.RUNTIME_TOOL_MISSING, 'direct 通道未接线模型传输（credential.chat 不可用）');
    }
    // 3) 请求有界校验：不合法则**不发起**网络调用。
    const normalized = normalizeRequest(payload.request);
    if (!normalized.ok) return normalized;

    try {
      const raw = await transport(normalized.request, {
        subject: context.subject,
        projectId: context.projectId,
        runId: context.runId,
        ...(setTimeoutImpl ? { setTimeoutImpl } : {}),
      });
      if (isPlainObject(raw) && raw.ok === false) {
        // 下游已经给出结构化失败：原样透出（码只能是 AGENT_*）。
        return {
          ok: false,
          code: typeof raw.code === 'string' && /^AGENT_[A-Z_]+$/.test(raw.code) ? raw.code : DIRECT_CODES.TXN_ABORTED,
          message: String(raw.message || 'direct 调用失败').slice(0, LIMITS.maxMessageCharsInError),
          issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 20) : [],
        };
      }
      const choice = isPlainObject(raw) && Array.isArray(raw.choices) ? raw.choices[0] : null;
      const content = choice && isPlainObject(choice.message) && typeof choice.message.content === 'string'
        ? choice.message.content
        : (isPlainObject(raw) && typeof raw.content === 'string' ? raw.content : '');
      if (content.length > LIMITS.maxContentChars) {
        return failure(DIRECT_CODES.TXN_ABORTED, 'direct 返回内容超过上限（' + content.length + ' 字）');
      }
      return {
        ok: true,
        data: {
          content,
          finishReason: (choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null),
          model: (isPlainObject(raw) && typeof raw.model === 'string' ? raw.model.slice(0, 64) : null),
          chars: content.length,
        },
        issues: [],
      };
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : '';
      // 未配置 Key / 不可达：如实还是“能力缺失”，绝不返回空成功。
      if (code === 'DEEPSEEK_NOT_CONFIGURED') {
        return failure(DIRECT_CODES.RUNTIME_TOOL_MISSING, 'direct 通道未配置模型凭据');
      }
      const message = error && error.message ? path.basename(String(error.message)) : 'direct 调用失败';
      return failure(DIRECT_CODES.TXN_ABORTED, message);
    }
  }

  return { invoke, describe };
}

module.exports = {
  createDirectWorkspaceRuntime,
  normalizeRequest,
  LIMITS,
  DIRECT_CODES,
};
