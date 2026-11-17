'use strict';

/**
 * 私有 Registry overlay（P2）。
 *
 * 目标：让候选 FrontendPack 能被**未修改的** Composer 解析/校验，同时
 *
 * - 不写全局 `templates/registry`、`templates/frontend-packs`、`miniprogram/`；
 * - 不复制/不缓存可信资产的实现，只在 overlay 索引里**投影**可信条目（路径与 integrity
 *   原样保留），由 `loadRegistry({ assetRoots: [overlayRoot, REPO_ROOT] })` 只读解析；
 * - 候选资产与（可选的）候选 Recipe 只落在调用方给的私有 attempt 目录里；
 * - 可信条目仍按全局冻结摘要做完整性校验（verifyFreeze），所以仓库资产被改动时
 *   overlay 加载同样会失败，不会“绕过 registry:check”。
 *
 * overlay 目录内容：
 *
 * ```
 * <overlayRoot>/registry.v1.json    可信条目投影 + 候选条目（frozen:true）
 * <overlayRoot>/registry.lock.json  contentDigest = registryDigest(index)
 * <overlayRoot>/assets/frontend-packs/<candidateId>/<version>/{manifest.json,src/**,preview/**}
 * <overlayRoot>/assets/recipes/<recipeId>/<version>/recipe.json        （可选）
 * ```
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  REPO_ROOT,
  DEFAULT_REGISTRY_ROOT,
  loadRegistry,
} = require('../../scripts/composer/registry.cjs');
const { registryDigest, canonical, sha256 } = require('../../scripts/composer/digest.cjs');
const { validatePlan } = require('../../scripts/composer/schema.cjs');
const { treeDigestOfFiles } = require('./render.cjs');
const {
  assertCanonicalDir,
  assertSafeRelativePath,
  auditPath,
  ensureCanonicalDirectory,
  ensureDirectory,
  isInsideOrEqual,
  realpathOf,
  resolveInside,
} = require('./workspace.cjs');

const OVERLAY_REGISTRY_VERSION_SCHEMA = 'registry.v1';
const LOCK_VERSION = 'lock.v1';
const CANDIDATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
/** overlay 只允许写自己的候选资产；任何全局模板/镜像路径前缀一律拒绝。 */
const FORBIDDEN_OVERLAY_PREFIXES = Object.freeze(['templates/', 'miniprogram/', 'src/', 'server/']);

const CODES = Object.freeze({
  TRUSTED_INVALID: 'OVERLAY_TRUSTED_REGISTRY_INVALID',
  CANDIDATE_INVALID: 'OVERLAY_CANDIDATE_INVALID',
  CANDIDATE_COLLISION: 'OVERLAY_CANDIDATE_COLLISION',
  RECIPE_INVALID: 'OVERLAY_RECIPE_INVALID',
  WRITE_REJECTED: 'OVERLAY_WRITE_REJECTED',
  WRITE_FAILED: 'OVERLAY_WRITE_FAILED',
  VERIFY_FAILED: 'OVERLAY_VERIFY_FAILED',
});

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function fail(code, target, message) {
  return { ok: false, code, path: target || '.', message };
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/** 加载**可信**注册表（默认全局冻结 Registry），任何漂移都拒绝。 */
function loadTrustedRegistry(options) {
  const opts = options || {};
  const registryRoot = opts.registryRoot || DEFAULT_REGISTRY_ROOT;
  const assetRoots = opts.assetRoots || [REPO_ROOT];
  const loaded = loadRegistry({ verifyFreeze: true, registryRoot, assetRoots });
  if (!loaded.ok) {
    return { ...loaded, code: loaded.code || CODES.TRUSTED_INVALID };
  }
  return ok({ loaded, registryRoot, assetRoots });
}

/** 可信条目的投影（只保留索引字段，不含任何解析后的绝对路径/实现内容）。 */
function projectTrustedEntries(loaded) {
  const entries = [];
  for (const asset of loaded.registry.assets) {
    entries.push({
      id: asset.id,
      version: asset.version,
      kind: asset.kind,
      path: asset.path,
      integrity: asset.integrity,
    });
  }
  return entries;
}

/**
 * 纯函数：构造 overlay 索引/lock 与要写入的文件 Map。
 *
 * @param {object} options
 * @param {object} options.loaded           `loadTrustedRegistry` 返回的 loaded
 * @param {{id:string, version:string}} options.candidate 候选 FrontendPack 身份
 * @param {Map<string,string|Buffer>|Object<string,string|Buffer>} options.candidateFiles
 *        候选资产文件（相对候选资产根）
 * @param {{id:string, version:string, plan:object}} [options.recipe] 可选候选 Recipe
 * @returns {{ok:true, index:object, lock:object, files:Map<string,string|Buffer>,
 *            registryDigest:string, candidate:object, recipe:object|null, trustedCount:number}}
 */
function buildOverlayProjection(options) {
  const opts = options || {};
  const loaded = opts.loaded;
  if (!loaded || !loaded.ok || !loaded.registry) {
    return fail(CODES.TRUSTED_INVALID, 'loaded', '必须提供已成功加载的可信注册表');
  }
  const candidate = opts.candidate || {};
  if (typeof candidate.id !== 'string' || !CANDIDATE_ID_PATTERN.test(candidate.id)) {
    return fail(CODES.CANDIDATE_INVALID, 'candidate.id', '候选 id 非法：' + String(candidate.id));
  }
  if (typeof candidate.version !== 'string' || !VERSION_PATTERN.test(candidate.version)) {
    return fail(CODES.CANDIDATE_INVALID, 'candidate.version', '候选版本必须是 x.y.z');
  }
  const collision = loaded.assets.find((asset) => asset.id === candidate.id);
  if (collision) {
    return fail(CODES.CANDIDATE_COLLISION, 'candidate.id', '候选 id 与可信资产冲突：' + candidate.id);
  }

  const candidateFiles = opts.candidateFiles instanceof Map
    ? new Map(opts.candidateFiles)
    : new Map(Object.entries(opts.candidateFiles || {}));
  if (candidateFiles.size === 0) return fail(CODES.CANDIDATE_INVALID, 'candidateFiles', '候选文件不能为空');
  if (!candidateFiles.has('manifest.json')) {
    return fail(CODES.CANDIDATE_INVALID, 'candidateFiles', '候选资产必须包含 manifest.json');
  }
  const candidatePrefix = 'assets/frontend-packs/' + candidate.id + '/' + candidate.version + '/';
  const files = new Map();
  for (const [relative, content] of candidateFiles) {
    const safe = assertSafeRelativePath(relative);
    if (!safe.ok) return fail(CODES.CANDIDATE_INVALID, relative, '候选文件路径非法：' + safe.message);
    files.set(candidatePrefix + relative, content);
  }
  const candidateEntry = {
    id: candidate.id,
    version: candidate.version,
    kind: 'frontend-pack',
    path: candidatePrefix.slice(0, -1),
    integrity: treeDigestOfFiles(candidateFiles),
  };

  const entries = projectTrustedEntries(loaded);
  entries.push(candidateEntry);

  let recipe = null;
  if (opts.recipe) {
    const rawRecipe = opts.recipe;
    if (typeof rawRecipe.id !== 'string' || !RECIPE_ID_PATTERN.test(rawRecipe.id)) {
      return fail(CODES.RECIPE_INVALID, 'recipe.id', 'Recipe id 非法：' + String(rawRecipe.id));
    }
    if (typeof rawRecipe.version !== 'string' || !VERSION_PATTERN.test(rawRecipe.version)) {
      return fail(CODES.RECIPE_INVALID, 'recipe.version', 'Recipe 版本必须是 x.y.z');
    }
    if (loaded.assets.some((asset) => asset.id === rawRecipe.id)) {
      return fail(CODES.CANDIDATE_COLLISION, 'recipe.id', 'Recipe id 与可信资产冲突：' + rawRecipe.id);
    }
    const planCheck = validatePlan(rawRecipe.plan);
    if (!planCheck.ok) {
      return fail(CODES.RECIPE_INVALID, planCheck.path || 'recipe.plan', '候选 Recipe 的 Plan 不合法：' + planCheck.code);
    }
    const recipeDir = 'assets/recipes/' + rawRecipe.id + '/' + rawRecipe.version;
    const recipeFiles = new Map([['recipe.json', jsonText(rawRecipe.plan)]]);
    files.set(recipeDir + '/recipe.json', recipeFiles.get('recipe.json'));
    recipe = {
      id: rawRecipe.id,
      version: rawRecipe.version,
      path: recipeDir,
      integrity: treeDigestOfFiles(recipeFiles),
    };
    entries.push({ id: recipe.id, version: recipe.version, kind: 'recipe', path: recipe.path, integrity: recipe.integrity });
  }

  entries.sort((a, b) => (a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id)));
  const index = {
    schemaVersion: OVERLAY_REGISTRY_VERSION_SCHEMA,
    registryVersion: loaded.registry.registryVersion,
    frozen: true,
    assets: entries,
  };
  const lock = {
    lockVersion: LOCK_VERSION,
    registryVersion: index.registryVersion,
    contentDigest: registryDigest(index),
  };

  files.set('registry.v1.json', jsonText(index));
  files.set('registry.lock.json', jsonText(lock));

  return ok({
    index,
    lock,
    files,
    registryDigest: lock.contentDigest,
    sourceRegistryDigest: loaded.registryDigest,
    candidate: {
      id: candidateEntry.id,
      version: candidateEntry.version,
      path: candidateEntry.path,
      integrity: candidateEntry.integrity,
    },
    recipe,
  });
}

/**
 * 写入前把 overlayRoot 规范化成“规范目录”（P2 repair-3 / T18-F2）。
 *
 * 规则：
 * - 绝对路径；
 * - **mkdir 前**先 canonical 化最近已存在祖先（lstat/realpath 拒 symlink/junction、
 *   受保护路径检查），再用逐段非递归 mkdir 创建；因此“祖先 junction + 缺失根”
 *   会在创建任何目录前失败，不会在链接目标里留下新目录；
 * - overlayRoot 自身仍要求 `realpath(root) === 词法 root`，junction/别名拒绝；
 * - realpath 后再查仓库/受保护目录；
 * - 若调用方传入 `expectedPrivateRoot`（materialize 传本次 attemptDir），要求
 *   `isInsideOrEqual(realpath(expectedPrivateRoot), realpath(root))` **且**逐段 audit
 *   整条链，防止 overlayRoot 被换成指向 attempt 之外的链接。
 */
function canonicalOverlayRoot(overlayRoot, expectedPrivateRoot) {
  if (typeof overlayRoot !== 'string' || !path.isAbsolute(overlayRoot)) {
    return fail(CODES.WRITE_REJECTED, 'overlayRoot', 'overlayRoot 必须是绝对路径');
  }
  const rootInput = path.resolve(overlayRoot);
  // 创建目录之前先做词法越界检查：避免调用方给错路径时先在 attempt 之外留下空目录。
  let expected = null;
  if (expectedPrivateRoot !== undefined) {
    if (typeof expectedPrivateRoot !== 'string' || !path.isAbsolute(expectedPrivateRoot)) {
      return fail(CODES.WRITE_REJECTED, 'expectedPrivateRoot', 'expectedPrivateRoot 必须是绝对路径');
    }
    expected = path.resolve(expectedPrivateRoot);
    if (!isInsideOrEqual(expected, rootInput)) {
      return fail(CODES.WRITE_REJECTED, rootInput, 'overlayRoot 必须位于本次私有 attempt 目录内（mkdir 前拒绝）');
    }
    if (isInsideOrEqual(REPO_ROOT, rootInput)) {
      return fail(CODES.WRITE_REJECTED, rootInput, 'overlay 不得写入仓库（mkdir 前拒绝）');
    }
  }
  const canonical = ensureCanonicalDirectory(rootInput);
  if (!canonical.ok) {
    const code = canonical.code === 'WORKSPACE_PATH_REJECTED' ? CODES.WRITE_REJECTED : CODES.WRITE_FAILED;
    return fail(code, canonical.path || overlayRoot, '无法安全创建 overlayRoot：' + (canonical.message || canonical.code));
  }
  const root = canonical.dir;
  const rootReal = canonical.realDir;
  if (isInsideOrEqual(REPO_ROOT, root) || isInsideOrEqual(REPO_ROOT, rootReal)) {
    return fail(CODES.WRITE_REJECTED, root, 'overlay 不得写入仓库（会污染全局 templates/miniprogram）');
  }

  if (expected !== null) {
    let expectedReal;
    try {
      expectedReal = realpathOf(expected);
    } catch (error) {
      return fail(CODES.WRITE_REJECTED, expected, '无法解析私有 attempt 目录：' + (error.code || error.message));
    }
    // 词法与真实路径都要在 attempt 内：任何一层被换成链接都会在这里失败。
    if (!isInsideOrEqual(expected, root) || !isInsideOrEqual(expectedReal, rootReal)) {
      return fail(CODES.WRITE_REJECTED, root, 'overlayRoot 必须位于本次私有 attempt 目录内');
    }
    const audit = auditPath(expected, expectedReal, root);
    if (!audit.ok) return audit;
  }
  return ok({ root, rootReal });
}

/**
 * 把文件 Map 写入 overlay 根目录：每个相对路径先过安全校验，根目录必须规范化，
 * 每级父目录用逐段 mkdir + audit 创建（不会穿过已存在的 symlink/junction）。
 * 只允许写 overlay 根（调用方给的是私有 attempt 下的 staging 目录）。
 */
function writeOverlayFiles(overlayRoot, files, options) {
  const opts = options || {};
  const prepared = canonicalOverlayRoot(overlayRoot, opts.expectedPrivateRoot);
  if (!prepared.ok) return prepared;
  const { root, rootReal } = prepared;

  const writes = [];
  try {
    const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const [relative, content] of entries) {
      const normalized = String(relative).replace(/\\/g, '/');
      if (FORBIDDEN_OVERLAY_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
        return fail(CODES.WRITE_REJECTED, relative, 'overlay 不得写入全局模板/镜像/源码路径');
      }
      const resolved = resolveInside(root, relative);
      if (!resolved.ok) return fail(CODES.WRITE_REJECTED, relative, resolved.message);
      const parentEnsured = ensureDirectory(root, rootReal, path.dirname(resolved.target));
      if (!parentEnsured.ok) return fail(CODES.WRITE_REJECTED, relative, parentEnsured.message);
      // 每次写入前复核 overlay 根没有被换成链接。
      const rootCheck = assertCanonicalDir(root);
      if (!rootCheck.ok) return fail(CODES.WRITE_REJECTED, root, rootCheck.message);
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      fs.writeFileSync(resolved.target, buffer, { flag: 'wx' });
      writes.push(relative);
    }
  } catch (error) {
    return fail(CODES.WRITE_FAILED, root, 'overlay 写入失败：' + (error.code || error.message));
  }
  return ok({ overlayRoot: root, overlayRootReal: rootReal, files: writes });
}

/** overlay 的资产根顺序：私有 overlay 优先，其次只读可信仓库。 */
function overlayAssetRoots(overlayRoot) {
  return [path.resolve(overlayRoot), REPO_ROOT];
}

/**
 * 用与 Composer 完全相同的加载器验证 overlay（含冻结摘要与逐资产完整性）。
 */
function verifyOverlay(options) {
  const opts = options || {};
  if (typeof opts.overlayRoot !== 'string' || !path.isAbsolute(opts.overlayRoot)) {
    return fail(CODES.VERIFY_FAILED, 'overlayRoot', 'overlayRoot 必须是绝对路径');
  }
  const overlayRoot = path.resolve(opts.overlayRoot);
  const loaded = loadRegistry({
    verifyFreeze: true,
    registryRoot: overlayRoot,
    assetRoots: overlayAssetRoots(overlayRoot),
  });
  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.code || CODES.VERIFY_FAILED,
      path: loaded.path || '$',
      message: loaded.message || 'overlay 注册表校验失败',
      details: loaded.details,
    };
  }
  return ok({
    loaded,
    overlayRoot,
    assetRoots: overlayAssetRoots(overlayRoot),
    registryDigest: loaded.registryDigest,
  });
}

/** 稳定摘要（测试用：证明 overlay 索引未被改写、可信 Registry 未被动过）。 */
function overlayIndexDigest(index) {
  return sha256(canonical(index));
}

module.exports = {
  DEFAULT_REGISTRY_ROOT,
  CANDIDATE_ID_PATTERN,
  CODES,
  loadTrustedRegistry,
  projectTrustedEntries,
  buildOverlayProjection,
  writeOverlayFiles,
  overlayAssetRoots,
  verifyOverlay,
  overlayIndexDigest,
};
