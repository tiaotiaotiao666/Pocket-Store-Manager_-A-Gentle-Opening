import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 复用已采用候选的项目状态（run A 的 userData 副本），只验证「最终预览」这一步：
// 点预览 → 导出工程 → 调起微信开发者工具，且提示文案必须是新的、不能是点击前的旧文案。
const ROOT = process.cwd();
const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('用法：node preview-dock.mjs <已采用候选的 userData 目录>');
  process.exit(2);
}
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-dock-'));
for (const name of ['config.json', 'projects']) {
  fs.cpSync(path.join(source, name), path.join(workDir, name), { recursive: true });
}
// 清理上一轮预览产物，确保这次是重新导出。
fs.rmSync(path.join(workDir, 'preview-projects'), { recursive: true, force: true });

const port = 9361;
const env = { ...process.env, VITE_API_BASE_URL: 'http://127.0.0.1:3101/api/v1', VITE_IMPORT_AUTH_MODE: 'demo' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--no-sandbox', `--user-data-dir=${workDir}`, `--remote-debugging-port=${port}`], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPage() {
  for (let index = 0; index < 120; index += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && String(item.url).includes('5173'));
      if (page) return page;
    } catch {
      /* 端口未就绪 */
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
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails.text));
  return result.result?.result?.value;
};
const until = async (fn, label, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(400);
  }
  throw new Error('等待超时：' + label);
};
await call('Runtime.enable');

const report = { status: 'FAIL', workDir, steps: [] };

await until(async () => evaluate("document.readyState !== 'loading' && (document.body?.innerText||'').length > 0"), '页面加载', 60000);

// 关闭环境清单（如果因为进入预览而弹出）。
async function dismissGuide() {
  return evaluate(`(()=>{
    const card=document.querySelector('.env-guide-card');
    if(!card) return 'none';
    for(const box of document.querySelectorAll('.env-guide-checklist input[type="checkbox"]')) { if(!box.checked) box.click(); }
    const buttons=[...document.querySelectorAll('.env-guide-actions button')].filter((el)=>!el.disabled);
    const ready=buttons.find((el)=>String(el.textContent||'').includes('已准备就绪')) || buttons.find((el)=>String(el.textContent||'').includes('稍后再做'));
    if(!ready) return 'no-enabled-button';
    ready.click();
    return String(ready.textContent||'').trim();
  })()`);
}

// 应用可能停在项目列表：先打开这个项目（双击卡片/回车），再等「继续制作」。
if (await evaluate("!document.querySelector('.preview-dock-btn') && !document.querySelector('.prompt-studio')")) {
  const opened = await evaluate(`(()=>{
    const cards=[...document.querySelectorAll('button')].filter((el)=>String(el.textContent||'').includes('T6链路验证店'));
    if(!cards.length) return false;
    const card=cards[0];
    card.click();
    card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    return true;
  })()`);
  report.projectOpened = opened;
  await sleep(2500);
}

// 项目已采用：应恢复到「继续制作」，预览按钮在 dock 里。
try {
  await until(async () => evaluate("!!document.querySelector('.preview-dock-btn') || !!document.querySelector('.prompt-studio')"), '继续制作或预览入口', 90000);
} catch (error) {
  const dump = await evaluate(`(()=>({
    body:(document.body?.innerText||'').slice(0,1500),
    buttons:[...document.querySelectorAll('button')].map((el)=>String(el.textContent||el.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0,40)
  }))()`);
  console.log('RESTORE_FAILED_DUMP ' + JSON.stringify(dump, null, 2));
  report.status = 'BLOCKED';
  report.blockedReason = '项目未能恢复到继续制作/预览入口';
  report.dump = dump;
  fs.writeFileSync(path.join(ROOT, '.resultverify', 't6', 'preview-dock-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  socket.close();
  child.kill();
  await sleep(1000);
  process.exit(2);
}
report.steps.push({ name: 'project-restored', state: await evaluate(`(()=>({
  studio:!!document.querySelector('.prompt-studio'),
  dock:!!document.querySelector('.preview-dock-btn'),
  body:(document.body?.innerText||'').slice(0,150)
}))()`) });

await until(async () => evaluate("!!document.querySelector('.preview-dock-btn')"), '预览按钮', 60000);
const noticeBefore = await evaluate("document.querySelector('.preview-dock-note')?.innerText || ''");
report.noticeBefore = noticeBefore;
await evaluate("(()=>{const el=document.querySelector('.preview-dock-btn');el.click();return true;})()");

try {
  await until(async () => evaluate("!!document.querySelector('.env-guide-card')"), '预览环境清单', 20000);
  report.guideDismiss = await dismissGuide();
  await sleep(1500);
} catch {
  report.guideDismiss = 'not-shown';
}

const previewRoot = path.join(workDir, 'preview-projects');
const listPreviewDirs = () => (fs.existsSync(previewRoot)
  // .appid-backup / .smartstore-tmp-* 都是导出过程的侧车目录，不属于工程本身。
  ? fs.readdirSync(previewRoot).filter((name) => !name.startsWith('.'))
  : []);

// 点预览后可能先弹环境清单（点「已准备就绪」后再自动继续），所以这里按「导出目录出现」或
// 「明确告警」两种终态等待；中间态（is-info 的正在…）继续等，不能拿它当结论。
const outcome = await until(async () => {
  const state = await evaluate(`(()=>{
    const note=document.querySelector('.preview-dock-note');
    return { text:note?.innerText||'', tone:note?.className||'' };
  })()`);
  const dirs = listPreviewDirs();
  const warn = String(state.tone).includes('is-warn');
  if (dirs.length > 0 && !warn) return { ...state, exported: true };
  if (warn && state.text && state.text !== noticeBefore) return { ...state, exported: false };
  return null;
}, '预览导出与工具调起', 300000);
report.outcome = outcome;

// 「已发起启动请求，正在确认工具窗口…」只是中间态：必须等到确认成功或明确告警再下结论。
let confirmState = null;
try {
  confirmState = await until(async () => {
    const state = await evaluate(`(()=>{
      const note=document.querySelector('.preview-dock-note');
      return { text:note?.innerText||'', tone:note?.className||'' };
    })()`);
    if (!state.text || state.text === noticeBefore) return null;
    if (String(state.tone).includes('is-info') && state.text.includes('正在')) return null;
    return state;
  }, '工具窗口确认', 120000);
} catch {
  confirmState = {
    text: await evaluate("document.querySelector('.preview-dock-note')?.innerText || ''"),
    tone: 'timeout',
  };
}
report.confirmState = confirmState;

const dirs = listPreviewDirs();
report.previewDirs = dirs;
report.exportedProject = dirs.length > 0 ? (() => {
  const dir = path.join(previewRoot, dirs[0]);
  const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  const projectConfigPath = path.join(dir, 'project.config.json');
  const projectConfig = fs.existsSync(projectConfigPath) ? JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')) : {};
  const postprocessPath = path.join(dir, 'appid-postprocess.json');
  return {
    dirLabel: dirs[0],
    pages: (appJson.pages || []).length,
    projectAppid: projectConfig.appid || '',
    appidPostprocess: fs.existsSync(postprocessPath),
    hasLock: fs.existsSync(path.join(dir, 'composition.lock.json')),
  };
})() : null;

// 判定：导出成功 + 工具窗口得到确认（非 warn、非中间态）才算 PASS；
// 只有导出而工具窗口未确认时记 PARTIAL（导出 PASS / 调起未确认），绝不合并成 PASS。
const confirmText = String(report.confirmState?.text || '');
const confirmTone = String(report.confirmState?.tone || '');
const warn = confirmTone.includes('is-warn') || confirmTone.includes('timeout');
// 「已启动，但窗口里还没显示页面」是启动成功、页面未确认：必须与「页面已打开」区分开。
const pageShown = !warn && /页面已|已打开|已进入小程序/.test(confirmText);
const launched = !warn && Boolean(confirmText) && !confirmText.includes('正在');
report.verdict = {
  export: report.exportedProject ? 'PASS' : 'FAIL',
  openDevtools: pageShown ? 'PASS' : (launched ? 'BLOCKED' : 'FAIL'),
  confirmText,
  confirmTone,
  note: pageShown ? '工具已打开工程页面' : (launched ? '工具已启动，但工程页面未确认（提示需在工具里点一次编译）' : '工具未确认'),
};
report.status = report.verdict.export === 'PASS' && report.verdict.openDevtools === 'PASS'
  ? 'PASS'
  : (report.verdict.export === 'PASS' ? 'PARTIAL' : 'FAIL');
report.logTail = logs.join('').split('\n').filter((line) => line.trim() && !line.includes('libpng')).slice(-8);
fs.writeFileSync(path.join(ROOT, '.resultverify', 't6', 'preview-dock-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('PREVIEW_DOCK_RESULT ' + JSON.stringify(report, null, 2));

socket.close();
child.kill();
await sleep(1000);
process.exit(report.status === 'PASS' ? 0 : 1);
