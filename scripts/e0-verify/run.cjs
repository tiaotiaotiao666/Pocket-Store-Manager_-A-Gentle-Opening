#!/usr/bin/env node
'use strict';

/**
 * E0-V1 独立验证器入口（准备阶段骨架）。
 *
 * 用法：
 *   node scripts/e0-verify/run.cjs --mode offline            # 只跑可离线执行的用例（默认）
 *   node scripts/e0-verify/run.cjs --mode real               # 追加真实 Flash 用例（当前 NOT_RUN）
 *   node scripts/e0-verify/run.cjs --mode offline --no-write # 不落报告文件（仅打印）
 *   node scripts/e0-verify/run.cjs --out <file.json>         # 指定报告落点
 *
 * 退出码：
 *   0 = 用例真实执行且无 FAIL（NOT_RUN/BLOCKED 允许；**不代表 E0 通过**）
 *   1 = 有 FAIL（被测实现缺陷，需出 finding 给 Captain）
 *   2 = 用法/环境错误（临时目录建不起来、参数非法等）
 *
 * 边界：只 require 冻结模块；不复制实现；不写项目真实 userData；临时目录自建自清；
 *       verdict 由 t8（E0-V1）出具，本脚本恒输出 e0Verdict=NOT_RUN 或 FAIL。
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./lib/env.cjs');
const { createFrozenRegistry } = require('./lib/frozen.cjs');
const { STATUS, createHarness, readHead } = require('./lib/harness.cjs');
const { buildReadiness } = require('./readiness.cjs');

const CHAIN_PRECONDITIONS = require('./chains/preconditions.cjs');
const CHAIN_VERTICAL = require('./chains/vertical.cjs');
const CHAIN_COORDINATOR = require('./chains/coordinator.cjs');
const CHAIN_SCHEDULER = require('./chains/scheduler.cjs');
const CHAIN_WORKSPACE_W2 = require('./chains/workspace-w2.cjs');
const CHAIN_REAL = require('./chains/real-flash.cjs');
const ATTACKS_B1_B2 = require('./attacks/b1-b2.cjs');
const ATTACKS_E0 = require('./attacks/e0.cjs');

const DEFAULT_OUT = path.join(env.REPO_ROOT, 'docs', 'evidence', 'workspace-agent', 'e0-v1', 'run-report.json');
const MODES = ['offline', 'real'];

// 管道被下游截断（如 `| Select-Object -First N`）时不要以未捕获异常方式退出。
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(process.exitCode || 0);
});

function parseArgs(argv) {
  const options = { mode: 'offline', out: DEFAULT_OUT, write: true, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const value = argv[index + 1];
      if (!MODES.includes(value)) throw new Error('--mode 只接受 offline|real');
      options.mode = value;
      index += 1;
      continue;
    }
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out 需要文件路径');
      options.out = path.isAbsolute(value) ? value : path.join(env.REPO_ROOT, value);
      index += 1;
      continue;
    }
    if (arg === '--no-write') { options.write = false; continue; }
    if (arg === '--verbose') { options.verbose = true; continue; }
    if (arg === '--only') {
      const value = argv[index + 1];
      if (!value) throw new Error('--only 需要逗号分隔的用例 id，如 C07,S01');
      options.only = value.split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    throw new Error('未知参数：' + arg);
  }
  return options;
}

function usage() {
  return [
    'E0-V1 独立验证器（准备阶段）',
    '',
    '  node scripts/e0-verify/run.cjs --mode offline [--out <file>] [--no-write] [--verbose] [--only C07,S01]',
    '',
    '  退出码 0=无 FAIL / 1=有 FAIL / 2=用法或环境错误',
    '  注意：退出码 0 不代表 E0 通过；verdict 由 t8 出具。',
  ].join('\n');
}

function pad(value, width) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function printTable(cases) {
  console.log(pad('ID', 6) + pad('STATUS', 9) + pad('X', 16) + 'TITLE / 说明');
  console.log('-'.repeat(110));
  for (const item of cases) {
    const note = item.status === STATUS.PASS
      ? (item.detail || '')
      : (item.reason || item.detail || '');
    console.log(pad(item.id, 6) + pad(item.status, 9) + pad((item.x || []).join(','), 16)
      + (item.title || '') + (note ? '｜' + note : ''));
  }
  console.log('-'.repeat(110));
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error('[e0-verify] ' + error.message + '\n\n' + usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const frozen = createFrozenRegistry();
  let temp = null;
  let repoBefore = null;
  const startedAt = new Date();
  try {
    repoBefore = env.snapshotRepoDataDirs();
    temp = env.createTempUserData({ prefix: 'dsh-e0v1-' });
    if (options.verbose) console.log('[e0-verify] 临时 userData：<temp>（' + temp.prefix + '…）');

    const harness = createHarness({
      frozen,
      sanitize: (text) => env.sanitize(text, temp.real),
      sanitizeDeep: (value) => env.sanitizeDeep(value, temp.real),
    });
    const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null;
    const defineFiltered = (cases) => {
      harness.defineAll(only ? cases.filter((item) => only.has(item.id)) : cases);
    };
    defineFiltered(CHAIN_PRECONDITIONS.CASES);
    defineFiltered(CHAIN_COORDINATOR.CASES);
    defineFiltered(CHAIN_SCHEDULER.CASES);
defineFiltered(CHAIN_WORKSPACE_W2.CASES);
    defineFiltered(CHAIN_VERTICAL.CASES);    if (options.mode === 'real') {
      defineFiltered(CHAIN_REAL.CASES);
    } else {
      for (const def of CHAIN_REAL.CASES) {
        if (only && !only.has(def.id)) continue;
        harness.define(Object.assign({}, def, {
          requires: [],
          run: undefined,
          reason: 'offline 模式不执行真实模型用例（用 --mode real 显式开启）',
        }));
      }
    }
    defineFiltered(ATTACKS_B1_B2.CASES);
    defineFiltered(ATTACKS_E0.CASES);

    const ctx = { env, frozen, temp, mode: options.mode };
    const results = await harness.runAll(ctx);

    // 仓库零写入守卫：项目真实数据目录必须逐字节等价。
    const repoAfter = env.snapshotRepoDataDirs();
    const changed = env.diffRepoDataDirs(repoBefore, repoAfter);
    results.push({
      id: 'G01',
      group: 'G 环境守卫',
      title: '验证器运行期间仓库项目数据目录零写入',
      x: [],
      requires: [],
      expected: 'app-data / generated-projects / generated-projects-test 指纹前后一致',
      status: changed.length === 0 ? STATUS.PASS : STATUS.FAIL,
      detail: changed.length === 0 ? '仓库数据目录指纹未变化' : '仓库数据目录被写入：' + JSON.stringify(changed),
      observed: { changed },
      durationMs: 0,
    });

    const counts = harness.countsOf(results);

    // 验证器自检：断言工具必须能“失败”，否则整份报告没有判据价值。
    const selfCheck = { wrongCodeThrew: false, acceptedThrew: false, equalThrew: false };
    try {
      const { assertRejected, assertEqual } = require('./lib/harness.cjs');
      try {
        assertRejected({ ok: false, code: 'AGENT_PROBE_WRONG' }, ['AGENT_EXPECTED'], 'selfcheck');
      } catch {
        selfCheck.wrongCodeThrew = true;
      }
      try {
        assertRejected({ ok: true, code: null }, ['AGENT_EXPECTED'], 'selfcheck');
      } catch {
        selfCheck.acceptedThrew = true;
      }
      try {
        assertEqual('a', 'b', 'selfcheck');
      } catch {
        selfCheck.equalThrew = true;
      }
    } catch (error) {
      selfCheck.error = String(error && error.message);
    }
    const selfCheckPassed = selfCheck.wrongCodeThrew && selfCheck.acceptedThrew && selfCheck.equalThrew;
    results.push({
      id: 'G03',
      group: 'G 环境守卫',
      title: '验证器自检：拒绝断言/等值断言在“码不符/未拒绝/值不等”时必须抛错（防静默通过）',
      x: [],
      requires: [],
      expected: '错误码、未拒绝、值不相等三种情况都必须触发断言异常',
      status: selfCheckPassed ? STATUS.PASS : STATUS.FAIL,
      detail: selfCheckPassed
        ? '断言工具在三种失败路径上都抛错（报告具备判据价值）'
        : '断言工具未能抛错，报告不可信：' + JSON.stringify(selfCheck),
      observed: selfCheck,
      durationMs: 0,
    });

    // 先自清临时 userData，再打印/落报告：任何输出失败都不应留下临时树。
    let tempCleaned = false;
    try {
      if (temp.exists()) temp.dispose();
      tempCleaned = !temp.exists();
    } catch (cleanupError) {
      console.error('[e0-verify] 清理临时 userData 失败：' + (cleanupError && cleanupError.message));
      tempCleaned = !temp.exists();
    }
    if (!tempCleaned) {
      counts.FAIL += 1;
      counts.total += 1;
      results.push({
        id: 'G02',
        group: 'G 环境守卫',
        title: '临时 userData 自清',
        x: [],
        requires: [],
        expected: '运行结束后系统临时目录内不留 dsh-e0v1-* 目录',
        status: STATUS.FAIL,
        detail: '临时 userData 未清理干净',
        observed: null,
        durationMs: 0,
      });
    }

    const report = {
      schemaVersion: 'e0-verify-report.v1',
      kind: 'E0-V1 准备阶段运行报告（非验收结论）',
      mode: options.mode,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      head: readHead(),
      tempUserData: { prefix: temp.prefix, insideTmpdir: true, insideRepo: false, cleanedUp: tempCleaned },
      counts,
      e0Verdict: counts.FAIL > 0 ? 'FAIL' : 'NOT_RUN',
      e0VerdictNote: '本脚本是攻击链/垂直链骨架；E0 是否通过只能由 t8（E0-V1）在 X1–X12 关闭后出具。',
      guard: { repoDataDirsChanged: changed },
      frozenInterfaces: frozen.summary(),
      readiness: buildReadiness(frozen),
      cases: results,
    };

    printTable(results);
    console.log('统计：PASS=' + counts.PASS + ' FAIL=' + counts.FAIL
      + ' NOT_RUN=' + counts.NOT_RUN + ' BLOCKED=' + counts.BLOCKED + ' 合计=' + counts.total);
    console.log('E0 verdict（本阶段）：' + report.e0Verdict + '（准备阶段固定不判 PASS）');

    const notRun = results.filter((item) => item.status === STATUS.NOT_RUN);
    if (notRun.length > 0) {
      console.log('\nNOT_RUN（' + notRun.length + ' 条，需实现就绪后由 t8 补齐）：');
      for (const item of notRun) console.log('  ' + item.id + '  ' + (item.reason || ''));
    }

    if (options.write) {
      fs.mkdirSync(path.dirname(options.out), { recursive: true });
      fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log('\n报告：' + path.relative(env.REPO_ROOT, options.out));
    }

    return report.counts.FAIL > 0 ? 1 : 0;
  } catch (error) {
    console.error('[e0-verify] 运行失败：' + (error && error.stack ? error.stack : error));
    return 2;
  } finally {
    if (temp) {
      try {
        if (temp.exists()) temp.dispose();
      } catch (error) {
        console.error('[e0-verify] 清理临时目录失败：' + (error && error.message));
      }
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error('[e0-verify] 未捕获错误：' + error);
    process.exitCode = 2;
  });
}

module.exports = { main, parseArgs, DEFAULT_OUT };
