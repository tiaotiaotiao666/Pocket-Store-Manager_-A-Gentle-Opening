#!/usr/bin/env node
/**
 * P5 桌面端主流程走查（Electron + CDP 真实点击）。
 *
 * 走查「新建项目 → AI 填写门店/菜品 → 继续修改 → 模板选择 → 参考截图 →
 * 海报素材 → 预览 → 导出闸门」的真实结果，每步截图 + 记录状态。
 * 拿不到真实结果的步骤（例如需要原生目录对话框的导出）一律标 BLOCKED 并写明原因，
 * 不把构造调用或接口测试当成 UI 验收。
 *
 * 采用「按当前阶段驱动」的写法：每个阶段用界面上真实存在的文案判定，
 * 再执行该阶段唯一的下一步动作。这样阶段顺序变化（是否经过店铺装修）不会让走查假失败。
 *
 * 前置：vite 在 127.0.0.1:5173；electron 带 --remote-debugging-port=9222；
 *       后端 readyz 为 ok（真实 DeepSeek 调用）。
 *
 * 用法：
 *   node scripts/p5-desktop-walkthrough.cjs --phase flow     # 主流程（默认）
 *   node scripts/p5-desktop-walkthrough.cjs --phase restore  # 重开恢复校验
 */
const fs = require('node:fs');
const path = require('node:path');

const cdp = require('./desktop-cdp.cjs');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const phase = argValue('--phase', 'flow');
const outDir = path.resolve(argValue('--out', '.arts/p5'));
const shotsDir = path.join(outDir, 'shots');
const reportFile = path.join(outDir, phase === 'restore' ? 'desktop-restore.json' : 'desktop-walkthrough.json');

const report = { phase, startedAt: new Date().toISOString(), target: '', steps: [], artifacts: {} };

function record(id, title, status, observation, extra = {}) {
  report.steps.push({ id, title, status, observation, at: new Date().toISOString(), ...extra });
  console.log('[' + status + '] ' + id + ' ' + title + '：' + observation);
}

async function step(session, id, title, fn) {
  try {
    const result = await fn();
    if (result !== 'skip') record(id, title, 'PASS', (result && result.observation) || '完成');
    return result;
  } catch (error) {
    record(id, title, 'FAIL', String((error && error.message) || error));
    return null;
  }
}

function save() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
}

const TEXT = 'document.body.innerText.replace(/\\n{2,}/g, "\\n")';

async function text(session, from = 0, to = 4000) {
  return session.evaluate(TEXT + '.slice(' + from + ', ' + to + ')');
}

async function shot(session, name) {
  const file = path.join(shotsDir, name + '.png');
  await session.screenshot(file);
  report.artifacts[name] = path.relative(process.cwd(), file);
  return name;
}

function buttonExpr(label) {
  return 'Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === '
    + JSON.stringify(label) + ' && b.getBoundingClientRect().width > 0 && !b.disabled)';
}

async function clickButton(session, label) {
  const labels = Array.isArray(label) ? label : [label];
  let lastError = null;
  for (const item of labels) {
    try {
      return await session.clickAt(buttonExpr(item));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('找不到按钮：' + labels.join('/'));
}

function hasButton(session, label) {
  return session.evaluate('Boolean(' + buttonExpr(label) + ')');
}

async function waitText(session, needle, { timeoutMs = 60000, label = '' } = {}) {
  return session.waitFor('document.body.innerText.includes(' + JSON.stringify(needle) + ')', {
    timeoutMs,
    label: label || needle,
  });
}

async function fillTextarea(session, value) {
  const filled = await session.evaluate(`(() => {
    const area = Array.from(document.querySelectorAll('textarea')).find((node) => node.getBoundingClientRect().width > 0);
    if (!area) return null;
    area.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, ${JSON.stringify(value)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return area.value.slice(0, 30);
  })()`);
  if (!filled) throw new Error('找不到可输入的会话输入框');
  await cdp.sleep(300);
  return filled;
}

async function dismissNotice(session) {
  const closed = await session.evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('button')).find((node) => (node.innerText || '').trim() === '关闭');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (closed) await cdp.sleep(400);
  return closed;
}

/**
 * 读当前阶段：以「本阶段独有的动作按钮」判定。
 * 文本判定不可靠——阶段名（生图提示词/海报素材）会出现在流程条和历史消息里，
 * 之前就因此把模板阶段误判成生图阶段，循环空转。
 */
async function detectStage(session) {
  return session.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => (b.innerText || '').trim());
    const has = (label) => labels.includes(label);
    const t = document.body.innerText;
    if (has('选择导出位置') || has('我已了解')) return 'deploy';
    if (has('暂时跳过') || has('上传图片（PNG）')) return 'poster';
    if (has('这版可以了，开始生成')) return 'prompt';
    if (has('资料无误，继续') || has('整理资料') || has('返回修改资料') || has('确认店铺信息')) return 'store-info';
    if (has('重新匹配骨架') || has('应用修改') || has('下一步')) return 'template';
    if (has('加入定制能力')) return 'features';
    if (has('命名并开始')) return 'naming';
    if (t.includes('选择一个方案以开始构建')) return 'home';
    return 'unknown';
  })()`);
}

async function phaseFlow(session) {
  // S0：回到项目列表
  await step(session, 'S0', '连接桌面窗口', async () => {
    await session.send('Page.bringToFront');
    const info = await session.evaluate('({ w: innerWidth, h: innerHeight, vis: document.visibilityState })');
    if (info.vis !== 'visible') throw new Error('窗口不可见（visibilityState=' + info.vis + '），走查结果无效');
    await clickButton(session, '我的项目').catch(() => null);
    await waitText(session, '新建项目', { label: '项目列表' });
    await shot(session, '00-projects');
    report.target = session.target.url;
    return { observation: '窗口可见 ' + info.w + '×' + info.h + '，项目列表已加载' };
  });

  // S1：新建项目并命名（含轻启介绍推进）
  await step(session, 'S1', '新建项目并命名', async () => {
    await clickButton(session, '新建项目');
    await waitText(session, '选择一个方案以开始构建', { label: '新项目会话' });
    await cdp.sleep(1200);
    await dismissNotice(session);
    await clickButton(session, '开始');
    await waitText(session, '请给你的店铺小程序命名', { label: '命名步骤' });
    await fillTextarea(session, '柑橘小馆演示店');
    await clickButton(session, '命名并开始');
    await waitText(session, '柑橘小馆演示店', { label: '项目命名生效' });
    await shot(session, '01-named');
    const deadline = Date.now() + 150000;
    let stage = '';
    while (Date.now() < deadline) {
      stage = await detectStage(session);
      if (stage === 'features') break;
      if (await hasButton(session, '跳过')) await clickButton(session, '跳过').catch(() => null);
      await cdp.sleep(1200);
    }
    if (stage !== 'features') throw new Error('轻启介绍未推进到功能选择，当前阶段=' + stage);
    return { observation: '项目创建并命名为「柑橘小馆演示店」，已推进到功能选择' };
  });

  // S2：功能选择 → 候选模板
  await step(session, 'S2', '功能选择并生成候选模板', async () => {
    await shot(session, '02-features');
    await clickButton(session, '加入定制能力');
    await session.waitFor(
      'document.body.innerText.includes("候选模板") && document.body.innerText.includes("街巷食集")',
      { timeoutMs: 180000, label: '候选模板' },
    );
    const info = await session.evaluate(`(() => {
      const t = document.body.innerText;
      const names = ['街巷食集', '一杯日常', '主厨推荐'].filter((name) => t.includes(name));
      return { names, rankSource: t.includes('本地规则（模型不可用）') ? '本地规则（模型不可用）' : '服务端排序' };
    })()`);
    if (info.names.length < 2) throw new Error('候选模板不足：' + JSON.stringify(info.names));
    report.artifacts.candidates = info.names;
    await shot(session, '03-templates');
    return { observation: '候选模板：' + info.names.join(' / ') + '；推荐来源=' + info.rankSource };
  });

  // S3：模板选择（真实点击候选卡片）
  await step(session, 'S3', '选择候选模板', async () => {
    await session.clickText('一杯日常', { exact: false });
    await cdp.sleep(1500);
    const chosen = await session.evaluate('(() => { const t = document.body.innerText; const i = t.indexOf("当前使用"); return i < 0 ? "" : t.slice(i, i + 24).replace(/\\s+/g, " "); })()');
    await shot(session, '04-template-chosen');
    if (!chosen) throw new Error('未能读取「当前使用」状态');
    return { observation: '点击「一杯日常」后：' + chosen };
  });

  // S3b：预览面板真实交互（点底部「菜单」标签）
  await step(session, 'S3b', '预览面板交互', async () => {
    await session.clickText('菜单', { exact: true });
    await cdp.sleep(1200);
    const showed = await session.evaluate('(() => { const t = document.body.innerText; return { hasPreview: t.includes("实时小程序预览"), dish: /招牌|拼盘|饭|茶/.test(t) }; })()');
    await shot(session, '04b-preview-menu');
    if (!showed.hasPreview) throw new Error('预览面板未出现');
    return { observation: '预览面板存在，点击底部「菜单」标签后菜品可见=' + showed.dish };
  });
  const visited = [];
  let storeTurn = 0;
  for (let guard = 0; guard < 30; guard += 1) {
    const stage = await detectStage(session);
    if (visited[visited.length - 1] !== stage) visited.push(stage);
    if (stage === 'deploy') break;

    if (stage === 'template') {
      await step(session, 'S4', '确认模板并进入下一步', async () => {
        if (await hasButton(session, '下一步')) await clickButton(session, '下一步');
        else throw new Error('模板阶段找不到「下一步」');
        await cdp.sleep(2500);
        const next = await detectStage(session);
        return { observation: '已从模板阶段进入：' + next };
      });
      continue;
    }

    if (stage === 'store-info') {
      storeTurn += 1;
      if (storeTurn === 1) {
        await step(session, 'S5', 'AI 填写门店与菜品', async () => {
          await fillTextarea(session, '店名是柑橘小馆，社区家常菜，10:00-21:00，堂食和自取，招牌牛肉饭 28 元、柠香鸡腿饭 26 元、时令小食拼盘 16 元。');
          await clickButton(session, '整理资料');
          await waitText(session, '资料完成度', { timeoutMs: 180000, label: '资料草稿' });
          await session.waitFor('document.body.innerText.includes("5/5")', { timeoutMs: 180000, label: '资料齐全' });
          const summary = await session.evaluate('(() => { const t = document.body.innerText; const i = t.indexOf("当前门店配置"); return i < 0 ? "" : t.slice(i, i + 180).replace(/\\n+/g, " | "); })()');
          await shot(session, '05-agent-filled');
          return { observation: 'AI 回填完成：' + summary };
        });
      } else if (storeTurn === 2) {
        await step(session, 'S6', '继续修改门店资料（第二轮 AI）', async () => {
          if (await hasButton(session, '返回修改资料')) {
            await clickButton(session, '返回修改资料');
            await cdp.sleep(800);
          }
          await fillTextarea(session, '时令小食拼盘改成 18 元，再加一道桂花酸梅汤 12 元。');
          const labels = await session.evaluate(`(() => Array.from(document.querySelectorAll('button'))
            .filter((b) => b.getBoundingClientRect().width > 0)
            .map((b) => (b.innerText || '').trim() + (b.disabled ? '(禁用)' : ''))
            .filter(Boolean))()`);
          report.artifacts.storeInfoButtons = labels;
          await clickButton(session, ['整理资料', '资料无误，继续', '确认这版提示词', '应用修改']);
          await session.waitFor('document.body.innerText.includes("桂花酸梅汤")', { timeoutMs: 180000, label: '新增菜品落地' });
          const state = await session.evaluate(`(() => {
            const t = document.body.innerText;
            return { hasNew: t.includes('桂花酸梅汤'), has18: t.includes('18.00') || /18\\s*元/.test(t) };
          })()`);
          await shot(session, '06-agent-revised');
          if (!state.hasNew) throw new Error('第二轮修改未落到草稿');
          return { observation: '第二轮修改生效：新增桂花酸梅汤=' + state.hasNew + '，18 元=' + state.has18 };
        });
      } else {
        await step(session, 'S7', '确认资料与店铺信息', async () => {
          if (await hasButton(session, '资料无误，继续')) {
            await clickButton(session, '资料无误，继续');
            await cdp.sleep(2000);
          }
          await shot(session, '07-store-info');
          if (await hasButton(session, '确认店铺信息')) {
            await clickButton(session, '确认店铺信息');
            await cdp.sleep(2500);
          }
          return { observation: '已确认资料；当前阶段=' + (await detectStage(session)) };
        });
      }
      continue;
    }

    if (stage === 'prompt') {
      await step(session, 'S8', '生图提示词阶段', async () => {
        const prompt = await session.evaluate('(() => { const t = document.body.innerText; const i = t.indexOf("生图提示词"); return i < 0 ? "" : t.slice(i, i + 200).replace(/\\n+/g, " | "); })()');
        await shot(session, '08-prompt-studio');
        if (await hasButton(session, '这版可以了，开始生成')) await clickButton(session, '这版可以了，开始生成');
        await cdp.sleep(2500);
        return { observation: '提示词已确认并继续：' + prompt.slice(0, 120) };
      });
      continue;
    }

    if (stage === 'poster') {
      await step(session, 'S9', '海报素材阶段（生图能力现状）', async () => {
        const body = await text(session);
        const notWired = body.includes('尚未接入生图服务');
        await shot(session, '09-poster');
        record('S9a', 'AI 生图（真实图像生成）', 'BLOCKED',
          notWired
            ? '界面明示「尚未接入生图服务，当前版本不会生成海报」；本机未接入真实生图服务，不伪造素材。'
            : '未观察到「尚未接入生图服务」说明，需要人工复核。');
        if (await hasButton(session, '暂时跳过')) await clickButton(session, '暂时跳过');
        await cdp.sleep(2500);
        return { observation: '海报步骤未阻断生成，已按界面提示跳过（生图能力另记 BLOCKED）' };
      });
      continue;
    }

    if (stage === 'home' || stage === 'naming' || stage === 'features') {
      // 回退到了前段：尽量推进
      if (await hasButton(session, '开始')) await clickButton(session, '开始');
      else if (await hasButton(session, '命名并开始')) await clickButton(session, '命名并开始');
      else if (await hasButton(session, '加入定制能力')) await clickButton(session, '加入定制能力');
      await cdp.sleep(2000);
      continue;
    }

    await cdp.sleep(2000);
  }
  report.artifacts.stagesVisited = visited;

  // S10：预览证据复核（预览在模板阶段已真实点过，见 S3b）
  await step(session, 'S10', '预览证据复核', async () => {
    if (!report.artifacts['04b-preview-menu']) throw new Error('缺少预览截图，S3b 未执行');
    const files = ['03-templates', '04-template-chosen', '04b-preview-menu'].filter((name) => report.artifacts[name]);
    await shot(session, '10-preview');
    return { observation: '预览证据链：' + files.join(' / ') + '（模板阶段真实点按预览标签）' };
  });

  // S11：导出闸门（体检提示 + plan 摘要）
  await step(session, 'S11', '导出闸门与体检提示', async () => {
    await waitText(session, '选择导出位置', { timeoutMs: 60000, label: '导出步骤' });
    let guard = 0;
    while ((await hasButton(session, '我已了解')) && guard < 4) {
      await clickButton(session, '我已了解');
      await cdp.sleep(700);
      guard += 1;
    }
    const gate = await session.evaluate('(() => { const m = document.body.innerText.match(/Plan 摘要[^\\n]*/); return m ? m[0] : ""; })()');
    await shot(session, '11-deploy');
    if (!(await hasButton(session, '选择导出位置'))) throw new Error('导出按钮仍不可用，闸门未打开');
    return { observation: '体检提示确认 ' + guard + ' 次；' + (gate || '未读取到 Plan 摘要') };
  });

  // S12：真实点击「选择导出位置」→ 原生对话框
  await step(session, 'S12', '点击选择导出位置', async () => {
    await clickButton(session, '选择导出位置');
    await cdp.sleep(2500);
    const pending = await session.evaluate('document.body.innerText.includes("生成进度")');
    await shot(session, '12-export-dialog');
    record('S12a', 'UI 导出到指定目录', 'BLOCKED',
      '「选择导出位置」调用主进程 dialog.showOpenDialog 打开原生目录对话框：CDP 只能点到按钮，无法在原生对话框里选目录；'
      + '按 P5 要求不追 UIA/ACL。导出改由同一 IPC + Composer 通道在命令行复核并比对产物。生成进度区出现=' + pending);
    return 'skip';
  });
}

async function phaseRestore(session) {
  await step(session, 'R0', '重开后连接窗口', async () => {
    await session.send('Page.bringToFront');
    const info = await session.evaluate('({ vis: document.visibilityState, w: innerWidth, h: innerHeight })');
    if (info.vis !== 'visible') throw new Error('窗口不可见，恢复校验无效');
    await shot(session, '20-restored-list');
    return { observation: '窗口可见 ' + info.w + '×' + info.h };
  });

  await step(session, 'R1', '重开后项目仍在列表', async () => {
    if (await hasButton(session, '我的项目')) await clickButton(session, '我的项目');
    await waitText(session, '柑橘小馆演示店', { timeoutMs: 30000, label: '项目卡片' });
    const count = await session.evaluate('(() => { const m = document.body.innerText.match(/(\\d+)\\s*个项目/); return m ? Number(m[1]) : 0; })()');
    await shot(session, '21-restored-list');
    return { observation: '项目列表仍有「柑橘小馆演示店」，共 ' + count + ' 个项目' };
  });

  await step(session, 'R2', '打开项目恢复阶段与资料', async () => {
    await session.clickText('柑橘小馆演示店', { exact: false });
    await waitText(session, '柑橘小馆', { timeoutMs: 60000, label: '项目内容' });
    await cdp.sleep(1500);
    await dismissNotice(session);
    const stage = await detectStage(session);
    const body = await text(session, 0, 3000);
    await shot(session, '22-restored-project');
    const kept = {
      stage,
      dishes: body.includes('招牌牛肉饭') || body.includes('共 3 道') || body.includes('资料已确认'),
      store: body.includes('柑橘小馆'),
    };
    if (!kept.store) throw new Error('项目内容未恢复：' + JSON.stringify(kept));
    return { observation: '恢复阶段=' + kept.stage + '；店名与菜品仍在=' + kept.store + '/' + kept.dishes };
  });
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  const session = await cdp.connect();
  try {
    if (phase === 'restore') await phaseRestore(session);
    else await phaseFlow(session);
  } finally {
    session.close();
    report.summary = {
      pass: report.steps.filter((item) => item.status === 'PASS').length,
      fail: report.steps.filter((item) => item.status === 'FAIL').length,
      blocked: report.steps.filter((item) => item.status === 'BLOCKED').length,
    };
    report.finishedAt = new Date().toISOString();
    save();
    console.log('汇总：PASS ' + report.summary.pass + ' / FAIL ' + report.summary.fail + ' / BLOCKED ' + report.summary.blocked);
    console.log('报告：' + path.relative(process.cwd(), reportFile));
  }
}

main().catch((error) => {
  record('FATAL', '走查中断', 'FAIL', String((error && error.message) || error));
  save();
  process.exitCode = 1;
});
