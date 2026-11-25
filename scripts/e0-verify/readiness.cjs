'use strict';

/**
 * X1–X12 就绪度矩阵（只陈述**当前事实**，不关闭任何 X）。
 *
 * 口径（rev15 §14.1 / §14.11）：
 *  - 每条 X 的关闭必须同时有「代码 + 测试 + 独立复核」，由 t8（E0-V1）出具；
 *  - 本文件只报告：冻结接口是否已落地、关键静态事实、以及“因此当前判不了”的理由；
 *  - 状态词只用 NOT_RUN / BLOCKED；本文件**永远不会**把 X 标成 PASS。
 */

const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT } = require('./lib/env.cjs');

function readText(relative) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  } catch {
    return null;
  }
}

function existsRelative(relative) {
  return fs.existsSync(path.join(REPO_ROOT, relative));
}

function checksFacts(frozen) {
  const checks = frozen.requireOrNull('checks');
  if (!checks) return { available: false };
  const definitions = checks.CHECK_DEFINITIONS || {};
  const ids = Array.isArray(checks.CHECK_IDS) ? checks.CHECK_IDS.slice() : [];
  return {
    available: true,
    checkIds: ids,
    sourceCheckScript: definitions['source.check'] ? definitions['source.check'].script : null,
    sourceCheckExpectation: 'scripts/frontend-source/check.cjs（rev15 §14.4）',
    miniCheckScoped: definitions['mini.check'] ? Boolean(definitions['mini.check'].scoped) : null,
    checkSubjects: Object.fromEntries(ids.map((id) => [id, definitions[id] ? definitions[id].subject : null])),
    hasCapabilitiesCheck: ids.includes('capabilities.check'),
  };
}

function buildReadiness(frozen) {
  const rows = [];
  const push = (row) => rows.push(Object.assign({ status: 'NOT_RUN' }, row));

  const coordinator = frozen.load('run-coordinator');
  const scheduler = frozen.load('model-call-scheduler');
  const runtime = frozen.load('agent-runtime');
  const checks = checksFacts(frozen);
  const toolsIpc = readText('desktop/agent-tools-ipc.cjs') || '';
  const credentials = readText('desktop/model-credentials.cjs') || '';
  const serverWorkspaceService = readText('server/src/agent/workspace/workspace-agent.service.ts') || '';

  push({
    x: 'X1',
    owner: 'E0-W1（workspace-lead，任务 t1）',
    evidence: 'desktop/agent-workspace/run-coordinator.cjs + docs/evidence/workspace-agent/e0-v1/incremental-w1r1a.md',
    facts: {
      coordinatorPresent: coordinator.present,
      coordinatorStatus: coordinator.status,
      w1r1aEvidencePresent: existsRelative('docs/evidence/workspace-agent/e0-v1/incremental-w1r1a.md'),
      executedCases: ['C01', 'C02', 'C04', 'C13', 'C14', 'C16'],
    },
    reason: coordinator.present
      ? 'W1 执行断言已在 e0-v1 增量复跑（C01/C02/C04/C13/C14 = PASS：startRun 从 currentVersionId 复制 attempt 树、'
        + '无版本/未知项目 AGENT_VERSION_NOT_FOUND 且零建目录、写事务 revision+1 与摘要重算、getRun 视图一致、入参校验）；'
        + 'C16 用**真实注册表+真实检查子进程**跑通 写改→派生→双检查→submit(partial)→adopt v2。'
        + '整体关闭（IPC 挂载、direct 通道接入、真实 Flash）仍由 t8 判'
      : 'Coordinator 尚未落地；direct 唯一执行所有者、不经 renderer 回环的事实无法判定',
  });
  push({
    x: 'X2',
    owner: 'E0-R2（runtime-engineer，任务 t7）',
    evidence: 'desktop/agent-runtime/**（resolveAssetImage / buildMultimodalContent）',
    facts: { runtimePresent: runtime.present, hasResolveAssetImage: /resolveAssetImage/.test(readText('desktop/model-credentials.cjs') || '') },
    reason: '图片资产解析与多模态 content parts 未落地；无法验证回答是否依赖图像内容（A43–A48 全 NOT_RUN）',
  });
  push({
    x: 'X3',
    owner: 'E0-W1（workspace-lead，任务 t1）',
    evidence: 'desktop/agent-workspace/run-coordinator.cjs + docs/evidence/workspace-agent/e0-v1/incremental-w1r1a.md',
    facts: {
      coordinatorPresent: coordinator.present,
      coordinatorExports: coordinator.exports,
      coordinatorMissingExports: coordinator.missingExports,
      executedCases: ['C03', 'C04', 'C05', 'C08', 'C10', 'C11', 'C15', 'C16'],
    },
    reason: coordinator.present
      ? 'W1 执行断言 PASS（C03 写入拒绝 version subject / read_file 版本覆盖只读；C04 写只落 attempt；'
        + 'C05 工具面 11 vs 平台专用 3；C08 提交后 AGENT_ATTEMPT_IMMUTABLE；C10 伪造/跨项目/跨 run/跨 turn 句柄 '
        + 'AGENT_ATTEMPT_NOT_FOUND|AGENT_RUN_NOT_FOUND|AGENT_PROJECT_MISMATCH 且目录指纹不变；'
        + 'C11 取消三态与迟到零落盘；C15 注册表漂移 fail-closed 不抛异常）。'
        + '图片资产/多模态证据（X2）、direct 通道（t6）与真实模型属后续任务，整体关闭由 t8 判'
      : '无 startRun/invokeTool，工具 subject 注入与“写只落 attempt”无法在 E0 语义下判定；'
        + 'B1 层句柄/路径负例已可由 A16–A20、A23 覆盖',
  });
  push({
    x: 'X4',
    owner: 'E0-W2（workspace-lead，任务 t5）',
    evidence: 'desktop/agent-workspace/checks.cjs + scripts/frontend-source/check.cjs',
    facts: checks,
    reason: checks.available
      ? 'rev15 §14.5/§14.12-5：checks.cjs 现已声明 checkId→subject（source.check/composer.dry-run=attempt、'
        + 'mini.check/output.consistency/wechat.verify=export、其余=repo），并在结果里回 subjectKind/exportedRoot/exportTreeDigest；'
        + 'W1 侧 C07（证据主体降级即拒）与 C16（真实 source.check/dry-run 双 PASS）已执行 PASS。'
        + '仍需 t5 判定：source.check 是否直连 scripts/frontend-source/check.cjs（当前 ' + checks.sourceCheckScript + '）、'
        + 'mini.check scoped=' + String(checks.miniCheckScoped) + '（期望只查派生导出树）→ t5 交付前 X4 记未关闭'
      : 'checks 注册表不可用',
  });
  push({
    x: 'X5',
    owner: 'E0-W2（workspace-lead，任务 t5）',
    evidence: 'submit 8 页枚举 + SourceFacts/page-contract 派生',
    facts: { submitImplementPresent: coordinator.present, coordinatorExports: coordinator.exports },
    reason: 'submit 8 页单一来源枚举是否成立，需 t8 用 V08/A01–A03 执行判定（Coordinator 已导出 createRunCoordinator，'
      + '但页枚举与 SourceFacts 同源无法从导出面静态确认）',
  });
  push({
    x: 'X6',
    owner: 'E0-W2（workspace-lead，任务 t5）',
    evidence: 'deriveSourceBundle（平台派生，模型不可调）',
    facts: { derivesBundlePresent: false },
    reason: 'source-bundle 平台派生未落地（正文中无 deriveSourceBundle 实现）；A01/A04 无法执行',
  });
  push({
    x: 'X7',
    owner: 'E0-W1/W2（workspace-lead，任务 t1/t5）',
    evidence: 'desktop/agent-tools-ipc.cjs + desktop/agent-workspace/run-coordinator.cjs + B2 versions.adoptAttempt',
    facts: {
      adoptAttemptIpcPresent: /adopt-attempt/.test(toolsIpc),
      submitGatePresent: coordinator.present,
      b2AdoptAttemptPresent: frozen.isPresent('versions'),
      executedCases: ['C06', 'C07', 'C08', 'C09', 'C16'],
    },
    reason: 'W1 层已执行：C06 缺证据 submit → AGENT_STATIC_GATE_FAILED；C07 证据主体降级（version）→ 门禁拒绝；'
      + 'C08 attempt 主体 PASS 证据 → submitted(partial)；C09 adopt 三分码各自命中且不互相顶替；'
      + 'C16 真实检查链 submit/adopt 跑通。**仍未关闭**：agent:adopt-attempt IPC 未实现（adoptAttemptIpcPresent='
      + String(/adopt-attempt/.test(toolsIpc)) + '），B2 adoptAttempt 不校验磁盘证据绑定 → A01–A09 由 t8 复跑',
  });
  push({
    x: 'X8',
    owner: 'E0-R1（runtime-engineer，任务 t6）',
    evidence: 'desktop/model-credentials.cjs#requestChat + direct workspace loop',
    facts: {
      requestChatHasFinishReason: /finishReason/.test(credentials),
      requestChatHasTruncated: /truncated/.test(credentials),
      outputTruncatedCode: /output_truncated/.test(credentials) || /AGENT_OUTPUT_TRUNCATED/.test(credentials),
    },
    reason: 'requestChat 未返回 finishReason/truncated，direct 循环不存在；截断不回放工具的语义无法判定（A32–A34）',
  });
  push({
    x: 'X9',
    owner: 'E0-R1（桌面侧，任务 t6）+ E0-R1b（服务端副本，任务 t9）',
    evidence: 'desktop 回复处理（删除伪状态正则改写）+ server/src/agent/workspace/workspace-agent.service.ts',
    facts: {
      serverRegexRewriteStillPresent: /待本地确认/.test(serverWorkspaceService),
      directRuntimePresent: runtime.present,
    },
    reason: 'rev15 §14.12-3：X9 判据 = 桌面侧已删 且 服务端副本已删/证明不可达。当前 desktop 侧未落地；'
      + '服务端仍保留 `已验证/已采用 → 待本地确认` 改写（server/src/agent/workspace/workspace-agent.service.ts:80），'
      + '必须在 E0 关闭前由 t9 E0-R1b 删除并补“已不存在”断言 → X9 未关闭',
  });
  push({
    x: 'X10',
    owner: 'E0-U1（product-ui，任务 t3）+ 后续接线',
    evidence: 'src/components/agent/e0/** + docs/evidence/workspace-agent/e0-u1/**',
    facts: {
      e0ComponentsPresent: existsRelative('src/components/agent/e0'),
      e0u1EvidencePresent: existsRelative('docs/evidence/workspace-agent/e0-u1'),
    },
    reason: '本轮只判“接入项是否冻结”：统一 run 状态/单页枚举/截图二进制/未知 stage 不丢步 → 待 t3 交付后由 t8 判',
  });
  push({
    x: 'X11',
    owner: 'E0-Git（Captain，已完成）',
    evidence: 'docs/evidence/workspace-agent/e0-git/{baseline.md,status-classification.json}',
    facts: {
      baselineEvidencePresent: existsRelative('docs/evidence/workspace-agent/e0-git/baseline.md'),
      statusClassificationPresent: existsRelative('docs/evidence/workspace-agent/e0-git/status-classification.json'),
    },
    reason: '基线证据已归档（基线=origin/main 内容+15 local-edit+7 untracked-only）；'
      + '“后续每个任务能说清基线与变更归属”仍需 t8 对交付逐项核对，故本轮不关闭',
  });
  push({
    x: 'X12',
    owner: 'E0-R1a（桌面侧，任务 t2）+ 服务端通道（任务 t9）',
    evidence: 'desktop/model-call-scheduler.cjs + docs/evidence/workspace-agent/e0-r1a/',
    facts: {
      schedulerPresent: scheduler.present,
      schedulerStatus: scheduler.status,
      maxUpstreamConcurrency: scheduler.present ? scheduler.module.MAX_UPSTREAM_CONCURRENCY : null,
      e0r1aEvidencePresent: existsRelative('docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs'),
      desktopSideClosed: scheduler.present === true,
      executedCases: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'],
      w1r1aEvidencePresent: existsRelative('docs/evidence/workspace-agent/e0-v1/incremental-w1r1a.md'),
    },
    reason: scheduler.present
      ? 'rev15 §14.12：桌面侧已关闭（t2 交付 27 tests + 5 并发实测 active=3/queued=2 + 两进程峰值 3，证据 e0-r1a/）；'
        + 'W1 侧独立复验 S01–S06 全 PASS（5 并发→active 3/queued 2；排队超时 MODEL_QUEUE_TIMEOUT；取消 MODEL_ABORTED 不泄漏槽位；'
        + '两进程峰值 3；clamp=3 且非法值 MODEL_CONFIG_INVALID；FIFO 无插队）；'
        + '服务端侧（t9）与真实模型并发（t8）未做，故仍只记“桌面侧已关闭”'
      : 'ModelCallScheduler 未落地；上游并发 ≤3 无法验证（A38–A42 全 NOT_RUN）',
  });

  return {
    generatedAt: new Date().toISOString(),
    note: '本表只陈述事实，不关闭任何 X；X1–X12 关闭结论由 t8（E0-V1）出具。',
    rows,
  };
}

module.exports = { buildReadiness };
