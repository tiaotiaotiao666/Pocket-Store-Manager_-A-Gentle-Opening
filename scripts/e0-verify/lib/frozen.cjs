'use strict';

/**
 * E0-V1 独立验证器：冻结接口清单（只 require，不复制实现）。
 *
 * 依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15
 *   §1.10（B1 导出）/ §2.6（B2 导出）/ §3.8（B4 checkId 映射）/
 *   §14.2（Coordinator）/ §14.6（ModelCallScheduler）/ §14.8（图片）。
 *
 * 本模块**只做存在性/导出面探测**：拿到模块对象后由各攻击/链路用例调用真实实现。
 * 缺模块一律视为 NOT_RUN（准备阶段），不得用替身/自写实现冒充。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const FROZEN_INTERFACES = Object.freeze({
  workspace: {
    kind: 'module',
    path: 'desktop/agent-workspace/workspace.cjs',
    revision: 'rev3 §1.10',
    exports: ['openWorkspace', 'workspacePaths', 'attemptPaths', 'createAttempt', 'openAttempt',
      'listAttempts', 'removeAttempt', 'assertOwnership', 'copySourceTree', 'CODES', 'LIMITS'],
  },
  files: {
    kind: 'module',
    path: 'desktop/agent-workspace/files.cjs',
    revision: 'rev3 §1.10',
    exports: ['listFiles', 'readFile', 'searchFiles', 'writeFile', 'deleteFile', 'normalizeRelativePath'],
  },
  transactions: {
    kind: 'module',
    path: 'desktop/agent-workspace/transactions.cjs',
    revision: 'rev3 §1.10',
    exports: ['beginChanges', 'commitChanges', 'applyChanges', 'discardChanges'],
  },
  manifest: {
    kind: 'module',
    path: 'desktop/agent-workspace/manifest.cjs',
    revision: 'rev3 §1.10',
    exports: ['digestOfContent', 'treeDigestOfFiles', 'buildManifest', 'diffManifests',
      'readAttemptMeta', 'writeAttemptMeta', 'readRunMeta', 'writeRunMeta'],
  },
  paths: {
    kind: 'module',
    path: 'desktop/agent-workspace/paths.cjs',
    revision: 'rev3 §1.10',
    exports: ['resolvePrivateRoot', 'auditPath', 'assertCanonicalDir', 'isLinkLike', 'resolveInside'],
  },
  versions: {
    kind: 'module',
    path: 'desktop/agent-workspace/versions.cjs',
    revision: 'rev4 §2.6',
    exports: ['initProject', 'readProjectState', 'listVersions', 'readVersion', 'resolveVersionSource',
      'verifyExportIdentity', 'reopenProject', 'adoptAttempt', 'undoVersion', 'redoVersion'],
  },
  checks: {
    kind: 'module',
    path: 'desktop/agent-workspace/checks.cjs',
    revision: 'rev15 §14.4（t5 已改为 checkId→subject 平台表 + 四态归一）',
    exports: ['CHECK_IDS', 'CHECK_DEFINITIONS', 'createCheckRegistry', 'validateParams'],
  },
  'source-check': {
    kind: 'module',
    path: 'scripts/frontend-source/check.cjs',
    revision: 'C2（§14.4 要求 source.check 直连此入口）',
    exports: ['checkProject', 'PAGE_IDS'],
  },
  'agent-tools-ipc': {
    kind: 'module',
    path: 'desktop/agent-tools-ipc.cjs',
    revision: 'rev7 §3.6（E0 需补 agent:adopt-attempt）',
    exports: [],
  },
  // —— 以下为 E0 新增，当前尚未落地；缺失即相关用例 NOT_RUN ——
  'run-coordinator': {
    kind: 'module',
    path: 'desktop/agent-workspace/run-coordinator.cjs',
    revision: 'rev15 §14.2',
    exports: ['createRunCoordinator'],
    methods: ['startRun', 'getRun', 'invokeTool', 'getAttemptState', 'cancelRun', 'submitAttempt', 'adoptAttempt'],
    owner: 'workspace-lead（t1 E0-W1 / t5 E0-W2）',
  },
  'model-call-scheduler': {
    kind: 'module',
    path: 'desktop/model-call-scheduler.cjs',
    revision: 'rev15 §14.6',
    exports: ['createModelCallScheduler', 'MAX_UPSTREAM_CONCURRENCY', 'DEFAULT_QUEUE_TIMEOUT_MS'],
    owner: 'runtime-engineer（t2 E0-R1a）',
  },
  'agent-runtime': {
    kind: 'module-or-dir',
    path: 'desktop/agent-runtime',
    revision: 'rev15 §14.7/§14.8',
    exports: [],
    owner: 'runtime-engineer（t6 E0-R1 / t7 E0-R2）',
  },
  // —— t5 E0-W2 交付面（E0-V1b 复核对象）——
  'source-bundle': {
    kind: 'module',
    path: 'desktop/agent-workspace/source-bundle.cjs',
    revision: 'rev15 §14.5（平台派生 bundle + 8 页枚举单一事实源）',
    exports: ['PAGE_IDS', 'PAGE_CONTRACTS', 'BUNDLE_FILE', 'enumerateTargetPages', 'isKnownTargetPage',
      'readTree', 'deriveBundle', 'bundleIsStale', 'renderBundle', 'composeAttempt', 'loadComposerContext'],
    owner: 'workspace-lead（t5 E0-W2）',
  },
  'direct-runtime': {
    kind: 'module',
    path: 'desktop/agent-workspace/direct-runtime.cjs',
    revision: 'rev15 §14.7（invokeDirect 下游，未接线显式 AGENT_RUNTIME_TOOL_MISSING）',
    exports: ['createDirectWorkspaceRuntime'],
    owner: 'workspace-lead（t5 E0-W2）/ runtime-engineer（t6 E0-R1）',
  },
});

function interfaceOf(name) {
  return FROZEN_INTERFACES[name] || null;
}

function resolveModulePath(name) {
  const spec = FROZEN_INTERFACES[name];
  if (!spec) return null;
  const absolute = path.join(REPO_ROOT, spec.path);
  if (spec.kind === 'module' || fs.existsSync(absolute)) return absolute;
  return absolute;
}

function entryFile(name) {
  const spec = FROZEN_INTERFACES[name];
  if (!spec) return null;
  const absolute = path.join(REPO_ROOT, spec.path);
  if (spec.kind === 'module') return absolute;
  const candidates = ['index.cjs', 'index.js', 'index.mjs'];
  for (const candidate of candidates) {
    const file = path.join(absolute, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function createFrozenRegistry() {
  const cache = new Map();

  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const spec = interfaceOf(name);
    const entry = { name, present: false, status: 'missing', exports: [], missingExports: [],
      module: null, error: null, path: spec ? spec.path : null, revision: spec ? spec.revision : null,
      owner: spec ? spec.owner || null : null };
    if (!spec) {
      entry.error = '未登记的冻结接口';
      cache.set(name, entry);
      return entry;
    }
    const file = entryFile(name);
    if (!file || !fs.existsSync(file)) {
      cache.set(name, entry);
      return entry;
    }
    try {
      // 只 require 冻结模块本身；不在验证器里重写任何实现。
      const loaded = require(file);
      entry.present = true;
      entry.status = 'present';
      entry.module = loaded;
      entry.exports = loaded && typeof loaded === 'object' ? Object.keys(loaded) : [];
      const expected = spec.exports || [];
      entry.missingExports = expected.filter((key) => !(loaded && Object.prototype.hasOwnProperty.call(loaded, key)));
      if (entry.missingExports.length > 0) entry.status = 'incomplete';
    } catch (error) {
      entry.status = 'error';
      entry.error = error && error.message ? error.message : String(error);
    }
    cache.set(name, entry);
    return entry;
  }

  function isPresent(name) {
    const entry = load(name);
    return entry.status === 'present';
  }

  function requireOrNull(name) {
    const entry = load(name);
    return entry.present ? entry.module : null;
  }

  function requireStrict(name) {
    const entry = load(name);
    if (!entry.present) {
      throw new Error('冻结接口不可用：' + name + '（' + (entry.error || entry.status) + '）');
    }
    return entry.module;
  }

  function summary() {
    return Object.keys(FROZEN_INTERFACES).map((name) => {
      const entry = load(name);
      return {
        name,
        path: entry.path,
        revision: entry.revision,
        status: entry.status,
        missingExports: entry.missingExports,
        error: entry.error,
        owner: entry.owner,
      };
    });
  }

  return { load, isPresent, requireOrNull, requireStrict, summary, list: () => Object.keys(FROZEN_INTERFACES) };
}

module.exports = {
  FROZEN_INTERFACES,
  interfaceOf,
  createFrozenRegistry,
  REPO_ROOT,
};
