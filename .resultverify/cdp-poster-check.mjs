import assert from 'node:assert/strict';

// 本轮独立验证：模板选择页的预览是否真的随 Recipe 变化。
// 只通过 CDP 观察真实 DOM，不向 React 注入状态、不读应用内部变量。

const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const target = targets.find((item) => item.type === 'page');
assert.ok(target, 'No CDP page target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  }
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const body = await ev('document.body?.innerText?.slice(0,1200)').catch(() => 'unavailable');
  throw new Error(`Timeout: ${label}; ${lastError?.message || 'no value'}; body=${body}`);
}
async function click(selector, text) {
  const expression = `(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=nodes.find((node)=>${text === undefined ? 'true' : `node.textContent.includes(${JSON.stringify(text)})`});if(!el)return false;el.click();return true;})()`;
  assert.equal(await ev(expression), true, `Cannot click ${selector} ${text || ''}`);
}
async function setValue(selector, value, index = 0) {
  const expression = `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})][${index}];if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`;
  assert.equal(await ev(expression), true, `Cannot set ${selector}[${index}]`);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.navigate', { url: 'http://127.0.0.1:5187/' });
await until(() => ev("document.readyState === 'complete' && !!document.querySelector('.workbench')"), 'workbench');
await click('button.primary-button', '新建项目');
await until(() => ev("!!document.querySelector('.flow-home-start')"), 'home');
await click('.flow-home-start');
await until(() => ev("!!document.querySelector('.composer-input')"), 'onboarding composer');
await setValue('.composer-input', '基线食堂');
await click('.composer-send');
await until(() => ev("!!document.querySelector('.workspace-skip button')"), 'skip intro');
await click('.workspace-skip button');
await until(() => ev("!!document.querySelector('.feature-customize-button')"), 'features');
await click('.feature-customize-button');
await until(() => ev("!!document.querySelector('.template-gallery')"), 'template gallery');

const cards = await ev(`[...document.querySelectorAll('.template-card')].map((card)=>({
  name: card.querySelector('h3')?.textContent?.trim() || '',
  recipe: card.querySelector('.template-recipe')?.textContent?.trim() || '',
  hasPoster: !!card.querySelector('.mini-poster'),
  posterTitle: card.querySelector('.mini-poster-title')?.textContent?.trim() || '',
  hasHero: !!card.querySelector('.mini-compact-hero'),
}))`);

assert.equal(cards.length, 3, `expected 3 candidates, got ${cards.length}`);
assert.ok(cards.every((card) => card.recipe.length > 0), '每个模板卡片都应显示配方名');

const posterCard = cards.find((card) => card.recipe === '海报点餐');
const classicCard = cards.find((card) => card.recipe === '经典点餐');
assert.ok(posterCard, '缺少海报点餐候选');
assert.ok(classicCard, '缺少经典点餐候选');
assert.equal(posterCard.hasPoster, true, '海报点餐卡片必须渲染 .mini-poster');
assert.equal(posterCard.posterTitle, '秋日暖锅上新');
assert.equal(classicCard.hasPoster, false, '经典点餐卡片不应渲染海报块');
assert.equal(classicCard.hasHero, true, '经典点餐应回落到 hero 兜底');

const posterIndex = cards.findIndex((card) => card.recipe === '海报点餐');
await ev(`document.querySelectorAll('.template-card')[${posterIndex}].click()`);
await until(() => ev("!!document.querySelector('.template-detail-preview .mini-poster')"), 'detail poster');

const detail = await ev(`({
  title: document.querySelector('.template-detail-preview .mini-poster-title')?.textContent?.trim() || '',
  sub: document.querySelector('.template-detail-preview .mini-poster-sub')?.textContent?.trim() || '',
  eyebrow: document.querySelector('.template-detail-preview .mini-poster-eyebrow')?.textContent?.trim() || '',
  dots: document.querySelectorAll('.template-detail-preview .mini-poster-dot').length,
  activeDots: document.querySelectorAll('.template-detail-preview .mini-poster-dot.is-active').length,
  height: Math.round(document.querySelector('.template-detail-preview .mini-poster')?.getBoundingClientRect().height || 0),
  recipeMeta: document.querySelector('.template-detail-meta')?.textContent?.trim() || '',
})`);
assert.equal(detail.title, '秋日暖锅上新');
assert.equal(detail.sub, '两人份 · 到店自取也可');
assert.equal(detail.eyebrow, '本周推荐');
assert.equal(detail.dots, 3, '三张海报应有三个指示点');
assert.equal(detail.activeDots, 1, '任意时刻只有一个激活指示点');
assert.ok(detail.height > 80, `海报块高度应可见，实际 ${detail.height}`);
assert.ok(detail.recipeMeta.includes('海报点餐'), `详情区应显示配方名，实际 ${detail.recipeMeta}`);

const beforeClick = detail.title;
await ev("document.querySelector('.template-detail-preview .mini-poster-slide').click()");
await sleep(250);
const afterClick = await ev("document.querySelector('.template-detail-preview .mini-poster-title')?.textContent?.trim() || ''");
assert.notEqual(afterClick, beforeClick, '点击海报应切换到下一张');
assert.equal(afterClick, '午后茶点 8 折');

// 切回经典点餐：详情预览必须回到 hero 兜底，而不是残留海报
const classicIndex = cards.findIndex((card) => card.recipe === '经典点餐');
await ev(`document.querySelectorAll('.template-card')[${classicIndex}].click()`);
await sleep(250);
const classicDetail = await ev(`({
  hasPoster: !!document.querySelector('.template-detail-preview .mini-poster'),
  hasHero: !!document.querySelector('.template-detail-preview .mini-hero'),
  recipeMeta: document.querySelector('.template-detail-meta')?.textContent?.trim() || '',
})`);
assert.equal(classicDetail.hasPoster, false, '切到经典点餐后不应残留海报块');
assert.equal(classicDetail.hasHero, true, '经典点餐应显示 hero 兜底');
assert.ok(classicDetail.recipeMeta.includes('经典点餐'));

// 四个 tab 在两种配方下都可用
const tabResults = {};
for (const [label, selector] of [['首页', '.mini-hero'], ['菜单', '.mini-products'], ['订单', '.mini-order-steps'], ['我的', '.mini-mine-card']]) {
  await click('.template-detail-preview .mini-phone-tab', label);
  await until(() => ev(`!!document.querySelector(${JSON.stringify(`.template-detail-preview ${selector}`)})`), `tab ${label}`);
  tabResults[label] = true;
}

const consoleErrors = await ev("window.__cdpConsoleErrors ? window.__cdpConsoleErrors.length : 0");

console.log(JSON.stringify({
  url: 'http://127.0.0.1:5187/',
  cards,
  detail: { ...detail, afterClick, clickedIndexChanged: afterClick !== beforeClick },
  classicDetail,
  tabs: tabResults,
  runtimeErrors,
  consoleErrors,
}, null, 2));

assert.deepEqual(runtimeErrors, [], '页面不应有运行时异常');
ws.close();