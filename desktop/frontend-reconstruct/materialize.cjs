'use strict';

/**
 * 原子物化（P2）：Draft → 候选 FrontendPack + 私有 Registry overlay → attempt 提交。
 *
 * 事务边界：
 * 1. 校验 Draft（schema + 页面目录事实）与渲染都在**内存**完成，失败不落盘；
 * 2. 分配独占 `attempts/attempt-<n>`，所有写盘先写到该 attempt 内的 `.staging-<8hex>`；
 * 3. 用与 Composer 完全相同的 `loadRegistry`（verifyFreeze）验证 staging 里的 overlay，
 *    并核对磁盘上候选目录的树摘要与渲染摘要一致；
 * 4. 只在全部校验通过后 rename 提交 `candidate/`、`overlay/`，再写 `attempt.json`
 *    并更新 `run.json`；任一步失败都只删除**本次** attempt，之前 attempt 原样保留。
 *
 * 安全（repair-2）：
 * - staging / candidate / overlay 每次创建后都 `assertCanonicalDir`（lstat + realpath），
 *   overlay 写入前还要求 root 位于本次 attemptDir 之内（`expectedPrivateRoot`）；
 * - 可信注册表加载、Base 页面事实读取、renderer 的**意外异常**都收敛为结构化错误码
 *   （MATERIALIZE_BASE_INVALID / MATERIALIZE_FAILED），不会把异常文本当作结果返回；
 * - 清理用 `removeAttempt`（内部 `removeTreeSafely`），不会跟随 symlink/junction。
 *
 * 该模块不做网络、不起进程、不接受任意命令；所有路径都来自固定布局的工作区。
 */

const fs = require('node:fs');
const path = require('node:path');

const { treeSha256 } = require('../../scripts/composer/digest.cjs');
const { validateFacts, DRAFT_ERROR_CODES } = require('./schema.cjs');
const { renderFrontendPack } = require('./render.cjs');
const {
  createWorkspace,
  beginAttempt,
  removeAttempt,
  removeStaging,
  resolveInside,
  writeJsonAtomic,
  recordAttempt,
  auditPath,
  assertCanonicalDir,
  ensureDirectory,
  isInsideOrEqual,
  realpathOf,
  ATTEMPT_FILE,
} = require('./workspace.cjs');
const {
  loadTrustedRegistry,
  buildOverlayProjection,
  writeOverlayFiles,
  verifyOverlay,
  overlayAssetRoots,
} = require('./registry-overlay.cjs');

const ATTEMPT_SCHEMA_VERSION = 'frontend-attempt.v1';

/**
 * P1 打包分发的只读能力快照（单一事实源）：
 * - 开发态：`<repo>/server/src/agent/frontend-reconstruct/*.json`
 * - 打包态：`app.asar/server/src/agent/frontend-reconstruct/*.json`（同一相对路径）
 *
 * 页面级 dataPaths 一律以该快照为准（P1 的规范命名空间，例如 `home.mode`、
 * `menu.products`、`cart.totalCents`）；**绝不**从原始 WXML token 自建一套。
 */
const SNAPSHOT_DIR_RELATIVE = path.join('server', 'src', 'agent', 'frontend-reconstruct');
const SNAPSHOT_FACTS_FILE = 'capabilities.snapshot.json';
const SNAPSHOT_PAGE_FACTS_FILE = 'page-capabilities.snapshot.json';
const PAGE_FACTS_VERSION = 'frontend-page-facts.v1';
const DATA_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,7}$/;
const FACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_FACT_ENTRIES = 128;

const CODES = Object.freeze({
  INPUT_INVALID: 'MATERIALIZE_INPUT_INVALID',
  BASE_INVALID: 'MATERIALIZE_BASE_INVALID',
  FACTS_INVALID: 'MATERIALIZE_FACTS_INVALID',
  DRAFT_INVALID: 'MATERIALIZE_DRAFT_INVALID',
  RENDER_FAILED: 'MATERIALIZE_RENDER_FAILED',
  VERIFY_FAILED: 'MATERIALIZE_VERIFY_FAILED',
  FAILED: 'MATERIALIZE_FAILED',
});

const STAGES = Object.freeze(['validate', 'render', 'workspace', 'write', 'verify', 'commit']);

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function fail(code, target, message) {
  return { ok: false, code, path: target || '.', message };
}

function boundedDetail(error) {
  const raw = error && (error.code || error.message) ? String(error.code || error.message) : 'UNKNOWN';
  return raw.slice(0, 160);
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/** 快照目录：显式 `snapshotDir`（测试/打包注入）或仓库内固定相对路径。 */
function snapshotDirOf(options) {
  const raw = options && options.snapshotDir;
  if (raw === undefined) return path.resolve(__dirname, '..', '..', SNAPSHOT_DIR_RELATIVE);
  if (typeof raw !== 'string' || raw.trim() === '' || !path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

function readSnapshotFile(dir, name) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) };
  } catch (error) {
    return { ok: false, error: boundedDetail(error) };
  }
}

function readFactIdArray(value, pattern, label) {
  if (!Array.isArray(value)) return fail(CODES.FACTS_INVALID, label, '必须是数组');
  if (value.length > MAX_FACT_ENTRIES) return fail(CODES.FACTS_INVALID, label, '条目超过上限');
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || !pattern.test(item)) {
      return fail(CODES.FACTS_INVALID, label + '[' + index + ']', '事实条目格式非法');
    }
    if (out.includes(item)) return fail(CODES.FACTS_INVALID, label + '[' + index + ']', '事实条目重复');
    out.push(item);
  }
  return ok({ values: out });
}

/** 校验页面级事实映射（与 server page-facts.ts 同口径；任何未知键都拒绝）。 */
function validatePageFactsMap(rawPages, facts, sourceLabel) {
  if (!rawPages || typeof rawPages !== 'object' || Array.isArray(rawPages)) {
    return fail(CODES.FACTS_INVALID, sourceLabel + '.pages', '页面级事实必须是对象');
  }
  const pageFacts = {};
  for (const pageId of Object.keys(rawPages)) {
    const label = 'pages.' + pageId;
    if (!FACT_ID_PATTERN.test(pageId)) return fail(CODES.FACTS_INVALID, label, '页面 id 非法');
    const entry = rawPages[pageId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(CODES.FACTS_INVALID, label, '页面事实必须是对象');
    }
    for (const key of Object.keys(entry)) {
      if (!['components', 'slots', 'dataPaths'].includes(key)) {
        return fail(CODES.FACTS_INVALID, label + '.' + key, '页面事实不允许字段：' + key);
      }
    }
    const components = readFactIdArray(entry.components, FACT_ID_PATTERN, label + '.components');
    if (!components.ok) return components;
    const slots = readFactIdArray(entry.slots, FACT_ID_PATTERN, label + '.slots');
    if (!slots.ok) return slots;
    const dataPaths = readFactIdArray(entry.dataPaths, DATA_PATH_PATTERN, label + '.dataPaths');
    if (!dataPaths.ok) return dataPaths;
    for (const dataPath of dataPaths.values) {
      if (!facts.dataPaths.includes(dataPath)) {
        return fail(CODES.FACTS_INVALID, label + '.dataPaths', '页面数据路径不在全局事实中：' + dataPath);
      }
    }
    pageFacts[pageId] = {
      components: components.values,
      slots: slots.values,
      dataPaths: dataPaths.values,
    };
  }
  return ok({ pageFacts });
}

/**
 * 加载 P1 打包事实（单一事实源）：
 * - 全局事实 = `capabilities.snapshot.json`（可选内嵌 `pages`/`pageFacts`）；
 * - 页面事实 = 内嵌页面字段，否则 `page-capabilities.snapshot.json`；
 * - 文件缺失/形状非法/缺页 → MATERIALIZE_FACTS_INVALID（**不**退回原始 WXML token）。
 */
function loadPackagedFacts(options) {
  const dir = snapshotDirOf(options);
  if (!dir) return fail(CODES.INPUT_INVALID, 'snapshotDir', 'snapshotDir 必须是绝对路径');
  const factsRead = readSnapshotFile(dir, SNAPSHOT_FACTS_FILE);
  if (!factsRead.ok) {
    return fail(CODES.FACTS_INVALID, SNAPSHOT_FACTS_FILE, '缺少或无法解析能力快照（不退回原始 WXML）：' + factsRead.error);
  }
  const rawFacts = factsRead.value;
  if (!rawFacts || typeof rawFacts !== 'object' || Array.isArray(rawFacts)) {
    return fail(CODES.FACTS_INVALID, SNAPSHOT_FACTS_FILE, '能力快照必须是对象');
  }
  const embeddedPages = rawFacts.pageFacts !== undefined
    ? rawFacts.pageFacts
    : (rawFacts.pages !== undefined ? rawFacts.pages : undefined);
  // P1 快照在 FrontendFacts 之外还携带页面事实/关键动作等字段：剥离后再做严格事实校验；
  // 这里只白名单剥离已知快照字段，其余未知键仍会被 validateFacts 拒绝。
  const factsRaw = { ...rawFacts };
  for (const extra of ['pages', 'pageFacts', 'keyActions']) delete factsRaw[extra];

  const factsCheck = validateFacts(factsRaw);
  if (!factsCheck.ok) {
    return {
      ok: false,
      code: CODES.FACTS_INVALID,
      path: factsCheck.path,
      message: '能力快照事实非法：' + factsCheck.message,
      details: { factsCode: factsCheck.code },
    };
  }
  const facts = factsCheck.facts;

  let rawPages = embeddedPages;
  let pagesSource = SNAPSHOT_FACTS_FILE + '#pages';
  if (rawPages === undefined) {
    const pageRead = readSnapshotFile(dir, SNAPSHOT_PAGE_FACTS_FILE);
    if (!pageRead.ok) {
      return fail(CODES.FACTS_INVALID, SNAPSHOT_PAGE_FACTS_FILE, '缺少或无法解析页面级事实快照（不退回原始 WXML）：' + pageRead.error);
    }
    if (!pageRead.value || pageRead.value.version !== PAGE_FACTS_VERSION) {
      return fail(CODES.FACTS_INVALID, SNAPSHOT_PAGE_FACTS_FILE + '.version', '页面级事实快照版本不受支持');
    }
    rawPages = pageRead.value.pages;
    pagesSource = SNAPSHOT_PAGE_FACTS_FILE;
  }
  const pagesCheck = validatePageFactsMap(rawPages, facts, pagesSource);
  if (!pagesCheck.ok) return pagesCheck;
  return ok({
    facts,
    pageFacts: pagesCheck.pageFacts,
    source: SNAPSHOT_FACTS_FILE,
    pagesSource,
    snapshotDir: dir,
  });
}

/**
 * 从**可信** Base 校验并装配页面级事实：
 * - 页面事实本身只来自 P1 快照（单一事实源），不存在“原始 WXML 推导”回退；
 * - 快照仍必须与可信 Base 同源：组件 ⊆ 页面 usingComponents、插槽 == Base Manifest 插槽；
 * - 缺页/缺快照 → MATERIALIZE_FACTS_INVALID；Base 结构损坏 → MATERIALIZE_BASE_INVALID。
 */
function loadPageFacts(loaded, options) {
  const opts = options || {};
  const baseId = opts.baseId || 'ordering-base';
  const baseVersion = opts.baseVersion || '1.0.0';
  const pageIds = opts.pageIds || [];
  try {
    if (!loaded || !Array.isArray(loaded.assets)) {
      return fail(CODES.BASE_INVALID, 'loaded', '可信注册表未加载');
    }
    const base = loaded.assets.find(
      (asset) => asset.kind === 'base' && asset.id === baseId && asset.version === baseVersion,
    );
    if (!base) {
      return fail(CODES.BASE_INVALID, 'baseTemplate', '可信注册表缺少 Base：' + baseId + '@' + baseVersion);
    }
    const manifest = base.manifest;
    if (!manifest || typeof manifest !== 'object'
      || !manifest.identity || typeof manifest.identity.version !== 'string'
      || !manifest.entry || typeof manifest.entry.root !== 'string'
      || !Array.isArray(manifest.slots)) {
      return fail(CODES.BASE_INVALID, 'baseTemplate', 'Base Manifest 结构损坏（identity/entry.root/slots）');
    }
    for (const slot of manifest.slots) {
      if (!slot || typeof slot.pageId !== 'string' || typeof slot.slotId !== 'string') {
        return fail(CODES.BASE_INVALID, 'baseTemplate.slots', 'Base Manifest 插槽声明损坏');
      }
    }

    let packaged = opts.packagedFacts;
    if (!packaged) {
      const loadedPackaged = loadPackagedFacts({ snapshotDir: opts.snapshotDir });
      if (!loadedPackaged.ok) return loadedPackaged;
      packaged = loadedPackaged;
    }
    if (!packaged.facts || !packaged.pageFacts) {
      return fail(CODES.FACTS_INVALID, 'packagedFacts', '缺少打包事实（facts/pageFacts）');
    }
    const baseRoot = path.join(base.dir, manifest.entry.root);
    const pageFacts = {};
    for (const pageId of pageIds) {
      if (!packaged.facts.pageIds.includes(pageId)) {
        return fail(CODES.FACTS_INVALID, 'pages.' + pageId, '全局事实缺少页面：' + pageId);
      }
      const entry = packaged.pageFacts[pageId];
      if (!entry) {
        return fail(CODES.FACTS_INVALID, 'pages.' + pageId, '页面级事实快照缺少页面：' + pageId);
      }
      let pageJson;
      try {
        pageJson = JSON.parse(fs.readFileSync(path.join(baseRoot, 'pages', pageId, 'index.json'), 'utf8'));
      } catch (error) {
        return fail(CODES.BASE_INVALID, 'pages/' + pageId + '/index.json', '无法读取 Base 页面配置：' + boundedDetail(error));
      }
      const using = pageJson && typeof pageJson.usingComponents === 'object' && pageJson.usingComponents
        ? pageJson.usingComponents
        : {};
      const baseComponents = Object.keys(using).sort();
      for (const componentId of entry.components) {
        if (!baseComponents.includes(componentId)) {
          return fail(CODES.FACTS_INVALID, 'pages.' + pageId + '.components', '页面事实含 Base 未声明的组件：' + componentId);
        }
      }
      const baseSlots = manifest.slots
        .filter((slot) => slot.pageId === pageId)
        .map((slot) => slot.slotId)
        .sort();
      if (entry.slots.length !== baseSlots.length || entry.slots.some((slot, index) => slot !== baseSlots[index])) {
        return fail(CODES.FACTS_INVALID, 'pages.' + pageId + '.slots', '页面事实插槽与 Base Manifest 不同源');
      }
      pageFacts[pageId] = {
        components: [...entry.components],
        slots: [...entry.slots],
        dataPaths: [...entry.dataPaths],
      };
    }
    return ok({
      pageFacts,
      base: { version: manifest.identity.version, minWechatLib: '3.0.0' },
      sources: { facts: packaged.source, pages: packaged.pagesSource },
    });
  } catch (error) {
    return fail(CODES.BASE_INVALID, 'baseTemplate', '读取可信 Base 页面事实失败：' + boundedDetail(error));
  }
}

/**
 * 写候选文件 Map：根必须是规范目录（lstat + realpath），每级父目录逐段创建 + audit，
 * 且整棵树必须位于本次 attemptDir 内（`expectedPrivateRoot`）。
 */
function writeFileMap(root, files, options) {
  const opts = options || {};
  const canonical = assertCanonicalDir(root);
  if (!canonical.ok) return canonical;
  const rootReal = canonical.realDir;
  if (opts.expectedPrivateRoot !== undefined) {
    if (typeof opts.expectedPrivateRoot !== 'string' || !path.isAbsolute(opts.expectedPrivateRoot)) {
      return fail(CODES.FAILED, 'expectedPrivateRoot', 'expectedPrivateRoot 必须是绝对路径');
    }
    let expectedReal;
    try {
      expectedReal = realpathOf(opts.expectedPrivateRoot);
    } catch (error) {
      return fail(CODES.FAILED, 'expectedPrivateRoot', '无法解析私有 attempt 目录：' + boundedDetail(error));
    }
    if (!isInsideOrEqual(opts.expectedPrivateRoot, root) || !isInsideOrEqual(expectedReal, rootReal)) {
      return fail(CODES.FAILED, root, '候选目录必须位于本次私有 attempt 目录内');
    }
    const audit = auditPath(opts.expectedPrivateRoot, expectedReal, root);
    if (!audit.ok) return audit;
  }

  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const [relative, content] of entries) {
    const normalized = String(relative).replace(/\\/g, '/');
    if (normalized === 'templates' || normalized.startsWith('templates/')
      || normalized === 'miniprogram' || normalized.startsWith('miniprogram/')) {
      return fail(CODES.FAILED, relative, '候选文件不得写入全局模板/镜像路径');
    }
    const resolved = resolveInside(root, relative);
    if (!resolved.ok) return resolved;
    const parentEnsured = ensureDirectory(root, rootReal, path.dirname(resolved.target));
    if (!parentEnsured.ok) return parentEnsured;
    const rootCheck = assertCanonicalDir(root);
    if (!rootCheck.ok) return rootCheck;
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fs.writeFileSync(resolved.target, buffer, { flag: 'wx' });
  }
  return ok({ files: entries.map((entry) => String(entry[0])) });
}

function stageEmitter(onStage) {
  return (stage, detail) => {
    if (typeof onStage !== 'function') return;
    // 监听器抛错视为取消/失败：由 materialize 的 catch 统一清理本次 attempt。
    onStage(stage, detail);
  };
}

/**
 * 物化一个候选 attempt。
 *
 * @param {object} options
 * @param {string} options.userDataDir       应用私有数据目录（Electron app.getPath('userData')）
 * @param {string} options.projectId         项目 id（严格字符集）
 * @param {string} options.runId             运行 id（`frun-...`）
 * @param {unknown} options.draft            FrontendPackDraft
 * @param {unknown} [options.facts]          可选：显式注入能力事实；缺省用 P1 打包快照（单一事实源）
 * @param {string} [options.snapshotDir]     可选：快照目录（仅测试/打包注入；默认仓库相对路径）
 * @param {string} [options.trustedRegistryRoot] 可信注册表目录（默认全局 templates/registry）
 * @param {string[]} [options.trustedAssetRoots] 可信资产根（默认 [仓库根]）
 * @param {string} [options.baseId]          默认 ordering-base
 * @param {string} [options.baseVersion]     默认 1.0.0
 * @param {string} [options.candidateVersion] 默认 1.0.0
 * @param {{id:string, version:string, plan:object}} [options.candidateRecipe]
 * @param {string} [options.createdAt]       仅测试注入；默认当前时间
 * @param {(stage:string, detail?:object)=>void} [options.onStage]
 */
function materializeCandidate(options) {
  const opts = options || {};
  const emit = stageEmitter(opts.onStage);
  const createdAt = typeof opts.createdAt === 'string' ? opts.createdAt : new Date().toISOString();

  // 单一事实源：P1 打包快照。文件缺失/形状非法/缺页都明确失败，绝不退回原始 WXML token。
  let packaged;
  try {
    packaged = loadPackagedFacts({ snapshotDir: opts.snapshotDir });
  } catch (error) {
    return fail(CODES.FACTS_INVALID, SNAPSHOT_FACTS_FILE, '加载能力快照异常：' + boundedDetail(error));
  }
  if (!packaged.ok) return packaged;

  let facts = packaged.facts;
  if (opts.facts !== undefined) {
    const factsCheck = validateFacts(opts.facts);
    if (!factsCheck.ok) {
      return { ...factsCheck, code: factsCheck.code || CODES.DRAFT_INVALID };
    }
    facts = factsCheck.facts;
  }
  if (!Array.isArray(facts.pageIds) || facts.pageIds.length === 0) {
    return fail(CODES.DRAFT_INVALID, '$facts.pageIds', '能力事实必须声明至少一个页面');
  }

  emit('validate');
  let trusted;
  try {
    trusted = loadTrustedRegistry({
      registryRoot: opts.trustedRegistryRoot,
      assetRoots: opts.trustedAssetRoots,
    });
  } catch (error) {
    return fail(CODES.BASE_INVALID, 'trustedRegistry', '可信注册表加载异常：' + boundedDetail(error));
  }
  if (!trusted.ok) {
    return {
      ok: false,
      code: CODES.BASE_INVALID,
      path: 'trustedRegistry',
      message: '可信注册表不可用：' + (trusted.message || trusted.code),
      details: { trustedCode: trusted.code },
    };
  }
  const loaded = trusted.loaded;

  let pageFactsResult;
  try {
    pageFactsResult = loadPageFacts(loaded, {
      baseId: opts.baseId,
      baseVersion: opts.baseVersion,
      pageIds: facts.pageIds,
      packagedFacts: packaged,
    });
  } catch (error) {
    return fail(CODES.BASE_INVALID, 'baseTemplate', '读取 Base 页面事实异常：' + boundedDetail(error));
  }
  if (!pageFactsResult.ok) return pageFactsResult;

  emit('render');
  let rendered;
  try {
    rendered = renderFrontendPack(opts.draft, {
      facts,
      pageFacts: pageFactsResult.pageFacts,
      version: opts.candidateVersion === undefined ? '1.0.0' : opts.candidateVersion,
      base: pageFactsResult.base,
    });
  } catch (error) {
    return fail(CODES.FAILED, 'draft', '渲染异常：' + boundedDetail(error));
  }
  if (!rendered.ok) {
    return {
      ok: false,
      code: CODES.DRAFT_INVALID,
      path: rendered.path,
      message: rendered.message,
      details: { draftCode: rendered.code },
    };
  }

  emit('workspace');
  const workspace = createWorkspace({
    userDataDir: opts.userDataDir,
    projectId: opts.projectId,
    runId: opts.runId,
  });
  if (!workspace.ok) return workspace;

  const attemptResult = beginAttempt(workspace);
  if (!attemptResult.ok) return attemptResult;
  const { attempt, attemptDir, stagingDir, attemptsDir } = attemptResult;

  const cleanup = () => removeAttempt(attemptDir, attemptsDir);

  try {
    emit('write', { attempt });

    // staging 链逐段 audit + 规范化复核：防止创建与写入之间被替换成 junction。
    const attemptCanonical = assertCanonicalDir(attemptDir);
    if (!attemptCanonical.ok) {
      cleanup();
      return attemptCanonical;
    }
    const attemptReal = attemptCanonical.realDir;
    const stagingEnsured = ensureDirectory(attemptDir, attemptReal, stagingDir);
    if (!stagingEnsured.ok) {
      cleanup();
      return stagingEnsured;
    }
    const stagingCanonical = assertCanonicalDir(stagingDir);
    if (!stagingCanonical.ok) {
      cleanup();
      return stagingCanonical;
    }
    const stagingReal = stagingCanonical.realDir;

    const candidateStaging = path.join(stagingDir, 'candidate');
    const overlayStaging = path.join(stagingDir, 'overlay');
    const candidateEnsured = ensureDirectory(stagingDir, stagingReal, candidateStaging);
    if (!candidateEnsured.ok) {
      cleanup();
      return candidateEnsured;
    }
    const candidateCanonical = assertCanonicalDir(candidateStaging);
    if (!candidateCanonical.ok) {
      cleanup();
      return candidateCanonical;
    }
    const overlayEnsured = ensureDirectory(stagingDir, stagingReal, overlayStaging);
    if (!overlayEnsured.ok) {
      cleanup();
      return overlayEnsured;
    }
    const overlayCanonical = assertCanonicalDir(overlayStaging);
    if (!overlayCanonical.ok) {
      cleanup();
      return overlayCanonical;
    }

    const candidateWrite = writeFileMap(candidateStaging, rendered.files, { expectedPrivateRoot: attemptDir });
    if (!candidateWrite.ok) {
      cleanup();
      return candidateWrite;
    }

    const projection = buildOverlayProjection({
      loaded,
      candidate: { id: rendered.candidateId, version: rendered.version },
      candidateFiles: rendered.files,
      recipe: opts.candidateRecipe,
    });
    if (!projection.ok) {
      cleanup();
      return projection;
    }
    const overlayWrite = writeOverlayFiles(overlayStaging, projection.files, { expectedPrivateRoot: attemptDir });
    if (!overlayWrite.ok) {
      cleanup();
      return overlayWrite;
    }

    emit('verify', { attempt });
    const verified = verifyOverlay({ overlayRoot: overlayStaging });
    if (!verified.ok) {
      cleanup();
      return {
        ok: false,
        code: CODES.VERIFY_FAILED,
        path: verified.path,
        message: 'overlay 注册表校验失败：' + (verified.message || verified.code),
        details: { overlayCode: verified.code },
      };
    }
    const diskDigest = treeSha256(candidateStaging);
    if (diskDigest !== rendered.digest) {
      cleanup();
      return fail(CODES.VERIFY_FAILED, 'candidate', '候选目录树摘要与渲染摘要不一致');
    }
    const verifiedCandidate = verified.loaded.byKey.get(rendered.candidateId + '@' + rendered.version);
    if (!verifiedCandidate || verifiedCandidate.kind !== 'frontend-pack') {
      cleanup();
      return fail(CODES.VERIFY_FAILED, 'candidate', 'overlay 中未登记候选 FrontendPack');
    }
    if (verifiedCandidate.integrity !== rendered.digest) {
      cleanup();
      return fail(CODES.VERIFY_FAILED, 'candidate', 'overlay 候选 integrity 与渲染摘要不一致');
    }

    emit('commit', { attempt });
    // rename 之前再复核一次：staging 目录若在 verify 之后被换成链接，立即失败。
    for (const staging of [candidateStaging, overlayStaging]) {
      const finalCheck = assertCanonicalDir(staging);
      if (!finalCheck.ok) {
        cleanup();
        return finalCheck;
      }
    }
    const candidateDir = path.join(attemptDir, 'candidate');
    const overlayDir = path.join(attemptDir, 'overlay');
    fs.renameSync(candidateStaging, candidateDir);
    fs.renameSync(overlayStaging, overlayDir);

    const attemptMeta = {
      schemaVersion: ATTEMPT_SCHEMA_VERSION,
      projectId: workspace.projectId,
      runId: workspace.runId,
      attempt,
      createdAt,
      status: 'committed',
      candidate: {
        id: rendered.candidateId,
        version: rendered.version,
        integrity: rendered.digest,
        draftDigest: rendered.draftDigest,
        pages: rendered.pages.map((page) => page.pageId),
        requiresSlots: rendered.requiresSlots,
      },
      overlay: {
        path: 'overlay',
        registryDigest: projection.registryDigest,
        candidatePath: projection.candidate.path,
      },
      files: [...rendered.files.keys()].sort(),
      degradations: rendered.degradations,
    };
    const metaWrite = writeJsonAtomic(path.join(attemptDir, ATTEMPT_FILE), attemptMeta);
    if (!metaWrite.ok) {
      cleanup();
      return metaWrite;
    }
    removeStaging(stagingDir, attemptDir);

    const recorded = recordAttempt(workspace, {
      attempt,
      createdAt,
      candidateId: rendered.candidateId,
      candidateVersion: rendered.version,
      integrity: rendered.digest,
    });
    if (!recorded.ok) {
      // attempt 已提交、只是索引更新失败：不删除已提交产物，如实返回告警。
      return ok({
        attempt,
        attemptDir,
        candidateDir,
        overlayDir,
        overlayRegistryRoot: overlayDir,
        assetRoots: overlayAssetRoots(overlayDir),
        candidate: attemptMeta.candidate,
        overlay: attemptMeta.overlay,
        files: attemptMeta.files,
        degradations: rendered.degradations,
        registryDigest: projection.registryDigest,
        factsSource: pageFactsResult.sources,
        warning: { code: recorded.code, message: recorded.message },
      });
    }

    return ok({
      attempt,
      attemptDir,
      candidateDir,
      overlayDir,
      overlayRegistryRoot: overlayDir,
      assetRoots: overlayAssetRoots(overlayDir),
      candidate: attemptMeta.candidate,
      overlay: attemptMeta.overlay,
      files: attemptMeta.files,
      degradations: rendered.degradations,
      registryDigest: projection.registryDigest,
      factsSource: pageFactsResult.sources,
      attemptMeta,
    });
  } catch (error) {
    cleanup();
    return fail(CODES.FAILED, 'attempt', '物化失败：' + boundedDetail(error));
  }
}

module.exports = {
  ATTEMPT_SCHEMA_VERSION,
  CODES,
  STAGES,
  DRAFT_ERROR_CODES,
  PAGE_FACTS_VERSION,
  SNAPSHOT_FACTS_FILE,
  SNAPSHOT_PAGE_FACTS_FILE,
  loadPackagedFacts,
  loadPageFacts,
  materializeCandidate,
};
