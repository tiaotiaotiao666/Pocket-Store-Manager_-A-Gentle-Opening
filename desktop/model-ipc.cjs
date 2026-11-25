'use strict';

/**
 * 模型与 API 的受信 IPC（Electron 主进程）。
 *
 * 渲染进程只能调用这 5 个语义通道，拿不到 Key 明文，也不能对任意 URL 发请求：
 * - settings:model-key:status → { configured, updatedAt }
 * - settings:model-key:save   → 保存（safeStorage 加密）后只回状态
 * - settings:model-key:clear  → 清除
 * - settings:model:test       → 用当前地址/模型发一条最小请求验证可用性
 * - settings:model:chat       → 直连模式下的一次对话（messages + tools）
 *
 * 统一返回体：{ ok: true, data } / { ok: false, code, message }。
 */

const { isTrustedSender } = require('./composer-ipc.cjs');
const { ModelCredentialError } = require('./model-credentials.cjs');

function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function toResult(error, fallbackCode, fallbackMessage) {
  if (error instanceof ModelCredentialError) {
    return fail(error.code, error.message);
  }
  return fail(fallbackCode, fallbackMessage);
}

/**
 * 直连对话返回体归一（rev15 §14.7 modelChat 对等）：
 * `finishReason` 与 `truncated` **必须**存在，`finish_reason=length` 一律是 truncated，
 * 即便正文为空也不能被上层当成“无响应”。既有字段（model/content/toolCalls/usage）保持不变。
 */
function normalizeChatResult(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const finishReason = typeof source.finishReason === 'string' ? source.finishReason : '';
  return {
    model: typeof source.model === 'string' ? source.model : '',
    content: typeof source.content === 'string' ? source.content : '',
    toolCalls: Array.isArray(source.toolCalls) ? source.toolCalls : [],
    usage: source.usage && typeof source.usage === 'object' ? source.usage : null,
    finishReason,
    truncated: source.truncated === true || finishReason === 'length',
    maxTokens: Number.isInteger(source.maxTokens) ? source.maxTokens : null,
    profile: source.profile === 'direct-edit' ? 'direct-edit' : 'chat',
  };
}

function createModelIpc(options) {
  const opts = options || {};
  const credentials = opts.credentials;
  const settings = opts.settings;
  if (!credentials || !settings) {
    throw new Error('createModelIpc 需要 credentials / settings');
  }

  async function readDefaults() {
    try {
      const loaded = await settings.loadConfig();
      const config = loaded && loaded.config ? loaded.config : {};
      return {
        baseUrl: config.modelApiBaseUrl || 'https://api.deepseek.com',
        model: config.modelName || 'deepseek-flash',
        timeoutMs: Number.isInteger(config.modelTimeoutMs) ? config.modelTimeoutMs : 60000,
      };
    } catch (error) {
      return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 60000 };
    }
  }

  const handlers = {
    'settings:model-key:status': async () => {
      try {
        return ok(await credentials.status());
      } catch (error) {
        return toResult(error, 'MODEL_KEY_UNREADABLE', 'API Key 状态读取失败，请重新填写一次。');
      }
    },

    'settings:model-key:save': async (_event, payload) => {
      const key = payload && typeof payload.key === 'string' ? payload.key : '';
      try {
        return ok(await credentials.setKey(key));
      } catch (error) {
        return toResult(error, 'MODEL_KEY_WRITE_FAILED', 'API Key 保存失败，请稍后重试。');
      }
    },

    'settings:model-key:clear': async () => {
      try {
        return ok(await credentials.clearKey());
      } catch (error) {
        return toResult(error, 'MODEL_KEY_WRITE_FAILED', 'API Key 清除失败，请稍后重试。');
      }
    },

    'settings:model:test': async (_event, payload) => {
      const source = payload && typeof payload === 'object' ? payload : {};
      const defaults = await readDefaults();
      const result = await credentials.test({
        baseUrl: typeof source.baseUrl === 'string' && source.baseUrl ? source.baseUrl : defaults.baseUrl,
        model: typeof source.model === 'string' && source.model ? source.model : defaults.model,
      });
      return result.ok === true ? ok(result) : fail(result.code, result.message);
    },

    'settings:model:chat': async (_event, payload) => {
      const source = payload && typeof payload === 'object' ? payload : {};
      const defaults = await readDefaults();
      try {
        const result = await credentials.chat({
          baseUrl: typeof source.baseUrl === 'string' && source.baseUrl ? source.baseUrl : defaults.baseUrl,
          model: typeof source.model === 'string' && source.model ? source.model : defaults.model,
          timeoutMs: Number.isInteger(source.timeoutMs) ? source.timeoutMs : defaults.timeoutMs,
          maxTokens: source.maxTokens,
          // 'direct-edit' 走 §14.7 的 6000/8000 预算；省略等同普通对话（1200/4096）。
          profile: source.profile === 'direct-edit' ? 'direct-edit' : 'chat',
          temperature: source.temperature,
          messages: source.messages,
          tools: source.tools,
          thinking: source.thinking,
        });
        return ok(normalizeChatResult(result));
      } catch (error) {
        return toResult(error, 'DEEPSEEK_UPSTREAM_ERROR', '模型服务暂时不可用，请稍后重试。');
      }
    },
  };

  return { handlers };
}

function registerModelIpc(ipcMain, options) {
  const created = createModelIpc(options);
  Object.entries(created.handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        return fail('UNTRUSTED_SENDER', '请求来源不受信任');
      }
      return handler(event, payload);
    });
  });
  return created;
}

module.exports = {
  createModelIpc,
  registerModelIpc,
  normalizeChatResult,
};
