const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');

async function loadModule(path) {
  return import(path);
}

/** 去掉注释后再做「不得出现某个标识符」的断言，否则注释里提到名字就会误报。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('dev fixture 模块不读取 query/localStorage/process.env 等旁路开关', async () => {
  const code = stripComments(readFileSync(join(projectRoot, 'src', 'domain', 'devStoreFixtures.mjs'), 'utf8'));

  // 只匹配「真的去访问」的形态，避免注释里提到这些名字就误报。
  const forbidden = [
    /localStorage\s*[.[]/,
    /sessionStorage\s*[.[]/,
    /location\.search/,
    /window\.location/,
    /process\.env\s*[.[]/,
    /new\s+URLSearchParams/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(code), false, `夹具模块不应使用 ${pattern}`);
  }
});

test('App.jsx 不再渲染开发者测试夹具（临时界面已移出产品）', async () => {
  const source = readFileSync(join(projectRoot, 'src', 'App.jsx'), 'utf8');
  const code = stripComments(source);

  // 夹具条属于只在开发时可见的临时界面：主界面不得再引用它，也不得留开关。
  assert.equal(/DevFixtureBar/.test(code), false, '产品界面不得再出现开发者测试夹具');
  assert.equal(/DEV_FIXTURES_ENABLED/.test(code), false, '夹具开关必须一起移除');
  assert.equal(/DEV_STORE_FIXTURES/.test(code), false, '界面不得直接引用夹具语料');
});

test('夹具元数据：id 唯一、label 非空、语料不超过输入框上限', async () => {
  const { DEV_STORE_FIXTURES, DEV_FIXTURE_MAX_UTTERANCE } = await loadModule('../src/domain/devStoreFixtures.mjs');

  assert.ok(Array.isArray(DEV_STORE_FIXTURES));
  assert.ok(DEV_STORE_FIXTURES.length >= 1);

  const ids = new Set();
  for (const fixture of DEV_STORE_FIXTURES) {
    assert.equal(typeof fixture.id, 'string');
    assert.ok(fixture.id.length > 0);
    assert.equal(ids.has(fixture.id), false, `夹具 id 重复：${fixture.id}`);
    ids.add(fixture.id);

    assert.equal(typeof fixture.label, 'string');
    assert.ok(fixture.label.trim().length > 0, `${fixture.id} 缺少可读 label`);

    assert.equal(typeof fixture.utterance, 'string');
    const length = Array.from(fixture.utterance).length;
    assert.ok(length > 0);
    assert.ok(
      length <= DEV_FIXTURE_MAX_UTTERANCE,
      `${fixture.id} 语料 ${length} 字，超过输入框上限 ${DEV_FIXTURE_MAX_UTTERANCE}`,
    );
    assert.ok(fixture.utterance.includes('店名'), `${fixture.id} 语料应显式包含店名，避免被当作品类`);
    assert.match(fixture.utterance, /\d+ 元/, `${fixture.id} 菜品必须带明确价格`);
  }
});

test('每句夹具都能被本地解析器填成可确认的完整草稿（mock 与 http 共用同一句）', async () => {
  const { DEV_STORE_FIXTURES } = await loadModule('../src/domain/devStoreFixtures.mjs');
  const { parseMockUtterance } = await loadModule('../src/services/agentTurn/mockAgentTransport.js');
  const { validateAgentDraft } = await loadModule('../src/domain/agentDraft.mjs');

  for (const fixture of DEV_STORE_FIXTURES) {
    const parsed = parseMockUtterance(fixture.utterance, {});
    const validation = validateAgentDraft(parsed.draft);

    assert.deepEqual(
      [...parsed.recognized].sort(),
      ['businessHours', 'category', 'dishes', 'fulfillment', 'storeName'],
      `${fixture.id} 未解析出全部五类资料：${parsed.recognized.join(',')}`,
    );
    assert.deepEqual(validation.missingFields, [], `${fixture.id} 仍缺资料`);
    assert.deepEqual(validation.errors, [], `${fixture.id} 存在字段错误`);
    assert.equal(validation.readyForReview, true, `${fixture.id} 未达到可确认状态`);
    assert.ok(parsed.draft.dishes.length >= 3, `${fixture.id} 菜品不足 3 道`);

    // 同一句话也必须是「用户在消息里真的提供了资料」，而不是让模型编造。
    for (const dish of parsed.draft.dishes) {
      assert.ok(Number.isInteger(dish.priceCents) && dish.priceCents > 0, `${fixture.id}/${dish.name} 价格不是明确整数分`);
    }
  }
});
