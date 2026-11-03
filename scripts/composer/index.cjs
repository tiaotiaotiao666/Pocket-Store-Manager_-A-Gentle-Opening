#!/usr/bin/env node
'use strict';

/**
 * Composer 编排入口：P0–P8。
 *
 * P0 契约校验 → P1 注册表冻结 → P2 组合解析 → P3 Lock → P4 预检
 * → P5 staging 写入 → P6 产物校验与 Lock 回填 → P7 原子提交 → P8 报告
 */

const fs = require('node:fs');
const path = require('node:path');

const { validatePlan, fail, ok } = require('./schema.cjs');
const { loadRegistry } = require('./registry.cjs');
const { resolvePlan, fillThemeDefaults } = require('./resolve.cjs');
const { planDigest } = require('./digest.cjs');
const { buildLock, finalizeLock } = require('./lock.cjs');
const { buildProjectFiles } = require('./emit.cjs');
const { verifyOutput } = require('./verify.cjs');
const { validateMedia } = require('./media.cjs');
const { preflight, createStaging, cleanupStale, writeFiles, commitStaging, removeStaging, estimateSize, sanitizeProjectName } = require('./atomic.cjs');
const { buildReport, writeReport } = require('./report.cjs');
const { COMPOSER_VERSION } = require('./version.cjs');

const STAGE_NAMES = ['契约校验', '注册表冻结', '组合解析', '生成锁', '目录预检', '生成工程', '产物校验', '提交目录', '生成报告'];

function emitProgress(onProgress, stageIndex, detail) {
  if (typeof onProgress !== 'function') return;
  onProgress({
    stage: ['validate', 'registry', 'resolve', 'lock', 'preflight', 'emit', 'verify', 'commit', 'report'][stageIndex] || 'unknown',
    step: stageIndex + 1,
    total: STAGE_NAMES.length,
    message: STAGE_NAMES[stageIndex] + (detail ? '：' + detail : ''),
  });
}

function idle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function cancelled(signal) {
  return Boolean(signal && signal.cancelled);
}

async function compose(options) {
  const opts = options || {};
  const started = Date.now();
  const stageTimes = {};
  let stageStart = started;
  const mark = (name) => {
    const now = Date.now();
    stageTimes[name] = now - stageStart;
    stageStart = now;
  };
  const signal = opts.signal || { cancelled: false };
  const projectName = sanitizeProjectName(opts.projectName || (opts.plan && opts.plan.storeProfile && opts.plan.storeProfile.name) || 'smart-store');
  const mode = opts.mode === 'production' ? 'production' : 'development';

  if (!opts.parentDir) {
    return fail('TARGET_PARENT_MISSING', 'parentDir', '必须提供导出父目录');
  }
  if (!opts.plan) {
    return fail('PLAN_MISSING', '$', '缺少 CompositionPlan');
  }

  await idle();
  emitProgress(opts.onProgress, 0);
  const planValidation = validatePlan(opts.plan);
  if (!planValidation.ok) return planValidation;
  let media;
  if (opts.media !== undefined) {
    const mediaValidation = validateMedia(opts.media);
    if (!mediaValidation.ok) return mediaValidation;
    media = mediaValidation.media;
  }
  mark('validate');

  await idle();
  emitProgress(opts.onProgress, 1);
  const loaded = loadRegistry({ verifyFreeze: true });
  if (!loaded.ok) return loaded;
  mark('registry');

  await idle();
  emitProgress(opts.onProgress, 2);
  const graph = resolvePlan(opts.plan, loaded, { onlineRecipe: opts.recipeStage === 'direct', role: opts.role });
  if (!graph.ok) return graph;
  mark('resolve');

  await idle();
  emitProgress(opts.onProgress, 3);
  const planHash = planDigest(opts.plan);
  const lockResult = buildLock(graph, {
    loaded,
    planDigest: planHash,
    registryDigest: loaded.registryDigest,
    backendVersions: opts.backendVersions || { configVersion: null, catalogVersion: null },
    generatedAt: opts.generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (!lockResult.ok) return lockResult;
  mark('lock');

  await idle();
  emitProgress(opts.onProgress, 4);
  const theme = fillThemeDefaults(graph.themeTokens);
  const emitted = buildProjectFiles(graph, {
    mode,
    projectName,
    theme,
    // 展示声明（C-PLAN-PRESENTATION@1）：resolve 归一化后的尺寸档位，交给 emit 输出 CSS 变量。
    presentationTokens: graph.presentationTokens,
    planDigest: planHash,
    lockDigest: lockResult.lockDigest,
    backendVersions: opts.backendVersions,
    storeId: opts.storeId,
    role: opts.role,
    media,
  });
  if (!emitted.ok) return emitted;

  const longestRelative = Math.max(...[...emitted.files.keys()].map((file) => file.length));
  const preflightResult = preflight({
    parentDir: opts.parentDir,
    projectName,
    estimatedBytes: estimateSize(emitted.files),
    maxRelativePathLength: longestRelative,
  });
  if (!preflightResult.ok) return preflightResult;
  mark('preflight');

  if (cancelled(signal)) return fail('EXPORT_CANCELLED', '$', '导出已取消');
  await idle();
  emitProgress(opts.onProgress, 5, emitted.stats.files + ' 个文件');
  cleanupStale(preflightResult.parentDir);
  let staging = null;
  try {
    staging = createStaging(preflightResult.parentDir);
    const writeResult = await writeFiles(staging, emitted.files, {
      signal,
      onFile: ({ index, total, file }) => {
        if (opts.onProgress && (index === total || index % 20 === 0)) {
          opts.onProgress({
            stage: 'emit',
            step: 6,
            total: STAGE_NAMES.length,
            message: '生成工程：' + index + '/' + total + '（' + file + '）',
            fileIndex: index,
            fileTotal: total,
          });
        }
      },
    });
    if (!writeResult.ok) {
      removeStaging(staging);
      return writeResult;
    }
    mark('emit');

    await idle();


    emitProgress(opts.onProgress, 6);
    const verified = verifyOutput(staging, { mode });
    if (!verified.ok) {
      removeStaging(staging);
      return verified;
    }
    const outputDigest = { tree: verified.tree, files: verified.files };
    const finalLock = finalizeLock(lockResult.lock, outputDigest);
    fs.writeFileSync(path.join(staging, 'composition.lock.json'), JSON.stringify(finalLock, null, 2) + '\n', 'utf8');
    mark('verify');

    if (cancelled(signal)) {
      removeStaging(staging);
      return fail('EXPORT_CANCELLED', '$', '导出已取消');
    }
    await idle();

    emitProgress(opts.onProgress, 7);
    const commit = commitStaging(staging, preflightResult.finalPath);
    if (!commit.ok) return commit;
    staging = null;
    mark('commit');

    await idle();


    emitProgress(opts.onProgress, 8);
    const report = buildReport({
      graph,
      lock: finalLock,
      lockDigest: finalLock.lockDigest,
      registryDigest: loaded.registryDigest,
      composerVersion: COMPOSER_VERSION,
      checks: verified.checks,
      outputPath: preflightResult.finalPath,
      outputTree: verified.tree,
      outputFiles: verified.files,
      generatedAt: lockResult.lock.generatedAt,
      wechatCompile: opts.wechatCompile || 'not-run',
      wechatCompileDetail: opts.wechatCompileDetail,
      versionGaps: opts.versionGaps || [],
      unresolved: opts.unresolved || [],
      warnings: opts.warnings || [],
      durations: { ...stageTimes, total: Date.now() - started },
    });
    const reportResult = writeReport(preflightResult.finalPath, report);
    mark('report');

    return {
      ...ok(),
      outputPath: preflightResult.finalPath,
      projectName,
      lock: finalLock,
      lockDigest: finalLock.lockDigest,
      planDigest: planHash,
      treeSha256: verified.tree,
      fileCount: verified.files.length,
      checks: verified.checks,
      stats: emitted.stats,
      previewOnly: graph.previewOnly,
      degraded: graph.degraded,
      updatesAvailable: graph.updatesAvailable,
      report,
      warnings: reportResult.warnings,
      mode,
    };
  } catch (error) {
    if (staging) removeStaging(staging);
    return fail('COMPOSE_FAILED', '$', '生成失败：' + error.message, { stack: String(error.stack || '').slice(0, 2000) });
  }
}

/** 只做 P0–P2 校验，不写盘；桌面端导出前调用。 */
function validateComposition(plan, options) {
  const opts = options || {};
  const planValidation = validatePlan(plan);
  if (!planValidation.ok) return planValidation;
  const loaded = opts.loaded || loadRegistry({ verifyFreeze: true });
  if (!loaded.ok) return loaded;
  const graph = resolvePlan(plan, loaded, { onlineRecipe: opts.recipeStage === 'direct', role: opts.role });
  if (!graph.ok) return graph;
  return {
    ...ok(),
    planDigest: planDigest(plan),
    registryVersion: loaded.registry.registryVersion,
    registryDigest: loaded.registryDigest,
    capabilitySet: graph.capabilitySet,
    previewOnly: graph.previewOnly,
    degraded: graph.degraded,
    updatesAvailable: graph.updatesAvailable,
    warnings: [
      ...graph.previewOnly.map((id) => '仅预览能力：' + id),
      ...graph.updatesAvailable.map((item) => item.id + ' 有可用版本 ' + item.available + '（本次按 Plan 精确版本）'),
    ],
  };
}

module.exports = {
  compose,
  validateComposition,
  STAGE_NAMES,
};