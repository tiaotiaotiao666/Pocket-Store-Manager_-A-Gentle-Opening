'use strict';

/**
 * P3-1：候选 dry-run（Composer P0–P6 + mini:check + 一致性 + 可观察项）。
 *
 * 证明：
 * 1. 统一结果结构 `{ok, code, summary, details, candidateId, revision, artifacts}`，
 *    失败 issue 能定位到 DSL path / 输出文件 / 字段；
 * 2. 真正复用 Composer 产物（composition.lock.json / generation-report.json / Lock 摘要），
 *    不是本地复制一套校验；
 * 3. 未知事件、非法样式、缺锚点都能结构化定位；取消如实 NOT_RUN；
 * 4. 全程只写私有 attempt 目录，不写全局 templates/registry、frontend-packs，证据无绝对路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
  dryRun,
  CODES,
  issuesFromMiniCheck,
  issuesFromComposer,
  resolveCandidatePlan,
} = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'dry-run.cjs'));
const { materializeCandidate, loadPackagedFacts } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const { compareObservable } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'compare.cjs'));
const { issuesFromObservable } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'dry-run.cjs'));
const { treeSha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const PACKAGED = loadPackagedFacts();
if (!PACKAGED.ok) throw new Error('无法加载 P1 能力快照：' + JSON.stringify(PACKAGED));

function buildDraft(overrides) {
  const draft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          {
            type: 'component',
            componentId: 'store-header',
            props: { storeName: { kind: 'data', dataPath: 'store.name' } },
            events: {},
          },
          { type: 'slot', slotId: 'home-hero' },
          { type: 'text', textToken: 'store.address', style: { size: 'md', colorToken: 'textColor' } },
          { type: 'button', label: '开始点餐', action: 'home.goMenu' },
        ],
        styles: [],
        pageJson: { navigationBarTitleText: '扫码点餐' },
      },
    ],
  };
  if (typeof overrides === 'function') overrides(draft);
  return draft;
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-dry-' + prefix + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return dir;
}

function materialize(base, draft) {
  return materializeCandidate({
    userDataDir: base,
    projectId: 'proj-alpha',
    runId: 'frun-20261117-dry',
    draft: draft || buildDraft(),
    createdAt: '2026-11-17T00:00:00.000Z',
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 结果结构契约：每个 dry-run 返回都必须带上这些字段。 */
function assertUnifiedShape(result) {
  assert.strictEqual(typeof result.ok, 'boolean');
  assert.strictEqual(typeof result.code, 'string');
  assert.strictEqual(typeof result.summary, 'string');
  assert.strictEqual(typeof result.details, 'object');
  assert.ok(result.details !== null);
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'candidateId'));
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'revision'));
  assert.strictEqual(typeof result.artifacts, 'object');
  assert.ok(Array.isArray(result.issues));
  assert.ok(Array.isArray(result.checks));
}

test('dry-run 全绿：统一结构、Composer 产物、mini:check、一致性、可观察项', async (t) => {
  const base = tempDir(t, 'ok');
  const registryDir = path.join(REPO, 'templates', 'registry');
  const packsDir = path.join(REPO, 'templates', 'frontend-packs');
  const registryBefore = treeSha256(registryDir);
  const packsBefore = treeSha256(packsDir);

  const draft = buildDraft();
  const materialized = materialize(base, draft);
  assert.strictEqual(materialized.ok, true, JSON.stringify(materialized));

  const stages = [];
  const result = await dryRun({
    materialized,
    draft,
    revision: materialized.attempt,
    onStage: (stage) => stages.push(stage),
  });

  assertUnifiedShape(result);
  assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
  assert.strictEqual(result.code, CODES.OK);
  assert.strictEqual(result.candidateId, materialized.candidate.id);
  assert.strictEqual(result.revision, materialized.attempt);
  assert.deepStrictEqual(result.issues, []);
  assert.deepStrictEqual(stages, ['materialize', 'compose', 'mini-check', 'consistency', 'observable', 'done']);

  // 真的复用了 Composer：输出目录里有 Lock/报告，摘要与 Composer 自算一致。
  const outputDir = result.artifacts.outputDir;
  assert.ok(fs.existsSync(outputDir));
  assert.ok(fs.existsSync(path.join(outputDir, 'composition.lock.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'generation-report.json')));
  const lock = readJson(path.join(outputDir, 'composition.lock.json'));
  assert.strictEqual(result.details.compose.treeSha256, lock.outputDigest.tree);
  assert.strictEqual(result.details.compose.fileCount, lock.outputDigest.files.length);
  assert.match(result.artifacts.treeSha256, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(result.artifacts.outputRelativePath, 'verification/dry-run/candidate');

  const checkById = new Map(result.checks.map((item) => [item.id, item]));
  assert.strictEqual(checkById.get('mini-check').status, 'pass');
  assert.strictEqual(checkById.get('consistency').status, 'pass');
  assert.strictEqual(checkById.get('observable').status, 'pass');
  assert.strictEqual(checkById.get('sections:home').status, 'pass');
  // 密度/溢出：不做像素测量，如实标未检查/不适用。
  assert.strictEqual(checkById.get('overflow').status, 'not_checked');
  assert.strictEqual(checkById.get('density').status, 'not_applicable');
  assert.ok(!JSON.stringify(result).includes('%'));

  // 证据文件存在且不含私有绝对路径。
  const evidence = fs.readFileSync(result.artifacts.evidenceFile, 'utf8');
  assert.ok(evidence.includes('frontend-dry-run.v1'));
  assert.ok(!evidence.includes(base), '证据不得包含私有根绝对路径');
  assert.ok(!/[A-Za-z]:[\\/]/.test(evidence), '证据不得包含 Windows 绝对路径');

  // 全局资产零变化。
  assert.strictEqual(treeSha256(registryDir), registryBefore);
  assert.strictEqual(treeSha256(packsDir), packsBefore);
});

test('未知事件：materialize 阶段定位到 DSL path 与 field', async (t) => {
  const base = tempDir(t, 'event');
  const draft = buildDraft((d) => {
    d.pages[0].nodes[0].events = { tap: 'home.goNope' };
  });
  const result = await dryRun({
    draft,
    userDataDir: base,
    projectId: 'proj-alpha',
    runId: 'frun-20261117-event',
  });

  assertUnifiedShape(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'DRAFT_UNKNOWN_EVENT');
  const issue = result.issues.find((item) => item.code === 'DRAFT_UNKNOWN_EVENT');
  assert.ok(issue, JSON.stringify(result.issues));
  assert.strictEqual(issue.path, '$.pages[0].nodes[0].events.tap');
  assert.strictEqual(issue.field, 'tap');
  assert.strictEqual(issue.file, null);
  assert.strictEqual(result.details.stage, 'materialize');
  assert.ok(!fs.existsSync(path.join(base, 'projects')), '失败不得创建候选工作区');
  assert.ok(!JSON.stringify(result.issues).includes(base));
});

test('非法样式：定位到 style 字段', async (t) => {
  const base = tempDir(t, 'style');
  const draft = buildDraft((d) => {
    d.pages[0].nodes[2].style = { size: 'huge' };
  });
  const result = await dryRun({
    draft,
    userDataDir: base,
    projectId: 'proj-alpha',
    runId: 'frun-20261117-style',
  });

  assert.strictEqual(result.ok, false);
  const issue = result.issues.find((item) => item.code === 'DRAFT_STYLE_INVALID');
  assert.ok(issue, JSON.stringify(result.issues));
  assert.strictEqual(issue.path, '$.pages[0].nodes[2].style.size');
  assert.strictEqual(issue.field, 'size');
  assert.ok(!fs.existsSync(path.join(base, 'projects')));
});

test('缺锚点：可观察对照定位到 slotId，并映射为 SLOT_ANCHOR_MISSING', async (t) => {
  const base = tempDir(t, 'anchor');
  const draft = buildDraft();
  const materialized = materialize(base, draft);
  assert.strictEqual(materialized.ok, true, JSON.stringify(materialized));

  const result = await dryRun({ materialized, draft });
  assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
  const outputDir = result.artifacts.outputDir;

  // 去掉 fallback 结束锚点（模拟 renderer/产物回归）。
  const wxmlFile = path.join(outputDir, 'pages', 'home', 'index.wxml');
  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  fs.writeFileSync(wxmlFile, wxml.replace(/<!-- @slot-fallback:home-hero:end -->\n?/g, ''), 'utf8');

  const observable = compareObservable({ draft, outputDir });
  assert.strictEqual(observable.ok, false);
  const anchor = observable.issues.find((item) => item.code === 'SLOT_ANCHOR_MISSING');
  assert.ok(anchor, JSON.stringify(observable.issues));
  assert.strictEqual(anchor.path, '$.pages[0].nodes[1].slotId');
  assert.strictEqual(anchor.file, 'pages/home/index.wxml');

  // dry-run 的映射层把它变成契约允许的 repair code（不是任意日志）。
  const mapped = issuesFromObservable(observable);
  assert.deepStrictEqual(mapped.map((item) => item.code), ['SLOT_ANCHOR_MISSING']);
  assert.strictEqual(mapped[0].path, '$.pages[0].nodes[1].slotId');
});

test('Composer / mini:check / 一致性失败映射：稳定 code + 文件/页定位', () => {
  const plan = readJson(path.join(REPO, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json'));

  // mini:check 错误字符串 → 文件 + DSL 页路径。
  const mini = issuesFromMiniCheck(['pages/home/index.wxml: 第 3 行标签不匹配'], plan);
  assert.strictEqual(mini.length, 1);
  assert.strictEqual(mini[0].code, 'MINI_CHECK_FAILED');
  assert.strictEqual(mini[0].file, 'pages/home/index.wxml');
  assert.strictEqual(mini[0].path, '$.pages[0]');
  assert.match(mini[0].message, /标签不匹配/);

  // Composer 计划级失败：不具备 DSL 修复能力 → DRY_RUN_FAILED + path:null（不会被 repair 采纳）。
  const composer = issuesFromComposer(
    { ok: false, code: 'FRONTEND_PACK_MISSING', path: 'frontendPack', message: '候选包未登记' },
    plan,
  );
  assert.strictEqual(composer.length, 1);
  assert.strictEqual(composer[0].code, 'DRY_RUN_FAILED');
  assert.strictEqual(composer[0].path, null);
  assert.strictEqual(composer[0].file, 'frontendPack');
  assert.match(composer[0].message, /FRONTEND_PACK_MISSING/);

  // Composer 内部静态校验失败：逐条展开成 MINI_CHECK_FAILED。
  const staticFailed = issuesFromComposer({
    ok: false,
    code: 'OUTPUT_STATIC_CHECK_FAILED',
    path: '$',
    message: '静态校验失败',
    details: { errors: ['pages/menu/index.wxml: 缺少处理函数 onNope'] },
  }, plan);
  assert.strictEqual(staticFailed.length, 1);
  assert.strictEqual(staticFailed[0].code, 'MINI_CHECK_FAILED');
  assert.strictEqual(staticFailed[0].file, 'pages/menu/index.wxml');
  assert.strictEqual(staticFailed[0].path, '$.pages[1]');

  // 产物级校验失败 → CONSISTENCY_FAILED。
  const consistency = issuesFromComposer(
    { ok: false, code: 'OUTPUT_TREE_MISMATCH', path: 'composition.lock.json', message: '摘要不一致' },
    plan,
  );
  assert.strictEqual(consistency[0].code, 'CONSISTENCY_FAILED');
  assert.strictEqual(consistency[0].file, 'composition.lock.json');
});

test('候选 Plan 默认覆盖 frontendPack，且不修改调用方对象', () => {
  const source = readJson(path.join(REPO, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json'));
  const snapshot = JSON.stringify(source);
  const result = resolveCandidatePlan(source, undefined, { id: 'fr-abc123456789', version: '1.0.0' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.overridden, true);
  assert.deepStrictEqual(result.previousFrontendPack, { id: 'warm-home-menu', version: '1.0.0' });
  assert.deepStrictEqual(result.plan.frontendPack, { id: 'fr-abc123456789', version: '1.0.0' });
  assert.strictEqual(JSON.stringify(source), snapshot, '不得修改调用方 Plan');
  assert.strictEqual(result.source, 'provided');
});

test('物化结果缺 overlay 来源：拒绝 dry-run（禁止回落到全局 Registry）', async (t) => {
  const base = tempDir(t, 'nofallback');
  const draft = buildDraft();
  const materialized = materialize(base, draft);
  assert.strictEqual(materialized.ok, true, JSON.stringify(materialized));

  const noOverlay = { ...materialized };
  delete noOverlay.overlayRegistryRoot;
  const missing = await dryRun({ materialized: noOverlay, draft });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, CODES.INPUT_INVALID);
  assert.match(missing.summary, /overlayRegistryRoot/);

  const globalOverlay = {
    ...materialized,
    overlayRegistryRoot: path.join(REPO, 'templates', 'registry'),
  };
  const wrong = await dryRun({ materialized: globalOverlay, draft });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.code, CODES.INPUT_INVALID);
  assert.match(wrong.summary, /overlayDir/);
});

test('关键动作可点：只读微信报告（PASS/FAIL/未跑三态），不伪造', async (t) => {
  const base = tempDir(t, 'runtime');
  const draft = buildDraft();
  const materialized = materialize(base, draft);
  const dry = await dryRun({ materialized, draft });
  assert.strictEqual(dry.ok, true, JSON.stringify(dry.issues));
  const outputDir = dry.artifacts.outputDir;

  // 1) 没跑运行时：not_run，不给通过。
  const notRun = compareObservable({ draft, outputDir });
  const runtimeCheck = notRun.checks.find((item) => item.id === 'runtime-action:home.goMenu');
  assert.strictEqual(runtimeCheck.status, 'not_run');
  assert.strictEqual(notRun.ok, true, '未执行运行时不等于失败，但绝不会显示为通过');

  // 2) 报告里该链路 FAIL：定位到按钮 action，并映射为契约 code。
  const failed = compareObservable({
    draft,
    outputDir,
    runtimeReport: {
      interactions: [{ label: '真实点击·首页选桌 →「开始点餐」进入菜单', status: 'FAIL', detail: '首页未渲染 .home__cta' }],
    },
  });
  assert.strictEqual(failed.ok, false);
  const failure = failed.issues.find((item) => item.code === 'OBS_ACTION_NOT_CLICKABLE');
  assert.ok(failure, JSON.stringify(failed.issues));
  assert.strictEqual(failure.path, '$.pages[0].nodes[3].action');
  const mapped = issuesFromObservable(failed);
  assert.ok(mapped.every((item) => item.code === 'CONSISTENCY_FAILED'));

  // 3) 报告里该链路 PASS：通过，且带证据摘要。
  const passed = compareObservable({
    draft,
    outputDir,
    runtimeReport: {
      interactions: [{ label: '真实点击·首页选桌 →「开始点餐」进入菜单', status: 'PASS', detail: '进入 pages/menu/index' }],
    },
  });
  const passedCheck = passed.checks.find((item) => item.id === 'runtime-action:home.goMenu');
  assert.strictEqual(passedCheck.status, 'pass');
  assert.match(passedCheck.message, /真实点击链路通过/);

  // 4) 报告存在但被工具阻塞：not_checked，不给通过也不判失败。
  const blocked = compareObservable({
    draft,
    outputDir,
    runtimeReport: {
      interactions: [{ label: '真实点击·首页选桌 →「开始点餐」进入菜单', status: 'BLOCKED', detail: 'SERVICE_PORT_DISABLED' }],
    },
  });
  const blockedCheck = blocked.checks.find((item) => item.id === 'runtime-action:home.goMenu');
  assert.strictEqual(blockedCheck.status, 'not_checked');
  assert.strictEqual(blocked.ok, true);

  // 5) requirement 携带 density：如实标 not_checked 且文案不含像素承诺。
  const withDensity = compareObservable({
    draft,
    outputDir,
    requirement: { visual: { density: 'compact' } },
  });
  const densityCheck = withDensity.checks.find((item) => item.id === 'density');
  assert.strictEqual(densityCheck.status, 'not_checked');
  assert.match(densityCheck.message, /不做像素测量/);
});

test('取消：开始前取消返回 DRY_RUN_CANCELLED 且不写任何目录', async (t) => {
  const base = tempDir(t, 'cancel');
  const result = await dryRun({
    draft: buildDraft(),
    userDataDir: base,
    projectId: 'proj-alpha',
    runId: 'frun-20261117-cancel',
    signal: { cancelled: true },
  });
  assertUnifiedShape(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, CODES.CANCELLED);
  assert.deepStrictEqual(fs.readdirSync(base), []);
});

test('dry-run 产物落在私有 attempt 内，重复执行互不覆盖', async (t) => {
  const base = tempDir(t, 'repeat');
  const draft = buildDraft();
  const materialized = materialize(base, draft);
  assert.strictEqual(materialized.ok, true, JSON.stringify(materialized));

  const first = await dryRun({ materialized, draft });
  const second = await dryRun({ materialized, draft });
  assert.strictEqual(first.ok, true, JSON.stringify(first.issues));
  assert.strictEqual(second.ok, true, JSON.stringify(second.issues));
  assert.strictEqual(first.artifacts.outputRelativePath, 'verification/dry-run/candidate');
  assert.strictEqual(second.artifacts.outputRelativePath, 'verification/dry-run-2/candidate');
  assert.ok(first.artifacts.outputDir.startsWith(materialized.attemptDir + path.sep));
  assert.ok(fs.existsSync(first.artifacts.outputDir));
  assert.ok(fs.existsSync(second.artifacts.outputDir));
  assert.strictEqual(treeSha256(materialized.candidateDir), materialized.candidate.integrity);
});
