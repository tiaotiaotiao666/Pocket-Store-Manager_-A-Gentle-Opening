'use strict';

/**
 * E0-W2（X5/X6）：SourceBundle 平台派生 + 8 页目标枚举 + attempt 的 dry-run 导出。
 *
 * 冻结契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.5。
 *
 * 边界（每一条都有测试）：
 * - 纯 CJS、不依赖 Electron；只读仓库 Base 与 attempt 候选树，**不写** templates/miniprogram/contracts。
 * - `deriveBundle()` 只做计算：输入 Base 源树 + 候选树，输出 `frontend-source-bundle.v1` 清单
 *   （`files` 为最终完整内容摘要、`deleted` 显式、`components[].scope`、`assets[]` 真实字节摘要）；
 *   写盘由调用的 Coordinator 走 B1 事务（这样 revision/treeDigest 由同一 ABI 维护）。
 * - 模型永远拿不到本模块：它不出现在模型工具面里（平台专用）。
 * - 8 页枚举只有一处事实源：`scripts/agent-source-facts.cjs` 的 `PAGE_IDS`/`PAGE_CONTRACTS`，
 *   `enabled` 由“候选树里该页 index.json / index.wxml 是否存在 + 是否有页面契约”派生，
 *   绝不硬编码 8 个 true。注意：这里只校验 index.json/index.wxml（不是“四件套”）；
 *   index.js/index.wxss 的完整性由 source.check 负责。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sourceFacts = require('../../scripts/agent-source-facts.cjs');
const composerDigest = require('../../scripts/composer/digest.cjs');
const composerRegistry = require('../../scripts/composer/registry.cjs');
const composerResolve = require('../../scripts/composer/resolve.cjs');
const composer = require('../../scripts/composer/index.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 'frontend-source-bundle.v1';
const BUNDLE_FILE = 'source-bundle.json';
/** 默认 dry-run 配方：Base 自带配方（确定性），不读用户 store plan（E1/E3 再换成用户方案）。 */
const DEFAULT_PLAN_PATH = path.join(REPO_ROOT, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json');

/** 8 页单一来源（顺序冻结）。 */
const PAGE_IDS = Object.freeze([...sourceFacts.PAGE_IDS]);
const PAGE_CONTRACTS = sourceFacts.PAGE_CONTRACTS || {};

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 64 * 1024 * 1024;

const PAGE_EXTENSIONS = Object.freeze(['js', 'json', 'wxml', 'wxss', 'wxs']);
const COMPONENT_EXTENSIONS = Object.freeze(['js', 'json', 'wxml', 'wxss', 'wxs']);
const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const IMAGE_MAGIC = Object.freeze({
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  webp: [0x52, 0x49, 0x46, 0x46],
});

const CODES = Object.freeze({
  PAYLOAD_INVALID: 'AGENT_PAYLOAD_INVALID',
  STATIC_GATE_FAILED: 'AGENT_STATIC_GATE_FAILED',
  CHECK_UNKNOWN: 'AGENT_CHECK_UNKNOWN',
  CHECK_FAILED: 'AGENT_CHECK_FAILED',
  TOOL_MISSING: 'CHECK_TOOL_MISSING',
  FILE_COUNT_EXCEEDED: 'AGENT_FILE_COUNT_EXCEEDED',
  FILE_TOO_LARGE: 'AGENT_FILE_TOO_LARGE',
  TREE_TOO_LARGE: 'AGENT_TREE_TOO_LARGE',
  VERSION_NOT_FOUND: 'AGENT_VERSION_NOT_FOUND',
  TARGET_PAGE_UNSUPPORTED: 'AGENT_TARGET_PAGE_UNSUPPORTED',
  WORKSPACE_INVALID: 'AGENT_WORKSPACE_INVALID',
});

function fail(code, message, issues) {
  return { ok: false, code, message, issues: Array.isArray(issues) ? issues : [] };
}

function issue(code, message, extra) {
  return {
    file: null,
    line: null,
    column: null,
    code,
    message: String(message || '').slice(0, 240),
    source: 'source-bundle',
    ...(extra || {}),
  };
}

function sha256Of(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeRelative(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

/** 递归读取一棵源树为 Map<相对路径, Buffer>（拒绝链接、越界；超限即失败）。 */
function readTree(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return fail(CODES.PAYLOAD_INVALID, '源树根必须是绝对路径（由平台派生）');
  }
  let stats;
  try {
    stats = fs.lstatSync(root);
  } catch (error) {
    return fail(CODES.VERSION_NOT_FOUND, '源树根不存在');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return fail(CODES.WORKSPACE_INVALID, '源树根必须是真实目录（拒绝链接）');
  }
  const files = new Map();
  let totalBytes = 0;
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      return fail(CODES.WORKSPACE_INVALID, '源树目录不可读');
    }
    for (const entry of entries) {
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) return fail(CODES.WORKSPACE_INVALID, '源树不允许链接：' + childRelative);
      if (entry.isDirectory()) {
        stack.push(childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const childAbsolute = path.join(root, ...childRelative.split('/'));
      let buffer;
      let fileStats;
      try {
        fileStats = fs.lstatSync(childAbsolute);
        if (fileStats.size > MAX_FILE_BYTES) return fail(CODES.FILE_TOO_LARGE, '单文件超过 1 MiB：' + childRelative);
        buffer = fs.readFileSync(childAbsolute);
      } catch (error) {
        return fail(CODES.WORKSPACE_INVALID, '源树文件不可读：' + childRelative);
      }
      totalBytes += buffer.length;
      if (totalBytes > MAX_TREE_BYTES) return fail(CODES.TREE_TOO_LARGE, '源树超过 64 MiB');
      if (files.size >= MAX_FILES) return fail(CODES.FILE_COUNT_EXCEEDED, '源树文件数超过上限');
      files.set(childRelative, buffer);
    }
  }
  return { ok: true, files, totalBytes };
}

/* ------------------------------------------------------------------ */
/* Composer 上下文（Base 身份 + Plan + 8 页）                          */
/* ------------------------------------------------------------------ */

let cachedContext = null;

/**
 * 载入 Composer 的 Base 身份/Plan/graph。只读，不写盘。
 * @param {{planPath?:string, refresh?:boolean}} [options]
 */
function loadComposerContext(options) {
  const opts = options || {};
  const planPath = typeof opts.planPath === 'string' ? opts.planPath : DEFAULT_PLAN_PATH;
  if (cachedContext && cachedContext.planPath === planPath && opts.refresh !== true) return cachedContext;
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    return fail(CODES.CHECK_UNKNOWN, 'dry-run 配方不可读');
  }
  const loaded = composerRegistry.loadRegistry({ verifyFreeze: true });
  if (!loaded.ok) return fail(CODES.CHECK_UNKNOWN, 'Registry 不可用（冻结校验失败）');
  const graph = composerResolve.resolvePlan(plan, loaded);
  if (!graph.ok) return fail(CODES.CHECK_UNKNOWN, 'dry-run 配方解析失败');
  const baseSrc = graph.baseSrc;
  let baseTreeSha256;
  try {
    baseTreeSha256 = composerDigest.treeSha256(baseSrc);
  } catch (error) {
    return fail(CODES.CHECK_UNKNOWN, 'Base 源树摘要计算失败');
  }
  cachedContext = {
    ok: true,
    planPath,
    plan,
    loaded,
    graph,
    base: { id: graph.base.id, version: graph.base.version },
    baseSrc,
    baseTreeSha256,
    pageIds: Array.isArray(graph.pageIds) ? [...graph.pageIds] : [],
  };
  return cachedContext;
}

function resetComposerContextForTests() {
  cachedContext = null;
}

/* ------------------------------------------------------------------ */
/* 8 页目标枚举（X5）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 由 SourceFacts 页面契约 + 候选树实际文件派生 `{id,enabled,reasons}`。
 * @param {{files?: Map<string,Buffer>|null}} [options]
 */
function enumerateTargetPages(options) {
  const opts = options || {};
  const files = opts.files instanceof Map ? opts.files : null;
  return PAGE_IDS.map((id) => {
    const reasons = [];
    const contract = PAGE_CONTRACTS[id];
    if (!contract) reasons.push('页面契约未定义（SourceFacts 缺 ' + id + '）');
    if (files) {
      for (const extension of ['json', 'wxml']) {
        const relative = 'pages/' + id + '/index.' + extension;
        if (!files.has(relative)) reasons.push('候选缺少 ' + relative);
      }
    } else {
      reasons.push('候选树未提供（无法确认该页存在）');
    }
    return { id, enabled: reasons.length === 0, reasons };
  });
}

/** 目标页是否在 8 页单一来源内（形状 + 存在性都由该表决定）。 */
function isKnownTargetPage(pageId) {
  return typeof pageId === 'string' && PAGE_IDS.includes(pageId);
}

/* ------------------------------------------------------------------ */
/* Bundle 派生（X6）                                                   */
/* ------------------------------------------------------------------ */

function topSegment(relative) {
  return relative.split('/')[0];
}

function extensionOf(relative) {
  return path.posix.extname(relative).slice(1).toLowerCase();
}

function validateOverlayPath(relative) {
  const top = topSegment(relative);
  if (!['pages', 'components', 'assets'].includes(top)) {
    return fail(CODES.STATIC_GATE_FAILED, 'overlay 只允许 pages/components/assets：' + relative, [
      issue('SOURCE_BUNDLE_PATH_FORBIDDEN', '候选改了 overlay 不允许的目录：' + top),
    ]);
  }
  const extension = extensionOf(relative);
  const allowed = top === 'assets' ? IMAGE_EXTENSIONS : (top === 'pages' ? PAGE_EXTENSIONS : COMPONENT_EXTENSIONS);
  if (!allowed.includes(extension)) {
    return fail(CODES.STATIC_GATE_FAILED, '不允许的 overlay 文件类型：' + relative, [
      issue('SOURCE_BUNDLE_FILE_TYPE_FORBIDDEN', '候选改了不允许的文件类型：' + relative),
    ]);
  }
  return { ok: true };
}

function componentIdOf(relative) {
  const match = /^components\/([a-z0-9-]+)\//.exec(relative);
  return match ? match[1] : null;
}

function pageIdOf(relative) {
  const match = /^pages\/([a-z0-9-]+)\//.exec(relative);
  return match ? match[1] : null;
}

/** 从候选页面的 index.json / index.wxml 推导“哪些页引用了该组件”。 */
function referencedPagesOf(componentId, candidateFiles) {
  const pages = new Set();
  for (const pageId of PAGE_IDS) {
    const jsonFile = 'pages/' + pageId + '/index.json';
    const wxmlFile = 'pages/' + pageId + '/index.wxml';
    const jsonBuffer = candidateFiles.get(jsonFile);
    if (jsonBuffer) {
      try {
        const parsed = JSON.parse(jsonBuffer.toString('utf8'));
        const using = parsed && typeof parsed === 'object' ? parsed.usingComponents : null;
        if (using && typeof using === 'object') {
          for (const [tag, target] of Object.entries(using)) {
            if (tag === componentId || String(target).includes('/components/' + componentId + '/')
              || String(target).includes('/components/' + componentId + '--' + pageId + '/')) {
              pages.add(pageId);
            }
          }
        }
      } catch (error) {
        /* 解析异常由 source.check 报，这里不伪造“使用关系” */
      }
    }
    const wxmlBuffer = candidateFiles.get(wxmlFile);
    if (wxmlBuffer && new RegExp('<' + componentId + '[\\s/>]').test(wxmlBuffer.toString('utf8'))) {
      pages.add(pageId);
    }
  }
  return [...pages].sort();
}

/**
 * 从 “Base 源树 → attempt 候选树” 派生 `frontend-source-bundle.v1` 清单（纯计算，不写盘）。
 *
 * @param {object} input
 * @param {string} input.baseSrc 仓库 Base 源树（绝对路径，平台派生）
 * @param {Map<string,Buffer>} input.candidateFiles 候选树文件
 * @param {string[]} input.targetPages 目标页（必须来自 8 页表）
 * @param {string[]} [input.pageIds] Composer Plan 的页集合（缺省用 8 页表）
 */
function deriveBundle(input) {
  const opts = input || {};
  const candidateFiles = opts.candidateFiles;
  if (!(candidateFiles instanceof Map)) return fail(CODES.PAYLOAD_INVALID, 'deriveBundle 需要候选文件集');
  const context = loadComposerContext(opts);
  if (!context.ok) return context;
  const baseRead = readTree(typeof opts.baseSrc === 'string' ? opts.baseSrc : context.baseSrc);
  if (!baseRead.ok) return baseRead;
  const baseFiles = baseRead.files;

  const targetPages = Array.isArray(opts.targetPages) ? [...new Set(opts.targetPages)] : [];
  if (targetPages.length === 0) {
    return fail(CODES.TARGET_PAGE_UNSUPPORTED, 'deriveBundle 需要至少一个目标页', [
      issue('SOURCE_BUNDLE_TARGET_PAGE_REQUIRED', '缺少 targetPages'),
    ]);
  }
  const pageIds = Array.isArray(opts.pageIds) && opts.pageIds.length > 0 ? opts.pageIds : context.pageIds;
  for (const pageId of targetPages) {
    if (!isKnownTargetPage(pageId) || !pageIds.includes(pageId)) {
      return fail(CODES.TARGET_PAGE_UNSUPPORTED, '目标页不在 8 页表/当前 Plan 内：' + String(pageId), [
        issue('SOURCE_BUNDLE_TARGET_PAGE_REQUIRED', '目标页不在当前 Plan：' + String(pageId)),
      ]);
    }
  }

  const files = [];
  const assets = [];
  const changedRelative = [];
  for (const [relative, buffer] of candidateFiles) {
    if (relative === BUNDLE_FILE) continue; // 清单自身不属于 overlay
    const baseBuffer = baseFiles.get(relative);
    const changed = !baseBuffer || !baseBuffer.equals(buffer);
    if (!changed) continue;
    const allowed = validateOverlayPath(relative);
    if (!allowed.ok) return allowed;
    if (topSegment(relative) === 'assets') {
      const extension = extensionOf(relative);
      const magic = IMAGE_MAGIC[extension];
      const matches = Array.isArray(magic) && magic.every((byte, index) => buffer[index] === byte);
      if (!matches) {
        return fail(CODES.STATIC_GATE_FAILED, '资产魔数与扩展名不一致：' + relative, [
          issue('SOURCE_BUNDLE_ASSET_TYPE_INVALID', '资产只接受真实 png/jpeg/webp：' + relative),
        ]);
      }
      assets.push(relative);
    }
    files.push({ path: relative, sha256: sha256Of(buffer) });
    changedRelative.push(relative);
  }

  const deleted = [];
  for (const relative of baseFiles.keys()) {
    if (candidateFiles.has(relative)) continue;
    if (topSegment(relative) !== 'assets') {
      return fail(CODES.STATIC_GATE_FAILED, '只允许删除 assets/**（' + relative + '）', [
        issue('SOURCE_BUNDLE_DELETE_FORBIDDEN', '候选删除了不允许删除的文件：' + relative),
      ]);
    }
    deleted.push(relative);
  }

  // 组件范围：被改动的组件按“被哪些页引用”派生 page/shared。
  const componentIds = [...new Set(changedRelative.map(componentIdOf).filter(Boolean))].sort();
  const components = componentIds.map((componentId) => {
    const pages = referencedPagesOf(componentId, candidateFiles);
    if (pages.length > 0 && pages.every((pageId) => targetPages.includes(pageId))) {
      return { componentId, scope: 'page', pages };
    }
    return { componentId, scope: 'shared' };
  });

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  deleted.sort();
  assets.sort();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    base: { id: context.base.id, version: context.base.version, treeSha256: context.baseTreeSha256 },
    targetPages,
    files,
    deleted,
    components,
    assets,
  };
  // 与 Composer overlay 摘要同口径：path:sha256 排序后取摘要（不含时间/绝对路径）。
  const digest = 'sha256:' + crypto.createHash('sha256')
    .update(files.map((file) => file.path + ':' + file.sha256).sort().join('\n'))
    .digest('hex');

  return {
    ok: true,
    manifest,
    digest,
    fileCount: files.length,
    deletedCount: deleted.length,
    assetCount: assets.length,
    componentCount: components.length,
    changedRelative,
  };
}

/**
 * 现有 bundle（若在候选树里）与当前候选是否一致：返回 true 表示需要重新派生。
 * @param {Map<string,Buffer>} candidateFiles 候选树
 * @param {Map<string,Buffer>} baseFiles Base 源树（用于判断“未列出 = 未改动”）
 */
function bundleIsStale(candidateFiles, baseFiles) {
  if (!(candidateFiles instanceof Map)) return true;
  const buffer = candidateFiles.get(BUNDLE_FILE);
  if (!buffer) return true;
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return true;
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !parsed.base || typeof parsed.base.treeSha256 !== 'string') {
    return true;
  }
  const listed = new Map((Array.isArray(parsed.files) ? parsed.files : [])
    .filter((entry) => entry && typeof entry.path === 'string')
    .map((entry) => [entry.path, entry.sha256]));
  const base = baseFiles instanceof Map ? baseFiles : new Map();
  for (const [relative, content] of candidateFiles) {
    if (relative === BUNDLE_FILE) continue;
    const digest = sha256Of(content);
    if (listed.has(relative)) {
      if (listed.get(relative) !== digest) return true;
      continue;
    }
    // 未列出的文件必须与 Base 完全一致，否则说明清单过期。
    const baseBuffer = base.get(relative);
    if (!baseBuffer || sha256Of(baseBuffer) !== digest) return true;
  }
  for (const relative of listed.keys()) {
    if (!candidateFiles.has(relative)) return true;
  }
  return false;
}

/** Bundle 文件的最终文本（确定性：2 空格缩进 + 结尾换行，键顺序固定）。 */
function renderBundle(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* attempt dry-run（composer.dry-run 的执行体）                        */
/* ------------------------------------------------------------------ */

/**
 * 在 attempt 候选树上执行一次 Composer dry-run（导出树落在调用方给的 parentDir 下）。
 * 不写 templates/miniprogram/contracts：只读 Base/Registry，产物写 parentDir。
 */
async function composeAttempt(input) {
  const opts = input || {};
  const root = opts.root;
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return fail(CODES.CHECK_UNKNOWN, 'dry-run 需要平台派生的候选根（不接受模型路径）');
  }
  if (typeof opts.parentDir !== 'string' || !path.isAbsolute(opts.parentDir)) {
    return fail(CODES.CHECK_UNKNOWN, 'dry-run 需要平台派生的导出父目录');
  }
  const context = loadComposerContext(opts);
  if (!context.ok) return context;
  let result;
  try {
    result = await composer.compose({
      plan: context.plan,
      parentDir: opts.parentDir,
      projectName: opts.projectName || 'export',
      mode: 'development',
      sourceOverlay: root,
      generatedAt: opts.generatedAt,
    });
  } catch (error) {
    return fail(CODES.CHECK_FAILED, 'dry-run 执行异常：' + String((error && error.message) || error).slice(0, 160));
  }
  if (!result || result.ok !== true) {
    const code = (result && result.code) || CODES.CHECK_FAILED;
    const environmentLike = ['TARGET_PARENT_MISSING', 'TARGET_NOT_WRITABLE', 'TARGET_NO_SPACE', 'PATH_TOO_LONG',
      'EXPORT_CANCELLED', 'SOURCE_OVERLAY_ROOT_INVALID', 'COMPOSE_FAILED'].includes(code);
    const message = String((result && (result.message || (result.errors && result.errors[0]))) || 'dry-run 失败');
    return {
      ok: false,
      code,
      environmentLike,
      message: message.slice(0, 240),
      issues: [issue(code, message, { source: 'composer' })],
    };
  }
  return {
    ok: true,
    outputPath: result.outputPath,
    treeSha256: result.treeSha256,
    fileCount: result.fileCount,
    checks: Array.isArray(result.checks) ? result.checks : [],
    sourceOverlay: result.sourceOverlay || null,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

module.exports = {
  SCHEMA_VERSION,
  BUNDLE_FILE,
  PAGE_IDS,
  PAGE_CONTRACTS,
  DEFAULT_PLAN_PATH,
  CODES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TREE_BYTES,
  loadComposerContext,
  resetComposerContextForTests,
  enumerateTargetPages,
  isKnownTargetPage,
  readTree,
  deriveBundle,
  bundleIsStale,
  renderBundle,
  sha256Of,
  normalizeRelative,
  composeAttempt,
};
