import assert from 'node:assert/strict';

// Independent verification-only CDP driver. It does not instrument the app or React state.
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
async function until(fn, label, timeout = 12000) {
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
  const body = await ev("document.body?.innerText?.slice(0,1200)").catch(() => 'unavailable');
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
async function previewInfo() {
  return ev(`(()=>{const root=document.querySelector('.mini-preview-compact');if(!root)return null;return {text:root.innerText,storeName:root.querySelector('.mini-compact-head b')?.textContent||'',subtitle:root.querySelector('.mini-compact-head small')?.textContent||'',products:[...root.querySelectorAll('.mini-compact-product')].map((el)=>({name:el.querySelector('b')?.textContent||'',price:el.querySelector('small')?.textContent||''}))};})()`);
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
await until(() => ev("!!document.querySelector('.template-gallery')"), 'template gallery', 15000);

const layouts = await ev("[...document.querySelectorAll('.template-card .mini-compact-products')].map((el)=>el.className)");
for (const layout of ['menu', 'catalog', 'editorial']) {
  assert.ok(layouts.some((name) => name.includes(`is-${layout}`)), `Missing ${layout}`);
}
const candidateCount = await ev("document.querySelectorAll('.template-card').length");
const tabEvidence = {};
for (const [label, selector] of [['菜单', '.mini-sec'], ['订单', '.mini-order-steps'], ['我的', '.mini-mine-card'], ['首页', '.mini-products']]) {
  await click('.template-detail-preview .mini-phone-tab', label);
  await until(() => ev(`!!document.querySelector(${JSON.stringify(`.template-detail-preview ${selector}`)})`), `tab ${label}`);
  tabEvidence[label] = await ev("document.querySelector('.template-detail-preview .mini-phone-body')?.innerText||''");
}
await click('.template-detail-preview .mini-phone-tab', '我的');
await ev("document.querySelectorAll('.template-card')[1].click()");
await sleep(200);
const retainedTab = await ev("({active:document.querySelector('.template-detail-preview .mini-phone-tab.is-active')?.textContent||'',mine:!!document.querySelector('.template-detail-preview .mini-mine-card')})");
assert.ok(retainedTab.active.includes('我的') && retainedTab.mine, 'Tab reset on VM update');
await click('.satisfy-prompt-action');
await until(() => ev("!!document.querySelector('.agent-panel') && !!document.querySelector('.mini-preview-compact')"), 'store info');

await setValue('.composer-input', '店名是夜航食堂，品类是深夜家常菜，每天 18:00-23:00，只做堂食。招牌是夜航炒饭 23.45 元。');
await click('.composer-send');
await until(async () => (await previewInfo())?.storeName === '夜航食堂', 'partial DOM name');
const partial = await previewInfo();
const partialStatus = await ev("document.querySelector('.agent-status')?.textContent||''");
assert.ok(partialStatus.includes('还差'), `Expected collecting, got ${partialStatus}`);
assert.equal(partial.subtitle, '深夜家常菜 · 堂食');
assert.deepEqual(partial.products, [{ name: '夜航炒饭', price: '¥23.45' }]);

await setValue('.composer-input', '店名是夜航食堂总店，品类是社区餐馆，每天 08:30-21:30，堂食和自取都做。还有番茄炒蛋 16 元、米饭 3 元。');
await click('.composer-send');
await until(async () => (await previewInfo())?.storeName === '夜航食堂总店', 'full DOM name');
const full = await previewInfo();
assert.equal(full.subtitle, '社区餐馆 · 堂食 · 到店自取');
assert.deepEqual(full.products.map((item) => item.name), ['夜航炒饭', '番茄炒蛋', '米饭']);

const beforeFailure = await previewInfo();
await click('.agent-simulate-switch input');
await setValue('.composer-input', '店名是失败响应店');
await click('.composer-send');
await until(() => ev("!!document.querySelector('.agent-failure')"), 'failure UI');
const afterFailure = await previewInfo();
assert.deepEqual(afterFailure, beforeFailure, 'Failure changed accepted preview');
const failureText = await ev("document.querySelector('.agent-failure')?.innerText||''");
await click('.agent-failure-actions button', '重试这次请求');
await until(async () => (await previewInfo())?.storeName === '失败响应店', 'retry DOM');

await click('.agent-btn-confirm', '资料无误，继续');
await until(() => ev("!!document.querySelector('.agent-summary')"), 'confirmed summary');
const confirmedSummary = await ev("document.querySelector('.agent-summary')?.innerText||''");
await click('.agent-summary button', '返回修改资料');
await until(() => ev("!!document.querySelector('#agent-field-storeName input')"), 'reopened editor');
await setValue('#agent-field-storeName input', '重开未确认新店');
await until(async () => (await previewInfo())?.storeName === '重开未确认新店', 'reopen edit DOM');
await setValue('#agent-field-businessHours input', '07:00-08:00');
await sleep(200);
const editedHours = await previewInfo();
await setValue('#agent-field-storeName input', '<img src=x onerror=window.__xss=1>');
await sleep(200);
const xss = await ev("({name:document.querySelector('.mini-compact-head b')?.textContent||'',injected:!!document.querySelector('.mini-compact-head img'),executed:window.__xss===1})");
assert.equal(xss.name, '<img src=x onerror=window.__xss=1>');
assert.equal(xss.injected, false);
assert.equal(xss.executed, false);

console.log(JSON.stringify({
  url: 'http://127.0.0.1:5187/',
  chrome: '156.0.8078.74',
  layouts,
  candidateCount,
  tabs: Object.fromEntries(Object.entries(tabEvidence).map(([key, value]) => [key, value.slice(0, 100)])),
  retainedTab,
  partial: { status: partialStatus, ...partial, businessHoursExpected: '18:00-23:00', businessHoursDomVisible: partial.text.includes('18:00-23:00') },
  full: { ...full, businessHoursExpected: '08:30-21:30', businessHoursDomVisible: full.text.includes('08:30-21:30') },
  failure: { retainedAcceptedPreview: true, error: failureText, retryUpdatedDom: true },
  confirmReopen: {
    confirmedSummary: confirmedSummary.slice(0, 300),
    reopenedEditName: '重开未确认新店',
    businessHoursAfterManualEditVisible: editedHours.text.includes('07:00-08:00'),
    businessHoursAfterManualEditText: editedHours.text,
  },
  xss,
  runtimeErrors,
}, null, 2));
ws.close();