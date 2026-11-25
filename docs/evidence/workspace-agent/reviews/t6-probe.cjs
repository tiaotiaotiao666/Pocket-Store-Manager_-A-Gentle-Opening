'use strict';

/**
 * t16（Review-t6）独立探针：不引用 t6 的测试文件，直接 require 被复核实现，
 * 用 fake model / fake coordinator / fake fetch 复核关键判据（真实上游调用 0 次）。
 *
 * 只读被复核代码；本身只写自己的 stdout。运行：
 *   node docs/evidence/workspace-agent/reviews/t6-probe.cjs
 * 退出码：0 = 全部 probe 成立；1 = 至少一条不成立；2 = 探针自身错误。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RUNTIME_DIR = path.join(ROOT, 'desktop', 'agent-runtime');
const runtime = require(RUNTIME_DIR);
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
}
function check(id, fn) {
  try {
    const value = fn();
    record(id, value === undefined ? true : value, value === undefined ? 'ok' : value);
  } catch (error) {
    record(id, false, (error && error.message) || String(error));
  }
}

/* ---------------------- 1. 源码边界（第二执行链） ---------------------- */

check('S1-no-write-api-in-agent-runtime', () => {
  const writeApis = /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmdir|rmdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|createWriteStream|openSync|writeSync)\b/;
  const offenders = [];
  for (const name of fs.readdirSync(RUNTIME_DIR).filter((item) => item.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
    if (writeApis.test(source)) offenders.push(name);
  }
  if (offenders.length > 0) throw new Error('发现写盘 API：' + offenders.join(','));
  return '0 个模块包含写盘/改权限/删除 API';
});

check('S2-no-child-process-in-agent-runtime', () => {
  const offenders = [];
  for (const name of fs.readdirSync(RUNTIME_DIR).filter((item) => item.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
    if (/require\(['"](node:)?child_process['"]\)/.test(source)) offenders.push(name);
    if (/\b(spawnSync|execSync|execFileSync)\b/.test(source)) offenders.push(name);
  }
  if (offenders.length > 0) throw new Error('发现子进程入口：' + offenders.join(','));
  return '0 个模块 require child_process / 同步执行命令';
});

check('S3-only-images-requires-fs-and-only-reads', () => {
  const withFs = [];
  for (const name of fs.readdirSync(RUNTIME_DIR).filter((item) => item.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
    if (/require\(['"](node:)?fs(\/promises)?['"]\)/.test(source)) withFs.push(name);
  }
  if (withFs.length !== 1 || withFs[0] !== 'images.cjs') {
    throw new Error('require fs 的模块应为且仅为 images.cjs，实际：' + JSON.stringify(withFs));
  }
  return '仅 images.cjs require fs（只读资产，无写 API）';
});

check('S4-no-pseudo-status-rewrite', () => {
  const offenders = [];
  for (const name of fs.readdirSync(RUNTIME_DIR).filter((item) => item.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
    if (source.includes('待本地确认')) offenders.push(name + ':待本地确认');
    if (/replace\([^)]*已采用/.test(source)) offenders.push(name + ':replace-已采用');
    if (/FORBIDDEN_CLAIM/.test(source)) offenders.push(name + ':FORBIDDEN_CLAIM');
  }
  if (offenders.length > 0) throw new Error(offenders.join(','));
  return '无「待本地确认」改写 / 无 claim 白名单';
});

/* ------------------------- 2. 工具面（§14.3） ------------------------- */

check('T1-eleven-model-tools-and-platform-only-excluded', () => {
  const defs = runtime.buildToolDefinitions();
  if (defs.length !== 11) throw new Error('模型工具数=' + defs.length);
  const names = defs.map((item) => item.function.name);
  if (JSON.stringify(names) !== JSON.stringify(runtime.MODEL_TOOL_NAMES)) {
    throw new Error('工具顺序/名单与 MODEL_TOOL_NAMES 不一致');
  }
  for (const platform of runtime.PLATFORM_ONLY_TOOL_NAMES) {
    if (names.includes(platform)) throw new Error('平台专用工具出现在模型工具列表：' + platform);
    const verdict = runtime.classifyModelToolName(platform);
    if (verdict.ok !== false || verdict.code !== 'AGENT_TOOL_NOT_ALLOWED') {
      throw new Error(platform + ' 未被拒绝：' + JSON.stringify(verdict));
    }
  }
  return '11 个模型工具 + 3 个平台专用全部 AGENT_TOOL_NOT_ALLOWED';
});

/* --------------------- 3. runtime 行为（fake） --------------------- */

const CONTEXT = Object.freeze({
  projectId: 'probe-project',
  runId: 'probe-run',
  turnId: 'probe-turn',
  attemptId: 'probe-attempt',
});

function toolCall(id, name, args) {
  return { id, name, arguments: JSON.stringify(args || {}) };
}

function makeModelChat(script, options) {
  const calls = [];
  let index = 0;
  return {
    calls,
    describe: () => ({ transport: 'direct', wired: true, supportsVision: false }),
    chat: async (payload) => {
      calls.push(payload);
      if (options && typeof options.onCall === 'function') options.onCall(payload, calls.length);
      const step = script[index];
      index += 1;
      if (!step) throw new Error('probe fake model script exhausted');
      return {
        model: 'probe-model',
        content: typeof step.content === 'string' ? step.content : '',
        toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls : [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: step.finishReason === undefined ? 'stop' : step.finishReason,
        truncated: step.truncated === true,
      };
    },
  };
}

function makeCoordinator(handlers) {
  const calls = [];
  return {
    calls,
    invokeTool: async (input) => {
      calls.push(input);
      const handler = handlers && handlers[input.tool];
      return handler ? handler(input, calls.length) : { ok: true, data: {} };
    },
    assertRunActive: () => ({ ok: true }),
  };
}

async function checkAsync(id, fn) {
  try {
    const value = await fn();
    record(id, value === undefined ? true : value, value === undefined ? 'ok' : value);
  } catch (error) {
    record(id, false, (error && error.message) || String(error));
  }
}

/* ------------------------- 4. maxTokens（真实 requestChat） ------------------------- */

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('base64')),
    decryptString: (buffer) => Buffer.from(buffer.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

function makeUpstream(script) {
  const bodies = [];
  let index = 0;
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const step = (script && script[index]) || {};
      index += 1;
      const payload = step.payload === undefined
        ? {
          model: 'deepseek-flash',
          choices: [{ message: { content: 'pong' }, finish_reason: step.finishReason || 'stop' }],
        }
        : step.payload;
      return { ok: true, status: 200, json: async () => payload };
    },
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't16-review-'));
  try {
    /* ---- 截断：带 tool_calls 也必须停批 ---- */
    await checkAsync('R1-truncated-with-tool-calls-stops-batch', async () => {
      const coordinator = makeCoordinator();
      const modelChat = makeModelChat([{
        content: '半截源码',
        finishReason: 'length',
        toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'pages/home/index.wxml', content: '<view/>' }] })],
      }]);
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: '改首页' } });
      if (result.code !== 'AGENT_OUTPUT_TRUNCATED') throw new Error('code=' + result.code);
      if (result.data.status !== 'output_truncated' || result.data.retryable !== true) {
        throw new Error('status/retryable 不符：' + JSON.stringify(result.data));
      }
      if (coordinator.calls.length !== 0) throw new Error('截断批执行了工具：' + coordinator.calls.length);
      if (modelChat.calls.length !== 1) throw new Error('截断后仍发起上游：' + modelChat.calls.length);
      return '工具 0 次、上游 1 次、status=output_truncated/retryable';
    });

    await checkAsync('R2-empty-content-length-is-truncated', async () => {
      const coordinator = makeCoordinator();
      const modelChat = makeModelChat([{ content: '', finishReason: 'length' }]);
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: '看长图' } });
      if (result.code !== 'AGENT_OUTPUT_TRUNCATED') throw new Error('code=' + result.code);
      if (result.data.stopReason === 'empty_reply') throw new Error('被当成 empty_reply');
      return '空正文 + length → AGENT_OUTPUT_TRUNCATED（非 empty_reply）';
    });

    /* ---- 取消：取消后不再发上游 ---- */
    await checkAsync('R3-aborted-signal-no-upstream-call', async () => {
      const controller = new AbortController();
      controller.abort();
      const modelChat = makeModelChat([{ content: '不该被调用' }]);
      const run = runtime.createDirectWorkspaceRuntime({ coordinator: makeCoordinator(), modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x', signal: controller.signal } });
      if (result.code !== 'AGENT_CANCELLED') throw new Error('code=' + result.code);
      if (modelChat.calls.length !== 0) throw new Error('取消后仍发上游：' + modelChat.calls.length);
      return 'signal 已 abort → 上游 0 次';
    });

    await checkAsync('R4-coordinator-gate-rejects-no-upstream-call', async () => {
      const modelChat = makeModelChat([{ content: '不该被调用' }]);
      const coordinator = makeCoordinator();
      coordinator.assertRunActive = () => ({ ok: false, code: 'AGENT_CANCELLED', message: 'run 已取消' });
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
      if (result.code !== 'AGENT_CANCELLED') throw new Error('code=' + result.code);
      if (modelChat.calls.length !== 0) throw new Error('取消后仍发上游：' + modelChat.calls.length);
      return 'Coordinator 拒绝 → 上游 0 次';
    });

    await checkAsync('R5-late-cancel-drops-tool-batch', async () => {
      const controller = new AbortController();
      const modelChat = makeModelChat([{
        content: '迟到的回复',
        toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'a.wxml', content: 'x' }] })],
      }], { onCall: () => controller.abort() });
      const coordinator = makeCoordinator();
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x', signal: controller.signal } });
      if (result.code !== 'AGENT_CANCELLED') throw new Error('code=' + result.code);
      if (coordinator.calls.length !== 0) throw new Error('迟到结果执行了工具');
      if (modelChat.calls.length !== 1) throw new Error('迟到后又发上游');
      return '模型返回后取消 → 工具 0 次、后续上游 0 次';
    });

    /* ---- 顺序契约闸门 ---- */
    await checkAsync('R6-order-contract-gate-blocks-repeat-submit', async () => {
      const stale = {
        ok: false,
        code: 'AGENT_EVIDENCE_STALE',
        message: '证据陈旧',
        nextAction: 'rerun-checks',
        issues: [{ code: 'EVIDENCE_STALE_RERUN_CHECKS' }],
      };
      let submitCalls = 0;
      const coordinator = makeCoordinator({
        submit_candidate: () => {
          submitCalls += 1;
          return submitCalls === 1 ? stale : { ok: true, data: { status: 'submitted' } };
        },
        run_check: () => ({ ok: true, data: { status: 'PASS' } }),
      });
      // 第二次 submit 换参数，避免“同参三次 → loop_detected”抢先命中；
      // 本 probe 要单独验证的是「顺序契约闸门」而不是 loop detection。
      const modelChat = makeModelChat([
        { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
        { content: '', toolCalls: [toolCall('c2', 'submit_candidate', { targetPage: 'menu' })] },
        { content: '', toolCalls: [toolCall('c3', 'run_check', { checkId: 'source.check' })] },
        { content: '', toolCalls: [toolCall('c4', 'submit_candidate', { targetPage: 'cart' })] },
        { content: '已按 nextAction 重跑检查后提交。', finishReason: 'stop' },
      ]);
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: '提交' } });
      if (!result.ok) throw new Error('回合失败：' + result.code);
      const tools = coordinator.calls.map((call) => call.tool);
      if (JSON.stringify(tools) !== JSON.stringify(['submit_candidate', 'run_check', 'submit_candidate'])) {
        throw new Error('Coordinator 收到工具序列不符：' + JSON.stringify(tools));
      }
      const blocked = result.data.toolCalls.filter((trace) => trace.note === 'blocked_by_order_contract');
      if (blocked.length !== 1 || blocked[0].errorCode !== 'AGENT_EVIDENCE_STALE') {
        throw new Error('本地闸门未拦住第二次 submit');
      }
      const secondToolMessage = modelChat.calls[2].messages.filter((message) => message.role === 'tool')[1];
      const body = JSON.parse(secondToolMessage.content);
      if (body.error.nextAction !== 'rerun-checks') throw new Error('缺 nextAction=rerun-checks');
      return '陈旧 submit 被本地拒绝；run_check 后放行；nextAction 回填';
    });

    /* ---- trace 脱敏 ---- */
    await checkAsync('R7-trace-has-no-prompt-key-image', async () => {
      const secret = 'sk-probe-0123456789abcdef';
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const modelChat = makeModelChat([
        { content: '', toolCalls: [toolCall('c1', 'read_file', { path: 'pages/home/index.wxml' })] },
        { content: '完成', finishReason: 'stop' },
      ]);
      const coordinator = makeCoordinator({
        read_file: () => ({ ok: true, data: { content: 'SOURCE ' + dataUrl + ' ' + secret } }),
      });
      const run = runtime.createDirectWorkspaceRuntime({ coordinator, modelChat });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: '把标题改成' + secret } });
      const serialized = JSON.stringify(result);
      for (const needle of [secret, 'data:image', 'SOURCE ', 'base64']) {
        if (serialized.includes(needle)) throw new Error('trace 泄漏：' + needle);
      }
      const traces = JSON.stringify(result.data.toolCalls);
      if (traces.includes('index.wxml')) throw new Error('trace 含工具参数');
      return '结果/trace 不含 Key、prompt、图片 data URL、工具参数';
    });

    /* ---- 无 Coordinator 不造执行链 ---- */
    await checkAsync('R8-no-coordinator-is-runtime-tool-missing', async () => {
      const run = runtime.createDirectWorkspaceRuntime({ modelChat: makeModelChat([{ content: 'x' }]) });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
      if (result.code !== 'AGENT_RUNTIME_TOOL_MISSING') throw new Error('code=' + result.code);
      return 'AGENT_RUNTIME_TOOL_MISSING（不自己造执行链）';
    });

    /* ---- X9：reply 原样透传 ---- */
    await checkAsync('R9-x9-reply-passthrough', async () => {
      const claim = '已采用并通过验证。';
      const run = runtime.createDirectWorkspaceRuntime({
        coordinator: makeCoordinator(),
        modelChat: makeModelChat([{ content: claim, finishReason: 'stop' }]),
      });
      const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
      if (result.data.reply !== claim) throw new Error('reply 被改写：' + result.data.reply);
      return 'reply 原样透传';
    });

    /* ---- maxTokens 契约（真实 requestChat + fake fetch） ---- */
    await checkAsync('R10-maxTokens-contract', async () => {
      const upstream = makeUpstream([{ finishReason: 'stop' }, { finishReason: 'stop' }, { finishReason: 'stop' }, { finishReason: 'length', payload: { model: 'deepseek-flash', choices: [{ message: { content: '' }, finish_reason: 'length' }] } }]);
      credentialsMod.resetSharedModelCallScheduler();
      const credentials = credentialsMod.createModelCredentials({
        userDataDir: temp,
        safeStorage: fakeSafeStorage(),
        fetchImpl: upstream.fetchImpl,
        env: { MODEL_UPSTREAM_TOKEN_DIR: path.join(temp, 'slots') },
      });
      await credentials.setKey('sk-test-0123456789abcdef');
      const messages = [{ role: 'user', content: 'ping' }];

      const direct = await credentials.chat({ messages, profile: 'direct-edit' });
      if (upstream.bodies[0].max_tokens !== 6000) throw new Error('direct-edit 默认≠6000：' + upstream.bodies[0].max_tokens);
      if (direct.finishReason !== 'stop' || direct.truncated !== false) throw new Error('stop 未回传 truncated=false');

      const raised = await credentials.chat({ messages, profile: 'direct-edit', maxTokens: 1200 });
      if (upstream.bodies[1].max_tokens !== 6000) throw new Error('1200 未被抬到 6000：' + upstream.bodies[1].max_tokens);
      if (raised.maxTokensRaised !== true) throw new Error('未标记 maxTokensRaised');

      const chatDefault = await credentials.chat({ messages, profile: 'chat' });
      const chatBodyTokens = upstream.bodies[2].max_tokens;
      if (chatBodyTokens !== 1200) throw new Error('chat 默认≠1200：' + chatBodyTokens);

      const length = await credentials.chat({ messages, profile: 'direct-edit' });
      if (length.finishReason !== 'length' || length.truncated !== true) {
        throw new Error('length 未标 truncated：' + JSON.stringify(length));
      }

      let overLimit = null;
      try {
        await credentials.chat({ messages, profile: 'direct-edit', maxTokens: 8001 });
      } catch (error) {
        overLimit = error;
      }
      if (!overLimit || overLimit.code !== 'MODEL_REQUEST_INVALID') {
        throw new Error('>8000 未显式报错：' + JSON.stringify(overLimit && overLimit.code));
      }

      credentialsMod.resetSharedModelCallScheduler();
      return 'direct-edit 默认 6000 / 1200→6000(raised) / 上限 8000 显式拒绝 / length→truncated；'
        + 'chat 通道默认仍为 1200（既有对话行为，非源码编辑回退）';
    });
  } finally {
    try { credentialsMod.resetSharedModelCallScheduler(); } catch (error) { /* ignore */ }
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (error) { /* ignore */ }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(JSON.stringify({
    probe: 't6-review-probe.v1',
    at: new Date().toISOString(),
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ probe: 't6-review-probe.v1', error: (error && error.message) || String(error) }, null, 2));
  process.exitCode = 2;
});
