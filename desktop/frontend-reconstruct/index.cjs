'use strict';

/**
 * P2 本地候选链入口（Electron 主进程侧，纯 CJS）。
 *
 * 模块的职责边界：
 * - `schema.cjs`           frontend-pack-draft.v1 安全校验（无 IO）；
 * - `render.cjs`           确定性 renderer（无 IO，输出 FrontendPack 文件 Map）；
 * - `workspace.cjs`        应用私有工作区布局与路径/symlink/junction 防护；
 * - `registry-overlay.cjs` 可信 Registry 投影 + 候选资产 overlay（只写私有目录）；
 * - `materialize.cjs`      把以上串成一次原子 attempt；
 * - `dry-run.cjs`          Composer P0–P6 + mini:check + 一致性 + 可观察项（P3）；
 * - `repair.cjs`           最多两轮受控修复编排，只发送结构化 issues + 有界 Draft（P3）；
 * - `verify-runtime.cjs`   固定包装微信真实编译/截图脚本，PASS/FAIL/BLOCKED/NOT_RUN（P3）；
 * - `compare.cjs`          只检查可观察项，不做像素测量（P3）。
 *
 * 这里只做再导出，不写业务逻辑；IPC/UI 接线属于 P4。
 */

const schema = require('./schema.cjs');
const render = require('./render.cjs');
const workspace = require('./workspace.cjs');
const registryOverlay = require('./registry-overlay.cjs');
const materialize = require('./materialize.cjs');
const dryRun = require('./dry-run.cjs');
const repair = require('./repair.cjs');
const verifyRuntime = require('./verify-runtime.cjs');
const compare = require('./compare.cjs');

module.exports = {
  schema,
  render,
  workspace,
  registryOverlay,
  materialize,
  dryRun,
  repair,
  verifyRuntime,
  compare,
  // 最常用入口直出，便于调用方按需解构。
  validateFacts: schema.validateFacts,
  validateDraft: schema.validateDraft,
  renderFrontendPack: render.renderFrontendPack,
  draftDigest: render.draftDigest,
  materializeCandidate: materialize.materializeCandidate,
  loadPackagedFacts: materialize.loadPackagedFacts,
  loadPageFacts: materialize.loadPageFacts,
  createWorkspace: workspace.createWorkspace,
  workspacePaths: workspace.workspacePaths,
  loadTrustedRegistry: registryOverlay.loadTrustedRegistry,
  verifyOverlay: registryOverlay.verifyOverlay,
  dryRunCandidate: dryRun.dryRun,
  runRepairLoop: repair.runRepairLoop,
  verifyRuntimeCandidate: verifyRuntime.verifyRuntime,
  compareObservable: compare.compareObservable,
};
