#!/usr/bin/env node
'use strict';

/**
 * B4：`output.consistency` 的固定包装（只读，不写任何文件）。
 *
 * 用法（只由 scripts/agent-checks/run-check.cjs 以固定 argv 调用）：
 *   node scripts/agent-checks/output-consistency.cjs --root <工程目录>
 *
 * 复用 `desktop/output-consistency.cjs` 的 inspectOutput：清单/lock/report/markdown/AppID/sidecar
 * 一致性；任何不一致 → exit 1（由分发器映射为 FAIL），参数缺失 → exit 2（BLOCKED）。
 */

const path = require('node:path');

const { inspectOutput } = require('../../desktop/output-consistency.cjs');

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : '';
  if (!root || !path.isAbsolute(root)) {
    console.error('参数错误：必须提供 --root <工程目录>');
    return 2;
  }
  const result = inspectOutput(root);
  if (result.ok) {
    console.log(JSON.stringify({ status: 'PASS', fileCount: result.fileCount, treeSha256: result.tree ? result.tree.treeSha256 : null }));
    return 0;
  }
  for (const problem of (result.problems || []).slice(0, 200)) {
    console.error((problem.code || 'OUTPUT_INCONSISTENT') + ' ' + (problem.message || ''));
  }
  return 1;
}

process.exitCode = main(process.argv.slice(2));
