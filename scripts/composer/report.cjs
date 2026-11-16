#!/usr/bin/env node
'use strict';

/**
 * 生成报告：JSON（机器读）+ Markdown（人读）。
 * 报告写失败只记 warning，不回滚已交付工程。
 */

const fs = require('node:fs');
const path = require('node:path');

const { scanText } = require('./safety.cjs');

function summarizeChecks(checks) {
  return (checks || []).map((item) => ({
    id: item.id,
    result: item.result,
    message: item.message || '',
  }));
}

function buildReport(context) {
  const ctx = context || {};
  const graph = ctx.graph;
  return {
    reportVersion: 'generation-report.v1',
    generatedAt: ctx.generatedAt,
    recipe: {
      id: graph.plan.planId,
      version: graph.plan.planVersion,
    },
    lock: {
      lockDigest: ctx.lockDigest,
      planDigest: ctx.lock.planDigest,
    },
    registry: {
      version: graph.plan.registryVersion,
      digest: ctx.registryDigest,
    },
    composer: { version: ctx.composerVersion },
    plan: {
      base: graph.base.manifest.identity,
      pages: graph.pageIds,
      capabilitySet: graph.capabilitySet,
    },
    checks: summarizeChecks(ctx.checks),
    wechatCompile: {
      result: ctx.wechatCompile || 'not-run',
      detail: ctx.wechatCompileDetail || '本机未执行微信开发者工具编译（CLI 端口关闭）',
    },
    output: {
      projectPath: ctx.outputPath,
      treeSha256: ctx.outputTree,
      files: ctx.outputFiles || [],
      fileCount: (ctx.outputFiles || []).length,
    },
    previewOnly: graph.previewOnly,
    degraded: graph.degraded,
    updatesAvailable: graph.updatesAvailable,
    versionGaps: ctx.versionGaps || [],
    unresolved: ctx.unresolved || [],
    durations: ctx.durations || {},
    warnings: ctx.warnings || [],
  };
}

function renderMarkdown(report) {
  const history = Array.isArray(report.output && report.output.history) ? report.output.history : [];
  const lines = [
    '# 生成报告',
    '',
    '- 生成时间：' + report.generatedAt,
    '- Recipe：`' + report.recipe.id + '@' + report.recipe.version + '`',
    '- Base：`' + report.plan.base.id + '@' + report.plan.base.version + '`',
    '- 注册表：`' + report.registry.version + '`',
    '- 输出目录：`' + report.output.projectPath + '`',
    '- 产物树摘要：`' + report.output.treeSha256 + '`',
    '- Lock 摘要：`' + ((report.lock && report.lock.lockDigest) || '—') + '`',
    '',
    '## 检查项',
    '',
    '| 检查 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...report.checks.map((item) => '| `' + item.id + '` | ' + item.result + ' | ' + String(item.message).replace(/\|/g, '\\|') + ' |'),
    '',
    '## 产物摘要历史',
    '',
    ...(history.length
      ? history.map((item) => '- ' + (item.stage || '历史记录')
        + '（历史记录，不是当前值）：产物树 `' + item.treeSha256 + '`，'
        + (item.fileCount === undefined ? '—' : item.fileCount) + ' 个文件'
        + (item.recordedAt ? '，记录于 ' + item.recordedAt : ''))
      : ['- 无。']),
    '',
    '## 微信编译',
    '',
    '- 结果：`' + report.wechatCompile.result + '`',
    '- 说明：' + report.wechatCompile.detail,
    '',
    '## 仅预览资产（preview-only）',
    '',
    ...(report.previewOnly.length
      ? report.previewOnly.map((id) => '- `' + id + '`：仅可预览，不得对外宣称已上线。')
      : ['- 无。']),
    '',
    '## 降级与版本',
    '',
    ...(report.degraded.length
      ? report.degraded.map((item) => '- 降级：`' + item.assetId + '@' + item.version + '`，原因：' + item.reason)
      : ['- 无显式降级。']),
    ...(report.updatesAvailable.length
      ? report.updatesAvailable.map((item) => '- 可用升级：`' + item.id + '` ' + item.current + ' → ' + item.available + '（本次按 Plan 精确版本，不自动升级）')
      : []),
    ...(report.versionGaps.length ? report.versionGaps.map((item) => '- 版本缺口：' + item) : []),
    '',
    '## 未解决问题',
    '',
    ...(report.unresolved.length ? report.unresolved.map((item) => '- ' + item) : ['- 无。']),
    '',
    '## 警告',
    '',
    ...(report.warnings.length ? report.warnings.map((item) => '- ' + item) : ['- 无。']),
    '',
  ];
  return lines.join('\n');
}

/**
 * 报告自己声明的产物路径（当前值 + 历史值）。
 * W1：只有这些字面值允许出现在报告里，其他绝对路径一律拦截。
 */
function collectReportDeclaredPaths(report) {
  const values = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !values.includes(value)) values.push(value);
  };
  const output = report && typeof report === 'object' ? report.output : null;
  if (!output || typeof output !== 'object') return values;
  push(output.projectPath);
  const history = Array.isArray(output.history) ? output.history : [];
  history.forEach((item) => {
    if (item && typeof item === 'object') push(item.projectPath);
  });
  return values;
}

function writeReport(outputDir, report) {
  const warnings = [];
  const jsonText = JSON.stringify(report, null, 2) + '\n';
  const markdown = renderMarkdown(report);
  const declaredPaths = collectReportDeclaredPaths(report);
  const findings = [
    ...scanText(jsonText, { file: 'generation-report.json', mode: 'development', declaredPaths }),
    ...scanText(markdown, { file: '生成报告.md', mode: 'development', declaredPaths }),
  ];
  if (findings.length > 0) {
    return { ok: false, warnings: ['报告包含敏感内容，已拒绝写入：' + findings.map((item) => item.code).join(',')] };
  }
  try {
    fs.writeFileSync(path.join(outputDir, 'generation-report.json'), jsonText, 'utf8');
    fs.writeFileSync(path.join(outputDir, '生成报告.md'), markdown, 'utf8');
    return { ok: true, warnings };
  } catch (error) {
    warnings.push('报告写入失败：' + error.message);
    return { ok: false, warnings };
  }
}

module.exports = { buildReport, renderMarkdown, writeReport, collectReportDeclaredPaths };