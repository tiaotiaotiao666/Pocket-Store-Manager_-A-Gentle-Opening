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
  const lines = [
    '# 生成报告',
    '',
    '- 生成时间：' + report.generatedAt,
    '- Recipe：`' + report.recipe.id + '@' + report.recipe.version + '`',
    '- Base：`' + report.plan.base.id + '@' + report.plan.base.version + '`',
    '- 注册表：`' + report.registry.version + '`',
    '- 输出目录：`' + report.output.projectPath + '`',
    '- 产物树摘要：`' + report.output.treeSha256 + '`',
    '',
    '## 检查项',
    '',
    '| 检查 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...report.checks.map((item) => '| `' + item.id + '` | ' + item.result + ' | ' + String(item.message).replace(/\|/g, '\\|') + ' |'),
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

function writeReport(outputDir, report) {
  const warnings = [];
  const jsonText = JSON.stringify(report, null, 2) + '\n';
  const markdown = renderMarkdown(report);
  const findings = [...scanText(jsonText, { file: 'generation-report.json', mode: 'development' }), ...scanText(markdown, { file: '生成报告.md', mode: 'development' })]
    .filter((finding) => finding.code !== 'PATH_ESCAPE');
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

module.exports = { buildReport, renderMarkdown, writeReport };