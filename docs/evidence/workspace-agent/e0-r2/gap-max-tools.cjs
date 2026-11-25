'use strict';

/**
 * E0-Fix1（t12）回归脚本：模型工具上限必须等于 §14.3 工具清单长度（单一来源）。
 *
 * 背景：t7 报告的 F1 —— `desktop/model-credentials.cjs` 里旧的 `const MAX_TOOLS = 8;`
 * 小于 rev15 §14.3 冻结的 11 个模型工具，真实 direct 回合默认发全 11 个工具时会先被
 * `MODEL_REQUEST_INVALID: 工具数量超过上限` 拒掉（runtime 包成 `AGENT_TXN_ABORTED`），
 * 在发图之前就把整轮打死。
 *
 * 本脚本是**自校验**的：任何一项不符合预期 → 退出码 1；全部通过 → 退出码 0。
 * 真实上游调用 0 次（runtime 那条用 fake fetch 捕获真实发出的 HTTP body）。
 *
 * 运行：`node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CREDENTIALS_FILE = path.join(ROOT, 'desktop', 'model-credentials.cjs');
const credentialsMod = require(CREDENTIALS_FILE);
const { normalizeChatPayload } = credentialsMod;
const {
  buildToolDefinitions,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  createDirectWorkspaceRuntime,
  createModelChat,
} = require(path.join(ROOT, 'desktop', 'agent-runtime'));
const { makeProbePng } = require(path.join(__dirname, 'probe-tools.cjs'));

const checks = [];
function check(id, title, ok, detail) {
  checks.push({ id, title, ok: Boolean(ok), detail });
}

function attempt(payload) {
  try {
    normalizeChatPayload(payload);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, code: error.code, message: error.message };
  }
}

/* ---------------------------------------------------------------- */
/* C1 单一来源：源码里不再有写死的工具上限，也没有第二份工具名清单      */
/* ---------------------------------------------------------------- */

const source = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
// 只检查代码本体：注释里保留“旧的 MAX_TOOLS = 8 已被移除”的说明，不算违规。
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
check(
  'C1a',
  'model-credentials.cjs 的代码里不再有 MAX_TOOLS 标识符（写死的上限已删除）',
  !/\bMAX_TOOLS\b/.test(codeOnly),
  { occurrencesInCode: (codeOnly.match(/\bMAX_TOOLS\b/g) || []).length },
);
check(
  'C1b',
  '上限取自模型工具清单（require agent-runtime/constants.cjs 的 MODEL_TOOL_NAMES）',
  /require\(['"]\.\/agent-runtime\/constants\.cjs['"]\)/.test(source)
    && /MODEL_TOOL_NAMES/.test(source)
    && /MODEL_TOOL_NAMES\.length|Array\.isArray\(MODEL_TOOL_NAMES\)/.test(source),
  { helperDefined: /function\s+maxToolCount\s*\(/.test(source) },
);
const toolNameLiterals = MODEL_TOOL_NAMES.filter((name) => source.includes(`'${name}'`) || source.includes(`"${name}"`));
check(
  'C1c',
  'model-credentials.cjs 里没有第二份工具名常量（不出现任何模型工具名字面量）',
  toolNameLiterals.length === 0,
  { offending: toolNameLiterals },
);
check(
  'C1d',
  '工具上限由调用点统一走 maxToolCount()（3 处旧用法全部替换）',
  (source.match(/maxToolCount\(\)/g) || []).length >= 3,
  { occurrences: (source.match(/maxToolCount\(\)/g) || []).length },
);

/* ---------------------------------------------------------------- */
/* C2 8/9/10/11 个工具全部通过（修复前 9–11 被拒）                    */
/* ---------------------------------------------------------------- */

const allTools = buildToolDefinitions();
const probe = [];
for (const count of [1, 8, 9, 10, 11]) {
  probe.push({ count, ...attempt({ messages: [{ role: 'user', content: 'ping' }], tools: allTools.slice(0, count) }) });
}
check(
  'C2',
  '1/8/9/10/11 个工具全部被通道接受（修复前 9–11 → MODEL_REQUEST_INVALID）',
  probe.every((item) => item.accepted),
  { probe },
);

/* ---------------------------------------------------------------- */
/* C3 11 个工具一次发送通过；平台专用 3 名不在模型工具列表内          */
/* ---------------------------------------------------------------- */

const allEleven = attempt({ messages: [{ role: 'user', content: 'ping' }], tools: allTools });
check(
  'C3a',
  '§14.3 的 11 个模型工具可一次发送且不触发 MODEL_REQUEST_INVALID',
  allEleven.accepted && allTools.length === 11 && MODEL_TOOL_NAMES.length === 11,
  { modelToolCount: MODEL_TOOL_NAMES.length, definitionCount: allTools.length, result: allEleven },
);
check(
  'C3b',
  '工具名唯一且没有空值',
  new Set(MODEL_TOOL_NAMES).size === MODEL_TOOL_NAMES.length && MODEL_TOOL_NAMES.every((name) => typeof name === 'string' && name !== ''),
  { modelToolNames: MODEL_TOOL_NAMES },
);
const leaked = PLATFORM_ONLY_TOOL_NAMES.filter((name) => MODEL_TOOL_NAMES.includes(name));
check(
  'C3c',
  '平台专用工具名仍不在模型工具列表内',
  leaked.length === 0 && PLATFORM_ONLY_TOOL_NAMES.length === 3,
  { platformOnly: PLATFORM_ONLY_TOOL_NAMES, leaked },
);

/* ---------------------------------------------------------------- */
/* C4 上限仍然存在：超过真实清单长度（伪造第 12 个）必须拒绝          */
/* ---------------------------------------------------------------- */

const forged = allTools.concat([{
  type: 'function',
  function: { name: 'forged_extra_tool', description: '越界工具', parameters: { type: 'object', properties: {} } },
}]);
const tooMany = attempt({ messages: [{ role: 'user', content: 'ping' }], tools: forged });
check(
  'C4a',
  '伪造第 12 个工具 → 仍被拒绝，且错误码明确为 MODEL_REQUEST_INVALID',
  tooMany.accepted === false && tooMany.code === 'MODEL_REQUEST_INVALID',
  { result: tooMany, forgedCount: forged.length },
);
check(
  'C4b',
  '拒绝信息说明上限来源（含“上限”与真实上限值 11）',
  tooMany.accepted === false && /上限/.test(String(tooMany.message)) && String(tooMany.message).includes(String(MODEL_TOOL_NAMES.length)),
  { message: tooMany.message },
);
const twenty = attempt({
  messages: [{ role: 'user', content: 'ping' }],
  tools: Array.from({ length: 20 }, (_, index) => ({
    type: 'function',
    function: { name: 'forged_' + index, description: 'x', parameters: { type: 'object', properties: {} } },
  })),
});
check('C4c', '20 个伪造工具同样被拒（不是“无上限”）', twenty.accepted === false && twenty.code === 'MODEL_REQUEST_INVALID', { result: twenty });

/* ---------------------------------------------------------------- */
/* C5 端到端：真实 credentials + fake fetch，默认发全 11 个工具       */
/* ---------------------------------------------------------------- */

function inMemorySafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (buffer) => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function endToEnd() {
  const bodies = [];
  const tempDirs = [];
  const temp = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  try {
    const credentialsDir = temp('e0fix1-cred-');
    const userDataDir = temp('e0fix1-user-');
    credentialsMod.resetSharedModelCallScheduler();
    const credentials = credentialsMod.createModelCredentials({
      userDataDir: credentialsDir,
      safeStorage: inMemorySafeStorage(),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-flash',
            choices: [{ message: { content: '收到。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 4 },
          }),
        };
      },
      env: { MODEL_UPSTREAM_TOKEN_DIR: path.join(credentialsDir, 'slots') },
    });
    await credentials.setKey('sk-test-0123456789abcdef');

    const modelChat = createModelChat({ credentials, supportsVision: true });
    const coordinator = { invokeTool: async () => ({ ok: true, data: null }), assertRunActive: () => ({ ok: true }) };
    const runtime = createDirectWorkspaceRuntime({ coordinator, modelChat, userDataDir });
    const result = await runtime.invoke({
      context: { projectId: 'p_e0fix1aaa', runId: 'frun-fix1', turnId: 'turn-1', attemptId: 'att-fix1' },
      // 关键：**不**收窄 request.tools —— 让 runtime 按默认发全 §14.3 的 11 个工具。
      request: { utterance: '只回一句“收到”。', maxTokens: 6000 },
    });
    const sentTools = bodies[0] && Array.isArray(bodies[0].tools) ? bodies[0].tools.length : 0;
    return { result, upstreamCalls: bodies.length, sentTools };
  } finally {
    try {
      credentialsMod.resetSharedModelCallScheduler();
    } catch (error) {
      /* 清理不影响结论 */
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const report = {
  fixed: 'model-credentials#maxToolCount() = agent-runtime/constants.cjs → MODEL_TOOL_NAMES.length',
  modelToolCount: MODEL_TOOL_NAMES.length,
  definitionCount: allTools.length,
  checks,
};

endToEnd()
  .then((e2e) => {
    check(
      'C5',
      '端到端（真实 credentials + fake fetch，默认发全 11 个工具）不再 AGENT_TXN_ABORTED',
      e2e.result && e2e.result.ok === true && e2e.upstreamCalls === 1 && e2e.sentTools === MODEL_TOOL_NAMES.length,
      {
        ok: e2e.result && e2e.result.ok,
        code: e2e.result && e2e.result.code,
        stopReason: e2e.result && e2e.result.data ? e2e.result.data.stopReason : null,
        upstreamCalls: e2e.upstreamCalls,
        sentTools: e2e.sentTools,
      },
    );
    finish();
  })
  .catch((error) => {
    check('C5', '端到端（真实 credentials + fake fetch，默认发全 11 个工具）不再 AGENT_TXN_ABORTED', false, {
      error: error && error.message ? error.message : String(error),
    });
    finish();
  });

function finish() {
  const failed = checks.filter((item) => !item.ok);
  report.verdict = failed.length === 0
    ? 'OK：上限 = §14.3 工具清单长度（单一来源），11 个工具一次发送通过，超限仍拒绝'
    : 'FAIL：' + failed.map((item) => item.id).join(',');
  report.failed = failed.map((item) => item.id);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}
