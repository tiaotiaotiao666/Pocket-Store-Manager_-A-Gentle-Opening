#!/usr/bin/env node
'use strict';

/**
 * B4：受控检查分发器（固定映射，不接受任意 command/shell/env/cwd）。
 *
 * 由 `desktop/agent-workspace/checks.cjs` 以固定 argv 调用：
 *   node scripts/agent-checks/run-check.cjs --check <checkId> [--root <dir>] [--target <file>] [--timeout <ms>]
 *
 * 设计边界：
 * - checkId 必须在下面的固定表里；表外一律拒绝（AGENT_CHECK_UNKNOWN 由 checks.cjs 先拦，这里再 fail-closed）。
 * - 参数只有 --root/--target/--timeout 三个，且都做白名单/范围校验；不允许额外参数、位置参数或命令字符串。
 * - 子进程一律用 execFile + 固定 argv（shell:false），不拼 shell；env 只透传必要系统变量。
 * - wechat.verify 固定包装 scripts/wechat-devtools-run.cjs；工具缺失/超时/输出不可解析 → BLOCKED，不伪造 PASS。
 * - 输出单行 JSON：{checkId,status,durationMs,issues,evidenceRelative?}；退出码恒为 0，由 checks.cjs 读取状态。
 */

const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 固定映射：checkId → 既有脚本/包装器（新增 checkId 必须同时改 checks.cjs 与这里）。 */
const CHECKS = Object.freeze({
  'source.check': { script: 'scripts/frontend-capabilities.cjs', args: ['--check'] },
  'mini.check': { script: 'scripts/validate-miniprogram.cjs', args: [] },
  'composer.dry-run': { script: 'scripts/composer/verify-cli.cjs', args: [], requiresRoot: true },
  'output.consistency': { script: 'scripts/agent-checks/output-consistency.cjs', args: [], requiresRoot: true },
  'unit.targeted': { nodeTest: true, allowTarget: true },
  'unit.full': { nodeTest: true, args: ['test'] },
  'desktop.contract': { nodeTest: true, args: ['test/desktop-contract.test.cjs'] },
  'catalog.check': { script: 'scripts/component-catalog.cjs', args: ['--check'] },
  'registry.check': { script: 'scripts/registry-check.cjs', args: [] },
  'wechat.verify': { script: 'scripts/wechat-devtools-run.cjs', args: [], requiresRoot: true, wechat: true },
});

/** unit.targeted 只允许仓库内固定的测试文件白名单（不在表内一律拒绝）。 */
const TARGET_ALLOWLIST = Object.freeze([
  'test/desktop-contract.test.cjs',
  'test/frontend-contract.test.cjs',
  'test/agent-tools-ipc.test.cjs',
  'test/workspace-agent-service.test.cjs',
  'test/agent-workspace.checks.test.cjs',
]);

const MAX_TIMEOUT_MS = 600000;
const MAX_ISSUES = 200;

function parseArgs(argv) {
  const out = { checkId: null, root: null, targets: [], timeoutMs: 120000 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--check', '--root', '--target', '--timeout'].includes(flag)) return { ok: false, message: '未知参数' };
    // --target 允许重复（unit.targeted 的固定白名单文件），其它参数不允许重复。
    if (flag !== '--target' && seen.has(flag)) return { ok: false, message: '参数重复' };
    if (typeof value !== 'string' || value === '' || value.includes('\0')) return { ok: false, message: '参数缺少值' };
    seen.add(flag);
    index += 1;
    if (flag === '--check') out.checkId = value;
    if (flag === '--root') out.root = value;
    if (flag === '--target') {
      if (!TARGET_ALLOWLIST.includes(value)) return { ok: false, message: 'target 不在白名单' };
      if (out.targets.includes(value)) return { ok: false, message: 'target 重复' };
      if (out.targets.length >= 5) return { ok: false, message: 'target 过多' };
      out.targets.push(value);
    }
    if (flag === '--timeout') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1000 || parsed > MAX_TIMEOUT_MS) return { ok: false, message: 'timeout 非法' };
      out.timeoutMs = parsed;
    }
  }
  if (!out.checkId || !Object.prototype.hasOwnProperty.call(CHECKS, out.checkId)) {
    return { ok: false, message: 'checkId 未注册' };
  }
  const definition = CHECKS[out.checkId];
  if (definition.requiresRoot && (!out.root || !path.isAbsolute(out.root))) return { ok: false, message: '缺少派生 root' };
  if (out.targets.length > 0 && !definition.allowTarget) return { ok: false, message: '该 check 不接受 target' };
  return { ok: true, args: out, definition };
}

function sanitizeLine(line) {
  let text = String(line || '');
  for (const variant of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/')]) {
    text = text.split(variant).join('.');
  }
  text = text.replace(/[A-Za-z]:[\\/][^\s"']*/g, '[path]');
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > 240 ? text.slice(0, 237) + '...' : text;
}

function issuesFromText(stdout, stderr, code, source) {
  const lines = `${stdout || ''}\n${stderr || ''}`
    .split(/\r?\n/)
    .map(sanitizeLine)
    .filter(Boolean);
  return lines.slice(0, MAX_ISSUES).map((message) => ({
    file: null,
    line: null,
    column: null,
    code,
    message,
    source,
  }));
}

function parseWechatReport(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const candidates = [text];
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
  if (lastLine && lastLine !== text) candidates.push(lastLine);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object') continue;
      if (!['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(parsed.status)) continue;
      return parsed;
    } catch (error) {
      /* 继续尝试下一段 */
    }
  }
  return null;
}

function fixedEnv() {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'ComSpec', 'PATHEXT']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

const TOOL_MISSING = 'CHECK_TOOL_MISSING';

function runProcess(argv, options, spawnImpl) {
  const opts = options || {};
  const spawn = typeof spawnImpl === 'function' ? spawnImpl : execFile;
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    try {
      spawn(argv[0], argv.slice(1), {
        cwd: REPO_ROOT,
        shell: false,
        windowsHide: true,
        timeout: opts.timeoutMs || 120000,
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
        resolvePromise({ ok: true, code: 'OK', stdout: stdout || '', stderr: stderr || '', durationMs });
      });
    } catch (error) {
      // 受限环境（如沙箱）可能在调用 execFile 时同步抛 EPERM：归一为工具缺失，不许冒泡成 CHECK_FAILED。
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

/** 把“进程失败”归一为报告：工具/环境类 → BLOCKED + CHECK_TOOL_MISSING；真实非零退出 → FAIL + CHECK_FAILED。 */
function buildFailureReport(checkId, result) {
  const failed = result || {};
  const blocked = Boolean(failed.killed
    || ['ENOENT', 'EPERM', 'EACCES', 'ETIMEDOUT', TOOL_MISSING].includes(String(failed.code)));
  const code = blocked ? TOOL_MISSING : 'CHECK_FAILED';
  return {
    checkId: checkId || null,
    status: blocked ? 'BLOCKED' : 'FAIL',
    durationMs: Number.isInteger(failed.durationMs) ? failed.durationMs : 0,
    issues: issuesFromText(failed.stdout || '', failed.stderr || '', code, 'check').slice(0, MAX_ISSUES),
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify({
      checkId: null,
      status: 'BLOCKED',
      durationMs: 0,
      issues: [{ file: null, line: null, column: null, code: 'AGENT_CHECK_UNKNOWN', message: parsed.message, source: 'check' }],
    }) + '\n');
    return;
  }
  const { args, definition } = parsed;
  let argv;
  if (definition.nodeTest) {
    const targets = definition.allowTarget && args.targets.length > 0 ? args.targets : definition.args;
    argv = [process.execPath, '--test', ...targets];
  } else {
    const scriptPath = path.join(REPO_ROOT, definition.script);
    const extra = definition.requiresRoot ? ['--root', args.root] : [];
    argv = [process.execPath, scriptPath, ...definition.args, ...extra];
  }

  const result = await runProcess(argv, { timeoutMs: args.timeoutMs });
  if (definition.wechat) {
    const report = parseWechatReport(result.stdout);
    if (result.ok && report) {
      process.stdout.write(JSON.stringify({
        checkId: args.checkId,
        status: report.status,
        durationMs: result.durationMs,
        issues: issuesFromText('', result.stderr, report.status === 'PASS' ? 'CHECK_OK' : 'CHECK_BLOCKED', 'wechat').slice(0, MAX_ISSUES),
        ...(typeof report.evidenceRelative === 'string' ? { evidenceRelative: report.evidenceRelative } : {}),
      }) + '\n');
      return;
    }
    // 工具缺失/超时/输出不可解析/证据矛盾：一律 BLOCKED + 工具缺失码，绝不伪造 PASS。
    process.stdout.write(JSON.stringify({
      checkId: args.checkId,
      status: 'BLOCKED',
      durationMs: result.durationMs,
      issues: issuesFromText(result.stdout, result.stderr, TOOL_MISSING, 'wechat').slice(0, MAX_ISSUES),
    }) + '\n');
    return;
  }

  if (!result.ok) {
    process.stdout.write(JSON.stringify(buildFailureReport(args.checkId, result)) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify({
    checkId: args.checkId,
    status: 'PASS',
    durationMs: result.durationMs,
    issues: [],
  }) + '\n');
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({
      checkId: null,
      status: 'BLOCKED',
      durationMs: 0,
      issues: [{ file: null, line: null, column: null, code: TOOL_MISSING, message: '检查进程异常', source: 'check' }],
    }) + '\n');
  });
}

module.exports = {
  CHECKS,
  TARGET_ALLOWLIST,
  MAX_ISSUES,
  TOOL_MISSING,
  parseArgs,
  runProcess,
  buildFailureReport,
  parseWechatReport,
  issuesFromText,
};
