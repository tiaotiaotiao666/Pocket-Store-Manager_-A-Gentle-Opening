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
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000/api/v1';
const DEFAULT_MOCK_TIMEOUT_MS = 12000;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_CONTRACT_VERSION = 'agent-turn.v1';

/**
 * 「对话修改当前模板」专用端点（plan.md 2.2.8）。
 * 与 agent-turn 共用 baseUrl / timeout / transport 模式，但端点与契约版本独立，
 * 避免模板修改请求被误发到开店资料轮次路由上。
 */
const DEFAULT_TEMPLATE_REVISE_ENDPOINT = '/api/v1/agent/template-revise';
export const TEMPLATE_REVISE_CONTRACT_VERSION = 'agent-template-revise.v1';

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

  const rawBaseUrl = String(firstDefined(
    overrides.baseUrl,
    viteEnv.VITE_API_BASE_URL,
    readProcessEnv('VITE_API_BASE_URL'),
    '',
  )).trim();
  const baseUrl = rawBaseUrl || DEFAULT_API_BASE_URL;

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
    baseUrl,
    timeoutMs,
    contractVersion: DEFAULT_CONTRACT_VERSION,
    label: mode === 'http' ? modelLabel : MOCK_LABEL,
  };
}

/**
 * 把设置页里的 apiBaseUrl 与相对 Agent 端点拼成可直接请求的绝对地址。
 * 端点已是绝对地址时原样返回；baseUrl 为空时保留相对路径，交给 Vite 代理兜底。
 */
export function buildAgentRequestUrl(baseUrl, endpoint) {
  const rawEndpoint = String(endpoint || '').trim();
  if (/^https?:\/\//i.test(rawEndpoint)) return rawEndpoint;

  const rawBase = String(baseUrl || '').trim();
  if (!rawBase) return rawEndpoint;
  const base = rawBase.replace(/\/+$/, '');
  if (!rawEndpoint) return base;

  let basePath = '';
  try {
    basePath = new URL(base).pathname.replace(/\/+$/, '');
  } catch (error) {
    basePath = '';
  }

  const suffix = rawEndpoint.startsWith('/') ? rawEndpoint : `/${rawEndpoint}`;
  if (basePath && basePath !== '/' && (suffix === basePath || suffix.startsWith(`${basePath}/`))) {
    return `${base}${suffix.slice(basePath.length)}`;
  }
  return `${base}${suffix}`;
}

const resolved = resolveAgentTransportConfig();
let runtimeOverrides = null;

export const AGENT_TRANSPORT = resolved.mode;
export const AGENT_ENDPOINT = resolved.endpoint;
export const AGENT_TIMEOUT_MS = resolved.timeoutMs;
export const AGENT_CONTRACT_VERSION = resolved.contractVersion;

/**
 * 应用运行时覆盖（来自设置页保存的配置）。
 * 未提供的字段继续沿用 VITE_ 环境变量或默认值。
 */
export function applyAgentRuntimeConfig(config = {}) {
  const next = {};
  const source = config && typeof config === 'object' ? config : {};
  if (source.transport !== undefined) next.transport = source.transport;
  if (source.endpoint !== undefined) next.endpoint = source.endpoint;
  if (source.baseUrl !== undefined) next.baseUrl = source.baseUrl;
  if (source.timeoutMs !== undefined) next.timeoutMs = source.timeoutMs;
  if (source.modelLabel !== undefined) next.modelLabel = source.modelLabel;
  runtimeOverrides = next;
  return getAgentTransportConfig();
}

export function resetAgentRuntimeConfig() {
  runtimeOverrides = null;
}

export function getAgentTransportConfig() {
  return resolveAgentTransportConfig(runtimeOverrides || {});
}

export function describeAgentTransport() {
  const current = getAgentTransportConfig();
  return { mode: current.mode, label: current.label };
}
/**
 * 「对话修改当前模板」的传输配置（plan.md 2.2.8）。
 *
 * 与 agent-turn 共用 baseUrl / timeout / transport 模式，只替换端点与契约版本：
 * - VITE_AGENT_TEMPLATE_REVISE_ENDPOINT（默认 /api/v1/agent/template-revise）
 * - VITE_AGENT_CONTRACT_VERSION 不影响本端点，模板修改契约版本固定。
 */
export function resolveTemplateReviseConfig(overrides = {}) {
  const base = resolveAgentTransportConfig(overrides);
  const viteEnv = readViteEnv();
  const rawEndpoint = String(firstDefined(
    overrides.templateReviseEndpoint,
    viteEnv.VITE_AGENT_TEMPLATE_REVISE_ENDPOINT,
    readProcessEnv('VITE_AGENT_TEMPLATE_REVISE_ENDPOINT'),
    '',
  )).trim();

  return {
    mode: base.mode,
    endpoint: rawEndpoint || DEFAULT_TEMPLATE_REVISE_ENDPOINT,
    baseUrl: base.baseUrl,
    timeoutMs: base.timeoutMs,
    contractVersion: TEMPLATE_REVISE_CONTRACT_VERSION,
  };
}

export function getTemplateReviseConfig() {
  return resolveTemplateReviseConfig(runtimeOverrides || {});
}

export const TEMPLATE_REVISE_ENDPOINT = resolveTemplateReviseConfig().endpoint;