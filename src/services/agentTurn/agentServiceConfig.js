/**
 * Agent 传输配置。
 *
 * 支持两种 transport：
 * - mock：本地规则解析，零网络请求，桌面端默认值（没有后端时页面仍可启动）。
 * - http：POST /api/v1/agent/turn → NestJS → DeepSeek。
 *
 * 环境变量（只读取 VITE_ 前缀，绝不读取或转发 DEEPSEEK_API_KEY）：
 * - VITE_AGENT_TRANSPORT=mock|http
 * - VITE_AGENT_ENDPOINT=/api/v1/agent/turn
 * - VITE_AGENT_TIMEOUT_MS=12000（mock）/ 30000（http）
 */

const DEFAULT_ENDPOINT = '/api/v1/agent/turn';
const DEFAULT_MOCK_TIMEOUT_MS = 12000;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_CONTRACT_VERSION = 'agent-turn.v1';

const MOCK_LABEL = '本地 Mock（未接入真实模型）';
const HTTP_LABEL = 'DeepSeek 后端（真实模型）';

function readViteEnv() {
  try {
    const env = import.meta.env;
    return env && typeof env === 'object' ? env : {};
  } catch (error) {
    return {};
  }
}

function readProcessEnv(name) {
  if (typeof process === 'undefined' || !process.env) return '';
  const value = process.env[name];
  return typeof value === 'string' ? value : '';
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return '';
}

/**
 * 纯函数，便于在没有构建工具的环境（Node 测试）里直接验证。
 */
export function resolveAgentTransportConfig(overrides = {}) {
  const viteEnv = readViteEnv();

  const rawMode = String(firstDefined(
    overrides.transport,
    viteEnv.VITE_AGENT_TRANSPORT,
    readProcessEnv('VITE_AGENT_TRANSPORT'),
    '',
  )).trim().toLowerCase();
  const mode = rawMode === 'http' ? 'http' : 'mock';

  const rawEndpoint = String(firstDefined(
    overrides.endpoint,
    viteEnv.VITE_AGENT_ENDPOINT,
    readProcessEnv('VITE_AGENT_ENDPOINT'),
    '',
  )).trim();
  const endpoint = rawEndpoint || DEFAULT_ENDPOINT;

  const fallbackTimeout = mode === 'http' ? DEFAULT_HTTP_TIMEOUT_MS : DEFAULT_MOCK_TIMEOUT_MS;
  const rawTimeout = Number(firstDefined(
    overrides.timeoutMs,
    viteEnv.VITE_AGENT_TIMEOUT_MS,
    readProcessEnv('VITE_AGENT_TIMEOUT_MS'),
    '',
  ));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 1000
    ? Math.floor(rawTimeout)
    : fallbackTimeout;
  const modelLabel = String(firstDefined(
    overrides.modelLabel,
    viteEnv.VITE_AGENT_MODEL_LABEL,
    readProcessEnv('VITE_AGENT_MODEL_LABEL'),
    HTTP_LABEL,
  )).trim() || HTTP_LABEL;

  return {
    mode,
    endpoint,
    timeoutMs,
    contractVersion: DEFAULT_CONTRACT_VERSION,
    label: mode === 'http' ? modelLabel : MOCK_LABEL,
  };
}

const resolved = resolveAgentTransportConfig();

export const AGENT_TRANSPORT = resolved.mode;
export const AGENT_ENDPOINT = resolved.endpoint;
export const AGENT_TIMEOUT_MS = resolved.timeoutMs;
export const AGENT_CONTRACT_VERSION = resolved.contractVersion;

export function describeAgentTransport() {
  return { mode: resolved.mode, label: resolved.label };
}