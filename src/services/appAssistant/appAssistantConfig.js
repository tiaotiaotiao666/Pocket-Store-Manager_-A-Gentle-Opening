import { buildAgentRequestUrl, getAgentTransportConfig } from '../agentTurn/agentServiceConfig.js';

/**
 * 统一会话 `app-assistant.v1` 的传输配置。
 *
 * 与 agent-turn 共用 baseUrl / transport 模式与超时默认值，只替换端点与契约版本：
 * - `VITE_AGENT_APP_ASSISTANT_ENDPOINT`（默认 `/api/v1/agent/app-assistant`）
 * - `VITE_AGENT_APP_ASSISTANT_TIMEOUT_MS`（缺省沿用当前 transport 的超时）
 */
export const APP_ASSISTANT_ENDPOINT = '/api/v1/agent/app-assistant';
export const APP_ASSISTANT_CONTRACT_VERSION = 'app-assistant.v1';

const TRANSPORT_MODES = Object.freeze(['http', 'direct', 'mock']);

function readEnv(name) {
  let value = '';
  try {
    const env = import.meta.env;
    if (env && typeof env === 'object' && env[name] !== undefined) value = env[name];
  } catch (error) {
    value = '';
  }
  if (value !== '' && value !== undefined && value !== null) return String(value);
  if (typeof process === 'undefined' || !process.env) return '';
  const fromProcess = process.env[name];
  return typeof fromProcess === 'string' ? fromProcess : '';
}

export function resolveAppAssistantConfig(overrides = {}) {
  const base = getAgentTransportConfig();

  const rawMode = String(overrides.mode ?? base.mode ?? 'mock').trim().toLowerCase();
  const mode = TRANSPORT_MODES.includes(rawMode) ? rawMode : 'mock';

  const endpoint = String(
    overrides.endpoint ?? readEnv('VITE_AGENT_APP_ASSISTANT_ENDPOINT') ?? '',
  ).trim() || APP_ASSISTANT_ENDPOINT;

  const rawTimeout = Number(
    overrides.timeoutMs ?? readEnv('VITE_AGENT_APP_ASSISTANT_TIMEOUT_MS') ?? base.timeoutMs,
  );
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 1000
    ? Math.floor(rawTimeout)
    : (Number.isFinite(base.timeoutMs) ? base.timeoutMs : 60000);

  return {
    mode,
    endpoint,
    baseUrl: base.baseUrl,
    timeoutMs,
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
  };
}

export function buildAppAssistantRequestUrl(config) {
  return buildAgentRequestUrl(config.baseUrl, config.endpoint);
}

export function isAppAssistantTransportMode(value) {
  return TRANSPORT_MODES.includes(value);
}