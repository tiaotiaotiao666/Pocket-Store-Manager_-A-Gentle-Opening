import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const { materializeCandidate } = require(path.join(ROOT, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const { dryRun } = require(path.join(ROOT, 'desktop', 'frontend-reconstruct', 'dry-run.cjs'));
const report = { schemaVersion: 'sidebar-candidate-probe.v1', checks: [] };
const pass = (name, evidence = {}) => {
  report.checks.push({ name, status: 'PASS', ...evidence });
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
};

const draft = {
  schemaVersion: 'frontend-pack-draft.v1',
  displayName: 'T9 当前 Plan 候选',
  pages: [{
    pageId: 'home',
    nodes: [
      { type: 'component', componentId: 'store-header', props: { storeName: { kind: 'data', dataPath: 'store.name' } }, events: {} },
      { type: 'slot', slotId: 'home-hero' },
      { type: 'text', textToken: 'store.address', style: { size: 'md', colorToken: 'textColor' } },
      { type: 'button', label: '开始点餐', action: 'home.goMenu' },
    ],
    styles: [],
    pageJson: { navigationBarTitleText: '扫码点餐' },
  }],
};

try {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-t9-candidate-'));
  const projectId = 'p_t9r2probe';
  const runId = `frun-t9-r2-${Date.now()}`;
  const materialized = materializeCandidate({ userDataDir, projectId, runId, draft });
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  const { buildPlanFromSession } = await import(pathToFileURL(path.join(ROOT, 'src', 'composition', 'planFromSession.mjs')).href);
  const builtPlan = buildPlanFromSession({
    store: { name: 'T9 私有预览店', type: '社区餐馆', address: '验证路 9 号', phone: '13800000000' },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'store-gallery'] },
    visual: { styleId: 'warm' },
    agentDraft: {
      storeName: 'T9 私有预览店',
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [
        { name: '验证菜一', priceCents: 1001, description: '一' },
        { name: '验证菜二', priceCents: 1002, description: '二' },
        { name: '验证菜三', priceCents: 1003, description: '三' },
      ],
    },
    build: { selectedId: 'signature-kitchen' },
  });
  const plan = builtPlan.plan;
  const storeId = 'store-preview-candidate-probe';
  const backendVersions = { storeConfigVersion: 2, catalogVersion: 3 };
  const result = await dryRun({ materialized, draft, plan, storeId, backendVersions, revision: materialized.attempt });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.details.plan.source, 'provided');
  assert.equal(result.details.plan.planFile, null);
  assert.equal(result.details.plan.frontendPack.id, materialized.candidate.id);
  assert.equal(result.details.plan.frontendPack.version, materialized.candidate.version);
  assert.equal(result.artifacts.outputRelativePath, 'verification/dry-run/candidate');
  const outputDir = result.artifacts.outputDir;
  assert.ok(outputDir.startsWith(materialized.attemptDir));
  const generated = fs.readFileSync(path.join(outputDir, 'config', 'store.generated.js'), 'utf8');
  assert.ok(generated.includes(storeId), generated);
  assert.ok(/['"]storeConfigVersion['"]:\s*2/.test(generated), generated);
  assert.ok(/['"]catalogVersion['"]:\s*3/.test(generated), generated);
  const evidence = JSON.parse(fs.readFileSync(result.artifacts.evidenceFile, 'utf8'));
  assert.equal(evidence.details.plan.source, 'provided');
  assert.equal(evidence.details.plan.planDigest, result.details.plan.planDigest);
  pass('provided-plan-store-versions-same-attempt', {
    attempt: materialized.attempt,
    planSource: result.details.plan.source,
    planDigest: result.details.plan.planDigest,
    frontendPack: result.details.plan.frontendPack,
    outputRelativePath: result.artifacts.outputRelativePath,
    storeId,
    backendVersions,
  });

  const invalid = await dryRun({ materialized, draft, plan: null, storeId, backendVersions });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.details.stage, 'input');
  assert.ok(invalid.summary.includes('候选 Plan 不可用'));
  assert.equal(invalid.artifacts.outputDir, undefined);
  pass('explicit-invalid-plan-fail-closed', { code: invalid.code, summary: invalid.summary });

  const serviceModule = await import(pathToFileURL(path.join(ROOT, 'src', 'services', 'frontendReconstruct', 'frontendReconstructService.js')).href + `?t9=${Date.now()}`);
  const calls = [];
  const api = {
    isDesktop: true,
    buildCandidate: async (payload) => {
      calls.push(payload);
      return { ok: true, candidate: { candidateId: 'candidate', attempt: 1 } };
    },
  };
  const service = serviceModule.createFrontendReconstructService({ api });
  const base = { projectId, runId, draft };
  const invalidStore = await service.buildCandidate({ ...base, storeId: 'bad/store' });
  assert.equal(invalidStore.ok, false);
  assert.equal(invalidStore.code, 'FRONTEND_PAYLOAD_INVALID');
  const invalidVersions = await service.buildCandidate({ ...base, backendVersions: { storeConfigVersion: 1, catalogVersion: 1, extra: 0 } });
  assert.equal(invalidVersions.ok, false);
  assert.equal(invalidVersions.code, 'FRONTEND_PAYLOAD_INVALID');
  const oversized = await service.buildCandidate({ ...base, plan: { text: 'x'.repeat(256 * 1024 + 1) } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'FRONTEND_PAYLOAD_INVALID');
  assert.equal(calls.length, 0);
  const valid = await service.buildCandidate({ ...base, plan, storeId, backendVersions });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan, plan);
  assert.equal(calls[0].storeId, storeId);
  assert.equal(calls[0].backendVersions, backendVersions);
  pass('renderer-payload-validation-and-forwarding', {
    invalidStoreCode: invalidStore.code,
    invalidVersionsCode: invalidVersions.code,
    oversizedPlanCode: oversized.code,
    validForwarded: true,
  });
} catch (error) {
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  console.error(`CANDIDATE_PROBE_FAILURE ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(HERE, 'candidate-probe-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`CANDIDATE_PROBE_RESULT ${process.exitCode ? 'FAIL' : 'PASS'} checks=${report.checks.length}`);
}