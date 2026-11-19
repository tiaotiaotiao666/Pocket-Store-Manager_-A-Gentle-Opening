import { validateAppAssistantResponse } from '../../domain/appAssistantProposal.mjs';
import {
  createAgentTurnError,
  isAgentTurnError,
  normalizeAgentTurnError,
} from '../agentTurn/agentTurnError.js';
import {
  APP_ASSISTANT_CONTRACT_VERSION,
  resolveAppAssistantConfig,
} from './appAssistantConfig.js';
import { createAppAssistantError } from './appAssistantError.js';
import { buildAppAssistantRequest } from './appAssistantRequest.mjs';
import { createDirectAppAssistantTransport } from './directAppAssistantTransport.js';
import { createHttpAppAssistantTransport } from './httpAppAssistantTransport.js';
import { createMockAppAssistantTransport } from './mockAppAssistantTransport.js';

/**
 * 统一会话服务（T5）。
 *
 * 职责只有三件：组请求 → 选 transport → 用桌面校验器验响应外壳。
 * 不写 business state、不碰 reducer、不决定确认级别——那些属于 T3/T6。
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveFetchImpl(options) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

export function createAppAssistantTransport(options = {}) {
  if (options.transport) {
    if (typeof options.transport.send !== 'function') {
      throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
        message: '注入的 transport 缺少 send 方法。',
      });
    }
    return options.transport;
  }

  const config = resolveAppAssistantConfig(options);
  if (config.mode === 'direct') {
    return createDirectAppAssistantTransport({
      chat: options.chat,
      getModel: options.getModel,
    });
  }
  if (config.mode === 'http') {
    return createHttpAppAssistantTransport({
      fetchImpl: resolveFetchImpl(options),
      getAuthorization: options.getAuthorization,
      endpoint: config.endpoint,
      timeoutMs: config.timeoutMs,
    });
  }
  return createMockAppAssistantTransport();
}

export function createAppAssistantService(options = {}) {
  const transport = createAppAssistantTransport(options);

  return {
    transportName: transport.name,
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,

    /**
     * @param {object} params 见 buildAppAssistantRequest；另支持 signal。
     * @returns {Promise<{request: object, proposal: object, meta: object|null, transport: string, contractVersion: string}>}
     */
    async requestAppAssistant(params = {}) {
      const request = buildAppAssistantRequest(params);

      let raw;
      try {
        raw = await transport.send(request, { signal: params.signal });
      } catch (error) {
        if (isAgentTurnError(error)) throw error;
        throw normalizeAgentTurnError(error);
      }

      const checked = validateAppAssistantResponse(raw, {
        requestId: request.requestId,
        catalogVersion: request.catalogVersion,
        contextRevision: request.contextRevision,
        state: isPlainObject(params.state) ? params.state : undefined,
      });
      if (!checked.ok) {
        throw createAppAssistantError(checked.code, {
          message: checked.message,
          details: { requestId: request.requestId },
        });
      }

      return {
        request,
        proposal: checked.proposal,
        meta: isPlainObject(raw && raw.meta) ? raw.meta : null,
        transport: transport.name,
        contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
      };
    },
  };
}

let defaultService = null;

export function requestAppAssistant(params) {
  if (!defaultService) defaultService = createAppAssistantService();
  return defaultService.requestAppAssistant(params);
}

export function resetAppAssistantService() {
  defaultService = null;
}