'use strict';

/**
 * 契约 fixture 装载器：把 `test/fixtures/frontend-reconstruct/contract/cases.json`
 * 展开成「同一批 Draft」，供服务端（TS）与桌面端（CJS）两台校验器双跑。
 *
 * 设计要点：
 * - 事实不复制：`facts` / `pageFacts` 直接取 `capabilities.snapshot.json`（P1 随包分发的唯一快照），
 *   避免 fixture 里再存一份能力事实而与 Catalog 漂移；
 * - 用例只描述「相对基线 Draft 的改动」（`ops`），不复制整份 Draft，改动可逐条 review；
 * - `expect` 就是**当前语义**的断言：两台校验器必须同时接受或同时拒绝，且拒绝路径一致。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CASES_RELATIVE = path.join('test', 'fixtures', 'frontend-reconstruct', 'contract', 'cases.json');
const CASES_PATH = path.join(REPO, CASES_RELATIVE);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO, relative), 'utf8'));
}

/** 事实与页面事实来自同一份随包快照；缺失即失败，绝不兜底造数据。 */
function loadFacts(snapshotRelative) {
  const snapshot = readJson(snapshotRelative);
  const { pageFacts, keyActions, ...facts } = snapshot;
  if (!pageFacts || typeof pageFacts !== 'object') {
    throw new Error(snapshotRelative + ' 缺少 pageFacts');
  }
  void keyActions;
  return { facts, pageFacts };
}

function at(draft, segments) {
  let cursor = draft;
  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = cursor[segments[index]];
    if (cursor === undefined || cursor === null) {
      throw new Error('fixture op 路径不存在：' + JSON.stringify(segments.slice(0, index + 1)));
    }
  }
  return { parent: cursor, key: segments[segments.length - 1] };
}

/** 只支持 fixture 真正需要的几种改动，保持可审性。 */
function applyOp(draft, op) {
  switch (op.op) {
    case 'set': {
      const { parent, key } = at(draft, op.path);
      parent[key] = clone(op.value);
      return draft;
    }
    case 'remove': {
      const { parent, key } = at(draft, op.path);
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      return draft;
    }
    case 'nodes': {
      draft.pages[0].nodes = clone(op.nodes);
      return draft;
    }
    case 'repeatNode': {
      draft.pages[0].nodes = Array.from({ length: op.count }, () => clone(op.node));
      return draft;
    }
    case 'repeatChildren': {
      const container = draft.pages[0].nodes[op.containerIndex === undefined ? 2 : op.containerIndex];
      const child = container.children[op.childIndex === undefined ? 0 : op.childIndex];
      container.children = Array.from({ length: op.count }, () => clone(child));
      return draft;
    }
    case 'nestDepth': {
      let node = clone(op.leaf || { type: 'text', textToken: 'store.name' });
      for (let level = 0; level < op.depth; level += 1) {
        node = { type: 'container', style: { direction: 'column' }, children: [node] };
      }
      draft.pages[0].nodes = [node];
      return draft;
    }
    case 'addPage': {
      draft.pages.push(clone(op.page));
      return draft;
    }
    case 'setStringProp': {
      const node = draft.pages[0].nodes[op.nodeIndex === undefined ? 0 : op.nodeIndex];
      node.props[op.propName || 'storeName'] = { kind: 'literal', value: 'x'.repeat(op.chars) };
      return draft;
    }
    default:
      throw new Error('未知 fixture op：' + String(op.op));
  }
}

function loadCases() {
  const file = readJson(CASES_RELATIVE);
  const { facts, pageFacts } = loadFacts(file.factsSnapshot);
  const cases = file.cases.map((entry) => {
    const draft = clone(entry.draft || file.baseDraft);
    for (const op of entry.ops || []) applyOp(draft, op);
    return { name: entry.name, expect: entry.expect, draft };
  });
  return { file, facts, pageFacts, cases };
}

module.exports = {
  REPO,
  CASES_PATH,
  CASES_RELATIVE,
  loadFacts,
  loadCases,
  applyOp,
};
