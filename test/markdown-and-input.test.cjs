const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const desktopLinks = require('../desktop/external-link.cjs');

async function loadMarkdown() {
  return import('../src/domain/markdownView.mjs');
}

async function loadComposer() {
  return import('../src/domain/composerInput.mjs');
}

async function loadRunService() {
  return import('../src/services/agentTurn/agentRunService.js');
}

async function loadProcess() {
  return import('../src/domain/agentRunProcess.mjs');
}

// ---------------------------------------------------------------------------
// Markdown 白名单
// ---------------------------------------------------------------------------

test('M1 Markdown 白名单：标题 / 粗体 / 斜体 / 列表 / 引用 / 行内代码 / 代码块 / 链接', async () => {
  const { parseMarkdown, toPlainText } = await loadMarkdown();
  const source = [
    '# 开店清单',
    '',
    '请确认 **店名** 与 *营业时间*，也可以看看 `priceCents` 字段。',
    '',
    '- 堂食',
    '- 自取',
    '',
    '1. 先核对菜单',
    '2. 再确认营业时间',
    '',
    '> 资料齐了才能生成小程序。',
    '',
    '```js',
    'const total = 28 + 16;',
    '```',
    '',
    '参考 [轻启文档](https://example.com/help?from=chat)。',
  ].join('\n');

  const { blocks } = parseMarkdown(source);
  const types = blocks.map((block) => block.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'list', 'list', 'quote', 'codeBlock', 'paragraph']);

  const heading = blocks[0];
  assert.equal(heading.level, 1);
  assert.equal(toPlainText([heading]), '开店清单');

  const paragraph = blocks[1];
  const kinds = paragraph.children.map((node) => node.type);
  assert.ok(kinds.includes('strong'), '粗体要识别');
  assert.ok(kinds.includes('em'), '斜体要识别');
  assert.ok(kinds.includes('code'), '行内代码要识别');
  const strong = paragraph.children.find((node) => node.type === 'strong');
  assert.equal(strong.children[0].text, '店名');

  assert.deepEqual(blocks[2].items.map((item) => item.children[0].text), ['堂食', '自取']);
  assert.equal(blocks[2].ordered, false);
  assert.deepEqual(blocks[3].items.map((item) => item.children[0].text), ['先核对菜单', '再确认营业时间']);
  assert.equal(blocks[3].ordered, true);

  assert.equal(blocks[4].type, 'quote');
  assert.equal(toPlainText([blocks[4]]), '资料齐了才能生成小程序。');

  assert.equal(blocks[5].type, 'codeBlock');
  assert.equal(blocks[5].lang, 'js');
  assert.equal(blocks[5].text, 'const total = 28 + 16;');

  const link = blocks[6].children.find((node) => node.type === 'link');
  assert.ok(link, '普通链接要识别');
  assert.equal(link.href, 'https://example.com/help?from=chat');
  assert.equal(toPlainText([{ children: link.children }]), '轻启文档');
});

test('M2 原始 HTML 一律按文本处理，不产生可执行节点', async () => {
  const { parseMarkdown, toPlainText } = await loadMarkdown();
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">点我</a>',
    '<svg/onload=alert(1)>',
  ];
  for (const payload of attacks) {
    const { blocks } = parseMarkdown(`帮你整理：${payload}`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'paragraph');
    assert.ok(
      blocks[0].children.every((node) => node.type === 'text' || node.type === 'br'),
      `${payload} 不应生成 strong/em/code/link 之外的节点`,
    );
    assert.equal(toPlainText(blocks), `帮你整理：${payload}`, 'HTML 应作为可见文本原样保留');
  }
});

test('M3 链接协议白名单：只放行 http/https，伪装与危险协议全部拦住', async () => {
  const { sanitizeExternalUrl, parseMarkdown } = await loadMarkdown();

  const allowed = [
    'https://example.com/a?b=1#c',
    'http://127.0.0.1:3000/x',
  ];
  for (const url of allowed) {
    assert.ok(sanitizeExternalUrl(url), `${url} 应放行`);
  }

  const blocked = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'java\u200bscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/calc.exe',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    '//example.com/protocol-relative',
    '/relative/path',
    'https://user:pass@example.com/x',
    '',
    null,
    undefined,
    12345,
  ];
  for (const url of blocked) {
    assert.equal(sanitizeExternalUrl(url), null, `${String(url)} 必须拒绝`);
  }

  // 危险链接在 AST 里降级为普通文本，绝不生成 link 节点
  const { blocks } = parseMarkdown('看这里 [点我](javascript:alert(1)) 和 [正常](https://example.com)。');
  const nodes = blocks[0].children;
  const links = nodes.filter((node) => node.type === 'link');
  assert.equal(links.length, 1, '只保留合法链接');
  assert.equal(links[0].href, 'https://example.com/');
  assert.ok(
    nodes.some((node) => node.type === 'text' && node.text.includes('javascript:alert(1)')),
    '危险链接按原文显示，不能变成可点击节点',
  );
});

test('M4 点击链接只走桌面受控通道，不自动打开、不导航', async () => {
  const { resolveLinkAction } = await loadMarkdown();

  const opened = [];
  const withBridge = resolveLinkAction('https://example.com/x', {
    openExternal: (url) => { opened.push(url); },
  });
  assert.equal(withBridge.kind, 'external');
  assert.equal(withBridge.url, 'https://example.com/x');
  assert.deepEqual(opened, [], '判定阶段绝不自动打开');

  const blockedByScheme = resolveLinkAction('javascript:alert(1)', {
    openExternal: (url) => { opened.push(url); },
  });
  assert.equal(blockedByScheme.kind, 'blocked');
  assert.equal(blockedByScheme.reason, 'UNSAFE_URL');
  assert.deepEqual(opened, [], '危险协议不得触达桌面通道');

  // 浏览器里没有桌面桥：什么也不做，也不退回 window.open
  const noBridge = resolveLinkAction('https://example.com/x', {});
  assert.equal(noBridge.kind, 'blocked');
  assert.equal(noBridge.reason, 'NO_DESKTOP_BRIDGE');
});

test('M5 渲染前抹掉堆栈与密钥痕迹，不当正文展示', async () => {
  const { stripInternalNoise, parseMarkdown, toPlainText } = await loadMarkdown();
  const dirty = [
    '整理完成，但有个小问题。',
    '    at Object.<anonymous> (C:\\app\\src\\server.js:42:13)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'api key: sk-abcdef1234567890abcdef',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');

  const cleaned = stripInternalNoise(dirty);
  assert.ok(!cleaned.includes('server.js:42:13'), '堆栈行要移除');
  assert.ok(!cleaned.includes('task_queues'), '内部调用栈要移除');
  assert.ok(!cleaned.includes('sk-abcdef1234567890abcdef'), '密钥要抹掉');
  assert.ok(!cleaned.includes('MIIEowIBAAKCAQEA'), '私钥正文要抹掉');
  assert.ok(cleaned.includes('整理完成'), '正常内容要保留');

  const { blocks } = parseMarkdown(dirty);
  const plain = toPlainText(blocks);
  assert.ok(!plain.includes('sk-'), '渲染结果里不能出现密钥');
});

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

test('I1 纯空白不允许提交，中文/换行/标点原样保留', async () => {
  const { analyzeComposerInput } = await loadComposer();

  for (const blank of ['', '   ', '\n\n', '\t\t', '\u3000\u3000', ' \n\t\u3000 ']) {
    const analysis = analyzeComposerInput(blank);
    assert.equal(analysis.canSubmit, false, `${JSON.stringify(blank)} 不应允许提交`);
    assert.equal(analysis.text, '');
  }

  const chinese = '  开一家面馆，\n主推「牛肉面」28 元；营业时间 10:00-21:00。\n  ';
  const analysis = analyzeComposerInput(chinese);
  assert.equal(analysis.canSubmit, true);
  assert.equal(analysis.text, '开一家面馆，\n主推「牛肉面」28 元；营业时间 10:00-21:00。');
  assert.ok(analysis.text.includes('\n'), '换行必须保留');
  assert.ok(analysis.text.includes('「牛肉面」'), '中文标点必须保留');
  assert.equal(analysis.overLimit, false);
});

test('I2 超过长度上限时阻止提交并给出明确提示', async () => {
  const { analyzeComposerInput, COMPOSER_MAX_CHARS, countChars } = await loadComposer();

  assert.equal(COMPOSER_MAX_CHARS, 500);
  const atLimit = analyzeComposerInput('面'.repeat(COMPOSER_MAX_CHARS));
  assert.equal(atLimit.canSubmit, true);
  assert.equal(atLimit.overLimit, false);
  assert.equal(atLimit.remaining, 0);

  const over = analyzeComposerInput('面'.repeat(COMPOSER_MAX_CHARS + 1));
  assert.equal(over.canSubmit, false);
  assert.equal(over.overLimit, true);
  assert.match(over.notice, /超过上限 500 字/);
  assert.match(over.notice, /请精简后再发送/);

  // 中文/emoji 都按「字」计数，不按字节或代理对
  assert.equal(countChars('牛肉面'), 3);
  assert.equal(countChars('🍜'), 1);
  assert.equal(analyzeComposerInput('🍜'.repeat(501)).overLimit, true);
});

test('I3 连续点击/连按回车不重复提交同一轮', async () => {
  const { createSubmitGuard } = await loadComposer();

  let clock = 1_000;
  const guard = createSubmitGuard({ now: () => clock, windowMs: 400 });

  assert.equal(guard.accept('开一家面馆'), true);
  clock += 80;
  assert.equal(guard.accept('开一家面馆'), false, '同一段文字的连击必须被拦');
  clock += 900;
  assert.equal(guard.accept('开一家面馆'), true, '过了时间窗，用户确实想再发一次要放行');
  assert.equal(guard.accept('  '), false, '空白永远不放行');
  guard.reset();
  assert.equal(guard.accept('开一家面馆'), true);
});

// ---------------------------------------------------------------------------
// 桌面端受控打开（主进程侧再校验一次）
// ---------------------------------------------------------------------------

test('D1 主进程只允许 http/https，通过与渲染层一致的黑名单', async () => {
  const { sanitizeExternalUrl } = desktopLinks;
  const renderer = await loadMarkdown();

  const vectors = [
    'https://example.com/a',
    'http://127.0.0.1:5173',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/Windows/win.ini',
    'vbscript:msgbox(1)',
    'https://user:pass@example.com/x',
    '//example.com',
    '',
  ];
  for (const url of vectors) {
    assert.equal(
      sanitizeExternalUrl(url),
      renderer.sanitizeExternalUrl(url),
      `渲染层与主进程对 ${url} 的判定必须一致`,
    );
  }
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeExternalUrl('https://example.com/a'), 'https://example.com/a');
});

test('D2 打开动作：合法链接交给 shell，非法链接不触达 shell', async () => {
  const calls = [];
  const shell = { openExternal: async (url) => { calls.push(url); } };

  const ok = await desktopLinks.openExternalLink('https://example.com/help', { shell });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, ['https://example.com/help']);

  const blocked = await desktopLinks.openExternalLink('javascript:alert(1)', { shell });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'URL_BLOCKED');
  assert.deepEqual(calls, ['https://example.com/help'], '危险链接不得调用 shell');

  const failing = await desktopLinks.openExternalLink('https://example.com/x', {
    shell: { openExternal: async () => { throw new Error('boom'); } },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 'OPEN_FAILED');
  assert.ok(!/boom/.test(failing.message), '不要把底层异常原文抛给界面');

  const noShell = await desktopLinks.openExternalLink('https://example.com/x', {});
  assert.equal(noShell.code, 'SHELL_UNAVAILABLE');
});

test('D3 窗口只允许停留在应用自身页面，外链不导航', async () => {
  const { isAllowedAppUrl } = desktopLinks;
  const devPrefixes = ['http://127.0.0.1:5173'];
  assert.equal(isAllowedAppUrl('http://127.0.0.1:5173/#/store', devPrefixes), true);
  assert.equal(isAllowedAppUrl('https://evil.example.com', devPrefixes), false);
  assert.equal(isAllowedAppUrl('javascript:alert(1)', devPrefixes), false);
  assert.equal(isAllowedAppUrl('', devPrefixes), false);
  assert.equal(isAllowedAppUrl('http://127.0.0.1:5173', []), false);
});

test('D4 主进程与 preload 已接线：拒绝新窗口、限制导航、暴露受控外链通道', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.cjs'), 'utf8');

  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /on\('will-navigate'/);
  assert.match(mainSource, /ipcMain\.handle\('shell:open-external'/);
  assert.ok(mainSource.includes("require('./external-link.cjs')"));
  assert.match(preloadSource, /openExternalLink: \(url\) => ipcRenderer\.invoke\('shell:open-external'/);
  // 渲染层不得有 window.open / location 跳转兜底
  const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'chat', 'MarkdownView.jsx'), 'utf8');
  assert.ok(!viewSource.includes('window.open'), '前端不得自行开窗');
  assert.ok(!viewSource.includes('dangerouslySetInnerHTML'), 'Markdown 渲染不得注入 HTML');
  assert.ok(!/target=/.test(viewSource), '不得使用 target=_blank 自动开窗');
});

// ---------------------------------------------------------------------------
// W2 / W3 不回归
// ---------------------------------------------------------------------------

test('R1 W4 之后 W2 路由与 W3 过程卡语义不变', async () => {
  const runService = await loadRunService();
  const process = await loadProcess();

  assert.equal(
    runService.resolveAgentRequestRoute({ phase: 'store-info', imageCount: 0, transportMode: 'http' }),
    'agent-run.v1',
  );
  assert.equal(
    runService.resolveAgentRequestRoute({ phase: 'store-info', imageCount: 1, transportMode: 'http' }),
    'agent-turn.v2',
  );
  assert.equal(
    runService.resolveAgentRequestRoute({ phase: 'store-info', imageCount: 0, transportMode: 'mock' }),
    'agent-turn.v1',
  );

  const failed = process.buildProcessView({
    trace: {
      modelCalls: 2,
      toolCalls: [{ callId: 'c1', name: 'update_store_draft', ok: false, attempts: 1, truncated: false }],
      stopReason: 'time_limit',
      degraded: true,
    },
  });
  assert.equal(failed.tone, 'partial');
  assert.equal(failed.title, '部分完成');

  const done = process.buildProcessView({
    trace: {
      modelCalls: 3,
      toolCalls: [
        { callId: 'c1', name: 'get_store_draft', ok: true, attempts: 1, truncated: false },
        { callId: 'c2', name: 'update_store_draft', ok: true, attempts: 1, truncated: false },
      ],
      stopReason: 'final_answer',
      degraded: false,
    },
  });
  assert.deepEqual(done.steps.map((step) => step.label), ['理解需求', '读取门店资料', '更新门店资料', '校验信息']);
});

test('R2 会话气泡接的是 Markdown 视图，用户输入仍是纯文本', () => {
  const bubbleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'chat', 'MessageBubble.jsx'), 'utf8');
  assert.ok(bubbleSource.includes('MarkdownView'), 'Agent 气泡必须走白名单渲染');
  assert.ok(bubbleSource.includes('bubble-user">{text}'), '用户气泡保持纯文本');
  assert.ok(!bubbleSource.includes('dangerouslySetInnerHTML'));
});
