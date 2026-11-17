#!/usr/bin/env node
'use strict';

/**
 * 打包资源契约检查：断言 electron-builder files 覆盖全部运行时资源。
 *
 * 背景（BUG-006）：旧导出脚本依赖 src/domain/catalog.mjs，但安装包未包含 src/，
 * 导致安装版导出失败。本检查把“必需资源”变成可执行断言。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_FILE = path.join(REPO_ROOT, 'package.json');

function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        regex += '.*';
        index += 1;
        if (normalized[index + 1] === '/') index += 1;
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + regex + '$');
}

function isIncluded(file, patterns) {
  const normalized = file.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function walk(dir, base, result) {
  if (!fs.existsSync(dir)) return result;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return;
      walk(full, base, result);
    } else {
      result.push(relative);
    }
  });
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * P0：安装版微信验证的运行依赖断言。
 *
 * 只有「脚本进包 + automator 进包」同时成立，安装版才可能给出真实 PASS/FAIL/BLOCKED；
 * 任何一项缺失都必须在打包检查阶段失败，而不是等用户在安装版里点「验证」拿到 BLOCKED。
 */
function checkRuntimeDependencyContract(pkg) {
  const errors = [];
  const notes = [];
  const dependencies = pkg.dependencies || {};
  const devDependencies = pkg.devDependencies || {};

  if (!dependencies['miniprogram-automator']) {
    errors.push('miniprogram-automator 必须在 dependencies 里（devDependencies 不会进安装包）');
  }
  if (devDependencies['miniprogram-automator']) {
    errors.push('miniprogram-automator 不能同时留在 devDependencies');
  }
  if (pkg.build && pkg.build.asar === true) {
    errors.push('build.asar 不能为 true：固定脚本必须能被 electron.exe 以 Node 模式直接执行');
  }

  const moduleRoot = path.join(REPO_ROOT, 'node_modules', 'miniprogram-automator');
  if (!fs.existsSync(moduleRoot)) {
    errors.push('本机没有安装 miniprogram-automator（请先 npm install），无法保证打包完整性');
  } else {
    const manifest = readJson(path.join(moduleRoot, 'package.json'));
    notes.push('miniprogram-automator@' + manifest.version);
    for (const name of Object.keys(manifest.dependencies || {})) {
      if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules', name))) {
        errors.push('miniprogram-automator 的运行依赖缺失：node_modules/' + name);
      }
    }
  }

  // 固定脚本自身依赖的仓库内模块也必须可打包（相对 require 不能落在 files 覆盖外）。
  const runnerSource = path.join(REPO_ROOT, 'scripts', 'wechat-devtools-run.cjs');
  if (!fs.existsSync(runnerSource)) {
    errors.push('缺少固定验证脚本 scripts/wechat-devtools-run.cjs');
  } else {
    const source = fs.readFileSync(runnerSource, 'utf8');
    for (const match of source.matchAll(/require\('(\.\.[^']+)'\)/g)) {
      const resolved = path.resolve(path.dirname(runnerSource), match[1]);
      const relative = path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
      if (!fs.existsSync(resolved)) {
        errors.push('固定脚本引用了不存在的模块：' + relative);
      }
    }
  }
  return { errors, notes };
}

function collectRequiredFiles() {
  const required = new Set([
    'package.json',
    'desktop/main.cjs',
    'desktop/preload.cjs',
    'desktop/composer-ipc.cjs',
    'desktop/devtools-cli.cjs',
    'scripts/validate-miniprogram.cjs',
    // P0：安装版要走同一条真实微信验证链，固定脚本必须随包分发。
    'scripts/wechat-devtools-run.cjs',
    // P1：服务端只读能力快照必须随包分发（桌面 overlay/renderer 后续读取同一份事实）。
    'server/src/agent/frontend-reconstruct/capabilities.snapshot.json',
    'scripts/frontend-capabilities.cjs',
    'dist/index.html',
  ]);

  walk(path.join(REPO_ROOT, 'scripts', 'composer'), REPO_ROOT, []).forEach((file) => required.add(file));

  // P2+ 的桌面前端重构执行模块（workspace/overlay/dry-run/verify）一旦落地，
  // 必须全部进入安装包；目录存在时强制枚举，避免“只在本机仓库能找到文件”。
  const frontendDesktopDir = path.join(REPO_ROOT, 'desktop', 'frontend-reconstruct');
  if (fs.existsSync(frontendDesktopDir)) {
    walk(frontendDesktopDir, REPO_ROOT, []).forEach((file) => required.add(file));
  }

  const registryRoot = path.join(REPO_ROOT, 'templates', 'registry');
  ['registry.v1.json', 'registry.lock.json', 'migration.json', 'preview-registry.json', 'expansion-order.json'].forEach((file) => {
    required.add('templates/registry/' + file);
  });
  walk(path.join(registryRoot, 'schema'), REPO_ROOT, [])
    .filter((file) => file.endsWith('.json'))
    .forEach((file) => required.add(file));

  const registry = readJson(path.join(registryRoot, 'registry.v1.json'));
  registry.assets.forEach((asset) => {
    const assetDir = path.join(REPO_ROOT, asset.path);
    if (asset.kind === 'recipe') {
      required.add(asset.path + '/recipe.json');
      required.add(asset.path + '/plan.json');
      if (fs.existsSync(path.join(assetDir, 'release.json'))) required.add(asset.path + '/release.json');
      return;
    }
    required.add(asset.path + '/manifest.json');
    const manifest = readJson(path.join(assetDir, 'manifest.json'));
    if (asset.kind === 'base') {
      ['slots.json', 'theme.tokens.json'].forEach((file) => {
        if (fs.existsSync(path.join(assetDir, file))) required.add(asset.path + '/' + file);
      });
      (manifest.entry.files || []).forEach((file) => required.add(asset.path + '/' + manifest.entry.root + '/' + file));
      walk(path.join(assetDir, manifest.entry.root), REPO_ROOT, []).forEach((file) => required.add(file));
    } else {
      (manifest.entry.files || []).forEach((file) => required.add(asset.path + '/' + manifest.entry.path + '/' + file));
      (manifest.entry.assets || []).forEach((file) => required.add(asset.path + '/' + manifest.entry.path + '/' + file));
      walk(path.join(assetDir, manifest.entry.path), REPO_ROOT, []).forEach((file) => required.add(file));
    }
  });

  ['templates/base', 'templates/catalog', 'templates/components', 'templates/features', 'templates/frontend-packs', 'templates/recipes', 'templates/registry'].forEach((dir) => {
    walk(path.join(REPO_ROOT, dir), REPO_ROOT, []).forEach((file) => required.add(file));
  });

  return [...required].filter((file) => fs.existsSync(path.join(REPO_ROOT, file)) || file === 'dist/index.html').sort();
}

function main() {
  const pkg = readJson(PACKAGE_FILE);
  const patterns = (pkg.build && pkg.build.files) || [];
  const required = collectRequiredFiles();
  const missing = required.filter((file) => !isIncluded(file, patterns));
  const legacy = isIncluded('scripts/generate-mini-program.cjs', patterns);

  console.log('打包资源契约检查：' + required.length + ' 个必需文件，' + patterns.length + ' 条 files 规则');

  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    console.log('  ⚠ dist/index.html 尚未构建，请先运行 npm run build');
  }

  const errors = [];
  if (missing.length > 0) {
    missing.forEach((file) => errors.push('缺少打包覆盖：' + file));
  }
  if (legacy) {
    errors.push('scripts/generate-mini-program.cjs 是已废弃脚本，不得进入安装包');
  }
  const runtime = checkRuntimeDependencyContract(pkg);
  runtime.errors.forEach((error) => errors.push(error));

  if (errors.length > 0) {
    errors.forEach((error) => console.log('  ✗ ' + error));
    console.error('\n打包资源契约检查失败：' + errors.length + ' 项');
    process.exitCode = 1;
    return;
  }

  console.log('  ✓ 注册表、Base、Composer 运行时、前端能力快照、desktop 与 dist 均在 files 覆盖内');
  console.log('  ✓ 旧复制模板脚本未进入安装包');
  console.log('  ✓ 微信验证运行依赖就位：scripts/wechat-devtools-run.cjs'
    + (runtime.notes.length > 0 ? ' + ' + runtime.notes.join('、') : ''));
}

main();