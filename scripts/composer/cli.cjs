#!/usr/bin/env node
'use strict';

/**
 * Composer CLI。
 *
 * 用法：
 *   node scripts/composer/cli.cjs --plan <plan.json> --out <parentDir> [--mode development|production]
 *     [--project-name <name>] [--store-profile <profile.json>] [--json]
 *
 * 退出码：0 成功；1 业务失败；2 参数错误。
 */

const fs = require('node:fs');
const path = require('node:path');

const { compose } = require('./index.cjs');

function parseArgs(argv) {
  const args = { mode: 'development', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--plan' || token === '--out' || token === '--mode' || token === '--project-name' || token === '--store-profile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('参数 ' + token + ' 缺少值');
      args[token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    throw new Error('未知参数：' + token);
  }
  return args;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(label + ' 读取失败：' + error.message);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('参数错误：' + error.message);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log('用法：node scripts/composer/cli.cjs --plan <plan.json> --out <父目录> [--mode development|production] [--project-name 名称] [--store-profile profile.json] [--json]');
    return;
  }
  if (!args.plan || !args.out) {
    console.error('参数错误：必须提供 --plan 与 --out');
    process.exitCode = 2;
    return;
  }

  let plan;
  try {
    plan = readJson(path.resolve(args.plan), 'Plan');
    if (args.storeProfile) {
      const profile = readJson(path.resolve(args.storeProfile), 'StoreProfile');
      plan = { ...plan, storeProfile: { ...plan.storeProfile, ...profile } };
    }
  } catch (error) {
    console.error('参数错误：' + error.message);
    process.exitCode = 2;
    return;
  }

  const result = await compose({
    plan,
    parentDir: path.resolve(args.out),
    mode: args.mode,
    projectName: args.projectName,
    onProgress: args.json ? undefined : (event) => console.log('[' + event.step + '/' + event.total + '] ' + event.message),
  });

  if (result.ok) {
    if (args.json) {
      console.log(JSON.stringify({
        ok: true,
        outputPath: result.outputPath,
        treeSha256: result.treeSha256,
        lockDigest: result.lockDigest,
        fileCount: result.fileCount,
        previewOnly: result.previewOnly,
        degraded: result.degraded,
        warnings: result.warnings,
      }, null, 2));
    } else {
      console.log('\n生成成功：' + result.outputPath);
      console.log('  产物树摘要：' + result.treeSha256);
      console.log('  Lock 摘要：' + result.lockDigest);
      console.log('  文件数：' + result.fileCount);
      if (result.previewOnly.length) console.log('  仅预览：' + result.previewOnly.join(', '));
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: false, code: result.code, path: result.path, message: result.message, details: result.details || null }, null, 2));
  } else {
    console.error('\n生成失败：' + result.code);
    console.error('  ' + (result.message || ''));
    if (result.path && result.path !== '$') console.error('  位置：' + result.path);
    if (result.details) console.error('  详情：' + JSON.stringify(result.details));
  }
  process.exitCode = 1;
}

main();