'use strict';

/**
 * E0-U1 组件静态门禁：原型组件必须是「只吃 props 的纯展示件」，并且每个可交互控件都有可读名称。
 *
 * 只读源码、不渲染 React（渲染放在 E3 的 UIA 走查）。这里锁三件事：
 * 1. 边界：没有 `window.smartStore` / `ipcRenderer` / `src/services/**` / reducer 依赖；
 * 2. 可访问性：每个 button/input/textarea/select 与 role=radio|checkbox 元素都有 `aria-label`，
 *    关键容器有 `role` + `aria-label`，交互锚点有稳定 `id`（映射 UIA automation_id，避免同名 AMBIGUOUS_TARGET）；
 * 3. 口径：未知阶段、缺图 MISSING/BLOCKED、四态、BLOCKED/NOT_RUN 原因都必须真的出现在渲染路径里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const E0_DIR = path.join(REPO, 'src', 'components', 'agent', 'e0');

const FILES = Object.freeze({
  targetPage: path.join(E0_DIR, 'TargetPageSelect.jsx'),
  image: path.join(E0_DIR, 'ReferenceImageUploader.jsx'),
  utterance: path.join(E0_DIR, 'UtteranceInput.jsx'),
  progress: path.join(E0_DIR, 'RunProgressBar.jsx'),
  candidate: path.join(E0_DIR, 'CandidateSummaryCard.jsx'),
  barrel: path.join(E0_DIR, 'index.js'),
  contract: path.join(E0_DIR, 'e0UiContract.mjs'),
  css: path.join(E0_DIR, 'e0.css'),
});

const ALL_COMPONENT_FILES = Object.freeze([FILES.targetPage, FILES.image, FILES.utterance, FILES.progress, FILES.candidate]);

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 去掉注释后再做边界扫描：注释里会提到“不调 IPC / 不读 window.smartStore”，那是说明不是实现。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 从 JSX 源码里切出每个开始标签（跳过 `=>`、`{...}` 表达式与字符串里的 `>`）。
 * 只做静态检查用，不追求完整 JSX 解析。
 */
function tagChunks(source) {
  const chunks = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start === -1) break;
    let cursor = start + 1;
    let depth = 0;
    let quote = null;
    while (cursor < source.length) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = null;
        cursor += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        cursor += 1;
        continue;
      }
      if (char === '{') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (char === '}') {
        depth = Math.max(0, depth - 1);
        cursor += 1;
        continue;
      }
      if (char === '>' && depth === 0) break;
      cursor += 1;
    }
    chunks.push(source.slice(start, Math.min(cursor + 1, source.length)));
    index = cursor + 1;
  }
  return chunks;
}

const NATIVE_CONTROLS = /^<{1}(button|input|textarea|select)\b/;
const ROLE_CONTROLS = /\brole="(radio|checkbox|switch|combobox|slider|tab|option)"/;

function interactiveTags(source) {
  return tagChunks(source).filter((chunk) => NATIVE_CONTROLS.test(chunk) || ROLE_CONTROLS.test(chunk));
}

test('每个可交互控件都有可读名称（aria-label / aria-labelledby）', () => {
  const mustHaveControls = new Set([FILES.targetPage, FILES.image, FILES.utterance]);
  for (const file of ALL_COMPONENT_FILES) {
    const source = readText(file);
    const tags = interactiveTags(source);
    const name = path.basename(file);
    if (!mustHaveControls.has(file)) {
      // 进度条与候选摘要卡是**只读展示**：不伪造点击；取消/采用/导出按钮属 E3。
      assert.equal(tags.length, 0, `${name} 本轮是只读展示件，不应出现可交互控件`);
      continue;
    }
    assert.ok(tags.length > 0, `${name} 应至少有一个可交互控件（否则这个原型什么都没提供）`);
    for (const tag of tags) {
      const readable = /aria-label=/.test(tag) || /aria-labelledby=/.test(tag);
      assert.ok(readable, `${name} 的可交互控件缺可读名称：${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
      assert.doesNotMatch(tag, /aria-label=""|aria-label={''}/, `${name} 不得留空 aria-label`);
    }
  }
});

test('关键容器有 role + aria-label，重要控件有稳定 id（UIA 锚点）', () => {
  const targetPage = readText(FILES.targetPage);
  assert.match(targetPage, /role="group" aria-label="目标页面选择"/);
  assert.match(targetPage, /role="radiogroup" aria-label="目标页面（单选）"/);
  assert.match(targetPage, /id="e0-target-page-field"/);
  assert.match(targetPage, /id=\{`\$\{idPrefix\}-\$\{page\.id\}`\}/, '每个页面选项要有稳定 id（e0-target-page-<id>）');

  const image = readText(FILES.image);
  assert.match(image, /role="group" aria-label="参考图与同意提示"/);
  assert.match(image, /role="checkbox"/);
  assert.match(image, /aria-checked=\{consentState\.granted\}/);
  assert.match(image, /id="e0-consent-checkbox"/);

  const utterance = readText(FILES.utterance);
  assert.match(utterance, /htmlFor="e0-utterance-input"/);
  assert.match(utterance, /id="e0-utterance-input"/);
  assert.match(utterance, /aria-label="用一句话说明想怎么改"/);

  const progress = readText(FILES.progress);
  assert.match(progress, /role="region" aria-label=\{title\}/);
  assert.match(progress, /role="list" aria-label="阶段列表"/);
  assert.match(progress, /aria-live="polite"/);

  const candidate = readText(FILES.candidate);
  assert.match(candidate, /role="region" aria-label=\{title\}/);
  assert.match(candidate, /id="e0-candidate-summary"/);
});

test('同一屏不出现同名可交互控件（避免 UIA AMBIGUOUS_TARGET）', () => {
  for (const file of ALL_COMPONENT_FILES) {
    const source = readText(file);
    const labels = [];
    for (const tag of interactiveTags(source)) {
      const literal = tag.match(/aria-label="([^"]+)"/);
      if (literal) labels.push(literal[1]);
    }
    const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
    assert.deepEqual(duplicates, [], `${path.basename(file)} 出现重复 aria-label：${duplicates.join(', ')}`);
  }
});

test('组件不直连 IPC / smartStore / services / reducer 状态机', () => {
  for (const file of ALL_COMPONENT_FILES) {
    const source = stripComments(readText(file));
    const name = path.basename(file);
    assert.doesNotMatch(source, /window\.smartStore/, `${name} 不得直接读 window.smartStore（冻结 §11）`);
    assert.doesNotMatch(source, /ipcRenderer|ipcMain|electron/, `${name} 不得直调 IPC/Electron（E0-U1 边界）`);
    assert.doesNotMatch(source, /from '\.\.\/\.\.\/services/, `${name} 不得依赖 src/services（接线在 E3）`);
    assert.doesNotMatch(source, /sessionMachine|useReducer|dispatch\(/, `${name} 不得改 reducer/状态机`);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest/, `${name} 不得发网络请求`);
    assert.doesNotMatch(source, /require\(/, `${name} 组件应为 ESM，不得 require`);
    // 数据/文案只能来自口径模块
    assert.match(readText(file), /from '\.\/e0UiContract\.mjs'/);
  }
});

test('进度条：未知 stage 走「未知阶段（x）」文案且标出来，不静默丢步', () => {
  const source = readText(FILES.progress);
  assert.match(source, /formatStageLabel/, 'stage 文案必须来自口径模块');
  assert.match(source, /step\.stageLabel/, '渲染用的是口径模块算好的 label（未知阶段已带前缀）');
  assert.match(source, /e0-progress-step-unknown/, '未知阶段要有可辨识样式');
  assert.match(source, /data-known-stage=\{unknown \? 'false' : 'true'\}/);
  assert.match(source, /白名单外阶段，按原样保留（不丢步）/);
  assert.match(source, /windowProgressSteps/, '超上限只折叠旧步，且未知阶段仍保留');
  // 四态词必须真的渲染出来
  for (const token of ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']) {
    assert.match(source, new RegExp(`'${token}'`), `进度条必须显式声明状态词 ${token}`);
  }
  // 不许有假进度：没有定时器推进
  assert.doesNotMatch(source, /setInterval|setTimeout/, '进度条不得用定时器伪造推进');
});

test('参考图：缺图显示 MISSING 与 BLOCKED，consent 表达“同意发给模型”', () => {
  const source = readText(FILES.image);
  assert.match(source, /describeReferenceImage/);
  assert.match(source, /imageState\.state/, '状态词来自口径模块（MISSING/READY/BLOCKED）');
  assert.match(source, /参考图缺失提示/);
  assert.match(source, /视觉分析 BLOCKED/);
  assert.match(source, /E0_CONSENT_TEXT/);
  assert.match(source, /E0_CONSENT_LABEL/);
  assert.match(source, /role="note" aria-label="同意状态说明"/);
  // 不读文件：没有 FileReader / createObjectURL / input type=file 之外的读盘动作
  assert.doesNotMatch(source, /FileReader|readAsDataURL|URL\.createObjectURL/, 'E0 只表达选图意图，不读文件内容');
  assert.doesNotMatch(source, /<input\b/, 'E0 原型不自己开原生文件选择框（picker 由主进程提供）');
  assert.match(source, /onRequestPick/, '选图只发出请求回调，由 E3 接 fabric/主进程');
});

test('utterance：受控输入、有上限与缺失提示', () => {
  const source = readText(FILES.utterance);
  assert.match(source, /E0_LIMITS\.maxUtteranceChars/, '长度上限必须来自口径模块');
  assert.match(source, /value=\{text\}/);
  assert.match(source, /onChange=\{handleChange\}/);
  assert.match(source, /MISSING/, '空输入要如实提示 MISSING');
  assert.match(source, /maxLength=\{maxLength\}/);
});

test('候选摘要卡：修改文件数/treeDigest/两套四态/BLOCKED·NOT_RUN 原因都在渲染路径上', () => {
  const source = readText(FILES.candidate);
  assert.match(source, /buildCandidateSummary/, '摘要聚合来自口径模块，不在组件里另算一套');
  assert.match(source, /修改文件数/);
  assert.match(source, /treeDigest/);
  assert.match(source, /静态检查/);
  assert.match(source, /运行时检查（微信）/);
  assert.match(source, /ariaLabel="BLOCKED 原因"/);
  assert.match(source, /ariaLabel="NOT_RUN 原因"/);
  assert.match(source, /aria-label=\{ariaLabel\}/, '原因分组必须有可读名称（不是只有标题文字）');
  assert.match(source, /partial ≠ 通过/);
  assert.match(source, /不等于已采用\/已导出/);
  assert.match(source, /E0_EMPTY_SUMMARY_TEXT/);
  // 四态来自口径模块的标签表，不在组件里另写一份中文状态词
  assert.match(source, /E0_STATUS_LABELS/);
  assert.doesNotMatch(source, /status:\s*'PASS'|status === 'partial'/, '不得在组件里造第五态');
});

test('导出面与自述：index.js 只导出原型件，README 说明不接 App', () => {
  const barrel = readText(FILES.barrel);
  for (const name of ['TargetPageSelect', 'ReferenceImageUploader', 'UtteranceInput', 'RunProgressBar', 'CandidateSummaryCard']) {
    assert.match(barrel, new RegExp(`export \\{ default as ${name} \\}`), `index.js 缺少导出 ${name}`);
  }
  assert.match(barrel, /export \* from '\.\/e0UiContract\.mjs'/);

  const readme = readText(path.join(E0_DIR, 'README.md'));
  assert.match(readme, /不接 App/);
  assert.match(readme, /window\.smartStore/);
  assert.match(readme, /未知阶段/);
  assert.match(readme, /MISSING/);

  const css = readText(FILES.css);
  assert.match(css, /\.e0-progress-step-unknown\s*\{/, '未知阶段样式必须存在');
  for (const token of ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']) {
    assert.match(css, new RegExp(`\\.e0-check-status\\[data-status='${token}'\\]`), `缺少 ${token} 状态样式`);
  }
});

test('aria-describedby / aria-labelledby 指向的 id 必须真的存在于同一组件（否则 UIA 名称会空）', () => {
  for (const file of ALL_COMPONENT_FILES) {
    const source = readText(file);
    const name = path.basename(file);
    const refs = [...source.matchAll(/aria-(?:describedby|labelledby)="([^"]+)"/g)].map((match) => match[1]);
    for (const ref of refs) {
      for (const id of ref.split(/\s+/).filter(Boolean)) {
        assert.match(source, new RegExp(`id="${id}"`), `${name} 的 aria 引用 ${id} 没有对应的 id`);
      }
    }
  }
});

test('本轮不接 App：e0 目录不被 App/RightPanel 引用（接线留给 E3）', () => {
  const appSource = readText(path.join(REPO, 'src', 'App.jsx'));
  assert.doesNotMatch(appSource, /components\/agent\/e0/, 'App.jsx 属 Captain 派单范围，本轮不得被 e0 引用');
  const rightPanel = readText(path.join(REPO, 'src', 'components', 'layout', 'RightPanel.jsx'));
  assert.doesNotMatch(rightPanel, /agent\/e0/, 'RightPanel.jsx 本轮不改');
});

test('组件源码不含中文乱码占位与 TODO 假实现', () => {
  for (const file of ALL_COMPONENT_FILES.concat([FILES.contract])) {
    const source = readText(file);
    const name = path.basename(file);
    assert.doesNotMatch(source, /TODO|FIXME|未实现|待补/, `${name} 不得留未实现标记（原型要能直接落地）`);
    assert.doesNotMatch(source, /\uFFFD/, `${name} 不得包含替换字符（编码损坏）`);
  }
});
