#!/usr/bin/env node
'use strict';

/**
 * 产物校验器：在 staging 目录上执行，失败绝不交付。
 */

const fs = require('node:fs');
const path = require('node:path');

const { runChecks } = require('../validate-miniprogram.cjs');
const { scanOutput } = require('./safety.cjs');
const { treeSha256, listTree, fileSha256 } = require('./digest.cjs');
const { ok, fail } = require('./schema.cjs');

function check(id, result, message) {
  return { id, result, message: message || '' };
}

function verifyOutput(stagingDir, options) {
  const opts = options || {};
  const checks = [];

  if (!fs.existsSync(stagingDir)) {
    return { ...fail('VERIFY_ROOT_MISSING', '$', '产物目录不存在'), checks };
  }

  const appJsonFile = path.join(stagingDir, 'app.json');
  if (!fs.existsSync(appJsonFile)) {
    return { ...fail('OUTPUT_APP_JSON_MISSING', 'app.json', '产物缺少 app.json'), checks };
  }

  let appJson;
  try {
    appJson = JSON.parse(fs.readFileSync(appJsonFile, 'utf8'));
  } catch (error) {
    return { ...fail('OUTPUT_APP_JSON_INVALID', 'app.json', 'app.json 解析失败：' + error.message), checks };
  }

  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  checks.push(check('app-json-pages', pages.length > 0 ? 'pass' : 'fail', pages.length + ' 个页面'));
  if (pages.length === 0) {
    return { ...fail('OUTPUT_PAGE_MISSING', 'app.json.pages', 'app.json 未注册页面'), checks };
  }

  for (const page of pages) {
    for (const extension of ['.js', '.json', '.wxml']) {
      if (!fs.existsSync(path.join(stagingDir, page + extension))) {
        checks.push(check('page-four-piece:' + page, 'fail', '缺少 ' + page + extension));
        return { ...fail('OUTPUT_PAGE_FILES_MISSING', page, '页面文件不完整：' + page + extension), checks };
      }
    }
  }
  checks.push(check('page-four-piece', 'pass'));

  const diskPages = [];
  const pagesDir = path.join(stagingDir, 'pages');
  if (fs.existsSync(pagesDir)) {
    fs.readdirSync(pagesDir, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) diskPages.push('pages/' + entry.name + '/index');
    });
  }
  const registered = [...pages].sort();
  const onDisk = diskPages.sort();
  if (JSON.stringify(registered) !== JSON.stringify(onDisk)) {
    checks.push(check('app-json-disk-match', 'fail', 'app.json 页面与磁盘不一致'));
    return {
      ...fail('OUTPUT_PAGE_MISMATCH', 'app.json.pages', 'app.json 页面与磁盘不一致', { registered, onDisk }),
      checks,
    };
  }
  checks.push(check('app-json-disk-match', 'pass'));

  const jsonFiles = listTree(stagingDir).filter((file) => file.endsWith('.json') && !file.startsWith('assets/'));
  for (const file of jsonFiles) {
    if (file === 'project.config.json' || file === 'app.json' || file === 'sitemap.json') continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(stagingDir, file), 'utf8'));
    } catch (error) {
      checks.push(check('json-parse:' + file, 'fail', error.message));
      return { ...fail('OUTPUT_JSON_INVALID', file, 'JSON 解析失败：' + error.message), checks };
    }
    const usingComponents = doc.usingComponents || {};
    for (const [tag, target] of Object.entries(usingComponents)) {
      const baseDir = path.dirname(path.join(stagingDir, file));
      const resolved = target.startsWith('/')
        ? path.join(stagingDir, target.slice(1))
        : path.resolve(baseDir, target);
      const componentBase = path.basename(resolved) === 'index' ? resolved : path.join(resolved, 'index');
      const missing = ['.js', '.json', '.wxml', '.wxss'].filter((ext) => !fs.existsSync(componentBase + ext));
      if (missing.length > 0) {
        checks.push(check('using-components:' + file + ':' + tag, 'fail', '组件缺失 ' + missing.join(',')));
        return {
          ...fail('USING_COMPONENT_MISSING', file, 'usingComponents 指向不存在组件：' + tag, { missing, target }),
          checks,
        };
      }
    }
  }
  checks.push(check('using-components', 'pass'));

  const dynamicPatterns = [
    { pattern: /require\(\s*[^'"]/, message: '存在按变量 require 的动态加载' },
    { pattern: /<component\s+is=/, message: '存在运行时动态组件' },
  ];
  for (const file of listTree(stagingDir).filter((item) => /\.(js|wxml)$/.test(item))) {
    const source = fs.readFileSync(path.join(stagingDir, file), 'utf8');
    for (const rule of dynamicPatterns) {
      if (rule.pattern.test(source)) {
        checks.push(check('dynamic-component:' + file, 'fail', rule.message));
        return { ...fail('DYNAMIC_COMPONENT_FORBIDDEN', file, rule.message), checks };
      }
    }
  }
  checks.push(check('dynamic-component', 'pass'));

  const staticResult = runChecks(stagingDir);
  if (!staticResult.ok) {
    checks.push(check('static-check', 'fail', staticResult.errors.slice(0, 5).join(' | ')));
    return {
      ...fail('OUTPUT_STATIC_CHECK_FAILED', '$', '静态校验失败', { errors: staticResult.errors.slice(0, 10) }),
      checks,
      stats: staticResult.stats,
    };
  }
  checks.push(check('static-check', 'pass', staticResult.stats.pages + ' 页 / ' + staticResult.stats.components + ' 组件'));

  const safety = scanOutput(stagingDir, { mode: opts.mode || 'development' });
  if (!safety.ok) {
    checks.push(check('security-scan', 'fail', safety.findings.slice(0, 5).map((finding) => finding.code + '@' + finding.file + ':' + finding.line).join(' | ')));
    return {
      ...fail(safety.findings[0].code, safety.findings[0].file, '安全扫描命中', { findings: safety.findings.slice(0, 10) }),
      checks,
    };
  }
  checks.push(check('security-scan', 'pass'));

  const tree = treeSha256(stagingDir);
  const files = listTree(stagingDir).map((file) => ({ path: file, digest: fileSha256(path.join(stagingDir, file)) }));
  if (opts.expectedTree && opts.expectedTree !== tree) {
    checks.push(check('reproducibility', 'fail', '两次生成产物树摘要不一致'));
    return {
      ...fail('REPRODUCIBILITY_FAILED', '$', '两次生成不一致', { expected: opts.expectedTree, actual: tree }),
      checks,
    };
  }
  checks.push(check('reproducibility', 'pass', tree));

  return { ...ok(), checks, tree, files, stats: staticResult.stats };
}

module.exports = { verifyOutput };