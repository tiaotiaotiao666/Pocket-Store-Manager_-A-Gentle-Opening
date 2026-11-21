import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-selftest-'));
const config = {
  schemaVersion: 1,
  apiBaseUrl: 'http://127.0.0.1:3101/api/v1',
  modelChannel: 'server',
  modelApiBaseUrl: 'https://api.deepseek.com',
  modelName: 'deepseek-flash',
  modelTimeoutMs: 60000,
  agentTransport: 'http',
  agentEndpoint: '/api/v1/agent/turn',
  agentTimeoutMs: 120000,
  defaultAppid: 'wx3b1c04f63cf6cfd0',
  autoSaveEnabled: true,
  autoSaveDebounceMs: 800,
  maxBackups: 3,
  lastProjectId: '',
  uiScale: 'default',
};
fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');

const env = { ...process.env, VITE_API_BASE_URL: 'http://127.0.0.1:3101/api/v1', VITE_IMPORT_AUTH_MODE: 'demo' };
delete env.ELECTRON_RUN_AS_NODE;

const port = 9355;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], { env, cwd: ROOT });
child.stdout.on('data', (chunk) => process.stdout.write('[electron] ' + chunk.toString()));
child.stderr.on('data', (chunk) => process.stdout.write('[electron:err] ' + chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPage() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && String(item.url).includes('5173'));
      if (page) return page;
    } catch {
      /* 端口还没起 */
    }
    await sleep(1000);
  }
  throw new Error('CDP 页面未就绪');
}

const page = await waitPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
};
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) return { exception: result.result.exceptionDetails.text };
  return result.result?.result?.value;
};
await call('Runtime.enable');

await sleep(6000);
console.log('BRIDGE', JSON.stringify(await evaluate(`(()=>({
  hasSmartStore: typeof window.smartStore,
  isDesktop: window.smartStore && window.smartStore.isDesktop,
  probeDevtools: typeof (window.smartStore && window.smartStore.probeDevtools),
  keys: window.smartStore ? Object.keys(window.smartStore).slice(0, 40) : []
}))()`)));

console.log('PROBE_DIRECT', JSON.stringify(await evaluate(`(async()=>{
  if(!window.smartStore || typeof window.smartStore.probeDevtools!=='function') return {skip:true};
  const started=Date.now();
  const race=await Promise.race([
    window.smartStore.probeDevtools().then((value)=>({settled:true,value})).catch((error)=>({settled:false,error:String(error)})),
    new Promise((resolve)=>setTimeout(()=>resolve({timeout:true}),9000))
  ]);
  return {elapsedMs:Date.now()-started, ...race};
})()`)));

console.log('READYZ_DIRECT', JSON.stringify(await evaluate(`(async()=>{
  const started=Date.now();
  try {
    const response=await fetch('/api/v1/readyz',{cache:'no-store'});
    const text=await response.text();
    return {elapsedMs:Date.now()-started,status:response.status,body:text.slice(0,120)};
  } catch(error) { return {elapsedMs:Date.now()-started,error:String(error)}; }
})()`)));

console.log('GUIDE_STATE', JSON.stringify(await evaluate(`(()=>({
  refresh:(()=>{const b=[...document.querySelectorAll('.env-guide-actions button')].map((el)=>String(el.textContent||'').trim());return b;})(),
  items:[...document.querySelectorAll('.env-guide-check-item')].map((el)=>String(el.innerText||'').replace(/\\s+/g,' ').slice(0,50))
}))()`)));

// 复制真实链路的第一步：点「新建项目」，然后按秒观察清单是否停在「检测中…」。
await evaluate("(()=>{const el=document.querySelector('button[aria-label=\"新建项目：创建空白门店项目\"]');if(el)el.click();return Boolean(el);})()");
for (let tick = 1; tick <= 10; tick += 1) {
  await sleep(2000);
  const state = await evaluate(`(()=>({
    ticks:${tick},
    guide:!!document.querySelector('.env-guide-card'),
    refresh:(()=>{const b=[...document.querySelectorAll('.env-guide-actions button')].map((el)=>String(el.textContent||'').trim());return b.join('|');})(),
    items:[...document.querySelectorAll('.env-guide-check-item')].map((el)=>String(el.innerText||'').replace(/\\s+/g,' ').slice(0,50)),
    start:!!document.querySelector('.flow-home-start'),
    composer:!!document.querySelector('.workspace-composer .composer-input')
  }))()`);
  console.log('GUIDE_TICK', JSON.stringify(state));
}

socket.close();
child.kill();
await sleep(1500);
console.log('USERDATA', userDataDir);
process.exit(0);
