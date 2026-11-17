/**
 * P5 接线：把「候选采用结果」整理成项目快照记录，并给导出/撤销提供受控输入。
 *
 * 这一层只做形状转换与取值，业务规则仍在 domain：
 * - `buildFrontendAdoption` / `undoFrontendAdoption` / `describeFrontendCandidate`
 *   全部来自 `src/domain/projectSnapshot.mjs`（P5 白名单与失败关闭语义不变）；
 * - 渲染进程拿不到 overlay 路径：attemptRelative 只从主进程返回的
 *   `recordRelative`（…/attempts/attempt-N/adopted.json）截出来，overlayRelative 随之派生；
 * - 导出只传 ids（projectId/runId/attempt/candidateId/candidateVersion/integrity
 *   /runtimeStatus/repairs），主进程会重新解析并校验摘要。
 */

import {
  buildFrontendAdoption,
  describeFrontendCandidate,
  undoFrontendAdoption,
} from '../../domain/projectSnapshot.mjs';

const ADOPTION_RECORD_PATTERN = /^projects\/[A-Za-z0-9._-]{1,64}\/frontend-runs\/frun-[A-Za-z0-9._-]{1,60}\/attempts\/attempt-[1-9][0-9]{0,3}\/adopted\.json$/;

/** 主进程 adopted.json 的相对路径 → attempt/overlay 相对路径（渲染进程不拼绝对路径）。 */
export function deriveAttemptPaths(recordRelative) {
  if (typeof recordRelative !== 'string' || !ADOPTION_RECORD_PATTERN.test(recordRelative)) {
    return { attemptRelative: null, overlayRelative: null };
  }
  const attemptRelative = recordRelative.slice(0, -'/adopted.json'.length);
  return { attemptRelative, overlayRelative: attemptRelative + '/overlay' };
}

/** 导出时只传受控 id；残留的路径/多余字段不会进入 payload。 */
export function candidateOverlayFromAdoption(record) {
  if (!record || record.status !== 'adopted') return null;
  if (!record.projectId || !record.runId || !Number.isInteger(record.attempt) || !record.candidateId) return null;
  return {
    projectId: record.projectId,
    runId: record.runId,
    attempt: record.attempt,
    candidateId: record.candidateId,
    candidateVersion: record.candidateVersion,
    ...(record.integrity ? { integrity: record.integrity } : {}),
    runtimeStatus: record.verification && typeof record.verification.runtime === 'string'
      ? record.verification.runtime
      : 'NOT_RUN',
    repairs: record.verification && Number.isInteger(record.verification.repairs) ? record.verification.repairs : 0,
  };
}

/**
 * 采用成功后构造快照记录。
 *
 * @param {object} options
 * @param {{candidateId:string, candidateVersion:string, attempt:number, digest?:string}} options.candidate
 *   构建结果里的候选摘要（digest 即 integrity）
 * @param {string} options.projectId / options.runId
 * @param {{candidateId?, candidateVersion?, attempt?, runtimeStatus?, partialConfirmed?, adoptedAt?, recordRelative?}} options.adoptionResult
 *   主进程 adoptCandidate 的返回
 * @param {{status?:string, repairs?:number, screenshots?:Array}} [options.runtimeVerification]
 * @param {object} [options.plan] 采用时的 Plan 引用（planId/planVersion/frontendPack/baseTemplate）
 * @param {object|null} [options.previous] 采用前的记录（只保留一层）
 */
export function buildAdoptionRecord(options = {}) {
  const candidate = options.candidate && typeof options.candidate === 'object' ? options.candidate : null;
  if (!candidate || !candidate.candidateId || !candidate.candidateVersion) return null;
  const result = options.adoptionResult && typeof options.adoptionResult === 'object' ? options.adoptionResult : {};
  const runtime = options.runtimeVerification && typeof options.runtimeVerification === 'object'
    ? options.runtimeVerification
    : {};
  const paths = deriveAttemptPaths(result.recordRelative);
  const adoptedAt = typeof result.adoptedAt === 'string' ? result.adoptedAt : new Date().toISOString();
  // 上一版记录原样保留（含 verified/status）；domain 的白名单会把嵌套 previous.verified
  // 归一成 false，这里在内存记录上按来源恢复它的原值，否则撤销会把未校验的上一版“洗白”。
  const previousSource = options.previous && options.previous.status !== 'none'
    ? { ...options.previous, previous: null }
    : null;
  const record = buildFrontendAdoption({
    candidate: {
      candidateId: result.candidateId || candidate.candidateId,
      candidateVersion: result.candidateVersion || candidate.candidateVersion,
      integrity: candidate.digest || candidate.integrity || null,
      runId: options.runId,
      projectId: options.projectId,
      attempt: Number.isInteger(result.attempt) ? result.attempt : candidate.attempt,
      attemptRelative: paths.attemptRelative,
      overlayRelative: paths.overlayRelative,
      registryDigest: candidate.registryDigest || null,
    },
    plan: options.plan
      ? {
        planId: options.plan.planId,
        planVersion: options.plan.planVersion,
        frontendPack: options.plan.frontendPack,
        baseTemplate: options.plan.baseTemplate,
      }
      : null,
    verification: {
      static: 'pass',
      runtime: result.runtimeStatus || runtime.status || 'NOT_RUN',
      repairs: Number.isInteger(runtime.repairs) ? runtime.repairs : (Number.isInteger(result.repairs) ? result.repairs : 0),
      screenshots: Array.isArray(runtime.screenshots) ? runtime.screenshots.length : 0,
      checkedAt: adoptedAt,
    },
    adoptedAt,
    previous: previousSource,
  });
  if (record && record.previous && previousSource) {
    // domain 会把嵌套记录 verified 归一为 false；这里按「采用前的内存记录」恢复原值，
    // 只可能恢复为 true 的前提是：上一版本会话里确实被校验过（adopted && verified）。
    record.previous = {
      ...record.previous,
      verified: previousSource.status === 'adopted' && previousSource.verified === true,
    };
  }
  // 本会话刚采用：overlay 刚由主进程校验过，内存里可以按 verified 使用；
  // 落盘时 domain 白名单会重新写回 verified=false，重开再由 candidateCheck 置位。
  return record && record.status === 'adopted' ? { ...record, verified: true } : record;
}

/** 项目快照里的记录 → 放进会话 state 供 buildPlanFromSession 使用。 */
export function adoptionStateSlice(record) {
  return record && record.status !== 'none' ? record : null;
}

/**
 * 撤销：恢复上一版记录（没有则 null）。
 *
 * 关键：**撤销不是重新校验**。上一版的 verified 必须保留原值——
 * - 上一版在本会话/重开校验里通过过（verified=true）→ 撤销后仍可用；
 * - 上一版未校验或已漂移（verified=false / unavailable）→ 撤销后仍被导出
 *   门禁阻断并提示，绝不能在撤销时“顺手置 true”放行。
 */
export function undoAdoptionRecord(record) {
  if (!record || record.status === 'none') {
    return { restored: false, adoption: null, undone: null };
  }
  const previousSource = record.previous && record.previous.status !== 'none' ? record.previous : null;
  const undone = undoFrontendAdoption(record);
  if (!undone.restored) return { restored: false, adoption: record, undone: null };
  const restored = undone.adoption && undone.adoption.status !== 'none' ? undone.adoption : null;
  if (!restored) return { restored: true, adoption: null, undone: undone.undone };
  if (restored.status !== 'adopted') {
    // 不可用的上一版保持不可用（issue/status 交给导出入口阻断），不假装恢复成功。
    return { restored: true, adoption: { ...restored, verified: false }, undone: undone.undone };
  }
  return {
    restored: true,
    adoption: { ...restored, verified: previousSource ? previousSource.verified === true : false },
    undone: undone.undone,
  };
}

/** 全局提示文案（缺失/漂移/未校验/已采用都给出可读状态）。 */
export function adoptionNotice(record) {
  if (!record || record.status === 'none') return null;
  if (record.status === 'unavailable') {
    return record.issue && record.issue.message
      ? record.issue.message
      : '候选前端当前不可用，已回退到 Base 页面（导出会被阻断）。';
  }
  if (record.verified !== true) {
    return '项目里的候选前端还没有校验 overlay 摘要；导出前会再次校验，不会静默回退 Base。';
  }
  return '已采用候选前端 '
    + record.candidateId + '@' + record.candidateVersion
    + '（微信验证：' + ((record.verification && record.verification.runtime) || 'NOT_RUN') + '）。';
}

export function describeAdoption(record) {
  return describeFrontendCandidate(record);
}
