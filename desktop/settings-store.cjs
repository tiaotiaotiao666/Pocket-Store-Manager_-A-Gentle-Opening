'use strict';

/**
 * 应用设置存储（Electron 主进程）。
 *
 * config.json 与项目目录平级，不属于任何项目（实现方案 4.2）。
 * 写盘前做键白名单 + 取值校验；敏感键一律拒绝，未知键归入 unmappedFields，绝不写到顶层。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { writeFileAtomic, ProjectStoreError, PROJECT_ID_RE } = require('./project-store.cjs');

const SCHEMA_VERSION = 1;
const MAX_CONFIG_BYTES = 16 * 1024;
const SENSITIVE_KEY_RE = /(api[-_]?key|secret|token|password|authorization|openid|cookie)/i;

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  apiBaseUrl: 'http://127.0.0.1:3000/api/v1',
  agentTransport: 'mock',
  agentEndpoint: '/api/v1/agent/turn',
  agentTimeoutMs: 30000,
  defaultAppid: '',
  autoSaveEnabled: true,
  autoSaveDebounceMs: 800,
  maxBackups: 3,
  lastProjectId: '',
  uiScale: 'default',
});

const ALLOWED_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));
const APPID_RE = /^wx[0-9a-f]{16}$/;

function defaultConfig(overrides) {
  return { ...DEFAULT_CONFIG, ...(overrides || {}) };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBoolean(value, field, errors) {
  if (typeof value !== 'boolean') errors.push({ field, message: '必须是布尔值' });
}

function validateConfig(input) {
  const errors = [];
  const source = isPlainObject(input) ? input : {};

  if (source.schemaVersion !== undefined && source.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ field: 'schemaVersion', message: '设置版本不受支持' });
  }
  if (typeof source.apiBaseUrl !== 'string' || !/^https?:\/\//.test(source.apiBaseUrl) || source.apiBaseUrl.length > 200) {
    errors.push({ field: 'apiBaseUrl', message: '接口地址必须以 http:// 或 https:// 开头且不超过 200 字符' });
  }
  if (!['mock', 'http'].includes(source.agentTransport)) {
    errors.push({ field: 'agentTransport', message: '模型通道只能是 mock 或 http' });
  }
  if (typeof source.agentEndpoint !== 'string' || source.agentEndpoint.length > 200 || !source.agentEndpoint.startsWith('/')) {
    errors.push({ field: 'agentEndpoint', message: 'Agent 端点必须以 / 开头且不超过 200 字符' });
  }
  if (!Number.isInteger(source.agentTimeoutMs) || source.agentTimeoutMs < 1000 || source.agentTimeoutMs > 120000) {
    errors.push({ field: 'agentTimeoutMs', message: '超时必须是 1000–120000 的整数毫秒' });
  }
  if (source.defaultAppid !== '' && !APPID_RE.test(String(source.defaultAppid || ''))) {
    errors.push({ field: 'defaultAppid', message: 'AppID 格式不正确（wx + 16 位十六进制）' });
  }
  assertBoolean(source.autoSaveEnabled, 'autoSaveEnabled', errors);
  if (!Number.isInteger(source.autoSaveDebounceMs) || source.autoSaveDebounceMs < 300 || source.autoSaveDebounceMs > 5000) {
    errors.push({ field: 'autoSaveDebounceMs', message: '自动保存间隔必须是 300–5000 的整数毫秒' });
  }
  if (!Number.isInteger(source.maxBackups) || source.maxBackups < 1 || source.maxBackups > 10) {
    errors.push({ field: 'maxBackups', message: '备份份数必须是 1–10 的整数' });
  }
  if (source.lastProjectId !== '' && !PROJECT_ID_RE.test(String(source.lastProjectId || ''))) {
    errors.push({ field: 'lastProjectId', message: '项目标识无效' });
  }
  if (!['default', 'compact'].includes(source.uiScale)) {
    errors.push({ field: 'uiScale', message: '界面尺寸只能是 default 或 compact' });
  }
  return errors;
}

/**
 * 归一化：已知键逐项取值，未知键进 unmappedFields。
 * 敏感键出现即拒绝（不静默吞掉，避免用户以为写进去了）。
 */
function normalizeConfig(input) {
  if (!isPlainObject(input)) {
    throw new ProjectStoreError('SETTINGS_INVALID', '设置数据无效');
  }
  const sensitive = Object.keys(input).filter((key) => SENSITIVE_KEY_RE.test(key));
  if (sensitive.length > 0) {
    throw new ProjectStoreError('SETTINGS_INVALID', '设置中包含不允许保存的敏感字段', { keys: sensitive });
  }

  const merged = defaultConfig();
  const unknown = isPlainObject(input.unmappedFields) ? { ...input.unmappedFields } : {};
  for (const key of Object.keys(input)) {
    if (key === 'unmappedFields') continue;
    if (!ALLOWED_KEYS.includes(key)) {
      unknown[key] = input[key];
      continue;
    }
    merged[key] = input[key];
  }
  merged.schemaVersion = SCHEMA_VERSION;

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new ProjectStoreError('SETTINGS_INVALID', '设置有未通过的项', { errors });
  }
  if (Object.keys(unknown).length > 0) merged.unmappedFields = unknown;
  return merged;
}

function createSettingsStore(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || !opts.userDataDir) {
    throw new Error('createSettingsStore 需要 userDataDir');
  }
  const userDataDir = path.resolve(opts.userDataDir);
  const configPath = path.join(userDataDir, 'config.json');
  const diagnosticsDir = path.join(userDataDir, 'diagnostics');
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  async function loadConfig() {
    let raw;
    try {
      raw = await fsp.readFile(configPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { config: defaultConfig(), source: 'default', warning: null };
      throw new ProjectStoreError('SETTINGS_INVALID', '设置文件无法读取', { cause: error.code });
    }

    try {
      const parsed = JSON.parse(raw);
      const config = normalizeConfig(parsed);
      return { config, source: 'file', warning: null };
    } catch (error) {
      if (error instanceof ProjectStoreError) {
        return { config: defaultConfig(), source: 'default', warning: error.message, details: error.details };
      }
      return { config: defaultConfig(), source: 'default', warning: 'config.json 已损坏，已使用默认设置' };
    }
  }

  async function saveConfig(input) {
    const config = normalizeConfig(input);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CONFIG_BYTES) {
      throw new ProjectStoreError('SETTINGS_INVALID', '设置内容超过 16 KB');
    }
    try {
      await writeFileAtomic(configPath, text);
    } catch (error) {
      throw new ProjectStoreError('SETTINGS_INVALID', '设置保存失败，请检查磁盘空间或权限', { cause: error.code });
    }
    return { savedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'), bytes, config };
  }

  function configFile() {
    return configPath;
  }

  async function saveDiagnosticsSnapshot(json) {
    if (!isPlainObject(json)) {
      throw new ProjectStoreError('DIAGNOSTICS_FAILED', '诊断内容无效');
    }
    const text = `${JSON.stringify(json, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
      throw new ProjectStoreError('DIAGNOSTICS_FAILED', '诊断快照超过 64 KB');
    }
    await fsp.mkdir(diagnosticsDir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const target = path.join(diagnosticsDir, `${stamp}.json`);
    await writeFileAtomic(target, text);
    await trimSnapshots(10);
    return { path: target };
  }

  async function trimSnapshots(keep) {
    try {
      const files = (await fsp.readdir(diagnosticsDir))
        .filter((name) => /\.json$/.test(name))
        .sort();
      while (files.length > keep) {
        const oldest = files.shift();
        try {
          await fsp.unlink(path.join(diagnosticsDir, oldest));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return {
    loadConfig,
    saveConfig,
    saveDiagnosticsSnapshot,
    configFile,
    userDataDir,
    diagnosticsDir,
  };
}

module.exports = {
  createSettingsStore,
  normalizeConfig,
  validateConfig,
  defaultConfig,
  DEFAULT_CONFIG,
  ALLOWED_KEYS,
  MAX_CONFIG_BYTES,
  SENSITIVE_KEY_RE,
};