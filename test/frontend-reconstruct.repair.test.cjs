'use strict';

/**
 * P3-2：本地最多两轮受控修复编排。
 *
 * 证明：
 * 1. 请求只含 `{contractVersion, runId, revision, round, issues[{path,code}], previousDraft}`；
 *    没有日志、绝对路径、源码、文件路径或任意命令；
 * 2. 修复 budget 严格 ≤2 轮，两轮仍失败时保留当前版本、候选不可采用；
 * 3. 不可定位到 DSL path 的本地故障不允许自动修复（不在模型能力内）；
 * 4. 服务端返回的 Draft 仍要过 P2 schema + 体积上限，非法响应直接失败；
 * 5. 白名单与 server 契约 `FRONTEND_REPAIR_ISSUE_CODES` 同源。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
  REPAIR_ISSUE_CODES,
  MAX_REPAIR_ROUNDS,
  MAX_ISSUES,
  MAX_PREVIOUS_DRAFT_BYTES,
  CODES,
  collectRepairIssues,
  boundedPreviousDraft,
  buildRepairRequest,
  runRepairLoop,
} = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'repair.cjs'));
const { loadPackagedFacts } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const { draftDigest } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'render.cjs'));
const { validateDraft } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'schema.cjs'));

const PACKAGED = loadPackagedFacts();
if (!PACKAGED.ok) throw new Error('无法加载 P1 能力快照：' + JSON.stringify(PACKAGED));
const FACTS = PACKAGED.facts;
const PAGE_FACTS = PACKAGED.pageFacts;

function buildDraft(overrides) {
  const draft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          { type: 'component', componentId: 'store-header', props: { storeName: { kind: 'data', dataPath: 'store.name' } }, events: {} },
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function failResult(code, issues) {
  return {
    ok: false,
    code,
    summary: 'dry-run 未通过',
    details: {},
    candidateId: 'fr-testcandidate1',
    revision: 1,
    artifacts: {},
    issues: issues || [{
      code: 'DRAFT_UNKNOWN_EVENT',
      path: '$.pages[0].nodes[0].events.tap',
      field: 'tap',
      file: null,
      message: '未在事实中的控制器动作',
      severity: 'error',
      source: 'materialize',
    }],
    checks: [],
  };
}

function okResult() {
  return {
    ok: true,
    code: 'DRY_RUN_OK',
    summary: 'dry-run 通过',
    details: {},
    candidateId: 'fr-testcandidate1',
    revision: 1,
    artifacts: {},
    issues: [],
    checks: [],
  };
}

function baseOptions(overrides) {
  return {
    draft: buildDraft(),
    facts: FACTS,
    pageFacts: PAGE_FACTS,
    runId: 'frun-20261117-repair',
    revision: 2,
    ...overrides,
  };
}

test('首次 dry-run 通过：不调用 repair，返回候选（未采用）', async () => {
  let repairCalls = 0;
  let dryRunCalls = 0;
  const draft = buildDraft();
  const result = await runRepairLoop(baseOptions({
    draft,
    dryRun: async () => { dryRunCalls += 1; return okResult(); },
    repair: async () => { repairCalls += 1; return { ok: true, draft }; },
  }));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.code, CODES.NO_REPAIR_NEEDED);
  assert.strictEqual(result.adoption, 'candidate');
  assert.strictEqual(result.repairs, 0);
  assert.strictEqual(dryRunCalls, 1);
  assert.strictEqual(repairCalls, 0);
  assert.strictEqual(result.digest, draftDigest(draft));
  assert.strictEqual(result.changed, false);
});

test('一轮修复成功：请求只有结构化 issues + 有界 previousDraft', async () => {
  const original = buildDraft();
  const repaired = clone(original);
  repaired.displayName = '修复后首页候选';
  const payloads = [];
  let dryRunCalls = 0;
  const events = [];
  const result = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => {
      dryRunCalls += 1;
      return dryRunCalls === 1 ? failResult('DRAFT_UNKNOWN_EVENT') : okResult();
    },
    repair: async (payload) => {
      payloads.push(payload);
      return { ok: true, draft: repaired };
    },
    onRound: (event) => events.push(event.phase),
  }));

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.code, CODES.OK);
  assert.strictEqual(result.repairs, 1);
  assert.strictEqual(result.adoption, 'candidate');
  assert.strictEqual(result.changed, true);
  assert.strictEqual(payloads.length, 1);

  const payload = payloads[0];
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    'contractVersion', 'issues', 'previousDraft', 'revision', 'round', 'runId',
  ]);
  assert.strictEqual(payload.contractVersion, 'frontend-repair.v1');
  assert.strictEqual(payload.runId, 'frun-20261117-repair');
  assert.strictEqual(payload.revision, 2);
  assert.strictEqual(payload.round, 1);
  assert.deepStrictEqual(payload.issues, [{
    path: '$.pages[0].nodes[0].events.tap',
    code: 'DRAFT_UNKNOWN_EVENT',
  }]);
  assert.deepStrictEqual(payload.issues[0], { path: payload.issues[0].path, code: payload.issues[0].code });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(payload.previousDraft)),
    original,
    'previousDraft 必须与进入本轮前的 Draft 语义一致',
  );
  assert.ok(Buffer.byteLength(JSON.stringify(payload.previousDraft), 'utf8') <= MAX_PREVIOUS_DRAFT_BYTES);

  // 没有日志/绝对路径/源码/文件路径字段。
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('C:\\'));
  assert.ok(!/\bfile:\/\//i.test(text));
  assert.ok(!/https?:\/\//i.test(text));
  assert.ok(!/"(log|logs|stack|stdout|stderr|command|file|source)"\s*:/.test(text));
  assert.ok(!text.includes('pages/home/index.wxml'));

  assert.deepStrictEqual(events, ['dry-run', 'repair', 'dry-run']);
  assert.deepStrictEqual(result.attempts.map((item) => item.round), [1]);
  assert.strictEqual(result.attempts[0].request.issues.length, 1);
});

test('两轮仍失败：只尝试 2 轮，保留当前版本且候选不可采用', async () => {
  const original = buildDraft();
  const payloads = [];
  let dryRunCalls = 0;
  let repairCalls = 0;
  const result = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => {
      dryRunCalls += 1;
      return failResult('DRAFT_UNKNOWN_DATA_PATH', [{
        code: 'DRAFT_UNKNOWN_DATA_PATH',
        path: '$.pages[0].nodes[2].textToken',
        field: 'textToken',
        file: null,
        message: '未在事实中的数据路径',
        severity: 'error',
      }]);
    },
    repair: async (payload) => {
      repairCalls += 1;
      payloads.push(payload);
      const next = clone(original);
      next.displayName = '第' + repairCalls + '轮修复候选';
      return { ok: true, draft: next };
    },
  }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, CODES.LIMIT_EXCEEDED);
  assert.strictEqual(result.adoption, 'none');
  assert.strictEqual(result.attempts.length, 2);
  assert.strictEqual(repairCalls, 2);
  assert.strictEqual(dryRunCalls, 3);
  assert.deepStrictEqual(payloads.map((item) => item.round), [1, 2]);
  // 失败返回的“当前版本”永远是进入本轮之前的版本，不是失败的修复草稿。
  assert.deepStrictEqual(result.keptDraft, original);
  assert.notDeepStrictEqual(result.lastDraft, original);
  assert.strictEqual(result.details.limit, MAX_REPAIR_ROUNDS);
});

test('不可定位的本地故障：不进入自动化修复（0 次 repair）', async () => {
  let repairCalls = 0;
  const result = await runRepairLoop(baseOptions({
    draft: buildDraft(),
    dryRun: async () => failResult('MATERIALIZE_BASE_INVALID', [{
      code: 'MATERIALIZE_BASE_INVALID',
      path: null,
      file: 'trustedRegistry',
      field: null,
      message: '可信注册表不可用',
      severity: 'error',
    }]),
    repair: async () => { repairCalls += 1; return { ok: true, draft: buildDraft() }; },
  }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, CODES.NOT_APPLICABLE);
  assert.strictEqual(result.adoption, 'none');
  assert.strictEqual(repairCalls, 0);
  assert.strictEqual(result.details.droppedIssues, 1);
});

test('repair 传输异常 / 服务端拒绝 / 非法 Draft 都不采用任何版本', async () => {
  const original = buildDraft();

  const transportFailed = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => { throw new Error('ECONNRESET at C:\\secret\\endpoint'); },
  }));
  assert.strictEqual(transportFailed.ok, false);
  assert.strictEqual(transportFailed.code, CODES.TRANSPORT_FAILED);
  assert.strictEqual(transportFailed.adoption, 'none');
  assert.deepStrictEqual(transportFailed.keptDraft, original);
  assert.ok(!transportFailed.message.includes('secret'));

  const rejected = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => ({ ok: false, code: 'FRONTEND_REPAIR_LIMIT_EXCEEDED' }),
  }));
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, CODES.REJECTED);
  assert.match(rejected.message, /FRONTEND_REPAIR_LIMIT_EXCEEDED/);
  assert.deepStrictEqual(rejected.keptDraft, original);

  const invalidDraft = buildDraft();
  invalidDraft.pages[0].nodes[0].events = { tap: 'home.goNope' };
  const invalid = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => ({ ok: true, draft: invalidDraft }),
  }));
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.code, CODES.RESPONSE_INVALID);
  assert.strictEqual(invalid.details.draftCode, 'DRAFT_UNKNOWN_EVENT');
  assert.deepStrictEqual(invalid.keptDraft, original);

  const missingDraft = await runRepairLoop(baseOptions({
    draft: original,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => ({ ok: true }),
  }));
  assert.strictEqual(missingDraft.code, CODES.RESPONSE_INVALID);
  assert.deepStrictEqual(missingDraft.keptDraft, original);
});

test('取消：开始前/传输中被取消都不产生候选', async () => {
  const before = await runRepairLoop(baseOptions({
    draft: buildDraft(),
    signal: { cancelled: true },
    dryRun: async () => okResult(),
    repair: async () => ({ ok: true, draft: buildDraft() }),
  }));
  assert.strictEqual(before.code, CODES.CANCELLED);
  assert.strictEqual(before.adoption, 'none');

  const signal = { cancelled: false };
  const during = await runRepairLoop(baseOptions({
    draft: buildDraft(),
    signal,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => {
      signal.cancelled = true;
      return { ok: true, draft: buildDraft() };
    },
  }));
  assert.strictEqual(during.code, CODES.CANCELLED);
  assert.deepStrictEqual(during.keptDraft, buildDraft());
  assert.strictEqual(during.adoption, 'none');
});

test('修复预算不得放宽：maxRounds>2 直接拒绝', async () => {
  const result = await runRepairLoop(baseOptions({
    draft: buildDraft(),
    maxRounds: 3,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => ({ ok: true, draft: buildDraft() }),
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, CODES.LIMIT_INVALID);
  assert.strictEqual(result.adoption, 'none');
});

test('请求构造：丢弃非白名单/非 DSL path/多余字段，上限 8 条', () => {
  const original = buildDraft();

  const mixed = collectRepairIssues({
    issues: [
      { code: 'DRAFT_UNKNOWN_EVENT', path: '$.pages[0].nodes[0].events.tap', message: 'C:\\x\\y.log', file: 'a.wxml' },
      { code: 'DRAFT_UNKNOWN_DATA_PATH', path: '$.pages[0].nodes[2].textToken' },
      { code: 'MATERIALIZE_BASE_INVALID', path: '$.pages[0]' },
      { code: 'DRAFT_STYLE_INVALID', path: 'pages/home/index.wxml' },
      { code: 'DRAFT_STYLE_INVALID', path: '$.pages[0].nodes[2].style.size', message: 'log' },
      { code: 'DRAFT_SCHEMA_INVALID', path: '$.pages[0]' },
    ],
  });
  assert.strictEqual(mixed.ok, true);
  assert.deepStrictEqual(mixed.issues.map((item) => item.code).sort(), [
    'DRAFT_SCHEMA_INVALID', 'DRAFT_STYLE_INVALID', 'DRAFT_UNKNOWN_DATA_PATH', 'DRAFT_UNKNOWN_EVENT',
  ]);
  for (const issue of mixed.issues) {
    assert.deepStrictEqual(Object.keys(issue).sort(), ['code', 'path']);
    assert.match(issue.path, /^\$/);
  }
  assert.strictEqual(mixed.dropped, 2);

  const many = [];
  for (let index = 0; index < 10; index += 1) {
    many.push({ code: 'DRAFT_SCHEMA_INVALID', path: '$.pages[0].nodes[' + index + ']' });
  }
  const capped = collectRepairIssues({ issues: many });
  assert.strictEqual(capped.issues.length, MAX_ISSUES);
  assert.strictEqual(capped.dropped, 2);

  const request = buildRepairRequest({
    runId: 'frun-20261117-repair',
    revision: 0,
    round: 2,
    issues: mixed.issues,
    previousDraft: original,
    facts: FACTS,
    pageFacts: PAGE_FACTS,
  });
  assert.strictEqual(request.ok, true, JSON.stringify(request));
  assert.strictEqual(request.payload.round, 2);
  assert.strictEqual(request.payload.issues.length, 4);

  // 超过 8 条 & 非法 runId/round 一律拒绝。
  assert.strictEqual(buildRepairRequest({
    runId: 'frun-20261117-repair', revision: 0, round: 1, issues: many, previousDraft: original, facts: FACTS, pageFacts: PAGE_FACTS,
  }).code, CODES.ISSUES_INVALID);
  assert.strictEqual(buildRepairRequest({
    runId: 'bad id', revision: 0, round: 1, issues: mixed.issues, previousDraft: original, facts: FACTS, pageFacts: PAGE_FACTS,
  }).code, CODES.ISSUES_INVALID);
  assert.strictEqual(buildRepairRequest({
    runId: 'frun-20261117-repair', revision: 0, round: 3, issues: mixed.issues, previousDraft: original, facts: FACTS, pageFacts: PAGE_FACTS,
  }).code, CODES.LIMIT_INVALID);
});

test('previousDraft 仍受 P2 schema 与体积约束', () => {
  const valid = boundedPreviousDraft(buildDraft(), FACTS, PAGE_FACTS);
  assert.strictEqual(valid.ok, true, JSON.stringify(valid));
  assert.ok(valid.bytes <= MAX_PREVIOUS_DRAFT_BYTES);
  assert.strictEqual(valid.digest, draftDigest(valid.draft));

  // 未知事件：即使来自“服务端”，也不能直接信。
  const withUnknownEvent = buildDraft((draft) => {
    draft.pages[0].nodes[0].events = { tap: 'home.goNope' };
  });
  const invalid = boundedPreviousDraft(withUnknownEvent, FACTS, PAGE_FACTS);
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.code, CODES.DRAFT_INVALID);
  assert.strictEqual(invalid.details.draftCode, 'DRAFT_UNKNOWN_EVENT');

  // 节点数超限（契约 48/页）必须在发送前被 schema 拒绝。
  const tooMany = buildDraft((draft) => {
    draft.pages[0].nodes = [];
    for (let index = 0; index < 60; index += 1) {
      draft.pages[0].nodes.push({ type: 'text', textToken: 'store.name' });
    }
  });
  const rejected = boundedPreviousDraft(tooMany, FACTS, PAGE_FACTS);
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, CODES.DRAFT_INVALID);
});

test('issue code 白名单与服务端契约同源（只读解析 types.ts）', () => {
  const typesFile = path.join(REPO, 'server', 'src', 'agent', 'frontend-reconstruct', 'types.ts');
  const source = fs.readFileSync(typesFile, 'utf8');
  const matched = source.match(/FRONTEND_REPAIR_ISSUE_CODES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
  assert.ok(matched, 'types.ts 必须声明 FRONTEND_REPAIR_ISSUE_CODES');
  const serverCodes = [...matched[1].matchAll(/'([A-Z_]+)'/g)].map((item) => item[1]);
  assert.ok(serverCodes.length >= 9, JSON.stringify(serverCodes));
  assert.deepStrictEqual([...REPAIR_ISSUE_CODES].sort(), [...serverCodes].sort());
  assert.deepStrictEqual([...REPAIR_ISSUE_CODES].sort(), [
    'CONSISTENCY_FAILED', 'DRAFT_PAGE_JSON_INVALID', 'DRAFT_SCHEMA_INVALID', 'DRAFT_STYLE_INVALID',
    'DRAFT_UNKNOWN_COMPONENT', 'DRAFT_UNKNOWN_DATA_PATH', 'DRAFT_UNKNOWN_EVENT', 'DRY_RUN_FAILED',
    'MINI_CHECK_FAILED', 'SLOT_ANCHOR_MISSING',
  ]);
});

test('同一份失败 Draft 反复返回也不会突破 2 轮预算', async () => {
  let repairCalls = 0;
  const draft = buildDraft();
  const result = await runRepairLoop(baseOptions({
    draft,
    dryRun: async () => failResult('DRAFT_UNKNOWN_EVENT'),
    repair: async () => { repairCalls += 1; return { ok: true, draft: clone(draft) }; },
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(repairCalls, 2);
  assert.strictEqual(result.code, CODES.LIMIT_EXCEEDED);
});

test('validateDraft 与 repair 使用同一套事实（不引入第二套校验）', () => {
  const validated = validateDraft(buildDraft(), FACTS, PAGE_FACTS);
  assert.strictEqual(validated.ok, true, JSON.stringify(validated));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(validated.draft)), buildDraft());
  const bounded = boundedPreviousDraft(validated.draft, FACTS, PAGE_FACTS);
  assert.strictEqual(bounded.ok, true);
});
