'use strict';

/**
 * B1：files.cjs 的 list / read / search、路径规范化、链接拒绝与上限。
 *
 * 契约：冻结文档 §1.4 上限、§1.5 路径不变量、§1.7 错误码。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'proj-alpha';
const RUN_ID = 'frun-20261124-b1';
const TURN_ID = 'turn-1';
const PNG_ASSET = 'assets/tabbar/home.png';

const workspaceMod = h.loadModule('workspace');
const filesMod = h.loadModule('files');
const CODES = workspaceMod.CODES;

function setup(t, options) {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, Object.assign({
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'base' },
  }, options));
  assert.strictEqual(created.ok, true, 'createAttempt 失败：' + JSON.stringify(created));
  return { userDataDir, workspace: opened.workspace, attempt: created.attempt };
}

function candidatePath(attempt, relative) {
  return path.join(attempt.candidateDir, ...relative.split('/'));
}

test('listFiles：默认全树、按 POSIX 路径升序、目录过滤有界', (t) => {
  const { attempt } = setup(t);
  const listed = filesMod.listFiles(attempt);
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  const baseFiles = h.listRelativeFiles(h.BASE_SOURCE_DIR);
  assert.deepStrictEqual(listed.files.map((item) => item.path), baseFiles.map((item) => item.path));
  assert.strictEqual(listed.fileCount, baseFiles.length);
  assert.strictEqual(listed.totalBytes, baseFiles.reduce((sum, item) => sum + item.bytes, 0));
  for (const relative of listed.files.map((item) => item.path)) {
    assert.ok(!relative.includes('\\'), '路径必须是 POSIX 形式：' + relative);
    assert.ok(!path.isAbsolute(relative), '路径必须是相对路径：' + relative);
  }

  const pages = filesMod.listFiles(attempt, { dir: 'pages' });
  assert.strictEqual(pages.ok, true, JSON.stringify(pages));
  assert.ok(pages.files.length > 0);
  for (const item of pages.files) {
    assert.ok(item.path.startsWith('pages/'), item.path);
  }

  h.assertFailure(filesMod.listFiles(attempt, { dir: '../templates' }), CODES.PATH_INVALID, '目录穿越');
  h.assertFailure(filesMod.listFiles(attempt, { dir: 'no-such-dir' }), CODES.FILE_NOT_FOUND, '不存在目录');
  h.assertFailure(filesMod.listFiles(attempt, { dir: '/etc' }), CODES.PATH_INVALID, '绝对目录');
});

test('readFile：完整读取、sha256: 摘要、offset/limit 续读、行数上限', (t) => {
  const { attempt } = setup(t);
  const appJson = fs.readFileSync(path.join(h.BASE_SOURCE_DIR, 'app.json'), 'utf8');
  const read = filesMod.readFile(attempt, { path: 'app.json' });
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.content, appJson);
  assert.strictEqual(read.bytes, Buffer.byteLength(appJson));
  assert.strictEqual(read.totalBytes, Buffer.byteLength(appJson));
  assert.strictEqual(read.sha256, 'sha256:' + h.sha256OfText(appJson));
  assert.strictEqual(read.encoding, 'utf8');
  assert.strictEqual(read.truncated, false);
  assert.strictEqual(read.offset, 0);
  assert.strictEqual(read.nextOffset, read.bytes);

  const head = filesMod.readFile(attempt, { path: 'app.json', offset: 0, limitBytes: 10 });
  assert.strictEqual(head.ok, true, JSON.stringify(head));
  assert.strictEqual(head.truncated, true);
  assert.ok(head.content.length > 0 && Buffer.byteLength(head.content) <= 10);
  assert.strictEqual(head.nextOffset, Buffer.byteLength(head.content));

  const tail = filesMod.readFile(attempt, { path: 'app.json', offset: head.nextOffset, limitBytes: 20 });
  assert.strictEqual(tail.ok, true, JSON.stringify(tail));
  assert.strictEqual(appJson.startsWith(head.content + tail.content), true, '续读应当拼回原文');

  // 单次读行数上限（写一个 20 行文件，然后按 3 行读）。
  const manyLines = Array.from({ length: 20 }, (_, index) => 'line-' + index).join('\n') + '\n';
  const written = filesMod.writeFile(attempt, { path: 'notes/many.txt', content: manyLines });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
  const limited = filesMod.readFile(attempt, { path: 'notes/many.txt', maxLines: 3 });
  assert.strictEqual(limited.ok, true, JSON.stringify(limited));
  assert.strictEqual(limited.truncated, true);
  assert.ok(limited.lines <= 3, 'lines=' + limited.lines);

  h.assertFailure(filesMod.readFile(attempt, { path: 'no-such-file.txt' }), CODES.FILE_NOT_FOUND, '不存在文件');
  h.assertFailure(filesMod.readFile(attempt, { path: 'pages' }), CODES.ARGUMENT_INVALID, '目录不是文件');
  h.assertFailure(filesMod.readFile(attempt, { path: PNG_ASSET }), CODES.BINARY_FILE, '二进制文件');
  h.assertFailure(filesMod.readFile(attempt, { path: '' }), CODES.PATH_INVALID, '空路径');
  h.assertFailure(filesMod.readFile(attempt, { path: 'app.json', offset: -1 }), CODES.ARGUMENT_INVALID, '负 offset');
});

test('路径安全：穿越/绝对/盘符/反斜杠/NUL/空段/超长/尾斜杠一律拒绝且码稳定无泄漏', (t) => {
  const { attempt, userDataDir } = setup(t);
  const badPaths = [
    '../outside.txt',
    '../../outside.txt',
    'pages/../../outside.txt',
    '/etc/passwd',
    '\\\\server\\share\\x',
    'C:\\Windows\\win.ini',
    'c:/Windows/win.ini',
    'pages\\menu\\index.wxml',
    'pages//menu/index.wxml',
    'pages/./menu/index.wxml',
    'pages/',
    ' pages/menu/index.wxml',
    'pages/menu/index.wxml ',
    'nul\u0000byte.txt',
    'ctrl\u0001char.txt',
    '',
    'x/' + 'y'.repeat(239),
  ];
  for (const bad of badPaths) {
    const first = filesMod.readFile(attempt, { path: bad });
    h.assertFailure(first, CODES.PATH_INVALID, 'readFile(' + JSON.stringify(bad) + ')');
    const second = filesMod.readFile(attempt, { path: bad });
    assert.strictEqual(second.code, first.code, '同一错误必须同一码：' + JSON.stringify(bad));
    h.assertNoPathLeak(first, [userDataDir]);
    assert.ok(!path.isAbsolute(first.path || ''), '失败体 path 不得是绝对路径：' + JSON.stringify(first));
    assert.ok(!first.message.includes(':') || !first.message.includes(userDataDir), 'message 不得回传本机路径');
  }

  // 解析后逃逸（合法段但拼出库外）同样拒绝。
  h.assertFailure(filesMod.readFile(attempt, { path: 'pages/menu/../../../etc/passwd' }), CODES.PATH_INVALID, '解析逃逸');
});

test('链接拒绝：工作树内的 junction/symlink 一律 AGENT_PATH_LINK，且不跟随', (t) => {
  const { attempt } = setup(t);
  const escapeDir = h.userDataWith(t);
  fs.writeFileSync(path.join(escapeDir, 'secret.txt'), 'do-not-read');

  h.createJunction(path.join(attempt.candidateDir, 'escape-dir'), escapeDir);
  h.assertFailure(filesMod.listFiles(attempt), CODES.PATH_LINK, 'listFiles 遇到 junction');
  h.assertFailure(filesMod.readFile(attempt, { path: 'escape-dir/secret.txt' }), CODES.PATH_LINK, '读 junction 内文件');
  h.assertFailure(filesMod.writeFile(attempt, { path: 'escape-dir/new.txt', content: 'x' }), CODES.PATH_LINK, '写 junction 内文件');

  if (h.tryCreateFileSymlink(path.join(attempt.candidateDir, 'link.txt'), path.join(escapeDir, 'secret.txt'))) {
    h.assertFailure(filesMod.readFile(attempt, { path: 'link.txt' }), CODES.PATH_LINK, '读 symlink 文件');
  }

  // 把 candidate 整体换成 junction 后，任何读写都不得到链接目标里。
  const realCandidate = attempt.candidateDir + '-real';
  fs.renameSync(attempt.candidateDir, realCandidate);
  h.createJunction(attempt.candidateDir, escapeDir);
  h.assertFailure(filesMod.readFile(attempt, { path: 'app.json' }), CODES.PATH_LINK, 'candidate 整体 junction');
  h.assertFailure(filesMod.writeFile(attempt, { path: 'app.json', content: 'x' }), CODES.PATH_LINK, '写 candidate junction');
  assert.strictEqual(fs.readFileSync(path.join(escapeDir, 'secret.txt'), 'utf8'), 'do-not-read');
  assert.deepStrictEqual(h.entriesOf(escapeDir).filter((name) => name !== 'secret.txt'), [], '链接目标不得出现新文件');
});

test('searchFiles：内容/文件名检索、命中上限、忽略二进制、无命中为空', (t) => {
  const { attempt } = setup(t);

  const contentHit = filesMod.searchFiles(attempt, { query: 'merchant-orders', mode: 'content' });
  assert.strictEqual(contentHit.ok, true, JSON.stringify(contentHit));
  assert.ok(contentHit.matches.some((match) => match.path === 'app.json' && match.line === 10), JSON.stringify(contentHit.matches));
  for (const match of contentHit.matches) {
    assert.ok(!path.isAbsolute(match.path));
    assert.ok(typeof match.line === 'number' && match.line >= 1);
    assert.ok(typeof match.preview === 'string' && match.preview.length <= 200);
  }

  const nameHit = filesMod.searchFiles(attempt, { query: 'home-active', mode: 'name' });
  assert.strictEqual(nameHit.ok, true, JSON.stringify(nameHit));
  assert.ok(nameHit.matches.some((match) => match.path === 'assets/tabbar/home-active.png'), JSON.stringify(nameHit.matches));

  const both = filesMod.searchFiles(attempt, { query: 'app.json', mode: 'both' });
  assert.ok(both.matches.some((match) => match.path === 'app.json'), JSON.stringify(both.matches));

  const none = filesMod.searchFiles(attempt, { query: 'zzz-no-such-token-zzz' });
  assert.strictEqual(none.ok, true);
  assert.deepStrictEqual(none.matches, []);
  assert.strictEqual(none.truncated, false);

  const bounded = filesMod.searchFiles(attempt, { query: 'e', maxResults: 3 });
  assert.strictEqual(bounded.ok, true);
  assert.ok(bounded.matches.length <= 3, '命中数必须受限：' + bounded.matches.length);
  assert.strictEqual(bounded.truncated, true);

  h.assertFailure(filesMod.searchFiles(attempt, { query: '' }), CODES.ARGUMENT_INVALID, '空 query');
  h.assertFailure(filesMod.searchFiles(attempt, { query: 'x', mode: 'regex' }), CODES.ARGUMENT_INVALID, '非法 mode');
});

test('上限：从 Base 建树超限时失败且不留半套工作区', (t) => {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true);

  const cases = [
    [{ maxFiles: 10 }, CODES.FILE_COUNT_EXCEEDED, '文件数上限'],
    [{ maxTreeBytes: 1000 }, CODES.TREE_TOO_LARGE, '总字节上限'],
    [{ maxDepth: 2 }, CODES.DEPTH_EXCEEDED, '深度上限'],
    [{ maxPathLength: 20 }, CODES.PATH_INVALID, '路径长度上限'],
    [{ maxFileBytes: 1024 }, CODES.FILE_TOO_LARGE, '单文件字节上限'],
  ];
  let sequence = 0;
  for (const [limits, code, label] of cases) {
    sequence += 1;
    const created = workspaceMod.createAttempt(opened.workspace, {
      runId: RUN_ID,
      turnId: TURN_ID,
      attempt: sequence,
      source: { kind: 'base' },
      limits,
    });
    h.assertFailure(created, code, label);
    const attemptDir = path.join(opened.workspace.runsDir, RUN_ID, 'turns', TURN_ID, 'attempts', 'attempt-' + sequence);
    assert.strictEqual(fs.existsSync(path.join(attemptDir, 'candidate')), false, label + '：不得留下半套 candidate');
  }
});

test('上限：写文件超单文件/树总量/深度限制时拒绝且原树不变', (t) => {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));

  // 小体量“已采用版本”夹具：让建树通过、写入触发各自上限。
  const versionSource = path.join(opened.workspace.versionsDir, 'v1', 'source');
  fs.mkdirSync(path.join(versionSource, 'pages', 'menu'), { recursive: true });
  fs.writeFileSync(path.join(versionSource, 'app.json'), '{"pages":[]}');
  fs.writeFileSync(path.join(versionSource, 'pages', 'menu', 'index.wxml'), '<view />');
  fs.writeFileSync(path.join(versionSource, 'README.md'), 'fixture\n');
  const smallBytes = h.listRelativeFiles(versionSource).reduce((sum, item) => sum + item.bytes, 0);

  const created = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'version', versionId: 'v1' },
    limits: { maxFileBytes: 128, maxTreeBytes: smallBytes + 64, maxDepth: 6 },
  });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const attempt = created.attempt;

  const before = h.listRelativeFiles(attempt.candidateDir);
  h.assertFailure(
    filesMod.writeFile(attempt, { path: 'too-large.txt', content: 'x'.repeat(129) }),
    CODES.FILE_TOO_LARGE,
    '单文件超限',
  );
  h.assertFailure(
    filesMod.writeFile(attempt, { path: 'tree-over.txt', content: 'y'.repeat(65) }),
    CODES.TREE_TOO_LARGE,
    '树总量超限',
  );
  h.assertFailure(
    filesMod.writeFile(attempt, { path: 'a/b/c/d/e/f/g/deep.txt', content: 'z' }),
    CODES.DEPTH_EXCEEDED,
    '深度超限',
  );
  assert.deepStrictEqual(h.listRelativeFiles(attempt.candidateDir), before, '失败后工作树必须原样');

  // 单次读上限：limitBytes 被钳制到读上限（用默认上限的另一棵工作树写 300KB 文件）。
  const other = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    attempt: 2,
    source: { kind: 'base' },
  });
  assert.strictEqual(other.ok, true, JSON.stringify(other));
  const big = 'q'.repeat(300 * 1024);
  const written = filesMod.writeFile(other.attempt, { path: 'big.txt', content: big });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
  const read = filesMod.readFile(other.attempt, { path: 'big.txt', limitBytes: 8 * 1024 * 1024 });
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.ok(Buffer.byteLength(read.content) <= 256 * 1024, '读取字节必须被钳制到 readMaxBytes');
  assert.strictEqual(read.truncated, true);
});
