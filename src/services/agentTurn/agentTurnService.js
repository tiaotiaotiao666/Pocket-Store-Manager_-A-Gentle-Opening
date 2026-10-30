import {
  buildNextQuestion,
  fromContractDraft,
  normalizeAgentDraft,
  toContractDraft,
  validateAgentDraft,
} from '../../domain/agentDraft.mjs';
import {
  AGENT_CONTRACT_VERSION,
  AGENT_ENDPOINT,
  AGENT_TIMEOUT_MS,
  AGENT_TRANSPORT,
  describeAgentTransport as describeTransport,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  isAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';
import { createHttpTransport } from './httpAgentTransport.js';
import { createMockTransport } from './mockAgentTransport.js';

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

  if (AGENT_TRANSPORT === 'http') {
    // 只携带短期 Token（默认不携带）；DeepSeek API Key 永远留在服务端。
    fallbackTransport = createHttpTransport({
      fetchImpl: resolveFetchImpl(),
      endpoint: AGENT_ENDPOINT,
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    return fallbackTransport;
  }

  if (AGENT_TRANSPORT === 'mock') {
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

export function createAgentTurnService(options = {}) {
  const transport = resolveTransport(options.transport);
  let pendingFailure = false;

  return {
    describeAgentTransport: describeTransport,
    transportName: transport.name,

    async requestAgentTurn({ utterance, draft, simulateFailureOnce = false } = {}) {
      const text = String(utterance ?? '').trim();
      if (!text || Array.from(text).length > MAX_UTTERANCE) {
        throw createAgentTurnError('AGENT_REQUEST_INVALID');
      }

      const contractDraft = toContractDraft(draft);
      const request = {
        contractVersion: AGENT_CONTRACT_VERSION,
        utterance: text,
        draft: contractDraft,
        client: { surface: 'desktop', phase: 'store-info' },
        projectId: null,
      };

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
      if (response.contractVersion !== AGENT_CONTRACT_VERSION) {
        throw createAgentTurnError('AGENT_CONTRACT_MISMATCH');
      }
      if (!isPlainObject(response.draft) || !isPlainObject(response.meta)) {
        throw createAgentTurnError('AGENT_RESPONSE_INVALID');
      }

      const normalizedDraft = normalizeAgentDraft(fromContractDraft(response.draft));
      const validation = validateAgentDraft(normalizedDraft);
      return createResult(response, normalizedDraft, validation);
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

export function resetAgentTurnServiceForTests() {
  defaultService = null;
  fallbackTransport = null;
}