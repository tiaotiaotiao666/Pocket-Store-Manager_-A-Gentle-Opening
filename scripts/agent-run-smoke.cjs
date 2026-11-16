#!/usr/bin/env node
/**
 * `agent-run.v1` 真实模型去敏 smoke（W2）。
 *
 * 用途：在本地已有 DEEPSEEK 配置时，用三轮真实请求验证「两轮补全资料 → 缺价格追问 → 按 id 修改菜品」。
 * 边界：
 * - 只读配置由服务端自己读取，本脚本不接触任何密钥，也不打印请求头/环境变量。
 * - 输出只保留 requestId / runId / trace 摘要 / meta 与草稿摘要，不打印 prompt、工具参数或原始响应体。
 * - `meta.mock !== false` 视为失败：脚本化/Mock 响应不能当作真实模型证据。
 *
 * 用法：npm run server:dev 起后端后，node scripts/agent-run-smoke.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const BASE = process.env.AGENT_SMOKE_BASE_URL || `http://127.0.0.1:${PORT}/api/v1`;
const CONTRACT = 'agent-run.v1';
const OUT_FILE = path.join(__dirname, '..', '.arts', 'w2-agent-run-smoke.json');

let seq = 0;
function nextRequestId() {
  seq += 1;
  return `agent-smoke-w2-${Date.now().toString(36)}-${seq}`;
}

function emptyDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function summarizeDraft(draft) {
  return {
    storeName: draft.storeName,
    category: draft.category,
    businessHours: draft.businessHours,
    fulfillment: draft.fulfillment,
    dishes: (draft.dishes || []).map((dish) => ({
      id: dish.id,
      name: dish.name,
      priceCents: dish.priceCents,
    })),
  };
}

function summarizeTrace(trace) {
  return {
    modelCalls: trace?.modelCalls ?? null,
    stopReason: trace?.stopReason ?? null,
    degraded: trace?.degraded ?? null,
    toolCalls: (trace?.toolCalls || []).map((call) => ({
      name: call.name,
      ok: call.ok,
      attempts: call.attempts,
      truncated: call.truncated,
    })),
  };
}

function summarizeMeta(meta) {
  return {
    transport: meta?.transport ?? null,
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    mock: meta?.mock ?? null,
    latencyMs: meta?.latencyMs ?? null,
    runId: meta?.runId ?? null,
  };
}

async function runOnce({ utterance, draft }) {
  const requestId = nextRequestId();
  const body = {
    contractVersion: CONTRACT,
    utterance,
    draft,
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  };
  const started = Date.now();
  const response = await fetch(`${BASE}/agent/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'X-Agent-Contract': CONTRACT,
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${payload?.code || ''} ${payload?.message || ''}`.trim());
    error.httpStatus = response.status;
    error.payload = payload;
    error.requestId = requestId;
    throw error;
  }
  if (!payload || payload.contractVersion !== CONTRACT) {
    throw new Error(`响应契约版本不合法：${payload?.contractVersion ?? 'missing'}`);
  }
  if (payload.meta?.mock !== false) {
    throw new Error('响应 meta.mock 不是 false：拒绝把 Mock 响应当作真实模型证据。');
  }
  if (payload.meta?.runId !== payload.runId) {
    throw new Error('meta.runId 与 runId 不一致。');
  }

  return {
    requestId,
    runId: payload.runId,
    echoRequestId: response.headers.get('x-request-id'),
    status: payload.status,
    missingFields: (payload.missingFields || []).map((item) => item.field),
    replyLength: typeof payload.reply === 'string' ? payload.reply.length : 0,
    draft: summarizeDraft(payload.draft),
    trace: summarizeTrace(payload.trace),
    meta: summarizeMeta(payload.meta),
    wallMs: Date.now() - started,
  };
}

async function main() {
  const results = [];
  const failures = [];

  // 第一轮：只给品类与取餐方式，剩下必须追问
  const round1 = await runOnce({ utterance: '我想开一家面馆，堂食和外卖都做。', draft: emptyDraft() });
  results.push({ round: 1, ...round1 });

  // 第二轮：补营业时间与菜品（刻意先不给价格）
  const round2 = await runOnce({
    utterance: '营业时间是 10:00 到 21:00，卖牛肉面、凉皮和酸梅汤。',
    draft: emptyDraft(),
  });
  results.push({ round: 2, ...round2 });

  // 第三轮：按 id 修改菜品价格（使用第二轮返回的 id）
  const baseDish = round2.draft.dishes[0];
  if (!baseDish) {
    failures.push('第二轮没有返回任何菜品，无法验证按 id 修改。');
  } else {
    const round3Draft = {
      storeName: round2.draft.storeName,
      category: round2.draft.category,
      businessHours: round2.draft.businessHours,
      fulfillment: round2.draft.fulfillment,
      dishes: round2.draft.dishes.map((dish) => ({
        id: dish.id,
        name: dish.name,
        priceCents: dish.priceCents,
        description: '',
      })),
    };
    const round3 = await runOnce({
      utterance: `把「${baseDish.name}」的价格改成 30 元，其他不动。`,
      draft: round3Draft,
    });
    results.push({ round: 3, ...round3, targetDishId: baseDish.id });

    const patched = round3.draft.dishes.find((dish) => dish.id === baseDish.id);
    if (!patched) {
      failures.push(`第三轮返回的草稿里找不到原菜品 id ${baseDish.id}（应保留 id）。`);
    } else if (patched.priceCents !== 3000) {
      failures.push(`按 id 修改价格未生效：${baseDish.name} priceCents=${patched.priceCents}（期望 3000）。`);
    }
    const idsBefore = round2.draft.dishes.map((dish) => dish.id);
    const idsAfter = round3.draft.dishes.map((dish) => dish.id);
    if (idsBefore.join(',') !== idsAfter.join(',')) {
      failures.push(`菜品 id 集合发生变化：${idsBefore.join(',')} → ${idsAfter.join(',')}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    contract: CONTRACT,
    endpoint: `${BASE}/agent/run`,
    rounds: results,
    checks: {
      round1Collected: results[0].status === 'collecting',
      round1AskForDishPrice: results[0].missingFields.some((field) => field === 'dishes'),
      round2StillCollectingOrReviewing: ['collecting', 'reviewing'].includes(results[1].status),
      round2DishCount: results[1].draft.dishes.length,
      round3Reviewed: results[2]?.status ?? null,
    },
    failures,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const round of results) {
    console.log(`[round ${round.round}] requestId=${round.requestId} runId=${round.runId} echoXRequestId=${round.echoRequestId || '(none)'}`);
    console.log(`  status=${round.status} missing=${round.missingFields.join('|') || '(none)'} replyLength=${round.replyLength} wallMs=${round.wallMs}`);
    console.log(`  trace=${JSON.stringify(round.trace)}`);
    console.log(`  meta=${JSON.stringify(round.meta)}`);
    console.log(`  draft=${JSON.stringify(round.draft)}`);
  }
  console.log(`\nreport: ${OUT_FILE}`);
  if (failures.length) {
    console.error(`\nFAILED (${failures.length})`);
    for (const item of failures) console.error(` - ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK：三轮真实模型链路符合预期。');
}

main().catch((error) => {
  console.error(`smoke 中断：${error.message}`);
  if (error.httpStatus) console.error(`HTTP ${error.httpStatus} code=${error.payload?.code ?? '(none)'}`);
  process.exitCode = 1;
});
