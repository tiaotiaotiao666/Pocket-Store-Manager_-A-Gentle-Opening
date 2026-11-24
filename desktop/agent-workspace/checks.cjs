'use strict';

/**
 * B4：Workspace Agent 验证注册表（checkId → 固定脚本/包装器）。
 *
 * 冻结契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §3.4/§3.5（rev8）。
 *
 * 边界：
 * - 调用方（B3 `agent:run-check` / `agent:verify-wechat`）只能传 **checkId + 有界标量参数**；
 *   不接受 command/env/shell/cwd/任意路径，也不执行模型提供的命令。
 * - 每个 checkId 固定映射到仓库内既有脚本或 `scripts/agent-checks/*` 包装器（唯一分发器
 *   `scripts/agent-checks/run-check.cjs`，内部 `execFile(shell:false)` + 固定 argv）。
 * - 返回 `{checkId,status:PASS|FAIL|BLOCKED|NOT_RUN,durationMs,issues,evidenceRelative?}`；
 *   issues ≤200 且脱敏（无绝对路径/源码全文/密钥），失败 fail-closed（不可解析输出一律 BLOCKED）。
 * - `wechat.verify` 固定包装 `scripts/wechat-devtools-run.cjs`；CLI/自动化不可用、超时或证据矛盾 → BLOCKED，
 *   绝不伪造 PASS 或截图。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DISPATCHER = path.join(REPO_ROOT, 'scripts', 'agent-checks', 'run-check.cjs');

const CHECK_IDS = Object.freeze([
  'source.check',
  'mini.check',
  'composer.dry-run',
  'output.consistency',
  'unit.targeted',
  'unit.full',
  'desktop.contract',
  'catalog.check',
  'registry.check',
  'wechat.verify',
]);

const STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
const CODES = Object.freeze({
  CHECK_UNKNOWN: 'AGENT_CHECK_UNKNOWN',
  PAYLOAD_INVALID: 'AGENT_PAYLOAD_INVALID',
  CHECK_FAILED: 'AGENT_CHECK_FAILED',
  RUNTIME_TOOL_MISSING: 'AGENT_RUNTIME_TOOL_MISSING',
  // 检查工具/spawn 环境不可用（EPERM/ENOENT/超时/输出不可解析）统一用该码，区别于“工具可用但检查失败”。
  TOOL_MISSING: 'CHECK_TOOL_MISSING',
  TIMEOUT: 'AGENT_TIMEOUT',
  VERSION_NOT_FOUND: 'AGENT_VERSION_NOT_FOUND',
});

const MAX_ISSUES = 200;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_TIMEOUT_MS = 120000;

/** unit.targeted 只允许固定测试文件白名单（与 scripts/agent-checks/run-check.cjs 同步）。 */
const TARGET_ALLOWLIST = Object.freeze([
  'test/desktop-contract.test.cjs',
  'test/frontend-contract.test.cjs',
  'test/agent-tools-ipc.test.cjs',
  'test/workspace-agent-service.test.cjs',
  'test/agent-workspace.checks.test.cjs',
]);

/** 每个 checkId 的固定映射 + 参数白名单（params 只允许这些键）。 */
const CHECK_DEFINITIONS = Object.freeze({
  'source.check': {
    description: '源码/能力快照同源检查（frontend-capabilities --check）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/frontend-capabilities.cjs',
  },
  'mini.check': {
    description: '小程序镜像静态校验（validate-miniprogram）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/validate-miniprogram.cjs',
  },
  'composer.dry-run': {
    description: 'Composer 产物校验（verify-cli --root <版本 source>）',
    scoped: true,
    params: ['timeoutMs'],
    script: 'scripts/composer/verify-cli.cjs',
  },
  'output.consistency': {
    description: '产物只读一致性（output-consistency --root <版本 source>）',
    scoped: true,
    params: ['timeoutMs'],
    script: 'scripts/agent-checks/output-consistency.cjs',
  },
  'unit.targeted': {
    description: '定向 Node 测试（固定白名单文件）',
    scoped: false,
    params: ['timeoutMs', 'targetFiles'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'unit.full': {
    description: '全量 Node 测试（node --test test）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'desktop.contract': {
    description: '桌面契约测试（test/desktop-contract.test.cjs）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'catalog.check': {
    description: '组件目录同源检查（component-catalog --check）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/component-catalog.cjs',
  },
  'registry.check': {
    description: 'Registry 校验（registry-check）',
    scoped: false,
    params: ['timeoutMs'],
    script: 'scripts/registry-check.cjs',
  },
  'wechat.verify': {
    description: '微信真实编译/自动化验证（固定包装 scripts/wechat-devtools-run.cjs）',
    scoped: true,
    params: ['timeoutMs', 'appId'],
    script: 'scripts/wechat-devtools-run.cjs',
  },
});

const FORBIDDEN_KEY_PATTERN = /^(command|cmd|shell|exec|spawn|env|cwd|dir|directory|path|script|argv)$/i;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_OR_DRIVE_PATTERN = /^([A-Za-z]:[\\/]|\\\\|\/)/;
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|PRIVATE KEY)/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value) {
  let text = String(value === undefined || value === null ? '' : value);
  for (const variant of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/')]) {
    text = text.split(variant).join('.');
  }
  text = text.replace(/[A-Za-z]:[\\/][^\s"']*/g, '[path]');
  text = text.replace(SECRET_PATTERN, '[redacted]');
  text = text.replace(CONTROL_CHAR_PATTERN, ' ').trim();
  return text.length > 240 ? text.slice(0, 237) + '...' : text;
}

function normalizeIssue(raw, fallbackCode, fallbackSource) {
  const source = isPlainObject(raw) ? raw : {};
  const file = typeof source.file === 'string' && !path.isAbsolute(source.file) && !ABSOLUTE_OR_DRIVE_PATTERN.test(source.file)
    ? source.file.slice(0, 240)
    : null;
  return {
    file,
    line: Number.isInteger(source.line) ? source.line : null,
    column: Number.isInteger(source.column) ? source.column : null,
    code: typeof source.code === 'string' && source.code ? source.code.slice(0, 64) : fallbackCode,
    message: sanitizeText(source.message) || '检查失败',
    source: typeof source.source === 'string' && source.source ? source.source.slice(0, 40) : fallbackSource,
  };
}

function issuesFromText(text, code, source) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => sanitizeText(line))
    .filter(Boolean)
    .slice(0, MAX_ISSUES)
    .map((message) => normalizeIssue({ message, code, source }, code, source));
}

function validateParams(checkId, params) {
  const definition = CHECK_DEFINITIONS[checkId];
  if (params === undefined || params === null) return { ok: true, params: {} };
  if (!isPlainObject(params)) return { ok: false, message: 'params 必须是对象' };
  const allowed = definition.params;
  for (const [key, value] of Object.entries(params)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      return { ok: false, message: 'params 不允许命令/环境/路径类字段：' + key };
    }
    if (!allowed.includes(key)) return { ok: false, message: 'params 含未知键：' + key };
    if (key === 'timeoutMs') {
      if (!Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
        return { ok: false, message: 'timeoutMs 必须是 1000..600000 的整数' };
      }
      continue;
    }
    if (key === 'targetFiles') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
        return { ok: false, message: 'targetFiles 必须是 1..5 个白名单文件' };
      }
      const seen = new Set();
      for (const target of value) {
        if (typeof target !== 'string' || !TARGET_ALLOWLIST.includes(target) || seen.has(target)) {
          return { ok: false, message: 'targetFiles 含白名单外的文件' };
        }
        seen.add(target);
      }
      continue;
    }
    if (key === 'appId') {
      if (typeof value !== 'string' || !/^wx[0-9a-f]{16}$/.test(value)) {
        return { ok: false, message: 'appId 必须是合法 wx AppID' };
      }
      continue;
    }
    if (typeof value === 'string') {
      if (CONTROL_CHAR_PATTERN.test(value) || ABSOLUTE_OR_DRIVE_PATTERN.test(value) || value.includes('..')) {
        return { ok: false, message: 'params 不允许绝对路径/穿越/控制字符' };
      }
      continue;
    }
    if (value !== null && typeof value === 'object') return { ok: false, message: 'params 只接受标量' };
    return { ok: false, message: 'params 值非法' };
  }
  return { ok: true, params };
}

function fixedEnv() {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'ComSpec', 'PATHEXT']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

/** 默认 runner：固定 dispatcher + execFile(shell:false)，不接受命令字符串。 */
function defaultRunner(request) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    try {
      execFile(request.command, request.args, {
        cwd: REPO_ROOT,
        shell: false,
        windowsHide: true,
        timeout: request.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: fixedEnv(),
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error) {
          resolvePromise({
            ok: false,
            code: String(error.code || (error.killed ? 'ETIMEDOUT' : 'CHECK_FAILED')),
            killed: Boolean(error.killed),
            stdout: stdout || '',
            stderr: stderr || '',
            durationMs,
          });
          return;
        }
        resolvePromise({ ok: true, code: 'OK', killed: false, stdout: stdout || '', stderr: stderr || '', durationMs });
      });
    } catch (error) {
      // 受限环境（如沙箱）可能在调用 execFile 时同步抛 EPERM；必须归一为 BLOCKED，不能冒泡成 CHECK_FAILED。
      resolvePromise({
        ok: false,
        code: String((error && error.code) || 'EPERM'),
        killed: Boolean(error && error.killed),
        stdout: '',
        stderr: (error && error.message) || '',
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  });
}

function parseReport(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const candidates = [text];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > 0) candidates.push(lines[lines.length - 1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isPlainObject(parsed)) continue;
      if (!STATUSES.includes(parsed.status)) continue;
      return parsed;
    } catch (error) {
      /* 继续尝试下一段 */
    }
  }
  return null;
}

function boundedEvidence(relative) {
  if (typeof relative !== 'string' || !relative) return null;
  if (path.isAbsolute(relative) || ABSOLUTE_OR_DRIVE_PATTERN.test(relative) || relative.includes('..') || relative.includes('\\')) return null;
  return relative.slice(0, 240);
}

/**
 * 创建验证注册表。
 *
 * @param {object} [options]
 * @param {string} [options.userDataDir] 应用私有根（用于派生版本 source）
 * @param {(request:{command:string,args:string[],cwd:string,timeoutMs:number}) => Promise<object>} [options.runner]
 *   注入的进程执行器（测试用 fake，不 spawn）；默认 execFile(shell:false) 调固定 dispatcher。
 * @param {() => number} [options.now]
 */
function createCheckRegistry(options) {
  const opts = options || {};
  const userDataDir = typeof opts.userDataDir === 'string' ? opts.userDataDir : '';
  const runner = typeof opts.runner === 'function' ? opts.runner : defaultRunner;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  function listChecks() {
    return CHECK_IDS.map((checkId) => {
      const definition = CHECK_DEFINITIONS[checkId];
      return {
        checkId,
        scoped: Boolean(definition.scoped),
        params: [...definition.params],
        description: definition.description,
      };
    });
  }

  function resolveSourceRoot(projectId) {
    if (!userDataDir || typeof projectId !== 'string' || !projectId) return { ok: false, code: CODES.VERSION_NOT_FOUND };
    try {
      const versions = require('./versions.cjs');
      const resolved = versions.resolveVersionSource({ userDataDir, projectId });
      if (!resolved.ok) return { ok: false, code: resolved.code || CODES.VERSION_NOT_FOUND };
      return { ok: true, sourceRoot: resolved.sourceRoot, versionId: resolved.versionId };
    } catch (error) {
      return { ok: false, code: CODES.VERSION_NOT_FOUND };
    }
  }

  async function runCheck(input) {
    const request = isPlainObject(input) ? input : {};
    const checkId = request.checkId;
    if (typeof checkId !== 'string' || !Object.prototype.hasOwnProperty.call(CHECK_DEFINITIONS, checkId)) {
      return { ok: false, code: CODES.CHECK_UNKNOWN, message: '未知 checkId' };
    }
    const paramsResult = validateParams(checkId, request.params);
    if (!paramsResult.ok) {
      return { ok: false, code: CODES.PAYLOAD_INVALID, message: paramsResult.message };
    }
    const params = paramsResult.params;
    const definition = CHECK_DEFINITIONS[checkId];
    const timeoutMs = Number.isInteger(params.timeoutMs) ? params.timeoutMs : DEFAULT_TIMEOUT_MS;

    let root = null;
    if (definition.scoped) {
      const resolved = resolveSourceRoot(request.projectId);
      if (!resolved.ok) {
        return {
          ok: true,
          checkId,
          status: 'NOT_RUN',
          durationMs: 0,
          issues: [normalizeIssue({
            code: resolved.code,
            message: '没有可检查的当前版本源码（先初始化/采用版本）',
            source: 'check',
          }, resolved.code, 'check')],
        };
      }
      root = resolved.sourceRoot;
    }

    const args = [DISPATCHER, '--check', checkId, '--timeout', String(timeoutMs)];
    if (definition.scoped) args.push('--root', root);
    if (checkId === 'unit.targeted') {
      const targets = Array.isArray(params.targetFiles) && params.targetFiles.length > 0
        ? params.targetFiles
        : ['test/desktop-contract.test.cjs'];
      for (const target of targets) args.push('--target', target);
    }

    const startedAt = now();
    let result;
    try {
      result = await runner({
        command: process.execPath,
        args,
        cwd: REPO_ROOT,
        timeoutMs,
      });
    } catch (error) {
      // 注入 runner 同步/异步抛错（含受限环境 EPERM）也归一为一次“工具不可用”，由下面统一判定 BLOCKED。
      result = {
        ok: false,
        code: String((error && error.code) || 'EPERM'),
        killed: Boolean(error && error.killed),
        stdout: '',
        stderr: (error && error.message) || '',
        durationMs: Math.max(0, now() - startedAt),
      };
    }
    const durationMs = Number.isInteger(result && result.durationMs) ? result.durationMs : Math.max(0, now() - startedAt);

    if (!result || result.ok !== true) {
      const blocked = Boolean(result && (result.killed || ['ENOENT', 'EPERM', 'EACCES', 'ETIMEDOUT', CODES.TOOL_MISSING].includes(result.code)));
      // BLOCKED 一律用工具缺失码；CHECK_FAILED 只留给“工具可用但检查真的失败/非零退出”。
      const code = blocked ? CODES.TOOL_MISSING : CODES.CHECK_FAILED;
      return {
        ok: true,
        checkId,
        status: blocked ? 'BLOCKED' : 'FAIL',
        durationMs,
        issues: issuesFromText(`${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`, code, 'check'),
      };
    }

    const report = parseReport(result.stdout);
    if (!report || !STATUSES.includes(report.status)) {
      // 不可解析/不一致 → BLOCKED（工具/适配器不可用），绝不把“看起来成功”当 PASS。
      return {
        ok: true,
        checkId,
        status: 'BLOCKED',
        durationMs,
        issues: issuesFromText(`${result.stdout || ''}\n${result.stderr || ''}`, CODES.TOOL_MISSING, 'check')
          .concat([normalizeIssue({ code: CODES.TOOL_MISSING, message: '检查输出不可解析', source: 'check' }, CODES.TOOL_MISSING, 'check')])
          .slice(0, MAX_ISSUES),
      };
    }

    const rawIssues = Array.isArray(report.issues) ? report.issues : [];
    const issues = rawIssues.slice(0, MAX_ISSUES).map((issue) => normalizeIssue(issue, CODES.CHECK_FAILED, 'check'));
    const evidenceRelative = boundedEvidence(report.evidenceRelative);
    return {
      ok: true,
      checkId,
      status: report.status,
      durationMs,
      issues,
      ...(evidenceRelative ? { evidenceRelative } : {}),
    };
  }

  async function verifyWechat(input) {
    const request = isPlainObject(input) ? input : {};
    const params = {};
    if (request.timeoutMs !== undefined) params.timeoutMs = request.timeoutMs;
    if (request.appId !== undefined) params.appId = request.appId;
    const result = await runCheck({
      checkId: 'wechat.verify',
      params,
      projectId: request.projectId,
      attemptId: request.attemptId,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      status: result.status,
      durationMs: result.durationMs,
      pages: [],
      interactions: [],
      screenshots: [],
      issues: result.issues,
      ...(result.evidenceRelative ? { evidenceRelative: result.evidenceRelative } : {}),
    };
  }

  return { listChecks, runCheck, verifyWechat };
}

module.exports = {
  CHECK_IDS,
  STATUSES,
  CODES,
  CHECK_DEFINITIONS,
  TARGET_ALLOWLIST,
  MAX_ISSUES,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  createCheckRegistry,
  validateParams,
  sanitizeText,
  normalizeIssue,
  parseReport,
  dispatcherPath: DISPATCHER,
  repoRoot: REPO_ROOT,
  // 仅用于测试/诊断的静态断言：固定映射不允许出现任意命令入口。
  assertFixedMapping: () => {
    const seen = new Set();
    for (const checkId of CHECK_IDS) {
      const definition = CHECK_DEFINITIONS[checkId];
      if (!definition || seen.has(checkId)) throw new Error('checkId 映射重复/缺失：' + checkId);
      seen.add(checkId);
      if (checkId === 'wechat.verify' && definition.script !== 'scripts/wechat-devtools-run.cjs') {
        throw new Error('wechat.verify 必须固定包装 scripts/wechat-devtools-run.cjs');
      }
      if (!fs.existsSync(path.join(REPO_ROOT, definition.script))) {
        throw new Error('check 脚本不存在：' + definition.script);
      }
    }
    return true;
  },
};
