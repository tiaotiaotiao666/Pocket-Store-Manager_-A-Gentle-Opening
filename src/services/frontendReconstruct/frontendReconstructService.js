/**
 * P4：候选前端服务层（渲染进程唯一的 IPC 出口）。
 *
 * 边界：
 * - 只调用 preload 暴露的 8 个语义 API（analyzeFrontend / buildCandidate /
 *   validateCandidate / verifyCandidate / adoptCandidate / discardCandidate /
 *   cancelFrontendRun / onFrontendProgress），不拼任意 channel、不读文件、不跑命令。
 * - 输入在渲染进程先做一次「明显不合法」的拦截（体积/类型/页面），主进程会再校验一次；
 *   这里的拦截只让错误更快出现，不替代主进程与本地执行模块的门禁。
 * - 主进程返回的绝对路径一律不落到界面：只透传 attempt 序号、相对证据路径与有界结论。
 */

import {
  FRONTEND_LIMITS,
  FRONTEND_RECONSTRUCT_CONTRACT,
  createFrontendRunId,
  describeFrontendError,
  normalizeFrontendImage,
  normalizeTargetPages,
  normalizeUtterance,
} from '../../domain/frontendReconstruct.mjs';
import {
  SCREEN_CONSENT_PURPOSE,
  describeScreenConsentError,
} from '../../domain/screenConsent.mjs';

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * B5：把「本次确认」规范成主进程能校验的形状（不含图片内容）。
 * 缺字段或格式不对一律返回 null —— 调用方据此拒绝发起请求。
 */
export function normalizeScreenConsent(value) {
  if (!value || typeof value !== 'object') return null;
  const confirmedAt = typeof value.confirmedAt === 'string' ? value.confirmedAt.slice(0, 40) : '';
  const imageDigest = typeof value.imageDigest === 'string' && IMAGE_DIGEST_PATTERN.test(value.imageDigest)
    ? value.imageDigest
    : '';
  const host = typeof value.host === 'string' ? value.host.slice(0, 120) : '';
  const purpose = value.purpose === SCREEN_CONSENT_PURPOSE ? SCREEN_CONSENT_PURPOSE : '';
  if (!confirmedAt || !imageDigest || !host || !purpose) return null;
  if (!Number.isFinite(Date.parse(confirmedAt))) return null;
  return { confirmedAt, imageDigest, host, purpose };
}

export const FRONTEND_ANALYZE_ENDPOINT = '/api/v1/agent/frontend-reconstruct';

function bridgeFromWindow() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  return api && api.isDesktop ? api : null;
}

function cleanString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** 组装 `frontend-reconstruct.v1` 请求体（严格键集合，与服务端契约一致）。 */
export function buildFrontendAnalyzePayload(input = {}, ids = {}) {
  const runId = cleanString(ids.runId || input.runId, 80);
  const requestId = cleanString(ids.requestId || input.requestId, 120) || `fr-${runId || 'local'}`;
  const image = normalizeFrontendImage(input.image);
  if (!image.ok) return { ok: false, code: image.code, message: image.message };
  if (!image.image) {
    return { ok: false, code: 'FRONTEND_IMAGE_INVALID', message: '请先上传一张参考截图。' };
  }
  const utterance = normalizeUtterance(input.utterance);
  if (typeof input.utterance === 'string' && input.utterance.length > FRONTEND_LIMITS.maxUtteranceChars) {
    return { ok: false, code: 'FRONTEND_UTTERANCE_TOO_LONG', message: describeFrontendError('FRONTEND_UTTERANCE_TOO_LONG') };
  }
  const targetPages = normalizeTargetPages(input.targetPages);
  if (targetPages.length === 0) {
    return { ok: false, code: 'FRONTEND_TARGET_PAGES_INVALID', message: describeFrontendError('FRONTEND_TARGET_PAGES_INVALID') };
  }
  const baseTemplate = input.baseTemplate && typeof input.baseTemplate === 'object' ? input.baseTemplate : {};
  const consent = normalizeScreenConsent(input.consent);
  return {
    ok: true,
    payload: {
      runId: runId || createFrontendRunId(),
      projectId: cleanString(input.projectId, 80) || null,
      requestId,
      utterance,
      image: {
        mediaType: image.image.mediaType,
        dataBase64: image.image.dataBase64,
        bytes: image.image.bytes,
      },
      targetPages,
      consent,
      current: {
        baseTemplate: {
          id: 'ordering-base',
          version: cleanString(baseTemplate.version, 24) || '1.0.0',
        },
        frontendPack: null,
        presentationPatch: input.presentationPatch && typeof input.presentationPatch === 'object' ? input.presentationPatch : {},
      },
      client: { surface: 'desktop', phase: 'frontend-reconstruct' },
      contractVersion: FRONTEND_RECONSTRUCT_CONTRACT,
    },
  };
}

function failure(code, message, extra) {
  return {
    ok: false,
    status: 'failed',
    code: code || 'FRONTEND_FAILED',
    message: message || describeFrontendError(code),
    ...(extra || {}),
  };
}

function fromIpc(result, fallbackCode) {
  if (!result || typeof result !== 'object') {
    return failure(fallbackCode, describeFrontendError(fallbackCode));
  }
  if (result.ok === true) {
    return { ok: true, status: 'ok', ...result };
  }
  return failure(
    cleanString(result.code, 60) || fallbackCode,
    cleanString(result.message, FRONTEND_LIMITS.maxTextChars) || describeFrontendError(result.code),
    result.details ? { details: result.details } : undefined,
  );
}

export function createFrontendReconstructService(options = {}) {
  const injected = options.api !== undefined ? options.api : null;
  const resolveApi = () => (injected !== null ? injected : bridgeFromWindow());
  const isDesktop = () => Boolean(resolveApi() && resolveApi().isDesktop);
  const mode = isDesktop() ? 'desktop' : 'browser';

  function missingApi() {
    return {
      ok: false,
      status: 'desktop-required',
      code: 'DESKTOP_REQUIRED',
      message: describeFrontendError('DESKTOP_REQUIRED'),
    };
  }

  function requireMethod(name) {
    const api = resolveApi();
    if (!api || typeof api[name] !== 'function') return null;
    return api;
  }

  async function analyze(input = {}) {
    const api = requireMethod('analyzeFrontend');
    if (!api) return missingApi();
    // B5 规则 1：没有本次确认就一个请求都不发（主进程还会再校验一次）。
    if (!normalizeScreenConsent(input.consent)) {
      return failure(
        'FRONTEND_CONSENT_REQUIRED',
        describeScreenConsentError('FRONTEND_CONSENT_REQUIRED') || describeFrontendError('FRONTEND_CONSENT_REQUIRED'),
      );
    }
    const runId = cleanString(input.runId, 80) || createFrontendRunId(options.now, options.random);
    const built = buildFrontendAnalyzePayload(input, { runId, requestId: input.requestId });
    if (!built.ok) return failure(built.code, built.message);
    let result;
    try {
      result = await api.analyzeFrontend(built.payload);
    } catch (error) {
      return failure('FRONTEND_ANALYZE_FAILED', describeFrontendError('FRONTEND_ANALYZE_FAILED'));
    }
    const outcome = fromIpc(result, 'FRONTEND_ANALYZE_FAILED');
    if (!outcome.ok) return outcome;
    const response = outcome.response && typeof outcome.response === 'object' ? outcome.response : null;
    if (!response) return failure('FRONTEND_ANALYZE_FAILED', describeFrontendError('FRONTEND_ANALYZE_FAILED'));
    return { ok: true, status: 'ok', runId, response };
  }

  async function buildCandidate(input = {}) {
    const api = requireMethod('buildCandidate');
    if (!api) return missingApi();
    const draft = input.draft && typeof input.draft === 'object' ? input.draft : null;
    if (!draft) return failure('FRONTEND_DRAFT_MISSING', '没有可构建的草稿，请先完成识别。');
    let bytes = 0;
    try {
      const text = JSON.stringify(draft);
      bytes = typeof TextEncoder === 'function'
        ? new TextEncoder().encode(text).length
        : text.length;
    } catch (error) {
      return failure('FRONTEND_PAYLOAD_INVALID', '草稿无法序列化，请重试。');
    }
    if (bytes > 128 * 1024) return failure('PAYLOAD_TOO_LARGE', '草稿超过 128 KB，已拒绝。');

    const hasPlan = Object.prototype.hasOwnProperty.call(input, 'plan');
    if (hasPlan) {
      if (!input.plan || typeof input.plan !== 'object' || Array.isArray(input.plan)) {
        return failure('FRONTEND_PAYLOAD_INVALID', 'plan 必须是对象。');
      }
      let planBytes = 0;
      try {
        const text = JSON.stringify(input.plan);
        if (typeof text !== 'string') throw new TypeError('PLAN_NOT_SERIALIZABLE');
        planBytes = typeof TextEncoder === 'function'
          ? new TextEncoder().encode(text).length
          : text.length;
      } catch (error) {
        return failure('FRONTEND_PAYLOAD_INVALID', 'plan 无法序列化，请重试。');
      }
      if (planBytes > 256 * 1024) {
        return failure('FRONTEND_PAYLOAD_INVALID', 'plan 超过 256 KiB，已拒绝。');
      }
    }

    const hasStoreId = Object.prototype.hasOwnProperty.call(input, 'storeId');
    if (hasStoreId && (typeof input.storeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.storeId))) {
      return failure('FRONTEND_PAYLOAD_INVALID', 'storeId 格式不正确。');
    }

    const hasBackendVersions = Object.prototype.hasOwnProperty.call(input, 'backendVersions');
    if (hasBackendVersions) {
      const versions = input.backendVersions;
      const keys = versions && typeof versions === 'object' && !Array.isArray(versions) ? Object.keys(versions) : [];
      const validKeys = keys.length === 2 && keys.every((key) => ['storeConfigVersion', 'catalogVersion'].includes(key));
      const validValues = validKeys
        && ['storeConfigVersion', 'catalogVersion'].every((key) => versions[key] === null
          || (Number.isInteger(versions[key]) && versions[key] >= 0));
      if (!validValues) {
        return failure('FRONTEND_PAYLOAD_INVALID', 'backendVersions 必须只含非负整数或 null 的 storeConfigVersion/catalogVersion。');
      }
    }

    let result;
    try {
      result = await api.buildCandidate({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
        draft,
        ...(hasPlan ? { plan: input.plan } : {}),
        ...(hasStoreId ? { storeId: input.storeId } : {}),
        ...(hasBackendVersions ? { backendVersions: input.backendVersions } : {}),
      });
    } catch (error) {
      return failure('FRONTEND_BUILD_FAILED', describeFrontendError('FRONTEND_BUILD_FAILED'));
    }
    return fromIpc(result, 'FRONTEND_BUILD_FAILED');
  }

  async function validateCandidate(input = {}) {
    const api = requireMethod('validateCandidate');
    if (!api) return missingApi();
    let result;
    try {
      result = await api.validateCandidate({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
        attempt: Number.isInteger(input.attempt) ? input.attempt : null,
      });
    } catch (error) {
      return failure('FRONTEND_VERIFICATION_MISSING', describeFrontendError('FRONTEND_VERIFICATION_MISSING'));
    }
    return fromIpc(result, 'FRONTEND_VERIFICATION_MISSING');
  }

  async function verifyCandidate(input = {}) {
    const api = requireMethod('verifyCandidate');
    if (!api) return missingApi();
    const hasAppId = input.appId !== undefined;
    const appId = hasAppId && typeof input.appId === 'string' ? input.appId.trim().toLowerCase() : '';
    if (hasAppId && !/^wx[0-9a-f]{16}$/.test(appId)) {
      return failure('FRONTEND_PAYLOAD_INVALID', 'appId 必须是 wx 加 16 位小写十六进制');
    }
    let result;
    try {
      result = await api.verifyCandidate({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
        attempt: Number.isInteger(input.attempt) ? input.attempt : null,
        ...(hasAppId ? { appId } : {}),
      });
    } catch (error) {
      return failure('FRONTEND_VERIFY_FAILED', describeFrontendError('FRONTEND_VERIFY_FAILED'));
    }
    return fromIpc(result, 'FRONTEND_VERIFY_FAILED');
  }

  async function adoptCandidate(input = {}) {
    const api = requireMethod('adoptCandidate');
    if (!api) return missingApi();
    let result;
    try {
      result = await api.adoptCandidate({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
        attempt: Number.isInteger(input.attempt) ? input.attempt : null,
        partialConfirmed: input.partialConfirmed === true,
      });
    } catch (error) {
      return failure('FRONTEND_ADOPT_FAILED', describeFrontendError('FRONTEND_ADOPT_FAILED'));
    }
    return fromIpc(result, 'FRONTEND_ADOPT_FAILED');
  }

  async function discardCandidate(input = {}) {
    const api = requireMethod('discardCandidate');
    if (!api) return missingApi();
    let result;
    try {
      result = await api.discardCandidate({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
        attempt: Number.isInteger(input.attempt) ? input.attempt : null,
      });
    } catch (error) {
      return failure('FRONTEND_DISCARD_FAILED', describeFrontendError('FRONTEND_DISCARD_FAILED'));
    }
    return fromIpc(result, 'FRONTEND_DISCARD_FAILED');
  }

  async function cancelRun(input = {}) {
    const api = requireMethod('cancelFrontendRun');
    if (!api) return missingApi();
    let result;
    try {
      result = await api.cancelFrontendRun({
        projectId: cleanString(input.projectId, 80),
        runId: cleanString(input.runId, 80),
      });
    } catch (error) {
      return failure('FRONTEND_NO_ACTIVE_RUN', describeFrontendError('FRONTEND_NO_ACTIVE_RUN'));
    }
    return fromIpc(result, 'FRONTEND_NO_ACTIVE_RUN');
  }

  /** 订阅主进程进度；返回退订函数（组件卸载时必须调用）。 */
  function onProgress(listener) {
    const api = requireMethod('onFrontendProgress');
    if (!api || typeof listener !== 'function') return () => {};
    const unsubscribe = api.onFrontendProgress((payload) => {
      if (!payload || typeof payload !== 'object') return;
      try {
        listener(payload);
      } catch (error) {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    });
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  }

  return {
    mode,
    analyze,
    buildCandidate,
    validateCandidate,
    verifyCandidate,
    adoptCandidate,
    discardCandidate,
    cancelRun,
    onProgress,
  };
}

export const frontendReconstructService = createFrontendReconstructService();
