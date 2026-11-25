'use strict';

/**
 * E0-U1 口径回归：`src/components/agent/e0/e0UiContract.mjs` 必须与冻结文档逐项一致。
 *
 * 为什么这么写：
 * - 8 页枚举、progress stage 白名单、检查四态都是**冻结口径**（rev15 §14.5 / §9.1 / §14.9 / §14.4）。
 *   任何一方漂移（文档加页/加 stage，或组件自己抄一份），这里先失败。
 * - 旧链阶段标签有 3 份副本（冻结 §10 D-UI-3），E0 新链只允许 1 份：本次直接扫描 `src/` 证明没有第三份。
 * - 未知 stage 不丢步、缺图 MISSING/BLOCKED、四态文案都是“用户能看到的事实”，用行为断言锁死，
 *   不靠注释和 README 承诺。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FREEZE_DOC = path.join(REPO, 'docs', 'handoff', 'Workspace-Agent-B阶段接口冻结.md');
const SOURCE_FACTS = path.join(REPO, 'scripts', 'agent-source-facts.cjs');
const E0_DIR = path.join(REPO, 'src', 'components', 'agent', 'e0');
const CONTRACT_MODULE = path.join(E0_DIR, 'e0UiContract.mjs');

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function sectionOf(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `冻结文档缺少小节：${startHeading}`);
  const end = text.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `冻结文档缺少小节结束锚点：${endHeading}`);
  return text.slice(start, end);
}

function backtickChunks(text) {
  const chunks = [];
  const pattern = /`([^`]*)`/g;
  let match = pattern.exec(text);
  while (match) {
    chunks.push(match[1]);
    match = pattern.exec(text);
  }
  return chunks;
}

function splitSlashList(chunk) {
  return chunk.split('/').map((item) => item.trim()).filter(Boolean);
}

function docPages() {
  const text = readText(FREEZE_DOC);
  const section = sectionOf(text, '### 14.5', '### 14.6');
  const line = section.split('\n').find((entry) => entry.includes('**8 页目标枚举（单一来源）**'));
  assert.ok(line, '§14.5 必须保留「8 页目标枚举（单一来源）」条目');
  const chunk = backtickChunks(line)[0];
  assert.ok(chunk, '§14.5 8 页枚举应写在反引号清单里');
  return splitSlashList(chunk);
}

function docStages() {
  const text = readText(FREEZE_DOC);
  const base = sectionOf(text, '### 9.1', '## 10.');
  const stageChunk = backtickChunks(base).find((chunk) => chunk.trim().startsWith('analyze'));
  assert.ok(stageChunk, '§9.1 必须给出以 analyze 开头的 stage 清单');
  const stages = splitSlashList(stageChunk);

  const rev15 = sectionOf(text, '### 14.9', '### 14.10');
  const addedLine = rev15.split('\n').find((entry) => entry.includes('stage 白名单**追加**'));
  assert.ok(addedLine, '§14.9 必须保留 stage 白名单追加条目');
  const added = backtickChunks(addedLine).filter((token) => /^[a-z][a-z-]*$/.test(token));
  assert.ok(added.length >= 4, '§14.9 追加项应至少包含 queue/image/bundle/submit');

  const merged = stages.slice();
  for (const stage of added) {
    if (!merged.includes(stage)) merged.push(stage);
  }
  return merged;
}

function sourceFactsPageIds() {
  const text = readText(SOURCE_FACTS);
  const start = text.indexOf('const PAGE_CONTRACTS = Object.freeze({');
  assert.notEqual(start, -1, 'scripts/agent-source-facts.cjs 必须保留 PAGE_CONTRACTS');
  const end = text.indexOf('\n});', start);
  const block = text.slice(start, end);
  const ids = [];
  const pattern = /^ {2}(?:'([a-z0-9-]+)'|([a-z][a-z0-9-]*)): \{/gm;
  let match = pattern.exec(block);
  while (match) {
    ids.push(match[1] || match[2]);
    match = pattern.exec(block);
  }
  return ids;
}

async function loadContract() {
  return import('../src/components/agent/e0/e0UiContract.mjs');
}

test('8 页枚举与 rev15 §14.5 逐项一致（顺序也是契约）', async () => {
  const { E0_TARGET_PAGE_IDS, E0_TARGET_PAGE_LABELS } = await loadContract();
  const expected = docPages();
  assert.equal(expected.length, 8, '§14.5 的 8 页清单应正好 8 项');
  assert.deepEqual([...E0_TARGET_PAGE_IDS], expected, 'UI 页面枚举必须与冻结 §14.5 逐项同序');
  for (const id of expected) {
    assert.equal(typeof E0_TARGET_PAGE_LABELS[id], 'string', `页面 ${id} 必须有中文名`);
    assert.ok(E0_TARGET_PAGE_LABELS[id].length > 0);
  }
  assert.equal(Object.keys(E0_TARGET_PAGE_LABELS).length, 8, '页面标签表不得多出枚举外页面');
});

test('8 页枚举同时覆盖 SourceFacts/page-contract 的真实页面事实', async () => {
  const { E0_TARGET_PAGE_IDS } = await loadContract();
  const factsPages = sourceFactsPageIds();
  assert.equal(factsPages.length, 8, 'SourceFacts 的 PAGE_CONTRACTS 应正好 8 页');
  for (const id of E0_TARGET_PAGE_IDS) {
    assert.ok(factsPages.includes(id), `页面 ${id} 在 SourceFacts PAGE_CONTRACTS 里不存在`);
  }
});

test('不复用 v1 home/menu 常量：E0 口径模块不得 import 旧链 domain', async () => {
  const source = readText(CONTRACT_MODULE)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /frontendReconstruct/, 'E0 口径模块不得引用 v1 frontendReconstruct（X5）');
  assert.doesNotMatch(source, /FRONTEND_TARGET_PAGES/, 'E0 不得复用 v1 TARGET_PAGES 常量');
  assert.doesNotMatch(source, /window\.smartStore|ipcRenderer|require\(/, '口径模块必须纯函数，无 IPC/require');
  assert.doesNotMatch(source, /\bimport\b[^\n]*'\.\./, '口径模块不得向旧链 domain/components 借常量');
});

test('normalizeTargetPages：非 enabled 页不可选且带原因，绝不硬编码 8 个 true', async () => {
  const { normalizeTargetPages, pickTargetPage } = await loadContract();

  const empty = normalizeTargetPages(null);
  assert.equal(empty.pages.length, 8, '即使平台没给事实也要回 8 项骨架（全部不可选）');
  assert.ok(empty.pages.every((page) => page.enabled === false), '缺事实时所有页面必须 enabled:false');
  assert.ok(empty.pages.every((page) => page.reasons.length > 0), '不可选页必须给出原因');

  const partial = normalizeTargetPages([
    { id: 'menu', enabled: true },
    { id: 'home', enabled: false, reasons: ['首页缺少 page-contract 事件事实'] },
  ]);
  assert.equal(partial.pages.length, 8);
  assert.equal(partial.pages.find((page) => page.id === 'menu').enabled, true);
  const home = partial.pages.find((page) => page.id === 'home');
  assert.equal(home.enabled, false);
  assert.deepEqual([...home.reasons], ['首页缺少 page-contract 事件事实']);

  const unsupported = pickTargetPage(partial.pages, 'checkout');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'AGENT_TARGET_PAGE_UNSUPPORTED');

  const notInEnum = pickTargetPage(partial.pages, 'settings');
  assert.equal(notInEnum.ok, false);
  assert.equal(notInEnum.code, 'AGENT_TARGET_PAGE_UNSUPPORTED');

  assert.equal(pickTargetPage(partial.pages, 'menu').ok, true);

  const extras = normalizeTargetPages([{ id: 'menu', enabled: true }, { id: 'cart', enabled: true }]);
  assert.deepEqual([...extras.rejected], ['cart'], '枚举外页面 id 必须被记录而不是混进 8 页');
});

test('stage 白名单 = §9.1 原文 + §14.9 追加（adopt 不重复）', async () => {
  const { E0_PROGRESS_STAGES, E0_STAGE_LABELS } = await loadContract();
  const expected = docStages();
  assert.deepEqual([...E0_PROGRESS_STAGES], expected, 'stage 白名单必须与冻结文档逐项同序');
  assert.equal(new Set(E0_PROGRESS_STAGES).size, E0_PROGRESS_STAGES.length, '白名单不得有重复项');
  for (const stage of ['queue', 'image', 'bundle', 'submit']) {
    assert.ok(E0_PROGRESS_STAGES.includes(stage), `rev15 §14.9 追加项 ${stage} 必须在白名单内`);
  }
  for (const stage of E0_PROGRESS_STAGES) {
    assert.equal(typeof E0_STAGE_LABELS[stage], 'string', `stage ${stage} 缺少人话标签`);
  }
  assert.equal(Object.keys(E0_STAGE_LABELS).length, E0_PROGRESS_STAGES.length, '标签表不得多出白名单外 stage');
});

function filesUnder(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (/\.(mjs|js|jsx)$/.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function filesContaining(root, tokens) {
  const owners = [];
  for (const file of filesUnder(root)) {
    const lines = readText(file).split('\n');
    const hit = lines.some((line) => tokens.some((token) => line.includes(`'${token}'`) || line.includes(`"${token}"`)));
    if (hit) owners.push(path.relative(REPO, file).replace(/\\/g, '/'));
  }
  return owners.sort();
}

test('stage 白名单在 renderer 里只有一份副本（旧链副本不再增加第四份）', () => {
  // 'read-context' 只可能来自 rev15 白名单本身：全 renderer 只允许口径模块出现。
  assert.deepEqual(
    filesContaining(path.join(REPO, 'src'), ['read-context']),
    ['src/components/agent/e0/e0UiContract.mjs'],
    'stage 白名单只允许存在于 e0UiContract.mjs',
  );
  // 'mini-check' 在旧链里还有已知副本（domain + chat/stageNotice.mjs，属 D-UI-3 类，本轮不改也不扩大）。
  // 这里锁的是“允许集合”：任何新组件再加一份阶段表，本断言立刻失败。
  assert.deepEqual(
    filesContaining(path.join(REPO, 'src', 'components'), ['mini-check']),
    ['src/components/agent/e0/e0UiContract.mjs', 'src/components/chat/stageNotice.mjs'],
    'src/components/** 的阶段表副本集合不得增加（chat/stageNotice.mjs 是旧链既有副本，E0 不复用）',
  );
  // 组件各自不得定义自己的阶段常量：只允许 import 口径模块。
  const componentFiles = fs.readdirSync(E0_DIR).filter((name) => name.endsWith('.jsx'));
  assert.ok(componentFiles.length >= 5, 'E0 原型组件应至少 5 个');
  for (const name of componentFiles) {
    const text = readText(path.join(E0_DIR, name));
    assert.match(text, /from '\.\/e0UiContract\.mjs'/, `${name} 必须从口径模块取标签/stage`);
    assert.doesNotMatch(text, /STAGE_LABELS\s*=\s*Object\.freeze/, `${name} 不得自带阶段标签表`);
    assert.doesNotMatch(text, /PROGRESS_STAGES\s*=/, `${name} 不得自带阶段清单`);
  }
});

test('未知 stage 显示「未知阶段（x）」且不丢步', async () => {
  const { formatStageLabel, appendProgressStep, normalizeProgressEvent, windowProgressSteps } = await loadContract();

  assert.equal(formatStageLabel('analyze'), '识别参考图与页面能力');
  assert.equal(formatStageLabel('queue'), '等待模型槽位');
  assert.equal(formatStageLabel('mystery'), '未知阶段（mystery）');
  assert.equal(formatStageLabel(''), '未知阶段（空）');
  assert.equal(formatStageLabel(null), '未知阶段（空）');

  let steps = [];
  steps = appendProgressStep(steps, { stage: 'analyze', status: 'running' });
  steps = appendProgressStep(steps, { stage: 'mystery', status: 'running', message: '新的阶段' });
  steps = appendProgressStep(steps, { stage: 'done', status: 'succeeded' });
  assert.equal(steps.length, 3, '未知 stage 必须保留，不能被丢弃');
  assert.deepEqual(steps.map((step) => step.stage), ['analyze', 'mystery', 'done']);
  assert.equal(steps[1].stageLabel, '未知阶段（mystery）');
  assert.equal(steps[1].knownStage, false);

  // 完全相同的相邻事件才合并，避免刷屏但不吃步
  steps = appendProgressStep(steps, { stage: 'done', status: 'succeeded' });
  assert.equal(steps.length, 3);

  const unknownEvent = normalizeProgressEvent({ stage: 'brand-new', status: 'what' });
  assert.equal(unknownEvent.stageLabel, '未知阶段（brand-new）');
  assert.equal(unknownEvent.status, 'running', '非法事件状态不许假装 succeeded');
  assert.equal(unknownEvent.statusKnown, false);

  const long = [];
  for (let index = 0; index < 260; index += 1) {
    long.push(normalizeProgressEvent({ stage: index === 5 ? 'weird-stage' : 'analyze', status: 'running', message: `m${index}` }));
  }
  const windowed = windowProgressSteps(long, 200);
  assert.ok(windowed.hiddenCount > 0, '超上限时应折叠较早的步');
  assert.ok(windowed.steps.some((step) => step.stage === 'weird-stage'), '折叠也不能隐藏未知阶段');
});

test('四态只有 PASS/FAIL/BLOCKED/NOT_RUN，非法值降级为 NOT_RUN 且标 unknown', async () => {
  const { E0_CHECK_STATUSES, E0_STATUS_LABELS, normalizeCheckStatus, formatCheckStatusLabel } = await loadContract();

  assert.deepEqual([...E0_CHECK_STATUSES], ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
  assert.deepEqual(Object.keys(E0_STATUS_LABELS), ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
  assert.equal(E0_STATUS_LABELS.BLOCKED, '受阻');

  for (const status of E0_CHECK_STATUSES) {
    const normalized = normalizeCheckStatus(status);
    assert.equal(normalized.status, status);
    assert.equal(normalized.unknown, false);
  }
  assert.equal(normalizeCheckStatus('pass').status, 'PASS', '大小写归一');

  const legacy = normalizeCheckStatus('unknown');
  assert.equal(legacy.status, 'NOT_RUN', '旧链 unknown 不得被当成通过');
  assert.equal(legacy.unknown, true);
  assert.match(formatCheckStatusLabel('unknown'), /NOT_RUN（原始值未被冻结口径接受：unknown）/);
  assert.doesNotMatch(JSON.stringify(E0_STATUS_LABELS), /partial/, 'partial 不是第五态，只是标记');
});

test('缺图显示 MISSING + BLOCKED（不许静默退化成纯文本）', async () => {
  const { describeReferenceImage, describeConsent, E0_CONSENT_TEXT, E0_LIMITS } = await loadContract();

  const missing = describeReferenceImage(null);
  assert.equal(missing.state, 'MISSING');
  assert.equal(missing.visionStatus, 'BLOCKED');
  assert.equal(missing.canRunVision, false);
  assert.match(missing.text, /MISSING/);
  assert.match(missing.text, /BLOCKED/);

  const tooBig = describeReferenceImage({ assetId: 'asset-1', bytes: E0_LIMITS.maxImageBytes + 1 });
  assert.equal(tooBig.state, 'BLOCKED');
  assert.equal(tooBig.canRunVision, false);
  assert.match(tooBig.text, /MISSING|BLOCKED/);

  const ready = describeReferenceImage({ assetId: 'asset-1', bytes: 1024, mime: 'image/png' });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.canRunVision, true);
  assert.match(ready.text, /NOT_RUN/, '选中图片不等于已读取像素');

  assert.equal(describeConsent(false).state, 'BLOCKED');
  assert.match(describeConsent(false).note, /BLOCKED/);
  assert.equal(describeConsent(true).state, 'READY');
  assert.equal(describeConsent(true).text, E0_CONSENT_TEXT);
  assert.match(E0_CONSENT_TEXT, /同意.*发给模型|发给模型/, 'consent 文案必须表达“同意把图发给模型”');
});

test('候选摘要：修改文件数/treeDigest/静态+运行时四态/BLOCKED·NOT_RUN 原因', async () => {
  const { buildCandidateSummary } = await loadContract();
  const digest = 'sha256:' + 'a'.repeat(64);

  const passed = buildCandidateSummary({
    attemptId: 'attempt-1',
    revision: 3,
    targetPage: 'menu',
    treeDigest: digest,
    changedFiles: ['pages/menu/index.wxml', 'pages/menu/index.wxss'],
    staticChecks: [
      { checkId: 'source.check', status: 'PASS', treeDigest: digest },
      { checkId: 'composer.dry-run', status: 'PASS', treeDigest: digest },
      { checkId: 'mini.check', status: 'PASS', exportTreeDigest: digest },
    ],
    runtimeChecks: [{ checkId: 'wechat.verify', status: 'BLOCKED', reason: '开发者工具不可用' }],
  });

  assert.equal(passed.changedFileCount, 2);
  assert.equal(passed.treeDigest, digest);
  assert.match(passed.treeDigestShort, /^sha256:aaaaaaaa…/, '短摘要必须保留前缀，完整值放 title/aria-label');
  assert.equal(passed.static.status, 'PASS');
  assert.equal(passed.static.count, 3);
  assert.equal(passed.runtime.status, 'BLOCKED');
  assert.deepEqual([...passed.blockedReasons], [{ checkId: 'wechat.verify', status: 'BLOCKED', reason: '开发者工具不可用' }]);
  assert.equal(passed.submitReady, true, '静态门禁 PASS 才可提交');
  assert.equal(passed.partial, true, '运行时 BLOCKED 只能是 partial，不是通过');

  const failed = buildCandidateSummary({
    attemptId: 'attempt-2',
    treeDigest: digest,
    staticChecks: [
      { checkId: 'source.check', status: 'FAIL', reason: 'pages/menu/index.wxml 缺 product-card 事件' },
      { checkId: 'unit.targeted', status: 'NOT_RUN' },
    ],
  });
  assert.equal(failed.static.status, 'FAIL', '任一 FAIL 必须整体 FAIL');
  assert.equal(failed.submitReady, false, 'FAIL 一律拒绝提交');
  assert.equal(failed.blockedReasons.length, 0);
  assert.equal(failed.notRunReasons.length, 1);
  assert.match(failed.notRunReasons[0].reason, /未给出原因/, '缺原因时必须如实写，不能装作通过');

  const empty = buildCandidateSummary(null);
  assert.equal(empty.static.status, 'NOT_RUN');
  assert.equal(empty.runtime.status, 'NOT_RUN');
  assert.equal(empty.submitReady, false);
  assert.equal(empty.changedFileCount, 0);
});

test('口径模块仍可被 renderer 打包（ESM、无 Node 内置依赖）', async () => {
  const source = readText(CONTRACT_MODULE);
  assert.doesNotMatch(source, /require\(['"](node:)?(fs|path|crypto|child_process)['"]\)/, 'renderer 代码不得 require Node 内置模块');
  assert.doesNotMatch(source, /process\.env/, '不得在 UI 口径里读环境变量');
  const contract = await loadContract();
  assert.deepEqual(Object.keys(contract.E0_UI_CONTRACT_SNAPSHOT), ['contractId', 'targetPages', 'stages', 'checkStatuses', 'eventStatuses', 'imageStates']);
});
