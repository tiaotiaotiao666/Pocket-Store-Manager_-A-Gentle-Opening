'use strict';

/**
 * 后端就绪判定（W0 / P0-1）。
 *
 * 一键启动脚本原先只看「端口 3000 有没有人监听」，于是出现「服务看起来正常、
 * 数据库其实连不上」的演示事故。本模块把判定收敛成唯一实现：
 *
 *   ready === HTTP 200 && body.database === 'ok'
 *
 * 只要 `/api/v1/health` 返回 200 不算通过，端口可连通也不算通过。
 *
 * 用法（由 scripts/start-all.ps1 / ICT\start-all.ps1 调用）：
 *   node scripts/backend-readiness.cjs --port 3000 [--wait-seconds 45]
 *
 * 输出：单行 JSON 到 stdout；退出码 0 = 就绪，1 = 不就绪，2 = 参数错误。
 * 非就绪时 stderr 不写内容，保证 PowerShell 侧可以安全地 ConvertFrom-Json。
 */

const http = require('node:http');

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3000,
  path: '/api/v1/readyz',
  timeoutMs: 3000,
  waitSeconds: 0,
  intervalMs: 700,
});

/** 就绪失败的稳定错误码，供启动脚本按码给处置建议。 */
const READINESS_CODES = Object.freeze({
  BACKEND_UNREACHABLE: 'BACKEND_UNREACHABLE',
  BACKEND_HTTP_ERROR: 'BACKEND_HTTP_ERROR',
  BACKEND_BAD_RESPONSE: 'BACKEND_BAD_RESPONSE',
  DATABASE_NOT_READY: 'DATABASE_NOT_READY',
  PROBE_FAILED: 'PROBE_FAILED',
});

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    host: typeof source.host === 'string' && source.host ? source.host : DEFAULTS.host,
    port: clampInt(source.port, DEFAULTS.port, 1, 65535),
    path: typeof source.path === 'string' && source.path ? source.path : DEFAULTS.path,
    timeoutMs: clampInt(source.timeoutMs, DEFAULTS.timeoutMs, 200, 30000),
    waitSeconds: clampInt(source.waitSeconds, DEFAULTS.waitSeconds, 0, 600),
    intervalMs: clampInt(source.intervalMs, DEFAULTS.intervalMs, 50, 10000),
  };
}

/**
 * 单次探测。永不抛错：连接失败、超时、非 JSON 都收敛成结构化结果。
 *
 * @param {{host?:string,port?:number,path?:string,timeoutMs?:number}} options
 * @returns {Promise<{httpStatus:number|null,body:any,error:null|{code:string,message:string}}>}
 */
function probeOnce(options) {
  const opts = normalizeOptions(options);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = http.request(
      { host: opts.host, port: opts.port, path: opts.path, method: 'GET', timeout: opts.timeoutMs },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch (error) {
            body = null;
          }
          finish({ httpStatus: response.statusCode || null, body, raw, error: null });
        });
        response.on('error', (error) => {
          finish({
            httpStatus: null,
            body: null,
            raw: '',
            error: { code: READINESS_CODES.PROBE_FAILED, message: error.message || '响应读取失败' },
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({
        httpStatus: null,
        body: null,
        raw: '',
        error: { code: READINESS_CODES.BACKEND_UNREACHABLE, message: `连接 ${opts.host}:${opts.port} 超时（${opts.timeoutMs}ms）` },
      });
    });

    request.on('error', (error) => {
      const refused = error && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET');
      finish({
        httpStatus: null,
        body: null,
        raw: '',
        error: {
          code: refused ? READINESS_CODES.BACKEND_UNREACHABLE : READINESS_CODES.PROBE_FAILED,
          message: `${opts.host}:${opts.port} ${error && error.code ? error.code : (error && error.message) || '不可达'}`,
        },
      });
    });

    request.end();
  });
}

/**
 * 把一次探测结果翻译成「能不能用」以及人话原因。
 *
 * @param {{httpStatus:number|null,body:any,error:any}} probe
 * @returns {{ready:boolean,code:string|null,message:string,httpStatus:number|null,
 *   database:string|null,cache:string|null,cacheDegraded:boolean}}
 */
function evaluateReadiness(probe) {
  const source = probe && typeof probe === 'object' ? probe : {};
  const body = source.body && typeof source.body === 'object' ? source.body : null;
  const database = body && typeof body.database === 'string' ? body.database : null;
  const cache = body && typeof body.cache === 'string' ? body.cache : null;
  const base = {
    httpStatus: typeof source.httpStatus === 'number' ? source.httpStatus : null,
    database,
    cache,
    cacheDegraded: cache === 'memory',
  };

  if (source.error) {
    return {
      ...base,
      ready: false,
      code: source.error.code || READINESS_CODES.PROBE_FAILED,
      message: source.error.message || '就绪探测失败',
    };
  }
  if (base.httpStatus !== 200) {
    return {
      ...base,
      ready: false,
      code: READINESS_CODES.BACKEND_HTTP_ERROR,
      message: `/api/v1/readyz 返回 HTTP ${base.httpStatus === null ? '无响应' : base.httpStatus}`,
    };
  }
  if (!body) {
    return {
      ...base,
      ready: false,
      code: READINESS_CODES.BACKEND_BAD_RESPONSE,
      message: '/api/v1/readyz 响应不是合法 JSON 对象',
    };
  }
  if (database !== 'ok') {
    return {
      ...base,
      ready: false,
      code: READINESS_CODES.DATABASE_NOT_READY,
      message: `数据库未就绪：readyz.database=${database === null ? '缺失' : database}`,
    };
  }
  return {
    ...base,
    ready: true,
    code: null,
    message: `就绪：database=${database}${cache ? `, cache=${cache}` : ''}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 轮询直到就绪或超时。`waitSeconds=0` 表示只探测一次。
 *
 * @param {object} options
 * @returns {Promise<{ready:boolean,code:string|null,message:string,httpStatus:number|null,
 *   database:string|null,cache:string|null,cacheDegraded:boolean,attempts:number,elapsedMs:number}>}
 */
async function waitForReadiness(options) {
  const opts = normalizeOptions(options);
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let attempts = 0;
  let last = null;
  const startedAt = Date.now();

  for (;;) {
    attempts += 1;
    last = evaluateReadiness(await probeOnce(opts));
    if (last.ready) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(opts.intervalMs, Math.max(50, deadline - Date.now())));
  }

  return { ...last, attempts, elapsedMs: Date.now() - startedAt };
}

function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = { ...DEFAULTS };
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    const next = list[index + 1];
    if (token === '--port' && next !== undefined) { options.port = next; index += 1; continue; }
    if (token === '--host' && next !== undefined) { options.host = next; index += 1; continue; }
    if (token === '--path' && next !== undefined) { options.path = next; index += 1; continue; }
    if (token === '--timeout-ms' && next !== undefined) { options.timeoutMs = next; index += 1; continue; }
    if (token === '--wait-seconds' && next !== undefined) { options.waitSeconds = next; index += 1; continue; }
    if (token === '--interval-ms' && next !== undefined) { options.intervalMs = next; index += 1; continue; }
    if (token === '--help' || token === '-h') return { help: true };
    return { error: `未知参数：${token}` };
  }
  return { options: normalizeOptions(options) };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write('usage: node scripts/backend-readiness.cjs [--port 3000] [--host 127.0.0.1] [--wait-seconds 45] [--timeout-ms 3000]\n');
    return 2;
  }
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify({ ready: false, code: 'BAD_ARGS', message: parsed.error })}\n`);
    return 2;
  }
  const result = await waitForReadiness(parsed.options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ready ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        ready: false,
        code: READINESS_CODES.PROBE_FAILED,
        message: error && error.message ? error.message : '就绪探测异常',
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULTS,
  READINESS_CODES,
  normalizeOptions,
  probeOnce,
  evaluateReadiness,
  waitForReadiness,
  parseArgs,
  main,
};
