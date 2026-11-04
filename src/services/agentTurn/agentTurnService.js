import {
  buildNextQuestion,
  fromContractDraft,
  normalizeAgentDraft,
  toContractDraft,
  validateAgentDraft,
} from '../../domain/agentDraft.mjs';
import { validateAgentImages } from '../../domain/agentImageInput.mjs';
import {
  AGENT_CONTRACT_VERSION,
  applyAgentRuntimeConfig,
  describeAgentTransport as describeTransport,
  getAgentTransportConfig,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  isAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';
import { toAgentTurnImages } from './agentImageUpload.js';
import { createHttpTransport } from './httpAgentTransport.js';
import { createMockTransport } from './mockAgentTransport.js';

export { getAgentTransportConfig };
export { AGENT_TURN_V2_CONTRACT_VERSION } from './httpAgentTransport.js';

/**
 * 多模态契约版本（plan.md 2.2.7）。
 * 与 transport 内常量同值，但这里再次本地声明避免循环依赖。
 */
const AGENT_TURN_V2_CONTRACT = 'agent-turn.v2';

const MAX_UTTERANCE = 500;
let fallbackTransport = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveFetchImpl() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

function resolveTransport(transport) {
  if (transport) {
    if (typeof transport.send !== 'function') {
      throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN');
    }
    return transport;
  }
  if (fallbackTransport) return fallbackTransport;

  const config = getAgentTransportConfig();

  if (config.mode === 'http') {
    // 只携带短期 Token（默认不携带）；DeepSeek API Key 永远留在服务端。
    fallbackTransport = createHttpTransport({
      fetchImpl: resolveFetchImpl(),
      endpoint: config.endpoint,
      timeoutMs: config.timeoutMs,
    });
    return fallbackTransport;
  }

  if (config.mode === 'mock') {
    fallbackTransport = createMockTransport();
    return fallbackTransport;
  }

  throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN');
}

function createResult(response, draft, validation) {
  return {
    draft,
    validation,
    nextQuestion: buildNextQuestion(validation),
    reply: typeof response.reply === 'string' ? response.reply : '',
    meta: isPlainObject(response.meta) ? response.meta : null,
    // 前端最终状态只由本地 validateAgentDraft 决定，不信任服务端 status。
    status: validation.readyForReview ? 'reviewing' : 'collecting',
    turnId: typeof response.turnId === 'string' ? response.turnId : null,
  };
}

function normalizeVision(value) {
  if (!isPlainObject(value)) return null;
  return {
    menuImages: Number.isInteger(value.menuImages) ? value.menuImages : 0,
    storeImages: Number.isInteger(value.storeImages) ? value.storeImages : 0,
    analyzed: value.analyzed === true,
    degraded: value.degraded === true,
  };
}

/**
 * 图片超限时抛出结构化的 AgentTurnError（带 code/message/details、`ok:false`），
 * 由调用方在发送前拦截，绝不发起网络请求。
 */
function createStructuredImageError(validation) {
  const error = createAgentTurnError(validation.code, {
    message: validation.message,
    retryable: false,
    details: { scope: 'images' },
  });
  error.ok = false;
  error.structured = true;
  return error;
}

export function createAgentTurnService(options = {}) {
  const transport = resolveTransport(options.transport);
  let pendingFailure = false;

  return {
    describeAgentTransport: describeTransport,
    transportName: transport.name,

    async requestAgentTurn({ utterance, draft, images, simulateFailureOnce = false } = {}) {
      const text = String(utterance ?? '').trim();
      if (!text || Array.from(text).length > MAX_UTTERANCE) {
        throw createAgentTurnError('AGENT_REQUEST_INVALID');
      }

      // 图片在发送前用纯函数校验；超限直接抛结构化错误，不发请求。
      const hasImages = Array.isArray(images) && images.length > 0;
      if (hasImages) {
        const imageValidation = validateAgentImages(images);
        if (!imageValidation.ok) {
          throw createStructuredImageError(imageValidation);
        }
      }

      const contractVersion = hasImages ? AGENT_TURN_V2_CONTRACT : AGENT_CONTRACT_VERSION;
      const contractDraft = toContractDraft(draft);
      const request = {
        contractVersion,
        utterance: text,
        draft: contractDraft,
        client: { surface: 'desktop', phase: 'store-info' },
        projectId: null,
      };
      if (hasImages) {
        request.images = toAgentTurnImages(images);
      }

      const failOnce = Boolean(simulateFailureOnce) && transport.name === 'mock';
      pendingFailure = failOnce;

      let response;
      try {
        response = await transport.send(request, { failOnce: pendingFailure });
      } catch (error) {
        if (isAgentTurnError(error)) throw error;
        throw normalizeAgentTurnError(error);
      } finally {
        pendingFailure = false;
      }

      if (!isPlainObject(response)) {
        throw createAgentTurnError('AGENT_RESPONSE_INVALID');
      }
      if (response.contractVersion !== contractVersion) {
        throw createAgentTurnError('AGENT_CONTRACT_MISMATCH');
      }
      if (!isPlainObject(response.draft) || !isPlainObject(response.meta)) {
        throw createAgentTurnError('AGENT_RESPONSE_INVALID');
      }

      const normalizedDraft = normalizeAgentDraft(fromContractDraft(response.draft));
      const validation = validateAgentDraft(normalizedDraft);
      const result = createResult(response, normalizedDraft, validation);

      // v2 才透出 vision；v1 结果形状保持不变。
      if (contractVersion === AGENT_TURN_V2_CONTRACT) {
        result.vision = normalizeVision(response.vision);
      }
      return result;
    },
  };
}

let defaultService = null;

export function requestAgentTurn(params) {
  if (!defaultService) defaultService = createAgentTurnService();
  return defaultService.requestAgentTurn(params);
}

export function describeAgentTransport() {
  return describeTransport();
}

/**
 * 把设置页保存的模型配置应用到运行时，并丢弃按旧配置缓存的 transport。
 * 调用方负责在设置加载/保存成功后执行。
 */
export function configureAgentRuntime(settings = {}) {
  const resolved = applyAgentRuntimeConfig({
    transport: settings.agentTransport,
    endpoint: settings.agentEndpoint,
    baseUrl: settings.apiBaseUrl,
    timeoutMs: settings.agentTimeoutMs,
  });
  defaultService = null;
  fallbackTransport = null;
  return resolved;
}

export function resetAgentTurnService() {
  defaultService = null;
  fallbackTransport = null;
}

export function resetAgentTurnServiceForTests() {
  resetAgentTurnService();
}