'use strict';

/**
 * P3 微信运行时验证包装（固定命令、固定参数、超时、取消、证据路径）。
 *
 * 唯一被执行的命令是仓库里的 `scripts/wechat-devtools-run.cjs`（真实 DevTools CLI +
 * miniprogram-automator）。本模块：
 * - **不接受任何由模型/远端提供的命令**：没有 `command`/`shell` 入参，参数由本文件拼装；
 * - 参数集合固定：`<projectDir> --auto-port <port> --json <evidence> --shots <shots>`；
 * - 证据只写本次运行私有目录（`privateRoot/verification/runtime[-n]`，逐段 canonical 校验）；
 * - 结果严格 PASS / FAIL / BLOCKED / NOT_RUN：工具缺失、超时、脚本崩溃、证据缺失一律
 *   BLOCKED，**绝不**用“没跑”冒充通过；取消返回 NOT_RUN；
 * - 返回截图清单（相对文件名 + 字节数），不返回图片正文。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  ensureDirectory,
  assertCanonicalDir,
  isProtectedRepoDir,
} = require('./workspace.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'wechat-devtools-run.cjs');
const WRAPPER_EVIDENCE = 'frontend-runtime.json';
const WRAPPER_SCHEMA_VERSION = 'frontend-runtime.v1';
const DEFAULT_AUTO_PORT = 9420;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 1800000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE = 240;

const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT_RUN',
});

const CODES = Object.freeze({
  PASS: 'RUNTIME_PASS',
  FAIL: 'RUNTIME_FAIL',
  BLOCKED: 'RUNTIME_BLOCKED',
  NOT_RUN: 'RUNTIME_NOT_RUN',
  INPUT_INVALID: 'RUNTIME_INPUT_INVALID',
  TOOL_MISSING: 'RUNTIME_TOOL_MISSING',
  TIMEOUT: 'RUNTIME_TIMEOUT',
  CANCELLED: 'RUNTIME_CANCELLED',
  EVIDENCE_MISSING: 'RUNTIME_EVIDENCE_MISSING',
  SCRIPT_FAILED: 'RUNTIME_SCRIPT_FAILED',
  INCONSISTENT: 'RUNTIME_INCONSISTENT',
});

function truncate(value, limit) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function boundedDetail(error) {
  if (!error) return 'UNKNOWN';
  return truncate(error.code || error.message || String(error), 160);
}

function isCancelled(signal) {
  if (!signal) return false;
  if (typeof signal.cancelled === 'boolean') return signal.cancelled;
  if (typeof signal.aborted === 'boolean') return signal.aborted;
  return false;
}

/** 结果/证据里不出现本机绝对路径（脚本的 blocked 文本可能带 projectRoot）。 */
function sanitizeText(value) {
  return truncate(
    String(value === undefined || value === null ? '' : value)
      .replace(/[A-Za-z]:[\\/][^\s；，,）)]*/g, '<local-path>')
      .replace(/\\\\[^\s；，,）)]+/g, '<local-path>'),
    MAX_MESSAGE,
  );
}

/**
 * 解析开发者工具 CLI（只读，不启动任何进程）。
 * 显式 `cliPath` 优先（必须是绝对路径）；否则复用 `wechat-devtools-run.cjs#resolveCli`。
 */
function resolveToolchain(options) {
  const opts = options || {};
  const scriptPath = opts.scriptPath === undefined ? DEFAULT_SCRIPT : opts.scriptPath;
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || !fs.existsSync(scriptPath)) {
    return { ok: false, code: CODES.TOOL_MISSING, reason: '缺少固定微信验证脚本（scripts/wechat-devtools-run.cjs）' };
  }
  // 固定脚本不可替换：任何不同的 scriptPath 都拒绝，避免把包装层变成任意脚本执行入口。
  if (path.resolve(scriptPath) !== path.resolve(DEFAULT_SCRIPT)) {
    return { ok: false, code: CODES.INPUT_INVALID, reason: '只允许固定微信验证脚本（拒绝自定义 scriptPath）' };
  }
  let cliPath = '';
  if (opts.cliPath !== undefined) {
    if (typeof opts.cliPath !== 'string' || !path.isAbsolute(opts.cliPath)) {
      return { ok: false, code: CODES.INPUT_INVALID, reason: 'cliPath 必须是绝对路径' };
    }
    if (!fs.existsSync(opts.cliPath)) {
      return { ok: false, code: CODES.TOOL_MISSING, reason: '指定的开发者工具 CLI 不存在' };
    }
    cliPath = opts.cliPath;
  } else {
    try {
      // 只读探测（环境变量 + 固定候选路径），不会启动 DevTools。
      cliPath = require(path.join(REPO_ROOT, 'scripts', 'wechat-devtools-run.cjs')).resolveCli();
    } catch (error) {
      return { ok: false, code: CODES.TOOL_MISSING, reason: '无法探测开发者工具 CLI：' + boundedDetail(error) };
    }
  }
  if (!cliPath) {
    return { ok: false, code: CODES.TOOL_MISSING, reason: '本机未找到微信开发者工具 cli.bat（可用 WX_CLI_PATH 指定）' };
  }
  return { ok: true, scriptPath, cliPath };
}

/**
 * 固定参数集（顺序固定，全部由本模块决定）。
 * @returns {{ok:true,args:string[]}|{ok:false,code:string,reason:string}}
 */
function buildRunArgs(options) {
  const opts = options || {};
  const projectDir = opts.projectDir;
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    return { ok: false, code: CODES.INPUT_INVALID, reason: 'projectDir 必须是绝对路径' };
  }
  const scriptPath = opts.scriptPath === undefined ? DEFAULT_SCRIPT : opts.scriptPath;
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) {
    return { ok: false, code: CODES.INPUT_INVALID, reason: 'scriptPath 必须是绝对路径' };
  }
  if (path.resolve(scriptPath) !== path.resolve(DEFAULT_SCRIPT)) {
    return { ok: false, code: CODES.INPUT_INVALID, reason: '只允许固定微信验证脚本（拒绝自定义 scriptPath）' };
  }
  const autoPort = opts.autoPort === undefined ? DEFAULT_AUTO_PORT : opts.autoPort;
  if (!Number.isInteger(autoPort) || autoPort < 1024 || autoPort > 65535) {
    return { ok: false, code: CODES.INPUT_INVALID, reason: 'autoPort 必须是 1024–65535 的整数' };
  }
  const evidencePath = opts.evidencePath;
  const shotsDir = opts.shotsDir;
  for (const [name, value] of [['evidencePath', evidencePath], ['shotsDir', shotsDir]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      return { ok: false, code: CODES.INPUT_INVALID, reason: name + ' 必须是绝对路径' };
    }
  }
  return {
    ok: true,
    args: [
      scriptPath,
      projectDir,
      '--auto-port',
      String(autoPort),
      '--json',
      evidencePath,
      '--shots',
      shotsDir,
    ],
    autoPort,
    scriptPath,
  };
}

function cleanEnv() {
  const env = { ...process.env };
  // DevTools 的 CLI 在 ELECTRON_RUN_AS_NODE=1 下会退化成纯 Node（既有环境坑）。
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 默认执行器：spawn 固定脚本；stdio=ignore（不采集子进程输出，避免沙箱命名管道限制）。 */
function defaultSpawn(spec) {
  const child = spawn(spec.command, spec.args, {
    cwd: REPO_ROOT,
    env: cleanEnv(),
    windowsHide: true,
    stdio: 'ignore',
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: Number.isInteger(code) ? code : null }));
  });
  return { result, kill: () => { try { child.kill(); } catch (error) { /* 关闭失败不影响结论 */ } } };
}

/**
 * 跑子进程并施加超时/取消（可注入 spawnImpl 以便本地测试，不执行真实 DevTools）。
 * @returns {Promise<{exitCode:number|null, timedOut?:boolean, cancelled?:boolean, spawnError?:Error}>}
 */
function runWithLimits(options) {
  const opts = options || {};
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : defaultSpawn;
  const timeoutMs = opts.timeoutMs;
  const signal = opts.signal;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let watcher = null;
    let handle = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      resolve(outcome);
    };
    const kill = () => {
      try {
        if (handle && typeof handle.kill === 'function') handle.kill();
      } catch (error) {
        /* 结束失败也要返回结构化结论 */
      }
    };
    try {
      handle = spawnImpl({ command: opts.command, args: opts.args });
    } catch (error) {
      finish({ spawnError: error, exitCode: null });
      return;
    }
    timer = setTimeout(() => {
      kill();
      finish({ timedOut: true, exitCode: null });
    }, timeoutMs);
    if (signal) {
      watcher = setInterval(() => {
        if (!isCancelled(signal)) return;
        kill();
        finish({ cancelled: true, exitCode: null });
      }, 50);
    }
    const pending = handle && handle.result ? handle.result : handle;
    Promise.resolve(pending).then(
      (value) => {
        if (value && value.spawnError) finish({ spawnError: value.spawnError, exitCode: null });
        else finish({ exitCode: value && Number.isInteger(value.exitCode) ? value.exitCode : null });
      },
      (error) => finish({ spawnError: error, exitCode: null }),
    );
  });
}

function readReport(evidencePath) {
  let stats;
  try {
    stats = fs.statSync(evidencePath);
  } catch (error) {
    return { ok: false, reason: '证据文件不存在：' + boundedDetail(error), bytes: 0 };
  }
  if (!stats.isFile()) return { ok: false, reason: '证据路径不是文件', bytes: 0 };
  if (stats.size > MAX_REPORT_BYTES) return { ok: false, reason: '证据文件超过上限 ' + MAX_REPORT_BYTES + ' 字节', bytes: stats.size };
  let report;
  try {
    report = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: '证据文件无法解析：' + boundedDetail(error), bytes: stats.size };
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, reason: '证据文件必须是对象', bytes: stats.size };
  }
  return { ok: true, report, bytes: stats.size };
}

function countByStatus(list) {
  const counts = { total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const item of Array.isArray(list) ? list : []) {
    counts.total += 1;
    if (item && Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

/**
 * 截图清单：只收 shotsDir 内真实存在的文件（脚本报告里的绝对路径不外泄）。
 */
function collectScreenshots(report, shotsDir) {
  const candidates = [];
  for (const page of Array.isArray(report && report.pages) ? report.pages : []) {
    if (!page || typeof page.screenshot !== 'string' || page.screenshot === '') continue;
    candidates.push({ label: page.label || page.route || '', file: page.screenshot });
  }
  const out = [];
  const seen = new Set();
  const push = (label, file) => {
    const resolved = path.resolve(file);
    const relative = path.relative(path.resolve(shotsDir), resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const name = relative.replace(/\\/g, '/');
    if (seen.has(name)) return;
    let size = 0;
    try {
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) return;
      size = stats.size;
    } catch (error) {
      return;
    }
    seen.add(name);
    out.push({ label: truncate(label, 40), path: name, bytes: size });
  };
  for (const item of candidates) push(item.label, item.file);
  // 脚本在部分链路里会额外截图（例如演示支付），这里补齐目录里其余 PNG。
  try {
    for (const name of fs.readdirSync(shotsDir).sort()) {
      if (!/\.(png|jpg|jpeg)$/i.test(name)) continue;
      push('', path.join(shotsDir, name));
    }
  } catch (error) {
    /* 目录不存在时只返回报告里能核对到的截图 */
  }
  return out;
}

function baseResult(status, code, summary, extra) {
  return {
    ok: status === STATUS.PASS,
    status,
    code,
    summary: sanitizeText(summary),
    details: {},
    artifacts: {},
    ...(extra || {}),
  };
}

/**
 * 执行一次真实微信运行时验证。
 *
 * @param {object} options
 * @param {string} options.projectDir         Composer 产物目录（绝对路径，且必须像小程序工程）
 * @param {string} options.privateRoot        私有运行目录（证据只能写它下面）
 * @param {string} [options.evidenceDir]      证据目录（默认 <privateRoot>/verification/runtime[-n]）
 * @param {string} [options.shotsDir]         截图目录（默认 <evidenceDir>/shots）
 * @param {string} [options.cliPath]          显式 DevTools CLI（仅内部可信配置；缺省自动探测）
 * @param {string} [options.scriptPath]       固定脚本路径（默认仓库 scripts/wechat-devtools-run.cjs）
 * @param {number} [options.autoPort=9420]
 * @param {number} [options.timeoutMs=600000] 上限 1800000
 * @param {object} [options.signal]           取消信号（{cancelled} 或 AbortSignal）
 * @param {Function} [options.spawnImpl]      仅测试注入；生产永远走固定脚本
 */
async function verifyRuntime(options) {
  const opts = options || {};
  const privateRoot = opts.privateRoot;

  if (typeof privateRoot !== 'string' || !path.isAbsolute(privateRoot)) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'privateRoot 必须是绝对路径');
  }
  const privateCanonical = assertCanonicalDir(privateRoot);
  if (!privateCanonical.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'privateRoot 必须是规范目录：' + (privateCanonical.message || privateCanonical.code));
  }
  const privateReal = privateCanonical.realDir;

  if (typeof opts.projectDir !== 'string' || !path.isAbsolute(opts.projectDir)) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'projectDir 必须是绝对路径');
  }
  const projectCanonical = assertCanonicalDir(opts.projectDir);
  if (!projectCanonical.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'projectDir 必须是规范目录：' + (projectCanonical.message || projectCanonical.code));
  }
  // DevTools 打开工程会写 project.private.config.json 等本地产物：禁止把仓库内受保护目录当候选工程。
  if (isProtectedRepoDir(projectCanonical.realDir)) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'projectDir 不允许位于仓库内（避免 DevTools 产物污染 templates/miniprogram）');
  }
  if (!fs.existsSync(path.join(opts.projectDir, 'app.json'))) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'projectDir 不像小程序工程（缺少 app.json）');
  }

  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'timeoutMs 必须是 1000–' + MAX_TIMEOUT_MS + ' 的整数');
  }

  if (isCancelled(opts.signal)) {
    return baseResult(STATUS.NOT_RUN, CODES.CANCELLED, '运行时验证在开始前被取消');
  }

  // ---- 证据目录（只允许在 privateRoot 下，逐段 canonical） ----
  const baseDir = typeof opts.evidenceDir === 'string' && opts.evidenceDir !== ''
    ? opts.evidenceDir
    : path.join(privateRoot, 'verification');
  if (!path.isAbsolute(baseDir)) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'evidenceDir 必须是绝对路径');
  }
  const evidenceBase = typeof opts.evidenceDir === 'string' && opts.evidenceDir !== ''
    ? baseDir
    : path.join(baseDir, 'runtime');
  let evidenceDir = evidenceBase;
  if (fs.existsSync(evidenceBase)) {
    evidenceDir = '';
    for (let index = 2; index <= 10; index += 1) {
      const candidateDir = evidenceBase + '-' + index;
      if (!fs.existsSync(candidateDir)) {
        evidenceDir = candidateDir;
        break;
      }
    }
    if (!evidenceDir) {
      return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, '运行时证据目录超过上限（同一 run 已执行过 9 次）');
    }
  }
  const ensuredEvidence = ensureDirectory(privateRoot, privateReal, evidenceDir);
  if (!ensuredEvidence.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, '无法创建证据目录：' + (ensuredEvidence.message || ensuredEvidence.code));
  }
  const evidenceCanonical = assertCanonicalDir(evidenceDir);
  if (!evidenceCanonical.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, '证据目录不是规范目录：' + (evidenceCanonical.message || evidenceCanonical.code));
  }
  const shotsDir = typeof opts.shotsDir === 'string' && opts.shotsDir !== ''
    ? opts.shotsDir
    : path.join(evidenceDir, 'shots');
  if (!path.isAbsolute(shotsDir)) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, 'shotsDir 必须是绝对路径');
  }
  const ensuredShots = ensureDirectory(privateRoot, privateReal, shotsDir);
  if (!ensuredShots.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, '无法创建截图目录：' + (ensuredShots.message || ensuredShots.code));
  }
  const shotsCanonical = assertCanonicalDir(shotsDir);
  if (!shotsCanonical.ok) {
    return baseResult(STATUS.BLOCKED, CODES.INPUT_INVALID, '截图目录不是规范目录：' + (shotsCanonical.message || shotsCanonical.code));
  }

  const evidencePath = path.join(evidenceDir, 'wechat-devtools-run.json');
  const artifacts = { evidenceDir, evidencePath, shotsDir, screenshots: [] };
  const details = { privateRootRelative: path.relative(privateRoot, evidenceDir).replace(/\\/g, '/') };

  const finish = (status, code, summary, extra) => {
    const fullSummary = summary.startsWith('微信运行时') ? summary : '微信运行时 ' + status + '：' + summary;
    const result = baseResult(status, code, fullSummary, {
      details: { ...details, ...((extra && extra.details) || {}) },
      artifacts: { ...artifacts, ...((extra && extra.artifacts) || {}) },
    });
    if (extra && extra.pages) result.pages = extra.pages;
    if (extra && extra.interactions) result.interactions = extra.interactions;
    // 包装层证据（相对路径；不含绝对路径/命令环境）
    const wrapper = {
      schemaVersion: WRAPPER_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      status: result.status,
      code: result.code,
      summary: result.summary,
      details: result.details,
      screenshots: result.artifacts.screenshots,
      evidenceRelative: path.relative(evidenceDir, evidencePath).replace(/\\/g, '/'),
      projectDirRelative: path.relative(privateRoot, opts.projectDir).replace(/\\/g, '/'),
      autoPort: Number.isInteger(opts.autoPort) ? opts.autoPort : DEFAULT_AUTO_PORT,
      timeoutMs,
    };
    try {
      fs.writeFileSync(path.join(evidenceDir, WRAPPER_EVIDENCE), JSON.stringify(wrapper, null, 2) + '\n', 'utf8');
      result.artifacts.wrapperEvidencePath = path.join(evidenceDir, WRAPPER_EVIDENCE);
    } catch (error) {
      result.details.wrapperEvidenceError = boundedDetail(error);
    }
    return result;
  };

  // ---- 工具链（缺失 = BLOCKED，不启动、不伪造） ----
  const toolchain = resolveToolchain({ cliPath: opts.cliPath, scriptPath: opts.scriptPath });
  if (!toolchain.ok) {
    return finish(STATUS.BLOCKED, toolchain.code, toolchain.reason, {
      details: { blockedReason: toolchain.reason, toolchain: 'unavailable' },
    });
  }
  details.cli = path.basename(toolchain.cliPath);

  const argsResult = buildRunArgs({
    projectDir: opts.projectDir,
    scriptPath: toolchain.scriptPath,
    autoPort: opts.autoPort,
    evidencePath,
    shotsDir,
  });
  if (!argsResult.ok) {
    return finish(STATUS.BLOCKED, argsResult.code, argsResult.reason);
  }
  const args = argsResult.args;
  const runOutcome = await runWithLimits({
    spawnImpl: opts.spawnImpl,
    command: process.execPath,
    args,
    timeoutMs,
    signal: opts.signal,
  });
  artifacts.exitCode = runOutcome.exitCode;

  if (runOutcome.cancelled) {
    return finish(STATUS.NOT_RUN, CODES.CANCELLED, '运行时验证被取消（未产生可引用结论）');
  }
  if (runOutcome.timedOut) {
    return finish(STATUS.BLOCKED, CODES.TIMEOUT, '运行时验证超时（' + timeoutMs + 'ms）');
  }
  if (runOutcome.spawnError) {
    return finish(STATUS.BLOCKED, CODES.SCRIPT_FAILED, '无法启动微信验证脚本：' + boundedDetail(runOutcome.spawnError));
  }

  const read = readReport(evidencePath);
  if (!read.ok) {
    return finish(STATUS.BLOCKED, CODES.EVIDENCE_MISSING, '没有可引用的微信证据：' + read.reason, {
      details: { exitCode: runOutcome.exitCode },
    });
  }
  const report = read.report;
  if (typeof report.status !== 'string' || !Object.values(STATUS).includes(report.status)) {
    return finish(STATUS.BLOCKED, CODES.INCONSISTENT, '微信证据 status 非法，拒绝据此判定通过', {
      details: { reportStatus: truncate(report.status, 40) },
    });
  }

  const pageCounts = countByStatus(report.pages);
  const interactionCounts = countByStatus(report.interactions);
  const stepCounts = countByStatus(report.steps);
  const warnings = [];
  let status = report.status;
  let downgradeCode = null;
  if (status === STATUS.PASS && runOutcome.exitCode !== 0) {
    status = STATUS.BLOCKED;
    downgradeCode = CODES.INCONSISTENT;
    warnings.push('证据声称 PASS 但进程退出码非 0');
  }
  if (status === STATUS.FAIL && runOutcome.exitCode === 0) {
    warnings.push('证据声称 FAIL 但进程退出码为 0（按证据判定 FAIL）');
  }
  if (status === STATUS.PASS && pageCounts.total > 0 && pageCounts.PASS !== pageCounts.total) {
    status = STATUS.BLOCKED;
    downgradeCode = CODES.INCONSISTENT;
    warnings.push('证据声称 PASS 但存在未通过页面');
  }

  artifacts.screenshots = collectScreenshots(report, shotsDir);
  details.pages = pageCounts;
  details.interactions = interactionCounts;
  details.steps = stepCounts;
  details.reportBytes = read.bytes;
  if (report.blocked) details.blockedReason = sanitizeText(report.blocked);
  if (warnings.length > 0) details.warnings = warnings;

  const code = downgradeCode || (status === STATUS.PASS ? CODES.PASS
    : status === STATUS.FAIL ? CODES.FAIL
      : status === STATUS.NOT_RUN ? CODES.NOT_RUN : CODES.BLOCKED);
  const summary = '微信运行时 ' + status
    + '：页面 ' + pageCounts.PASS + '/' + pageCounts.total + ' 通过'
    + '，交互 ' + (interactionCounts.PASS || 0) + '/' + interactionCounts.total + ' 通过'
    + '，截图 ' + artifacts.screenshots.length + ' 张'
    + (report.blocked ? '；阻塞：' + sanitizeText(report.blocked) : '');

  return finish(status, code, summary, {
    details: {
      reportStatus: report.status,
      exitCode: runOutcome.exitCode,
    },
    pages: (Array.isArray(report.pages) ? report.pages : []).slice(0, 24).map((page) => ({
      route: truncate(page && page.route, 80),
      label: truncate(page && page.label, 40),
      status: page && page.status,
      screenshot: truncate(page && page.screenshot ? path.basename(String(page.screenshot)) : '', 80),
    })),
    interactions: (Array.isArray(report.interactions) ? report.interactions : []).slice(0, 32).map((item) => ({
      label: truncate(item && item.label, 60),
      status: item && item.status,
      detail: sanitizeText(item && item.detail),
      path: truncate(item && item.path, 40),
    })),
  });
}

module.exports = {
  STATUS,
  CODES,
  WRAPPER_EVIDENCE,
  WRAPPER_SCHEMA_VERSION,
  DEFAULT_AUTO_PORT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SCRIPT,
  resolveToolchain,
  buildRunArgs,
  collectScreenshots,
  verifyRuntime,
  sanitizeText,
  runWithLimits,
};
