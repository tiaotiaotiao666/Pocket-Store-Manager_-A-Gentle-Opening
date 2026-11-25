'use strict';

/**
 * P 组：前置链（P01–P08）。
 *
 * 这些用例只使用 **已被独立复核的 B1/B2 冻结模块**，用来证明 E0-V1 之后要跑的那条链
 * 「临时 userData + 当前版本 → attempt → 写真实修改 → 采用 → undo/redo/重开/导出身份」
 * 的地基在本次基线是可执行的；它们**不是** E0 结论，也不覆盖任何 X（X 关闭由 V/R/A 组裁定）。
 *
 * 依据：rev3 §1.10、rev4 §2.6（B1/B2 实际签名）与 rev4 §2.2/§2.4（指针与导出身份语义）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { assert, assertEqual } = require('../lib/harness.cjs');

const B1_B2_REQUIRES = ['workspace', 'files', 'manifest', 'versions'];

function openProject(ctx, projectId) {
  const versions = ctx.frozen.requireStrict('versions');
  const workspace = ctx.frozen.requireStrict('workspace');
  const files = ctx.frozen.requireStrict('files');
  const init = versions.initProject({ userDataDir: ctx.temp.real, projectId });
  assert(init.ok, 'initProject 失败：' + JSON.stringify({ code: init.code, message: init.message }));
  const opened = workspace.openWorkspace({ userDataDir: ctx.temp.real, projectId });
  assert(opened.ok, 'openWorkspace 失败：' + JSON.stringify({ code: opened.code, message: opened.message }));
  return { versions, workspace, files, ws: opened.workspace, projectId, init };
}

function attemptDirsOf(ctx, projectId) {
  const workspace = ctx.frozen.requireStrict('workspace');
  return workspace.workspacePaths({ userDataDir: ctx.temp.real, projectId });
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function contentOf(result) {
  if (!result || result.ok !== true) return null;
  if (result.content !== undefined) return result.content;
  if (result.data && result.data.content !== undefined) return result.data.content;
  return null;
}

/** buildManifest 返回 `{ok:true, manifest:{…,treeDigest}}`（B1 实际签名），这里统一取摘要。 */
function manifestDigest(result) {
  if (!result || result.ok !== true) return null;
  if (typeof result.treeDigest === 'string') return result.treeDigest;
  if (result.manifest && typeof result.manifest.treeDigest === 'string') return result.manifest.treeDigest;
  return null;
}

const CASES = [
  {
    id: 'P01',
    group: 'P 前置（B1/B2 冻结模块）',
    title: '临时 userData 只建在系统临时目录，且与项目真实 userData 不重叠',
    requires: [],
    expected: '临时根在 tmpdir 内、不在仓库内、与 app-data/AppData 真实 userData 无交集；用例结束可自清',
    run(ctx) {
      const tempReal = ctx.temp.real;
      assert(tempReal && tempReal.length > 0, '临时根缺失');
      const os = require('node:os');
      assert(ctx.env.isInside(ctx.env.realpathOrNull(os.tmpdir()), tempReal), '临时根不在系统临时目录内');
      assert(!ctx.env.isInside(ctx.env.repoRoot(), tempReal), '临时根落在仓库内（禁止）');
      const forbidden = ctx.env.forbiddenUserDataRoots();
      assert(forbidden.length >= 1, '未能识别项目真实 userData 候选');
      for (const root of forbidden) {
        assert(!ctx.env.isInside(root, tempReal) && !ctx.env.isInside(tempReal, root),
          '临时根与项目真实 userData 重叠（禁止）');
      }
      return {
        observed: { tempPrefix: ctx.temp.prefix, insideTmpdir: true, insideRepo: false },
        detail: '临时 userData 安全',
      };
    },
  },
  {
    id: 'P02',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'initProject 建立 v1（import-base），treeDigest 与磁盘一致且可重开',
    requires: B1_B2_REQUIRES,
    expected: 'currentVersionId=v1 / reason=import-base / parentVersionId=null；两次 reopen 摘要一致',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p02');
      const state = project.init.state;
      assertEqual(state.currentVersionId, 'v1', '当前版本应为 v1');
      const v1 = state.versions.find((entry) => entry.versionId === 'v1');
      assert(v1, 'versions 索引缺 v1');
      assertEqual(v1.reason, 'import-base', 'v1 的来源应为 import-base');
      assertEqual(v1.parentVersionId, null, 'v1 无父版本');
      const reopened = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(reopened.ok, 'reopenProject 失败：' + JSON.stringify(reopened.code));
      const reopenedAgain = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(reopenedAgain.ok, '第二次 reopenProject 失败');
      assertEqual(reopenedAgain.treeDigest, reopened.treeDigest, '两次重开摘要必须一致');
      return { observed: { versionId: 'v1', treeDigest: reopened.treeDigest }, detail: 'v1 基线可重开' };
    },
  },
  {
    id: 'P03',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'createAttempt 从当前版本 source 复制工作树，且不改动该版本',
    requires: B1_B2_REQUIRES,
    expected: 'attempt-1 目录在私有根内；versions/v1 指纹不变；attempt 记录创建时 treeDigest',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p03');
      const dirs = attemptDirsOf(ctx, project.projectId);
      assert(dirs.ok, 'workspacePaths 失败');
      const v1FingerprintBefore = ctx.env.fingerprintDir(path.join(dirs.versionsDir, 'v1'));
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p03', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败：' + JSON.stringify({ code: created.code, message: created.message }));
      const attempt = created.attempt;
      assertEqual(attempt.attempt, 1, '首个 attempt 应为 attempt-1');
      assert(attempt.candidateDir && fs.existsSync(attempt.candidateDir), 'candidate 工作树不存在');
      assert(ctx.env.isInside(ctx.temp.real, attempt.candidateDir), 'candidate 树越出临时私有根');
      assert(typeof attempt.treeDigest === 'string' && attempt.treeDigest.startsWith('sha256:'),
        'attempt 未记录 treeDigest');
      const v1FingerprintAfter = ctx.env.fingerprintDir(path.join(dirs.versionsDir, 'v1'));
      assertEqual(v1FingerprintAfter.digest, v1FingerprintBefore.digest, 'createAttempt 改动了已采用版本 v1');
      return {
        observed: { attempt: attempt.attempt, treeDigest: attempt.treeDigest, revision: attempt.revision },
        detail: 'attempt 工作树来源于当前版本',
      };
    },
  },
  {
    id: 'P04',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'writeFile 写入真实修改：revision 递增、treeDigest 变化、版本不被改动',
    requires: B1_B2_REQUIRES,
    expected: 'revision 递增；treeDigest 变化；读回内容为新内容；versions/v1/source 逐字节不变',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p04');
      const dirs = attemptDirsOf(ctx, project.projectId);
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p04', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败');
      const attempt = created.attempt;
      const digestBefore = attempt.treeDigest;
      const revisionBefore = attempt.revision;
      const versionFile = path.join(dirs.versionsDir, 'v1', 'source', 'pages', 'menu', 'index.wxml');
      const versionContentBefore = readFileOrNull(versionFile);
      assert(versionContentBefore !== null, '基线缺少 pages/menu/index.wxml（无法做真实修改用例）');

      const marker = '<view class="e0v1-probe">E0-V1p probe</view>';
      const written = project.files.writeFile(attempt, { path: 'pages/menu/index.wxml', content: marker });
      assert(written.ok, 'writeFile 失败：' + JSON.stringify({ code: written.code, message: written.message }));
      assert(written.revision > revisionBefore, '写入后 revision 未递增');
      assert(written.treeDigest !== digestBefore, '写入后 treeDigest 未变化');
      const readBack = project.files.readFile(attempt, { path: 'pages/menu/index.wxml' });
      assertEqual(contentOf(readBack), marker, '读回内容不是新内容');
      assertEqual(readFileOrNull(versionFile), versionContentBefore, '写 attempt 却改动了已采用版本 v1');
      return {
        observed: { revisionBefore, revisionAfter: written.revision, digestBefore, digestAfter: written.treeDigest },
        detail: 'attempt 内真实修改可读回，版本零写入',
      };
    },
  },
  {
    id: 'P05',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'adoptAttempt（B2）生成 v2：parent=v1、sourceKind=agent-edit、v1 逐字节不变',
    requires: B1_B2_REQUIRES,
    expected: 'currentVersionId=v2、previousVersionId=v1；adoption.sourceKind=agent-edit；v1 目录指纹前后一致',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p05');
      const dirs = attemptDirsOf(ctx, project.projectId);
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p05', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败');
      const attempt = created.attempt;
      const written = project.files.writeFile(attempt, {
        path: 'pages/menu/index.wxss', content: '/* e0v1 probe */\n',
      });
      assert(written.ok, 'writeFile 失败：' + JSON.stringify(written.code));
      const v1Before = ctx.env.fingerprintDir(path.join(dirs.versionsDir, 'v1'));
      const adopted = project.versions.adoptAttempt({
        userDataDir: ctx.temp.real, projectId: project.projectId,
        runId: 'frun-e0v1p05', turnId: 'turn-1', attempt: attempt.attempt,
      });
      assert(adopted.ok, 'adoptAttempt 失败：' + JSON.stringify({ code: adopted.code, message: adopted.message }));
      assertEqual(adopted.currentVersionId, 'v2', '采用后当前版本应为 v2');
      assertEqual(adopted.previousVersionId, 'v1', '采用后父版本应为 v1');
      const version = adopted.version || {};
      assert(version.adoption && version.adoption.sourceKind === 'agent-edit', 'adoption.sourceKind 应为 agent-edit');
      assertEqual(version.parentVersionId, 'v1', 'v2.parentVersionId 应为 v1');
      const v1After = ctx.env.fingerprintDir(path.join(dirs.versionsDir, 'v1'));
      assertEqual(v1After.digest, v1Before.digest, '采用后 v1 被改写（不可变性破坏）');
      return {
        observed: { currentVersionId: 'v2', sourceKind: version.adoption.sourceKind, treeDigest: adopted.treeDigest },
        detail: 'B2 采用链可用（E0 证据绑定仍由 V10/A07/A08 覆盖）',
      };
    },
  },
  {
    id: 'P06',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'undo/redo 只动指针，不新增版本目录',
    requires: B1_B2_REQUIRES,
    expected: 'undo→v1(redo=v2)；redo→v2(redo=null)；versions/ 目录集合不变',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p06');
      const dirs = attemptDirsOf(ctx, project.projectId);
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p06', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败');
      const seeded = project.files.writeFile(created.attempt, { path: 'pages/menu/index.js', content: '// e0v1\n' });
      assert(seeded.ok, 'writeFile 失败：' + JSON.stringify(seeded.code));
      const adopted = project.versions.adoptAttempt({
        userDataDir: ctx.temp.real, projectId: project.projectId,
        runId: 'frun-e0v1p06', turnId: 'turn-1', attempt: created.attempt.attempt,
      });
      assert(adopted.ok, 'adoptAttempt 失败：' + JSON.stringify(adopted.code));
      const dirsBefore = fs.readdirSync(dirs.versionsDir).slice().sort();
      const undone = project.versions.undoVersion({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(undone.ok, 'undoVersion 失败：' + JSON.stringify(undone.code));
      const stateAfterUndo = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(stateAfterUndo.ok, 'readProjectState 失败');
      assertEqual(stateAfterUndo.state.currentVersionId, 'v1', 'undo 后当前版本应为 v1');
      assertEqual(stateAfterUndo.state.redoVersionId, 'v2', 'undo 后 redo 指针应为 v2');
      const redone = project.versions.redoVersion({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(redone.ok, 'redoVersion 失败：' + JSON.stringify(redone.code));
      const stateAfterRedo = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assertEqual(stateAfterRedo.state.currentVersionId, 'v2', 'redo 后当前版本应为 v2');
      assertEqual(stateAfterRedo.state.redoVersionId, null, 'redo 后 redo 指针应清空');
      const dirsAfter = fs.readdirSync(dirs.versionsDir).slice().sort();
      assertEqual(JSON.stringify(dirsAfter), JSON.stringify(dirsBefore), 'undo/redo 新增了版本目录');
      return { observed: { versions: dirsAfter.length }, detail: 'undo/redo 指针语义成立' };
    },
  },
  {
    id: 'P07',
    group: 'P 前置（B1/B2 冻结模块）',
    title: '重开 + 导出身份：exportRoot 就是当前版本 source，摘要与索引一致',
    requires: B1_B2_REQUIRES,
    expected: 'reopenProject/verifyExportIdentity PASS；resolveVersionSource.sourceRoot=versions/<current>/source；摘要=索引摘要',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p07');
      const dirs = attemptDirsOf(ctx, project.projectId);
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p07', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败');
      const seeded = project.files.writeFile(created.attempt, {
        path: 'pages/menu/index.json', content: '{"usingComponents":{}}\n',
      });
      assert(seeded.ok, 'writeFile 失败：' + JSON.stringify(seeded.code));
      const adopted = project.versions.adoptAttempt({
        userDataDir: ctx.temp.real, projectId: project.projectId,
        runId: 'frun-e0v1p07', turnId: 'turn-1', attempt: created.attempt.attempt,
      });
      assert(adopted.ok, 'adoptAttempt 失败：' + JSON.stringify(adopted.code));
      const reopened = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(reopened.ok, 'reopenProject 失败：' + JSON.stringify(reopened.code));
      const identity = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(identity.ok, 'verifyExportIdentity 失败：' + JSON.stringify(identity.code));
      const resolved = project.versions.resolveVersionSource({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(resolved.ok, 'resolveVersionSource 失败：' + JSON.stringify(resolved.code));
      assertEqual(ctx.env.normalizeForCompare(resolved.sourceRoot),
        ctx.env.normalizeForCompare(path.join(dirs.versionsDir, 'v2', 'source')),
        '导出源不是当前版本 source（同源被破坏）');
      const manifest = ctx.frozen.requireStrict('manifest');
      const rebuilt = manifest.buildManifest(resolved.sourceRoot);
      const treeDigest = manifestDigest(rebuilt);
      assert(treeDigest, 'buildManifest 未返回摘要：' + JSON.stringify(rebuilt && rebuilt.code));
      assertEqual(treeDigest, resolved.treeDigest, '导出源重算摘要与版本登记的 treeDigest 不一致');
      return { observed: { versionId: resolved.versionId, treeDigest }, detail: '导出身份同源' };
    },
  },
  {
    id: 'P08',
    group: 'P 前置（B1/B2 冻结模块）',
    title: 'attempt 树摘要可被独立重算（平台摘要与磁盘一致）',
    requires: B1_B2_REQUIRES,
    expected: 'manifest.buildManifest(candidateDir).treeDigest === attempt 摘要（写入前后各一次）',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-p08');
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1p08', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败');
      const attempt = created.attempt;
      const manifest = ctx.frozen.requireStrict('manifest');
      const before = manifestDigest(manifest.buildManifest(attempt.candidateDir));
      assert(before, '创建时 buildManifest 未返回摘要');
      assertEqual(before, attempt.treeDigest, '创建时摘要与磁盘不一致');
      const written = project.files.writeFile(attempt, { path: 'assets/e0v1-probe.txt', content: 'probe\n' });
      assert(written.ok, 'writeFile 失败：' + JSON.stringify(written.code));
      const after = manifestDigest(manifest.buildManifest(attempt.candidateDir));
      assert(after, '写入后 buildManifest 未返回摘要');
      assertEqual(after, written.treeDigest, '写入后摘要与磁盘不一致');
      return { observed: { digest: after.treeDigest }, detail: '摘要可独立重算' };
    },
  },
];

module.exports = { CASES, B1_B2_REQUIRES, openProject, contentOf };
