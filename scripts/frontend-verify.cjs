#!/usr/bin/env node
'use strict';

/**
 * P3 固定本地验证命令：对一个已物化的候选 attempt 执行 dry-run，可选再跑真实微信验证。
 *
 *   node scripts/frontend-verify.cjs --attempt <attemptDir> [--draft <draft.json>]
 *        [--plan <plan.json>] [--requirement <requirement.json>] [--runtime]
 *        [--auto-port 9420] [--timeout-ms 600000] [--evidence <dir>] [--json <evidence.json>]
 *
 * 约定：
 * - 只接受固定参数，**不接受** `--command`/shell 之类的任意执行入口；
 * - 微信验证只会调用 `scripts/wechat-devtools-run.cjs`（固定参数、超时、证据目录）；
 * - 退出码：0 = dry-run 通过（且 runtime 未执行或 PASS）；1 = dry-run 失败；
 *   2 = 微信运行时 FAIL；3 = 微信运行时 BLOCKED/NOT_RUN（工具缺失也如实 3，不伪造通过）。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { dryRun } = require(path.join(REPO_ROOT, 'desktop', 'frontend-reconstruct', 'dry-run.cjs'));
const { verifyRuntime, STATUS: RUNTIME_STATUS } = require(path.join(REPO_ROOT, 'desktop', 'frontend-reconstruct', 'verify-runtime.cjs'));
const { overlayAssetRoots } = require(path.join(REPO_ROOT, 'desktop', 'frontend-reconstruct', 'registry-overlay.cjs'));
const { assertCanonicalDir, resolveInside } = require(path.join(REPO_ROOT, 'desktop', 'frontend-reconstruct', 'workspace.cjs'));

const EXIT = Object.freeze({ PASS: 0, DRY_RUN_FAILED: 1, RUNTIME_FAILED: 2, RUNTIME_BLOCKED: 3 });

function parseArgs(argv) {
  const options = { runtime: false, mode: 'development' };
  const flags = new Set([
    '--attempt', '--draft', '--plan', '--requirement', '--auto-port', '--timeout-ms', '--evidence', '--json', '--mode',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--runtime') {
      options.runtime = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (!flags.has(token)) return { ok: false, message: '不支持的参数：' + token };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, message: token + ' 需要一个值' };
    index += 1;
    if (token === '--attempt') options.attempt = value;
    else if (token === '--draft') options.draft = value;
    else if (token === '--plan') options.plan = value;
    else if (token === '--requirement') options.requirement = value;
    else if (token === '--evidence') options.evidence = value;
    else if (token === '--json') options.json = value;
    else if (token === '--mode') options.mode = value;
    else if (token === '--auto-port') options.autoPort = Number(value);
    else if (token === '--timeout-ms') options.timeoutMs = Number(value);
  }
  return { ok: true, options };
}

function readJsonFile(file, label) {
  try {
    const resolved = path.resolve(file);
    return { ok: true, value: JSON.parse(fs.readFileSync(resolved, 'utf8')), file: resolved };
  } catch (error) {
    return { ok: false, message: '无法读取 ' + label + '：' + (error.code || error.message) };
  }
}

function loadAttempt(attemptDir) {
  const canonical = assertCanonicalDir(attemptDir);
  if (!canonical.ok) return { ok: false, message: 'attempt 目录不是规范目录：' + (canonical.message || canonical.code) };
  const attemptFile = path.join(attemptDir, 'attempt.json');
  const read = readJsonFile(attemptFile, 'attempt.json');
  if (!read.ok) return read;
  const attempt = read.value;
  const candidate = attempt && attempt.candidate;
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.version !== 'string') {
    return { ok: false, message: 'attempt.json 缺少 candidate.id/version' };
  }
  if (!Number.isInteger(attempt.attempt)) return { ok: false, message: 'attempt.json 缺少 attempt 序号' };
  const overlay = resolveInside(attemptDir, 'overlay');
  if (!overlay.ok) return { ok: false, message: 'overlay 路径非法：' + overlay.message };
  const candidateDir = resolveInside(attemptDir, 'candidate');
  if (!candidateDir.ok) return { ok: false, message: 'candidate 路径非法：' + candidateDir.message };
  if (!fs.existsSync(overlay.target) || !fs.existsSync(candidateDir.target)) {
    return { ok: false, message: 'attempt 产物不完整（缺少 candidate/overlay）' };
  }
  return {
    ok: true,
    materialized: {
      ok: true,
      attempt: attempt.attempt,
      attemptDir,
      candidateDir: candidateDir.target,
      overlayDir: overlay.target,
      overlayRegistryRoot: overlay.target,
      assetRoots: overlayAssetRoots(overlay.target),
      candidate: { id: candidate.id, version: candidate.version },
    },
  };
}

function printIssues(issues) {
  for (const issue of issues || []) {
    const location = [issue.path, issue.file].filter(Boolean).join(' · ') || '(无法定位)';
    console.log('  [' + issue.severity + '] ' + issue.code + ' @ ' + location + '：' + issue.message);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = 2;
    return;
  }
  const options = parsed.options;
  if (options.help) {
    console.log('用法：node scripts/frontend-verify.cjs --attempt <attemptDir> [--draft <draft.json>] [--runtime] [--json <evidence.json>]');
    return;
  }
  if (!options.attempt) {
    console.error('缺少 --attempt <attemptDir>');
    process.exitCode = 2;
    return;
  }
  if (options.mode !== 'development' && options.mode !== 'production') {
    console.error('--mode 只支持 development/production');
    process.exitCode = 2;
    return;
  }

  const attemptDir = path.resolve(options.attempt);
  const loaded = loadAttempt(attemptDir);
  if (!loaded.ok) {
    console.error('候选 attempt 不可用：' + loaded.message);
    process.exitCode = 1;
    return;
  }

  let draft;
  if (options.draft) {
    const read = readJsonFile(options.draft, 'draft');
    if (!read.ok) {
      console.error(read.message);
      process.exitCode = 2;
      return;
    }
    draft = read.value;
  }
  let plan;
  if (options.plan) {
    const read = readJsonFile(options.plan, 'plan');
    if (!read.ok) {
      console.error(read.message);
      process.exitCode = 2;
      return;
    }
    plan = read.value;
  }
  let requirement;
  if (options.requirement) {
    const read = readJsonFile(options.requirement, 'requirement');
    if (!read.ok) {
      console.error(read.message);
      process.exitCode = 2;
      return;
    }
    requirement = read.value;
  }

  console.log('候选 dry-run：' + attemptDir);
  const result = await dryRun({
    materialized: loaded.materialized,
    draft,
    plan,
    requirement,
    mode: options.mode,
    revision: loaded.materialized.attempt,
    onStage: (stage) => console.log('  · ' + stage),
  });
  console.log('  结论：' + result.code + ' · ' + result.summary);
  console.log('  产物：' + (result.artifacts && result.artifacts.outputRelativePath ? result.artifacts.outputRelativePath : '(无)'));
  printIssues(result.issues);

  let runtime = null;
  if (options.runtime && result.ok) {
    console.log('微信运行时验证：');
    runtime = await verifyRuntime({
      projectDir: result.artifacts.outputDir,
      privateRoot: attemptDir,
      evidenceDir: options.evidence,
      autoPort: options.autoPort,
      timeoutMs: options.timeoutMs,
    });
    console.log('  结论：' + runtime.status + ' · ' + runtime.summary);
    console.log('  证据：' + (runtime.artifacts && runtime.artifacts.evidencePath
      ? path.relative(attemptDir, runtime.artifacts.evidencePath).replace(/\\/g, '/')
      : '(无)'));
    for (const shot of (runtime.artifacts && runtime.artifacts.screenshots) || []) {
      console.log('  截图：' + shot.path + '（' + shot.bytes + ' 字节）');
    }
    if (runtime.details && runtime.details.blockedReason) console.log('  阻塞：' + runtime.details.blockedReason);
  } else if (options.runtime) {
    console.log('dry-run 未通过：跳过微信运行时验证（NOT_RUN）');
  }

  if (options.json) {
    const evidence = {
      schemaVersion: 'frontend-verify.v1',
      generatedAt: new Date().toISOString(),
      attempt: loaded.materialized.attempt,
      candidateId: result.candidateId,
      revision: result.revision,
      dryRun: {
        ok: result.ok,
        code: result.code,
        summary: result.summary,
        checks: result.checks,
        issues: result.issues,
        artifacts: {
          outputRelativePath: result.artifacts && result.artifacts.outputRelativePath,
          evidenceRelativePath: result.artifacts && result.artifacts.evidenceFile
            ? path.relative(attemptDir, result.artifacts.evidenceFile).replace(/\\/g, '/')
            : null,
        },
      },
      runtime: runtime
        ? {
          status: runtime.status,
          code: runtime.code,
          summary: runtime.summary,
          screenshots: runtime.artifacts.screenshots,
          blockedReason: runtime.details && runtime.details.blockedReason ? runtime.details.blockedReason : null,
          evidenceRelativePath: runtime.artifacts.evidencePath
            ? path.relative(attemptDir, runtime.artifacts.evidencePath).replace(/\\/g, '/')
            : null,
        }
        : { status: 'NOT_RUN', code: 'RUNTIME_NOT_REQUESTED' },
    };
    try {
      const target = path.resolve(options.json);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      console.log('  证据（本地汇总）：' + target);
    } catch (error) {
      console.error('无法写入 --json：' + (error.code || error.message));
      process.exitCode = 1;
      return;
    }
  }

  if (!result.ok) {
    process.exitCode = EXIT.DRY_RUN_FAILED;
    return;
  }
  if (runtime) {
    if (runtime.status === RUNTIME_STATUS.PASS) process.exitCode = EXIT.PASS;
    else if (runtime.status === RUNTIME_STATUS.FAIL) process.exitCode = EXIT.RUNTIME_FAILED;
    else process.exitCode = EXIT.RUNTIME_BLOCKED;
    return;
  }
  process.exitCode = EXIT.PASS;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FRONTEND_VERIFY_FAILED', error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { EXIT, parseArgs, loadAttempt };
