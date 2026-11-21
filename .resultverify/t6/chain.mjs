import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(ROOT, 'server');
const require = createRequire(import.meta.url);
const debug = require(path.join(ROOT, 'scripts', 'agent-debug.cjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Map();
const logs = [];
let electronWindow = null;
let userDataDir = null;
const markerFile = path.join(ROOT, 'app-data', 'userdata-path.txt');
const markerBefore = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : null;
const report = { schemaVersion: 'sidebar-chain-probe.v1', status: 'NOT_RUN', checks: [] };

function logStream(child, name) {
  const file = path.join(HERE, `${name}.log`);
  const stream = fs.createWriteStream(file, { flags: 'w' });
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  logs.push(stream);
}

function launch(name, file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  children.set(name, child);
  logStream(child, name);
  return child;
}

async function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitHttp(url, child, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch { /* 有限次等待服务启动。 */ }
    await sleep(250);
  }
  return false;
}

async function stopChild(name) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (name === 'electron-3101' && process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(4000)]);
  }
}

let cdpSocket = null;
let cdpSequence = 0;
const cdpPending = new Map();
const runtimeErrors = [];
const frontendRequests = [];

async function cdpConnect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page' && String(item.url || '').includes('127.0.0.1:5173'));
  assert.ok(target, '未找到隔离 Electron 的 CDP page target');
  cdpSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdpSocket.onopen = resolve; cdpSocket.onerror = reject; });
  cdpSocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = cdpPending.get(message.id);
      if (!item) return;
      cdpPending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails?.text || 'Runtime exception');
    } else if (message.method === 'Network.requestWillBeSent') {
      const url = String(message.params?.request?.url || '');
      if (url.includes('/agent/frontend-reconstruct')) {
        frontendRequests.push({
          requestId: message.params?.requestId || null,
          method: message.params?.request?.method || null,
          url,
          observedAt: new Date().toISOString(),
        });
      }
    }
  };
  await cdpCall('Page.enable');
  await cdpCall('Runtime.enable');
  await cdpCall('Network.enable');
}

function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSequence;
    cdpPending.set(id, { resolve, reject });
    cdpSocket.send(JSON.stringify({ id, method, params }));
  });
}

async function ev(expression) {
  const result = await cdpCall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function domSnapshot() {
  const snapshot = await ev(`(()=>({
    title:document.title,
    url:location.href,
    bodyText:document.body?.innerText?.slice(0,12000)||'',
    controls:[...document.querySelectorAll('button,input,textarea,select,[role="button"]')].map((el,index)=>({
      index,tag:el.tagName,id:el.id||'',type:el.type||'',name:el.getAttribute('aria-label')||'',text:(el.innerText||el.value||'').slice(0,300),placeholder:el.placeholder||'',accept:el.accept||'',disabled:Boolean(el.disabled)
    }))
  }))()`);
  fs.writeFileSync(path.join(HERE, 'chain-cdp-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  return snapshot;
}

async function until(fn, label, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(150);
  }
  const body = await ev("document.body?.innerText?.slice(0,4000)").catch(() => 'unavailable');
  throw new Error(`等待超时：${label}; ${lastError?.message || 'no value'}; body=${body}`);
}

async function click(selector, text) {
  const found = await ev(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=nodes.find((node)=>${text === undefined ? 'true' : `node.textContent.includes(${JSON.stringify(text)})`});if(!el)return false;el.click();return true;})()`);
  assert.equal(found, true, `无法点击 ${selector} ${text || ''}`);
}

async function setValue(selector, value, index = 0) {
  const found = await ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})][${index}];if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  assert.equal(found, true, `无法输入 ${selector}[${index}]`);
}

async function setFileInput(selector, file) {
  const documentNode = await cdpCall('DOM.getDocument', { depth: 1 });
  const input = await cdpCall('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector });
  assert.ok(input.nodeId, `找不到文件输入框 ${selector}`);
  await cdpCall('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collectCandidateArtifacts() {
  const artifacts = [];
  const projectsDir = path.join(userDataDir, 'projects');
  if (!fs.existsSync(projectsDir)) return artifacts;
  for (const projectId of fs.readdirSync(projectsDir)) {
    const runsDir = path.join(projectsDir, projectId, 'frontend-runs');
    if (!fs.existsSync(runsDir)) continue;
    for (const runId of fs.readdirSync(runsDir)) {
      const attemptsDir = path.join(runsDir, runId, 'attempts');
      if (!fs.existsSync(attemptsDir)) continue;
      for (const attemptName of fs.readdirSync(attemptsDir)) {
        const attemptDir = path.join(attemptsDir, attemptName);
        const verificationDir = path.join(attemptDir, 'verification');
        const dryFile = path.join(verificationDir, 'dry-run', 'frontend-dry-run.json');
        const item = { projectId, runId, attempt: attemptName };
        if (fs.existsSync(dryFile)) {
          const dry = readJson(dryFile);
          item.dryRun = { ok: dry.ok, code: dry.code, plan: dry.details?.plan || null };
          const storeFile = path.join(verificationDir, 'dry-run', 'candidate', 'config', 'store.generated.js');
          if (fs.existsSync(storeFile)) item.storeGenerated = fs.readFileSync(storeFile, 'utf8');
        }
        if (fs.existsSync(verificationDir)) {
          for (const name of fs.readdirSync(verificationDir)) {
            if (!name.startsWith('runtime')) continue;
            const runtimeFile = path.join(verificationDir, name, 'frontend-runtime.json');
            if (!fs.existsSync(runtimeFile)) continue;
            const runtime = readJson(runtimeFile);
            item.runtime = {
              status: runtime.status,
              code: runtime.code,
              summary: runtime.summary,
              screenshots: runtime.artifacts?.screenshots || [],
              details: runtime.details || null,
            };
          }
        }
        const adoptedFile = path.join(attemptDir, 'adopted.json');
        if (fs.existsSync(adoptedFile)) item.adopted = readJson(adoptedFile);
        artifacts.push(item);
      }
    }
  }
  return artifacts;
}

async function main() {
  if (await portBusy(3101)) {
    report.status = 'BLOCKED';
    report.blockedReason = '端口 3101 已被其他进程占用，未盲目终止或假定已加载新代码';
    console.log(`BLOCKED ${report.blockedReason}`);
    return;
  }
  if (!(await portBusy(5173))) {
    report.status = 'BLOCKED';
    report.blockedReason = '5173 没有可复用的本仓库 Vite';
    console.log(`BLOCKED ${report.blockedReason}`);
    return;
  }
  const servedModule = await fetch('http://127.0.0.1:5173/src/services/importService.js');
  const servedText = await servedModule.text();
  if (!servedModule.ok || !servedText.includes('profile.businessHours') || !servedText.includes('完整对齐本轮 payload')) {
    report.status = 'BLOCKED';
    report.blockedReason = '5173 served 模块尚未包含 T6 稳定 confirmations，不能假定 HMR 已加载修复';
    console.log(`BLOCKED ${report.blockedReason}`);
    return;
  }
  report.checks.push({ name: 'reuse-vite-hmr-confirmed', status: 'PASS', port: 5173 });

  launch('server-3101', process.execPath, [path.join(SERVER, 'dist', 'main.js')], {
    cwd: SERVER,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '3101',
      SERVER_HOST: '127.0.0.1',
      ALLOW_DEMO_LOGIN: 'true',
      AGENT_REQUIRE_AUTH: 'false',
      CACHE_DRIVER: 'memory',
      CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,app://desktop',
    },
  });
  assert.ok(await waitHttp('http://127.0.0.1:3101/api/v1/health', children.get('server-3101')), '3000 服务未就绪');
  report.checks.push({ name: 'isolated-server', status: 'PASS', port: 3000 });

  const viteEnv = {
    ...process.env,
    VITE_API_BASE_URL: 'http://127.0.0.1:3101/api/v1',
    VITE_IMPORT_AUTH_MODE: 'demo',
  };
  assert.ok(await waitHttp('http://127.0.0.1:5173/', { exitCode: null }), '5173 Vite 未就绪');

  const windowsBefore = new Set(debug.listWindows().map((item) => item.id));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-t6-electron-'));
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
  const electronEnv = { ...viteEnv };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  let remoteDebugPort = 9333;
  while (remoteDebugPort <= 9340 && (await portBusy(remoteDebugPort))) remoteDebugPort += 1;
  assert.ok(remoteDebugPort <= 9340, '9333–9340 均被占用，无法建立隔离 CDP');
  launch('electron-3101', path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${remoteDebugPort}`], { env: electronEnv });
  assert.ok(await waitHttp(`http://127.0.0.1:${remoteDebugPort}/json/list`, { exitCode: null }, 120), 'Electron CDP 端口未就绪');

  for (let index = 0; index < 60 && !electronWindow; index += 1) {
    if (children.get('electron-3101').exitCode !== null) break;
    const candidates = debug.listWindows().filter((item) => !windowsBefore.has(item.id)
      && String(item.title || '').includes('口袋店长')
      && item.accessible !== false);
    if (candidates.length) electronWindow = candidates[0];
    else await sleep(1000);
  }
  assert.ok(electronWindow, '未找到本次隔离 Electron 窗口');
  await until(async () => {
    try { await cdpConnect(remoteDebugPort); return true; } catch { return false; }
  }, 'Electron CDP page', 30000);
  await until(() => ev("document.readyState !== 'loading' && (document.body?.innerText?.length || 0) > 0"), 'Electron DOM', 45000);
  const snapshot = await domSnapshot();
  report.status = 'PASS';
  report.uiaStatus = 'BLOCKED';
  report.uiaBlockedReason = 'agent-desktop: INTERNAL private file DACL grants an untrusted principal；此处只使用 Electron CDP，不冒充 UIA';
  report.checks.push({ name: 'electron-cdp-snapshot', status: 'PASS', windowId: electronWindow.id, controls: snapshot.controls.length });
  report.userDataDir = userDataDir;
  console.log(`ELECTRON_CDP_SNAPSHOT PASS window=${electronWindow.id} controls=${snapshot.controls.length} userData=${userDataDir}`);
  console.log(JSON.stringify(snapshot.controls, null, 2));

  // 环境清单会在多处弹出：统一用「稍后再做 / 已准备就绪」把它关掉，避免挡住主流程。
  // prefer='ready' 时点「已准备就绪」——「稍后再做」只是临时关闭，进入新阶段会再弹一次。
  async function dismissGuides(times = 3, prefer = 'later') {
    for (let index = 0; index < times; index += 1) {
      const closed = await ev(`(()=>{
        const card=document.querySelector('.env-guide-card');
        if(!card) return 'none';
        const buttons=[...document.querySelectorAll('.env-guide-actions button, .env-guide-actions a')];
        const later=buttons.find((el)=>String(el.textContent||'').includes('稍后再做'));
        const ready=buttons.find((el)=>String(el.textContent||'').includes('已准备就绪'));
        if(${prefer === 'ready' ? 'true' : 'false'}){
          // 预览模式下「已准备就绪」要求全部勾选，否则按钮是 disabled：先勾完再点。
          for(const box of document.querySelectorAll('.env-guide-checklist input[type="checkbox"]')){
            if(!box.checked) box.click();
          }
        }
        const target=${prefer === 'ready' ? 'ready||later' : 'later||ready'};
        if(!target) return 'no-button';
        if(target.disabled) return 'disabled:' + target.textContent.trim();
        target.click();
        return target.textContent.trim();
      })()`);
      report.guideDismissals = [...(report.guideDismissals || []), closed];
      if (closed === 'none') return;
      await sleep(700);
    }
  }

  await click('button[aria-label="新建项目：创建空白门店项目"]');
  await sleep(1200);
  await dismissGuides();
  // 环境清单会在进入新阶段时重复弹出。注意：每次点「开始」都会重新触发一遍环境检测，
  // 所以这里不能高频重复点击——必须先等清单检测结束（按钮可用）再关掉，然后才看是否进到命名步骤。
  async function reachNaming(timeoutMs = 180000) {
    const started = Date.now();
    const trace = [];
    let round = 0;
    while (Date.now() - started < timeoutMs) {
      round += 1;
      const state = await ev(`(()=>({
        composer:!!document.querySelector('.workspace-composer .composer-input'),
        start:!!document.querySelector('.flow-home-start'),
        guide:!!document.querySelector('.env-guide-card'),
        guideButton:(()=>{const el=document.querySelector('.env-guide-actions button:not([disabled])');return el?String(el.textContent||'').trim():'';})(),
        refresh:(()=>{const b=[...document.querySelectorAll('.env-guide-actions button')].find((el)=>String(el.textContent||'').includes('检测'));return b?String(b.textContent||'').trim():'';})()
      }))()`);
      if (state.composer) {
        report.reachNaming = { rounds: round, trace: trace.slice(-6) };
        return;
      }
      trace.push(state);
      if (state.guide) {
        // 等某检测结束后再关：最多等 25 秒，超时也必须继续，由后面的等待给出诚实结论。
        try {
          await until(() => ev("!!document.querySelector('.env-guide-actions button:not([disabled])')"), '清单检测结束', 25000);
        } catch {
          /* 超时按原样继续 */
        }
        await dismissGuides(1, round > 2 ? 'ready' : 'later');
        await until(() => ev("!document.querySelector('.env-guide-card')"), '清单关闭', 8000).catch(() => {});
        await sleep(800);
        continue;
      }
      if (state.start) {
        const clicked = await ev("(()=>{const el=document.querySelector('.flow-home-start');if(!el)return false;el.click();return true;})()");
        if (clicked) report.homeStartClicks = (report.homeStartClicks || 0) + 1;
        await sleep(1500);
        continue;
      }
      await sleep(1000);
    }
    report.reachNaming = { rounds: round, failed: true, trace: trace.slice(-6) };
    throw new Error('无法进入项目命名步骤：' + JSON.stringify(trace.slice(-4)));
  }

  await until(() => ev("!!document.querySelector('.flow-home-start')"), '空白项目首页');
  await reachNaming();
  await setValue('.workspace-composer .composer-input', `T6链路验证店${String(Date.now()).slice(-6)}`);
  await click('.workspace-composer .composer-send');
  await sleep(500);
  await dismissGuides();
  await until(() => ev("!!document.querySelector('.workspace-skip button')"), '跳过引导', 60000);
  await click('.workspace-skip button');
  await dismissGuides();
  await until(() => ev("!!document.querySelector('#project-agent-composer .composer-input') && !!document.querySelector('.agent-chat-attachments-input')"), '侧栏输入', 60000);
  report.checks.push({ name: 'isolated-project-created', status: 'PASS' });

  await click('.agent-chat-attachments-kind', '参考界面');
  const referenceImage = path.join(ROOT, 'docs', 'evidence', 'm7', 'wechat', 'order-classic-home.png');
  await setFileInput('.agent-chat-attachments-input', referenceImage);
  await until(() => ev("document.querySelectorAll('.agent-chat-attachment').length === 1"), '参考图附件');
  const utterance = '店名是T6链路验证店，品类是社区餐馆，每天09:00-21:00，堂食和自取。菜品有验证炒饭23.45元、番茄炒蛋16元、米饭3元。首页按图生成新骨架。订单列表保留现有首页数据与order-card，底部导航使用Base原生tabBar，不需要从图片推断数据或实现；其它区域按参考图结构生成，保留门店与点餐能力。';
  await setValue('#project-agent-composer .composer-input', utterance);
  const beforeSend = await ev(`(()=>({attachments:document.querySelectorAll('.agent-chat-attachment').length,draft:document.querySelector('#project-agent-composer .composer-input')?.value||''}))()`);
  assert.equal(beforeSend.attachments, 1);
  assert.equal(beforeSend.draft, utterance);
  await click('#project-agent-composer .composer-send');
  report.checks.push({ name: 'sidebar-reference-sent', status: 'PASS', attachmentCount: 1 });

  const firstOutcome = await until(() => ev(`(()=>{
    const consent=!!document.querySelector('#screen-send-confirm');
    const error=document.querySelector('#project-agent-error')?.innerText||document.querySelector('.screen-ref-error')?.innerText||'';
    return consent||error?{consent,error}:null;
  })()`), '资料写回与外发确认', 180000);
  const writebackEvidence = await ev(`(()=>({
    sidebar:document.querySelector('#project-agent-sidebar')?.innerText||'',
    changes:[...document.querySelectorAll('.agent-chat-changes')].map((el)=>el.innerText),
    panel:document.querySelector('#frontend-reconstruct-panel')?.innerText||''
  }))()`);
  report.sidebarWriteback = writebackEvidence;
  if (!firstOutcome.consent) throw new Error(`侧栏未进入外发确认：${firstOutcome.error || JSON.stringify(writebackEvidence).slice(0, 3000)}`);
  report.checks.push({ name: 'sidebar-writeback-and-consent', status: 'PASS', changeCards: writebackEvidence.changes.length });
  const consentStartedAt = Date.now();
  await click('#screen-send-confirm');
  const readCandidateState = () => ev(`(()=>{
    const adoptButton=!!document.querySelector('#frontend-adopt-button');
    const error=document.querySelector('#project-agent-error')?.innerText||document.querySelector('.screen-ref-error')?.innerText||'';
    const panel=document.querySelector('#frontend-reconstruct-panel')?.innerText||'';
    const busy=panel.includes('任务正在运行，等它结束再采用');
    const adopt=adoptButton&&!busy;
    const cancelled=/已取消/.test(panel);
    const stopped=/还需要补充|需要补充信息|能力覆盖不足|生成候选失败|识别失败|未能生成|无法生成|没有可构建的草稿/.test(panel);
    const runtimeStarted=panel.includes('微信真实编译与截图');
    return {adopt,busy,error,panel,cancelled,stopped,runtimeStarted,terminal:adopt||Boolean(error)||cancelled||stopped};
  })()`);
  let terminal = null;
  const consentGate = await until(async () => {
    const state = await readCandidateState();
    if (state.terminal) {
      terminal = state;
      return { terminal: true };
    }
    if (frontendRequests.length > 0) return { requestSeen: true };
    return null;
  }, '确认后 180 秒内的真实重构请求或终态', 180000);
  report.frontendRequests = frontendRequests;
  report.checks.push({
    name: 'consent-request-or-terminal-within-180s',
    status: 'PASS',
    elapsedMs: Date.now() - consentStartedAt,
    requestCount: frontendRequests.length,
    terminal: Boolean(terminal),
  });

  if (!terminal) {
    const buildGate = await until(async () => {
      const state = await readCandidateState();
      if (state.terminal) {
        terminal = state;
        return { terminal: true };
      }
      if (state.runtimeStarted) return { runtimeStarted: true };
      return null;
    }, '真实请求后的候选构建/微信验证起点', 300000);
    if (!terminal && buildGate.runtimeStarted) {
      report.checks.push({ name: 'candidate-runtime-started', status: 'PASS' });
      terminal = await until(async () => {
        const state = await readCandidateState();
        return state.terminal ? state : null;
      }, '微信验证终态', 720000);
    }
  }
  if (!terminal) throw new Error('候选链没有形成可判定的终态');
  report.candidatePanel = terminal.panel;
  report.candidateArtifacts = collectCandidateArtifacts();
  const candidateArtifact = report.candidateArtifacts.at(-1) || null;
  if (!terminal.adopt) {
    throw new Error(`候选未进入可采用/部分采用终态：${terminal.error || terminal.panel.slice(0, 3000)}`);
  }
  if (!candidateArtifact?.dryRun?.ok) {
    throw new Error(`候选缺少通过的 dry-run 证据：${JSON.stringify(candidateArtifact)}`);
  }
  report.checks.push({
    name: 'sidebar-auto-analyze-build-verify',
    status: 'PASS',
    runId: candidateArtifact.runId,
    attempt: candidateArtifact.attempt,
    planSource: candidateArtifact.dryRun.plan?.source || null,
    runtimeStatus: candidateArtifact.runtime?.status || 'NOT_RUN',
  });

  const adoptGate = await ev(`(()=>{const button=document.querySelector('#frontend-adopt-button');const partial=document.querySelector('#frontend-partial-confirm');return {disabled:Boolean(button?.disabled),partial:Boolean(partial),partialChecked:Boolean(partial?.checked)};})()`);
  if (adoptGate.disabled && adoptGate.partial) {
    await click('#frontend-partial-confirm');
  }
  const adoptDisabled = await ev("Boolean(document.querySelector('#frontend-adopt-button')?.disabled)");
  if (adoptDisabled) throw new Error(`当前候选禁止继续制作：${terminal.panel.slice(0, 3000)}`);
  const devtoolsBeforeAdopt = debug.listWindows().filter((item) => String(item.title || '').includes('微信')).length;
  await click('#frontend-adopt-button');
  await until(() => ev("!!document.querySelector('.prompt-studio')"), '采用后进入继续制作');
  const devtoolsAfterAdopt = debug.listWindows().filter((item) => String(item.title || '').includes('微信')).length;
  assert.equal(devtoolsAfterAdopt, devtoolsBeforeAdopt, '采用候选不得自动打开新的微信窗口');
  report.checks.push({ name: 'adopt-current-candidate-continue', status: 'PASS', devtoolsBeforeAdopt, devtoolsAfterAdopt });

  await until(() => ev("!!document.querySelector('.preview-dock-btn')"), '最终微信预览入口');
  const noticeBefore = await ev("document.querySelector('.preview-dock-note')?.innerText || ''");
  report.previewNoticeBefore = noticeBefore;
  await click('.preview-dock-btn');
  let guideShown = false;
  try {
    await until(() => ev("!!document.querySelector('.env-guide-card')"), '预览环境清单', 60000);
    guideShown = true;
  } catch {
    guideShown = false;
  }
  report.envGuideShown = guideShown;
  if (guideShown) {
    await ev(`(()=>{const boxes=[...document.querySelectorAll('.env-guide-checklist input[type="checkbox"]')];for(const box of boxes){if(!box.checked)box.click();}return boxes.length;})()`);
    await click('.env-guide-actions .primary-button', '已准备就绪');
  }
  const previewParentEarly = path.join(userDataDir, 'preview-projects');
  const hasPreviewDir = () => {
    if (!fs.existsSync(previewParentEarly)) return false;
    return fs.readdirSync(previewParentEarly).some((name) => {
      // 原子写会短暂出现 .smartstore-tmp-* 目录，可能在扫描瞬间被改名：读不到就跳过。
      if (name.startsWith('.smartstore-tmp')) return false;
      try {
        return fs.statSync(path.join(previewParentEarly, name)).isDirectory();
      } catch {
        return false;
      }
    });
  };
  const dockOutcome = await until(async () => {
    const state = await ev(`(()=>{const note=document.querySelector('.preview-dock-note');return {text:note?.innerText||'',tone:note?.className||''};})()`);
    const changed = Boolean(state.text) && state.text !== noticeBefore;
    if (!changed) return null;
    if (state.tone.includes('is-warn')) return state;
    if (hasPreviewDir()) return state;
    return null;
  }, '最终预览导出与工具调起', 420000);
  report.finalPreviewDock = dockOutcome;
  if (dockOutcome.tone.includes('is-warn')) throw new Error(`最终预览失败：${dockOutcome.text}`);

  const previewParent = path.join(userDataDir, 'preview-projects');
  const previewDirs = fs.existsSync(previewParent)
    ? fs.readdirSync(previewParent).map((name) => path.join(previewParent, name)).filter((dir) => fs.statSync(dir).isDirectory())
    : [];
  assert.ok(previewDirs.length > 0, '最终预览没有生成工程目录');
  previewDirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const finalProjectDir = previewDirs[0];
  const finalStoreGenerated = fs.readFileSync(path.join(finalProjectDir, 'config', 'store.generated.js'), 'utf8');
  const finalAppid = readJson(path.join(finalProjectDir, 'project.config.json')).appid;
  assert.equal(finalAppid, 'wx3b1c04f63cf6cfd0');
  if (candidateArtifact.storeGenerated) {
    const candidateStoreId = candidateArtifact.storeGenerated.match(/["']id["']:\s*["']([^"']+)["']/)?.[1] || null;
    const finalStoreId = finalStoreGenerated.match(/["']id["']:\s*["']([^"']+)["']/)?.[1] || null;
    const candidatePackId = candidateArtifact.storeGenerated.match(/["']frontendPackId["']:\s*["']([^"']+)["']/)?.[1] || null;
    const finalPackId = finalStoreGenerated.match(/["']frontendPackId["']:\s*["']([^"']+)["']/)?.[1] || null;
    assert.ok(candidateStoreId && candidateStoreId === finalStoreId, `最终预览门店不一致：${candidateStoreId} vs ${finalStoreId}`);
    assert.ok(candidatePackId && candidatePackId === finalPackId, `最终预览候选包不一致：${candidatePackId} vs ${finalPackId}`);
    report.finalPreviewSameSource = { candidateStoreId, finalStoreId, candidatePackId, finalPackId, appid: finalAppid };
  }
  report.checks.push({ name: 'final-preview-same-source-export-launch', status: 'PASS', dock: dockOutcome, appid: finalAppid });
  assert.deepEqual(runtimeErrors, [], `Electron 运行时异常：${runtimeErrors.join('; ')}`);
}

try {
  await main();
} catch (error) {
  report.status = report.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL';
  report.error = { message: error?.message || String(error), stack: error?.stack || null };
  console.error(`ELECTRON_PROBE_FAILURE ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  if (cdpSocket) cdpSocket.close();
  for (const name of ['electron-3101', 'server-3101']) await stopChild(name);
  if (markerBefore === null) {
    try { if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile); } catch { /* 恢复指针失败不掩盖主结果。 */ }
  } else {
    try { fs.writeFileSync(markerFile, markerBefore, 'utf8'); } catch { /* 同上。 */ }
  }
  for (const stream of logs) stream.end();
  fs.writeFileSync(path.join(HERE, 'chain-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`ELECTRON_PROBE_RESULT ${report.status}`);
}