/**
 * 运行自检服务（渲染进程编排）。
 *
 * 五行：运行环境 / 本地数据目录 / Composer 资源 / 后端服务 / 模型通道。
 * 前三条由主进程探测；后端与模型在渲染层探测，这样看到的是用户真实会遇到的可用性
 * （含 CORS 语义，见实现方案 5.5）。
 */

import { createDiagnosticLine, scrubDiagnosticJson, toCopyText, DIAGNOSTIC_RESULTS } from '../domain/diagnosticFormat.mjs';

const HEALTH_TIMEOUT_MS = 4000;
const DESKTOP_ONLY_MESSAGE = '需在桌面应用中运行';

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  return api && api.isDesktop ? api : null;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

async function requestJson(url, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) || HEALTH_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: opts.mode || 'cors',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
      headers: opts.mode === 'no-cors' ? undefined : { Accept: 'application/json' },
    });
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    return {
      ok: true,
      status: response.status,
      type: response.type,
      body,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function backendLine(result) {
  return createDiagnosticLine({
    id: 'backend',
    title: '后端服务',
    result: result.result,
    message: result.message,
    action: result.action,
    latencyMs: result.latencyMs,
  });
}

async function probeBackend(config) {
  const base = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.FAIL,
        message: '接口地址格式不正确',
        action: '在设置中填写 http:// 或 https:// 开头的地址',
      }),
      json: { baseUrl: base, health: { ok: false, status: 0 }, readyz: null },
      reachable: false,
    };
  }

  const health = await requestJson(`${base}/health`);
  if (!health.ok) {
    const opaque = await requestJson(`${base}/health`, { mode: 'no-cors' });
    if (opaque.ok) {
      return {
        line: backendLine({
          result: DIAGNOSTIC_RESULTS.FAIL,
          message: '服务在运行但被浏览器跨域策略拦截，请检查 DESKTOP_ORIGIN',
          action: '把 DESKTOP_ORIGIN 调整为应用来源，或留空以反射来源',
        }),
        json: { baseUrl: base, health: { ok: false, status: 0, failure: 'cors' }, readyz: null },
        reachable: false,
      };
    }
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.FAIL,
        message: '服务未启动，请在工作区根目录运行 npm start（或 npm run server:dev）',
        action: '启动后端后重新自检',
      }),
      json: { baseUrl: base, health: { ok: false, status: 0, failure: 'network' }, readyz: null },
      reachable: false,
    };
  }

  if (health.status >= 500) {
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.FAIL,
        message: `服务异常（HTTP ${health.status}），请查看服务端日志`,
        action: '查看 NestJS 控制台输出',
        latencyMs: health.latencyMs,
      }),
      json: { baseUrl: base, health: { ok: false, status: health.status }, readyz: null },
      reachable: false,
    };
  }

  const healthOk = health.status >= 200 && health.status < 300 && health.body && health.body.status === 'ok';
  if (!healthOk) {
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.FAIL,
        message: `健康检查返回异常（HTTP ${health.status}）`,
        action: '确认 /api/v1/health 是否注册',
        latencyMs: health.latencyMs,
      }),
      json: { baseUrl: base, health: { ok: false, status: health.status }, readyz: null },
      reachable: false,
    };
  }

  const ready = await requestJson(`${base}/readyz`);
  const healthJson = {
    ok: true,
    status: health.status,
    service: health.body?.service || null,
    environment: health.body?.environment || null,
    latencyMs: health.latencyMs,
  };

  if (!ready.ok) {
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.WARN,
        message: '后端可用，但就绪检查未返回（可能仍在启动）',
        action: '稍后重新自检',
        latencyMs: health.latencyMs,
      }),
      json: { baseUrl: base, health: healthJson, readyz: { ok: false, status: 0 } },
      reachable: true,
    };
  }

  const readyJson = {
    ok: ready.status >= 200 && ready.status < 300,
    status: ready.status,
    database: ready.body?.database || null,
    cache: ready.body?.cache || null,
  };

  if (ready.status === 503) {
    return {
      line: backendLine({
        result: DIAGNOSTIC_RESULTS.WARN,
        message: '服务在运行，但数据库不可用（readyz 503）',
        action: '检查 MySQL 连接后重新自检；演示流程仍可查看已缓存数据',
        latencyMs: health.latencyMs,
      }),
      json: { baseUrl: base, health: healthJson, readyz: readyJson },
      reachable: true,
    };
  }

  return {
    line: backendLine({
      result: DIAGNOSTIC_RESULTS.PASS,
      message: `服务可用 · health ${health.status} · readyz ${ready.status}`,
      latencyMs: health.latencyMs,
    }),
    json: { baseUrl: base, health: healthJson, readyz: readyJson },
    reachable: true,
  };
}

function agentLine(config, backend) {
  const transport = config.agentTransport === 'http' ? 'http' : 'mock';
  if (transport === 'mock') {
    return createDiagnosticLine({
      id: 'agent',
      title: '模型通道',
      result: DIAGNOSTIC_RESULTS.PASS,
      message: '本地 Mock（未接入真实模型）',
    });
  }

  const endpoint = String(config.agentEndpoint || '');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(endpoint)) {
    return createDiagnosticLine({
      id: 'agent',
      title: '模型通道',
      result: DIAGNOSTIC_RESULTS.FAIL,
      message: 'Agent 端点配置不正确（应为 /api/v1/agent/turn）',
      action: '在设置中修正 Agent 端点',
    });
  }
  if (!backend.reachable) {
    return createDiagnosticLine({
      id: 'agent',
      title: '模型通道',
      result: DIAGNOSTIC_RESULTS.FAIL,
      message: '后端不可用，Agent 无法工作',
      action: '先修复后端服务',
    });
  }
  return createDiagnosticLine({
    id: 'agent',
    title: '模型通道',
    result: DIAGNOSTIC_RESULTS.PASS,
    message: '后端可用，Agent 通道已配置（未发起真实调用，不消耗额度）',
  });
}

export function createDiagnosticsService() {
  const mode = bridge() ? 'desktop' : 'browser';

  async function run(config, scope) {
    const api = bridge();
    const scopes = Array.isArray(scope) && scope.length > 0 ? scope : ['all'];
    let lines = [];
    let json = {};

    if (api && typeof api.diagnosticsRun === 'function') {
      const main = await api.diagnosticsRun({ scope: ['runtime', 'storage', 'composer'] });
      if (main && main.ok === true) {
        lines = Array.isArray(main.data?.lines) ? main.data.lines : [];
        json = main.data?.json || {};
      } else {
        lines = [
          createDiagnosticLine({ id: 'runtime', title: '运行环境', result: DIAGNOSTIC_RESULTS.WARN, message: '主进程自检未返回' }),
          createDiagnosticLine({ id: 'storage', title: '本地数据目录', result: DIAGNOSTIC_RESULTS.FAIL, message: main?.message || '数据目录探测失败' }),
          createDiagnosticLine({ id: 'composer', title: 'Composer 资源完整性', result: DIAGNOSTIC_RESULTS.FAIL, message: '模板资产检查失败' }),
        ];
        json = { app: { mode: 'desktop' } };
      }
    } else {
      lines = [
        createDiagnosticLine({
          id: 'runtime',
          title: '运行环境',
          result: DIAGNOSTIC_RESULTS.WARN,
          message: '当前是浏览器预览，导出与文件落盘不可用',
          action: '使用桌面应用获得完整体验',
        }),
        createDiagnosticLine({
          id: 'storage',
          title: '本地数据目录',
          result: DIAGNOSTIC_RESULTS.WARN,
          message: '浏览器预览没有本机数据目录',
        }),
        createDiagnosticLine({
          id: 'composer',
          title: 'Composer 资源完整性',
          result: DIAGNOSTIC_RESULTS.WARN,
          message: `${DESKTOP_ONLY_MESSAGE}，无法检查模板资产`,
        }),
      ];
      json = { app: { mode: 'browser' } };
    }

    const backend = await probeBackend(config || {});
    const agent = agentLine(config || {}, backend);

    const byId = new Map(lines.map((line) => [line.id, createDiagnosticLine(line)]));
    byId.set('backend', backend.line);
    byId.set('agent', agent);
    const ordered = ['runtime', 'storage', 'composer', 'backend', 'agent']
      .map((id) => byId.get(id))
      .filter(Boolean);

    const merged = {
      ...json,
      backend: backend.json,
      agent: {
        transport: config.agentTransport === 'http' ? 'http' : 'mock',
        endpoint: String(config.agentEndpoint || ''),
        timeoutMs: Number(config.agentTimeoutMs) || 30000,
        reachable: backend.reachable,
      },
      checks: ordered.map((line) => ({ id: line.id, result: line.result, message: line.message })),
    };
    const scrubbed = scrubDiagnosticJson(merged);

    return {
      status: 'ok',
      lines: ordered,
      json: scrubbed,
      copyText: toCopyText(ordered, scrubbed),
    };
  }

  async function saveSnapshot(json) {
    const api = bridge();
    if (!api || typeof api.diagnosticsSaveSnapshot !== 'function') {
      return { status: 'failed', code: 'DIAGNOSTICS_FAILED', message: '只有桌面应用可以保存诊断快照' };
    }
    const result = await api.diagnosticsSaveSnapshot({ json });
    if (!result || result.ok !== true) {
      return { status: 'failed', code: result?.code || 'DIAGNOSTICS_FAILED', message: result?.message || '诊断快照保存失败' };
    }
    return { status: 'ok', ...(result.data || {}) };
  }

  async function copyText(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  return { mode, run, saveSnapshot, copyText };
}

export const diagnosticsService = createDiagnosticsService();
export { probeBackend, agentLine };