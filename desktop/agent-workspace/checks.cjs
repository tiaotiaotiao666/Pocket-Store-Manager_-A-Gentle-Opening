'use strict';

/**
 * B4 + E0-W2：Workspace Agent 验证注册表（checkId → 明确 subject 的固定实现）。
 *
 * 冻结契约：
 * - `docs/handoff/Workspace-Agent-B阶段接口冻结.md` §3.4/§3.5（rev8，注册表边界）
 * - rev15 §14.4（**检查目标绑定**：checkId → subject）、§14.5（submit 静态门禁口径）
 *
 * 每条 checkId 只有一个 subject，root 由**平台**给，模型只能给 `checkId`/`timeoutMs`/`targetFiles`/`appId`：
 *
 * | checkId | subject | 实现 |
 * |---|---|---|
 * | `source.check` | attempt 树 | `scripts/frontend-source/check.cjs#checkProject`（进程内，只读候选文件） |
 * | `composer.dry-run` | attempt → 导出树 | 进程内 `scripts/composer/index.cjs#compose`（sourceOverlay=候选树） |
 * | `mini.check` | 派生导出树 | 进程内 `scripts/validate-miniprogram.cjs#runChecks` |
 * | `output.consistency` | 派生导出树 | 进程内 `desktop/output-consistency.cjs#inspectOutput` |
 * | `capabilities.check` | 仓库级只读 | `scripts/frontend-capabilities.cjs --check`（旧语义保留原名） |
 * | `wechat.verify` | 派生导出树 | `scripts/wechat-devtools-run.cjs`（工具缺失 → BLOCKED） |
 * | `unit.targeted`/`unit.full`/`desktop.contract`/`catalog.check`/`registry.check` | 仓库级 | dispatcher 固定 argv |
 *
 * 状态口径（单一口径，不再混用 pass/unknown）：
 * - `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`；**未知/无法判定 → `NOT_RUN` + issue**，绝不归一成 FAIL；
 * - 工具缺失/环境不可用（EPERM/ENOENT/超时/不可解析） → `BLOCKED` + issue；
 * - `AGENT_CHECK_FAILED` 只留给“工具存在且检查真的失败”。
 *
 * 关键防护：`mini.check`/`output.consistency`/`wechat.verify` **必须**有平台给的导出根，
 * 缺根 → `AGENT_CHECK_UNKNOWN`，**绝不回落仓库 `miniprogram/` 镜像**（该回落是 X4 的原始缺陷）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const sourceBundle = require('./source-bundle.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DISPATCHER = path.join(REPO_ROOT, 'scripts', 'agent-checks', 'run-check.cjs');

const CHECK_IDS = Object.freeze([
  'source.check',
  'composer.dry-run',
  'mini.check',
  'output.consistency',
  'capabilities.check',
  'wechat.verify',
  'unit.targeted',
  'unit.full',
  'desktop.contract',
  'catalog.check',
  'registry.check',
]);

/** 合同别名：t5 验收要求的 `capabilities.source-facts` 与 rev15 §14.4 的 `capabilities.check` 同一实现。 */
const CHECK_ALIASES = Object.freeze({
  'capabilities.source-facts': 'capabilities.check',
});

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

/**
 * 固定映射：checkId → subject + 实现。`impl` 只有四种，全部是固定实现，没有任意命令入口。
 * - `attempt-source`：进程内 source-check 编排器（只读 attempt 候选树）
 * - `attempt-compose`：进程内 Composer dry-run（候选树 + 平台派生导出目录）
 * - `export-root`：进程内导出树校验（mini / output-consistency）
 * - `export-dispatch` / `repo-dispatch`：dispatcher 固定 argv 子进程
 */
const CHECK_DEFINITIONS = Object.freeze({
  'source.check': {
    description: '源码级检查（frontend-source/check.cjs 于 attempt 候选树）',
    subject: 'attempt',
    impl: 'attempt-source',
    params: ['timeoutMs'],
    script: 'scripts/frontend-source/check.cjs',
  },
  'composer.dry-run': {
    description: 'Composer dry-run（先派生 source-bundle，再 compose attempt 候选树）',
    subject: 'attempt',
    impl: 'attempt-compose',
    params: ['timeoutMs'],
    script: 'scripts/composer/index.cjs',
  },
  'mini.check': {
    description: '小程序静态校验（只查派生导出树，缺根即 AGENT_CHECK_UNKNOWN）',
    subject: 'export',
    impl: 'export-root',
    params: ['timeoutMs'],
    script: 'scripts/validate-miniprogram.cjs',
  },
  'output.consistency': {
    description: '导出树只读一致性（只查派生导出树）',
    subject: 'export',
    impl: 'export-root',
    params: ['timeoutMs'],
    script: 'desktop/output-consistency.cjs',
  },
  'capabilities.check': {
    description: '仓库级能力快照同源检查（frontend-capabilities --check，旧 source.check 语义）',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs'],
    script: 'scripts/frontend-capabilities.cjs',
  },
  'wechat.verify': {
    description: '微信开发者工具运行时验证（只查派生导出树；工具缺失 → BLOCKED）',
    subject: 'export',
    impl: 'export-dispatch',
    params: ['timeoutMs', 'appId'],
    script: 'scripts/wechat-devtools-run.cjs',
  },
  'unit.targeted': {
    description: '定向 Node 测试（固定白名单文件）',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs', 'targetFiles'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'unit.full': {
    description: '全量 Node 测试（node --test test）',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'desktop.contract': {
    description: '桌面契约测试（test/desktop-contract.test.cjs）',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs'],
    script: 'scripts/agent-checks/run-check.cjs',
  },
  'catalog.check': {
    description: '组件目录同源检查（component-catalog --check）',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs'],
    script: 'scripts/component-catalog.cjs',
  },
  'registry.check': {
    description: '模板注册表完整性检查',
    subject: 'repo',
    impl: 'repo-dispatch',
    params: ['timeoutMs'],
    script: 'scripts/registry-check.cjs',
  },
});

const IMPL_MODULES = Object.freeze({
  'attempt-source': 'scripts/frontend-source/check.cjs',
  'attempt-compose': 'scripts/composer/index.cjs',
  'export-root': 'scripts/validate-miniprogram.cjs',
});

/* ------------------------------------------------------------------ */
/* 脱敏与归一                                                          */
/* ------------------------------------------------------------------ */

function sanitizeText(input) {
  let text = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input);
  text = text.split(REPO_ROOT).join('<repo>');
  text = text.split(REPO_ROOT.replace(/\\/g, '/')).join('<repo>');
  text = text.replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>');
  text = text.replace(/\/[^\s"']{12,}/g, '<path>');
  text = text.replace(/sk-[A-Za-z0-9]{8,}/g, '<key>');
  text = text.replace(/[\u0000-\u001f]/g, ' ');
  if (text.length > 240) text = text.slice(0, 237) + '...';
  return text;
}

function normalizeIssue(raw) {
  const value = raw && typeof raw === 'object' ? raw : { message: raw };
  return {
    file: typeof value.file === 'string' ? value.file.replace(/\\/g, '/').slice(0, 200) : null,
    line: Number.isInteger(value.line) ? value.line : null,
    column: Number.isInteger(value.column) ? value.column : null,
    code: typeof value.code === 'string' ? value.code.slice(0, 64) : 'CHECK_ISSUE',
    message: sanitizeText(value.message === undefined ? '' : value.message),
    source: typeof value.source === 'string' ? value.source.slice(0, 32) : 'check',
  };
}

function boundIssues(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const issue = normalizeIssue(raw);
    const key = issue.code + '|' + issue.file + '|' + issue.line + '|' + issue.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/**
 * 状态归一：**未知/无法判定绝不归一成 FAIL**。
 * 返回 `{status, issues}`；未知状态补一条 `CHECK_STATUS_UNKNOWN` 并记 NOT_RUN。
 */
function normalizeStatus(rawStatus, issues) {
  const value = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '';
  if (STATUSES.includes(value)) return { status: value, issues: boundIssues(issues) };
  const withIssue = [...(Array.isArray(issues) ? issues : [])];
  withIssue.push({
    code: 'CHECK_STATUS_UNKNOWN',
    message: '检查没有给出可判定的状态（原始值：' + sanitizeText(value || '<empty>') + '），按要求记 NOT_RUN',
    source: 'check',
  });
  return { status: 'NOT_RUN', issues: boundIssues(withIssue) };
}

/* ------------------------------------------------------------------ */
/* 参数白名单                                                          */
/* ------------------------------------------------------------------ */

function validateParams(checkId, params) {
  const definition = CHECK_DEFINITIONS[checkId];
  if (!definition) return { ok: false, code: CODES.CHECK_UNKNOWN, message: '未知 checkId：' + sanitizeText(checkId) };
  if (params === undefined || params === null) return { ok: true, params: {} };
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'params 必须是对象' };
  }
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (!definition.params.includes(key)) {
      return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'checkId ' + checkId + ' 不接受参数：' + sanitizeText(key) };
    }
    if (key === 'timeoutMs') {
      if (!Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
        return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'timeoutMs 必须是 1000–' + MAX_TIMEOUT_MS + ' 的整数' };
      }
      out.timeoutMs = value;
      continue;
    }
    if (key === 'targetFiles') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
        return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'targetFiles 必须是 1–5 项的数组' };
      }
      for (const entry of value) {
        if (typeof entry !== 'string' || !TARGET_ALLOWLIST.includes(entry)) {
          return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'targetFiles 只接受固定白名单文件' };
        }
      }
      out.targetFiles = [...value];
      continue;
    }
    if (key === 'appId') {
      if (typeof value !== 'string' || !/^wx[0-9a-f]{16}$/.test(value)) {
        return { ok: false, code: CODES.PAYLOAD_INVALID, message: 'appId 形如 wx+16 位十六进制' };
      }
      out.appId = value;
      continue;
    }
    return { ok: false, code: CODES.PAYLOAD_INVALID, message: '参数不被接受：' + sanitizeText(key) };
  }
  if (out.timeoutMs === undefined) out.timeoutMs = DEFAULT_TIMEOUT_MS;
  return { ok: true, params: out };
}

/* ------------------------------------------------------------------ */
/* dispatcher（仓库级 / 微信）                                         */
/* ------------------------------------------------------------------ */

function parseReport(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const line = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop();
  if (!line) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

/** 子进程结果 → 报告（工具缺失/超时 → BLOCKED；真实非零退出 → FAIL）。 */
function reportFromProcess(checkId, result, sanitizer) {
  if (!result || result.ok !== true) {
    const code = result && result.code ? String(result.code) : 'SPAWN_FAILED';
    const environment = ['EPERM', 'EACCES', 'ENOENT', 'ETIMEDOUT', 'ABORT_ERR'].includes(code) || Boolean(result && result.killed);
    if (environment) {
      return {
        status: 'BLOCKED',
        issues: [{
          file: null,
          line: null,
          column: null,
          code: CODES.TOOL_MISSING,
          message: sanitizer('检查工具不可用（' + code + '）：' + String((result && result.stderr) || '').slice(0, 160)),
          source: 'check',
        }],
      };
    }
    return {
      status: 'FAIL',
      issues: [{
        file: null,
        line: null,
        column: null,
        code: CODES.CHECK_FAILED,
        message: sanitizer('检查失败（' + code + '）：' + String((result && result.stderr) || '').slice(0, 160)),
        source: 'check',
      }],
    };
  }
  const parsed = parseReport(result.stdout);
  if (!parsed) {
    return {
      status: 'BLOCKED',
      issues: [{
        file: null,
        line: null,
        column: null,
        code: CODES.TOOL_MISSING,
        message: sanitizer('检查输出不可解析（无法判定）：' + String(result.stdout || '').slice(0, 120)),
        source: 'check',
      }],
    };
  }
  return {
    status: parsed.status,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    evidenceRelative: typeof parsed.evidenceRelative === 'string' ? parsed.evidenceRelative : undefined,
    screenshots: Array.isArray(parsed.screenshots) ? parsed.screenshots : [],
    pages: Array.isArray(parsed.pages) ? parsed.pages : [],
  };
}

function defaultRunner(request) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(request.command, request.args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: { ...process.env, NODE_OPTIONS: '' },
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, code: error.code || 'SPAWN_FAILED', killed: Boolean(error.killed), stdout: String(stdout || ''), stderr: String(stderr || error.message || ''), durationMs: 0 });
          return;
        }
        resolve({ ok: true, code: 'OK', stdout: String(stdout || ''), stderr: String(stderr || ''), durationMs: 0 });
      });
    } catch (error) {
      resolve({ ok: false, code: error.code || 'SPAWN_FAILED', killed: false, stdout: '', stderr: String(error.message || ''), durationMs: 0 });
    }
    if (child && typeof child.on === 'function') child.on('error', () => {});
  });
}

/* ------------------------------------------------------------------ */
/* 进程内实现                                                          */
/* ------------------------------------------------------------------ */

const TEXT_EXTENSIONS = ['.js', '.json', '.wxml', '.wxss', '.wxs'];

function runSourceCheck(root, baseSrc) {
  const read = sourceBundle.readTree(root);
  if (!read.ok) return { unavailable: true, message: read.message };
  const baseRead = sourceBundle.readTree(baseSrc);
  if (!baseRead.ok) return { unavailable: true, message: 'Base 源树不可读' };
  const collect = (files) => {
    const out = [];
    for (const [relative, buffer] of files) {
      if (!TEXT_EXTENSIONS.some((extension) => relative.toLowerCase().endsWith(extension))) continue;
      out.push({ path: relative, content: buffer.toString('utf8') });
    }
    return out;
  };
  const files = collect(read.files);
  const baseline = Object.fromEntries(collect(baseRead.files).map((file) => [file.path, file.content]));
  const { checkProject, loadFacts } = require(path.join(REPO_ROOT, 'scripts', 'frontend-source', 'check.cjs'));
  // 与 checkBase 同口径：同一份 SourceFacts + Base 基线，只是把 files 换成 attempt 候选树。
  const result = checkProject({ files, facts: loadFacts(), contracts: {}, baseline });
  return {
    status: result.total === 0 && !result.failClosed ? 'PASS' : 'FAIL',
    issues: result.issues,
    factsDigest: result.factsDigest || null,
    pageMatrix: result.pageMatrix || null,
  };
}

async function runComposerDryRun(root, parentDir, baseSrc) {
  const bundleFile = path.join(root, sourceBundle.BUNDLE_FILE);
  if (!fs.existsSync(bundleFile)) {
    return { unavailable: true, message: '缺少 source-bundle.json（应由平台派生）' };
  }
  // overlay 契约不允许空 files：候选相对 Base 无改动时先给出可读结论，而不是把 loader 的内部错误抛给模型。
  let bundleValue = null;
  try {
    bundleValue = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  } catch (error) {
    return { status: 'FAIL', issues: [{ code: 'SOURCE_BUNDLE_MANIFEST_INVALID', message: 'source-bundle.json 不可解析（应由平台重新派生）', source: 'composer' }] };
  }
  if (!bundleValue || !Array.isArray(bundleValue.files) || bundleValue.files.length === 0) {
    return {
      status: 'FAIL',
      issues: [{
        code: 'SOURCE_BUNDLE_NO_CHANGES',
        message: '候选相对 Base 没有任何改动（overlay 不允许空 files），请先写入真实修改',
        source: 'composer',
      }],
    };
  }
  // 每次 dry-run 都产出一棵全新的导出树（compose 拒绝覆盖已存在目录）；只清本 attempt 的 dry-run 目录。
  const previous = path.join(parentDir, 'dry-run');
  if (fs.existsSync(previous)) {
    let stats;
    try {
      stats = fs.lstatSync(previous);
    } catch (error) {
      return { status: 'FAIL', issues: [{ code: 'SOURCE_OVERLAY_ROOT_INVALID', message: '旧导出树不可读', source: 'composer' }] };
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { status: 'FAIL', issues: [{ code: 'SOURCE_OVERLAY_ROOT_INVALID', message: '旧导出树不是真实目录（拒绝删除/复用）', source: 'composer' }] };
    }
    fs.rmSync(previous, { recursive: true, force: true });
  }
  const composed = await sourceBundle.composeAttempt({ root, parentDir, projectName: 'dry-run', baseSrc });
  if (!composed.ok) {
    return {
      status: composed.environmentLike ? 'BLOCKED' : 'FAIL',
      issues: composed.issues,
      code: composed.code,
    };
  }
  return {
    status: 'PASS',
    issues: [],
    exportedRoot: composed.outputPath,
    exportTreeDigest: composed.treeSha256,
    fileCount: composed.fileCount,
    checks: composed.checks,
  };
}

function runMiniCheck(exportRoot) {
  const { runChecks } = require(path.join(REPO_ROOT, 'scripts', 'validate-miniprogram.cjs'));
  const result = runChecks(exportRoot);
  if (result.fatal) {
    return { status: 'FAIL', issues: (result.errors || []).map((message) => ({ code: 'MINI_CHECK_FATAL', message, source: 'mini' })) };
  }
  const issues = [
    ...(result.errors || []).map((message) => ({ code: 'MINI_CHECK_ERROR', message, source: 'mini' })),
    ...(result.warnings || []).slice(0, 40).map((message) => ({ code: 'MINI_CHECK_WARNING', message, source: 'mini' })),
  ];
  return { status: (result.errors || []).length === 0 ? 'PASS' : 'FAIL', issues, stats: result.stats || null };
}

function runOutputConsistency(exportRoot) {
  const { inspectOutput } = require(path.join(REPO_ROOT, 'desktop', 'output-consistency.cjs'));
  const result = inspectOutput(exportRoot);
  if (result.ok) {
    return {
      status: 'PASS',
      issues: [],
      fileCount: result.fileCount,
      exportTreeDigest: result.tree ? result.tree.treeSha256 : null,
    };
  }
  return {
    status: 'FAIL',
    issues: (result.problems || []).map((problem) => ({
      code: problem.code || 'OUTPUT_INCONSISTENT',
      message: problem.message || '',
      source: 'output',
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 注册表                                                             */
/* ------------------------------------------------------------------ */

function createCheckRegistry(options) {
  const opts = options || {};
  const runner = typeof opts.runner === 'function' ? opts.runner : defaultRunner;
  const sanitize = (text) => sanitizeText(text);
  const startedAt = () => Date.now();

  /** checkId → 定义（含别名）。平台只读这张表决定主体，模型改不了。 */
  function definitionsView() {
    const view = {};
    for (const checkId of CHECK_IDS) view[checkId] = CHECK_DEFINITIONS[checkId];
    for (const [alias, target] of Object.entries(CHECK_ALIASES)) view[alias] = CHECK_DEFINITIONS[target];
    return view;
  }

  function listChecks() {
    return CHECK_IDS.map((checkId) => {
      const definition = CHECK_DEFINITIONS[checkId];
      return {
        checkId,
        description: definition.description,
        params: [...definition.params],
        subject: definition.subject,
        // 兼容 B4 旧字段：scoped = 需要平台给 root 的检查。
        scoped: definition.subject !== 'repo',
      };
    });
  }

  /** dispatcher 请求（固定 argv，shell:false）。 */
  function dispatcherRequest(checkId, params, extraArgs) {
    const args = [DISPATCHER, '--check', checkId];
    for (const arg of Array.isArray(extraArgs) ? extraArgs : []) args.push(arg);
    for (const target of params.targetFiles || []) args.push('--target', target);
    if (params.timeoutMs !== undefined) args.push('--timeout', String(params.timeoutMs));
    return {
      command: process.execPath,
      args,
      cwd: REPO_ROOT,
      timeoutMs: params.timeoutMs || DEFAULT_TIMEOUT_MS,
    };
  }

  function base(checkId, status, issues, extra) {
    const normalized = normalizeStatus(status, issues);
    return {
      ok: true,
      checkId,
      status: normalized.status,
      durationMs: 0,
      issues: normalized.issues,
      ...(extra || {}),
    };
  }

  /**
   * 执行一次检查。
   * @param {object} request
   * @param {string} request.checkId
   * @param {object} [request.params] 模型可给的有界参数
   * @param {string} [request.root] 平台派生：attempt 候选树（subject=attempt）
   * @param {string} [request.exportRoot] 平台派生：dry-run 导出树（subject=export）
   * @param {string} [request.exportParentDir] 平台派生：dry-run 导出父目录（attempt/verification）
   */
  async function runCheck(request) {
    const payload = request && typeof request === 'object' ? request : {};
    const requested = payload.checkId;
    // 别名归一到 canonical（rev15 `capabilities.check` ≡ 合同别名 `capabilities.source-facts`）。
    const checkId = typeof requested === 'string' && CHECK_ALIASES[requested] ? CHECK_ALIASES[requested] : requested;
    const definition = CHECK_DEFINITIONS[checkId];
    if (!definition) {
      return { ok: false, code: CODES.CHECK_UNKNOWN, message: '未知 checkId：' + sanitizeText(requested) };
    }
    const validated = validateParams(checkId, payload.params);
    if (!validated.ok) return validated;
    const params = validated.params;
    const started = startedAt();
    const finish = (result) => ({ ...result, durationMs: Math.max(0, startedAt() - started) });
    const subjectKind = definition.subject === 'repo' ? 'repo' : definition.subject;

    try {
      if (definition.impl === 'attempt-source') {
        if (typeof payload.root !== 'string' || !path.isAbsolute(payload.root)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: 'source.check 需要平台派生的 attempt 根（不接受模型路径）' };
        }
        if (!fs.existsSync(payload.root)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: 'attempt 根不存在' };
        }
        const context = sourceBundle.loadComposerContext();
        if (!context.ok) return { ok: false, code: CODES.CHECK_UNKNOWN, message: context.message };
        const result = runSourceCheck(payload.root, context.baseSrc);
        if (result.unavailable) {
          return finish(base(checkId, 'NOT_RUN', [{ code: 'SOURCE_CHECK_UNAVAILABLE', message: result.message, source: 'source-check' }], { subjectKind }));
        }
        return finish(base(checkId, result.status, result.issues, {
          subjectKind,
          factsDigest: result.factsDigest,
          pageMatrix: result.pageMatrix,
        }));
      }

      if (definition.impl === 'attempt-compose') {
        if (typeof payload.root !== 'string' || !path.isAbsolute(payload.root)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: 'composer.dry-run 需要平台派生的 attempt 根（不接受模型路径）' };
        }
        if (typeof payload.exportParentDir !== 'string' || !path.isAbsolute(payload.exportParentDir)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: 'composer.dry-run 需要平台派生的导出父目录' };
        }
        const context = sourceBundle.loadComposerContext();
        if (!context.ok) return { ok: false, code: CODES.CHECK_UNKNOWN, message: context.message };
        const result = await runComposerDryRun(payload.root, payload.exportParentDir, context.baseSrc);
        if (result.unavailable) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: result.message };
        }
        return finish(base(checkId, result.status, result.issues, {
          subjectKind,
          exportTreeDigest: result.exportTreeDigest || null,
          exportedRoot: result.exportedRoot || null,
          fileCount: result.fileCount || 0,
          composerChecks: Array.isArray(result.checks) ? result.checks.slice(0, 40) : [],
        }));
      }

      if (definition.impl === 'export-root') {
        if (typeof payload.exportRoot !== 'string' || !path.isAbsolute(payload.exportRoot)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: checkId + ' 需要平台派生的导出根（缺根不回落仓库 miniprogram/）' };
        }
        if (!fs.existsSync(payload.exportRoot)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: checkId + ' 的导出根不存在（先跑 composer.dry-run）' };
        }
        const result = checkId === 'mini.check'
          ? runMiniCheck(payload.exportRoot)
          : runOutputConsistency(payload.exportRoot);
        return finish(base(checkId, result.status, result.issues, {
          subjectKind,
          exportTreeDigest: result.exportTreeDigest || null,
          fileCount: result.fileCount || (result.stats ? result.stats.pages : 0),
        }));
      }

      if (definition.impl === 'export-dispatch') {
        if (typeof payload.exportRoot !== 'string' || !path.isAbsolute(payload.exportRoot)) {
          return { ok: false, code: CODES.CHECK_UNKNOWN, message: checkId + ' 需要平台派生的导出根（缺根不回落仓库 miniprogram/）' };
        }
        // wechat-devtools-run.cjs 只吃位置参数 root；appId 仅作证据记录（不拼进 argv）。
        const extra = ['--root', payload.exportRoot];
        const result = await runner(dispatcherRequest(checkId, params, extra));
        const report = reportFromProcess(checkId, result, sanitize);
        return finish(base(checkId, report.status, report.issues, {
          subjectKind,
          ...(report.evidenceRelative ? { evidenceRelative: report.evidenceRelative } : {}),
        }));
      }

      // repo-dispatch：仓库级只读检查，不接触 attempt 或导出树。
      const result = await runner(dispatcherRequest(checkId, params, []));
      const report = reportFromProcess(checkId, result, sanitize);
      return finish(base(checkId, report.status, report.issues, {
        subjectKind: 'repo',
        ...(report.evidenceRelative ? { evidenceRelative: report.evidenceRelative } : {}),
      }));
    } catch (error) {
      // 无法判定：NOT_RUN + issue（绝不归一成 FAIL，也不伪造 PASS）。
      return finish(base(checkId, 'NOT_RUN', [{
        code: 'CHECK_INTERNAL',
        message: '检查执行异常（无法判定）：' + String((error && error.message) || error).slice(0, 160),
        source: 'check',
      }], { subjectKind }));
    }
  }

  /** wechat.verify 单独入口（保留 B4 形状：不回传截图字节，只回相对引用）。 */
  async function verifyWechat(request) {
    const payload = request && typeof request === 'object' ? request : {};
    const result = await runCheck({
      checkId: 'wechat.verify',
      exportRoot: payload.exportRoot,
      params: {
        ...(payload.appId === undefined ? {} : { appId: payload.appId }),
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
      },
    });
    if (!result.ok) return result;
    const parsed = (result.issues || []).length === 0 ? { screenshots: [], pages: [] } : { screenshots: [], pages: [] };
    return {
      ok: true,
      status: result.status,
      durationMs: result.durationMs,
      issues: result.issues,
      subjectKind: result.subjectKind,
      pages: parsed.pages,
      interactions: [],
      screenshots: parsed.screenshots,
      ...(result.evidenceRelative ? { evidenceRelative: result.evidenceRelative } : {}),
    };
  }

  return { listChecks, runCheck, verifyWechat, definitions: definitionsView(), aliases: { ...CHECK_ALIASES } };
}

module.exports = {
  CHECK_IDS,
  CHECK_ALIASES,
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
  normalizeStatus,
  parseReport,
  reportFromProcess,
  dispatcherPath: DISPATCHER,
  repoRoot: REPO_ROOT,
  /** 仅用于测试/诊断的静态断言：固定映射不允许出现任意命令入口。 */
  assertFixedMapping: () => {
    const seen = new Set();
    for (const checkId of CHECK_IDS) {
      const definition = CHECK_DEFINITIONS[checkId];
      if (!definition || seen.has(checkId)) throw new Error('checkId 映射重复/缺失：' + checkId);
      seen.add(checkId);
      if (!STATUSES.includes('PASS')) throw new Error('状态口径损坏');
      if (!['attempt', 'export', 'repo'].includes(definition.subject)) throw new Error('subject 非法：' + checkId);
      if (checkId === 'wechat.verify' && definition.script !== 'scripts/wechat-devtools-run.cjs') {
        throw new Error('wechat.verify 必须固定包装 scripts/wechat-devtools-run.cjs');
      }
      if (!fs.existsSync(path.join(REPO_ROOT, definition.script))) {
        throw new Error('check 脚本不存在：' + definition.script);
      }
    }
    for (const modulePath of Object.values(IMPL_MODULES)) {
      if (!fs.existsSync(path.join(REPO_ROOT, modulePath))) throw new Error('进程内实现模块不存在：' + modulePath);
    }
    return true;
  },
};
