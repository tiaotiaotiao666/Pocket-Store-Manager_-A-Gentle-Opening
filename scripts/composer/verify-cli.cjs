#!/usr/bin/env node
'use strict';

/**
 * 产物校验 CLI：独立验证一个已生成工程。
 *
 * 用法：node scripts/composer/verify-cli.cjs --root <工程目录> [--mode production|development]
 */

const path = require('node:path');
const { verifyOutput } = require('./verify.cjs');

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const modeIndex = args.indexOf('--mode');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : '';
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'development';
  if (!root) {
    console.error('参数错误：必须提供 --root <工程目录>');
    process.exitCode = 2;
    return;
  }
  const result = verifyOutput(path.resolve(root), { mode });
  result.checks.forEach((check) => {
    console.log('  ' + (check.result === 'pass' ? '✓' : '✗') + ' ' + check.id + (check.message ? '：' + check.message : ''));
  });
  if (!result.ok) {
    console.error('\n产物校验失败：' + result.code + ' · ' + (result.message || ''));
    process.exitCode = 1;
    return;
  }
  console.log('\n产物校验通过：' + result.tree);
}

main();