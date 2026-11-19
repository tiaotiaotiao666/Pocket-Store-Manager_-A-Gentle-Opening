import { formatCents, normalizeAgentDraft } from './agentDraft.mjs';

/**
 * `agent-run.v1` 运行过程 → 用户看得懂的过程卡视图模型（W3）。
 *
 * 设计约束：
 * - 只依据真实收到的 `trace` / `degradation` / 错误构造步骤，绝不输出固定假进度；
 * - 只暴露人话标签与计数，不携带任何工具参数、工具结果、原始 JSON 或堆栈；
 * - 四种状态（处理中 / 部分完成 / 完成 / 失败可重试）由同一处判定，避免 UI 各说各话。
 */

export const PROCESS_STEP_LABELS = Object.freeze({
  understand: '理解需求',
  read: '读取门店资料',
  update: '更新门店资料',
  validate: '校验信息',
});

export const TOOL_STEP_LABELS = Object.freeze({
  get_store_draft: '读取门店资料',
  update_store_draft: '更新门店资料',
});

/**
 * P6：图片驱动前端重构（frontend-reconstruct.v1）的四个真实工具 → 人话标签。
 *
 * 与 `TOOL_STEP_LABELS` 分开维护，避免改变既有 `agent-run.v1` 过程卡的冻结标签；
 * 只有真实 trace 里出现过的调用才生成步骤，未知工具一律折叠为「辅助步骤」。
 */
export const FRONTEND_TOOL_STEP_LABELS = Object.freeze({
  get_frontend_capabilities: '读取页面能力',
  check_frontend_coverage: '检查能力覆盖',
  propose_frontend_draft: '生成候选页面',
  repair_frontend_draft: '调整候选页面',
});

const FRONTEND_TOOL_STEP_IDS = Object.freeze({
  get_frontend_capabilities: 'frontend-capabilities',
  check_frontend_coverage: 'frontend-coverage',
  propose_frontend_draft: 'frontend-propose',
  repair_frontend_draft: 'frontend-repair',
});

/** 前端重构进度阶段（来自主进程真实 `frontend:progress`，不是模型自述）。 */
export const FRONTEND_STAGE_STEP_LABELS = Object.freeze({
  analyze: '识别截图与页面能力',
  materialize: '准备候选文件',
  compose: '检查页面结构',
  'mini-check': '检查小程序结构',
  consistency: '核对导出内容',
  observable: '核对页面细节',
  verify: '在微信开发者工具里试跑',
  adopt: '记录采用结果',
  done: '完成',
});

const FRONTEND_STATUS_LABELS = Object.freeze({
  idle: '等待输入',
  analyzing: '识别中',
  generating: '生成中',
  validating: '校验中',
  verifying: '微信验证中',
  ready: '已验证',
  partial: '部分完成',
  needs_input: '待补充',
  rejected: '当前不支持',
  failed: '失败',
  cancelled: '已取消',
  adopted: '已采用',
});

const FRONTEND_STATUS_TONES = Object.freeze({
  idle: 'idle',
  analyzing: 'running',
  generating: 'running',
  validating: 'running',
  verifying: 'running',
  ready: 'done',
  adopted: 'done',
  partial: 'partial',
  needs_input: 'partial',
  rejected: 'failed',
  failed: 'failed',
  cancelled: 'idle',
});

const FRONTEND_BUSY = new Set(['analyzing', 'generating', 'validating', 'verifying']);
const FRONTEND_STATUS_SET = new Set(Object.keys(FRONTEND_STATUS_TONES));
const RUN_ID_PATTERN = /^(?:frun|run)[-_][A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROCESS_TEXT = 200;
const MAX_PROCESS_DURATION_MS = 24 * 60 * 60 * 1000;

const TOOL_TO_STEP = Object.freeze({
  get_store_draft: 'read',
  update_store_draft: 'update',
  get_frontend_capabilities: 'frontend-capabilities',
  check_frontend_coverage: 'frontend-coverage',
  propose_frontend_draft: 'frontend-propose',
  repair_frontend_draft: 'frontend-repair',
});


/** 未知工具统一折叠成「辅助步骤」，不回显工具真名，避免把内部实现细节抛给店主。 */
export const UNKNOWN_TOOL_LABEL = '辅助步骤';

export function translateToolName(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return TOOL_STEP_LABELS[key] || FRONTEND_TOOL_STEP_LABELS[key] || UNKNOWN_TOOL_LABEL;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolCallsOf(trace) {
  return isObject(trace) && Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
}

/**
 * 步骤状态：
 * - `done` 已成功；`failed` 出现失败调用；`active` 正在进行；`pending` 等待中；
 * - `partial` 因上限/超时等停止原因未拿到正常结论。
 */
export function buildProcessSteps({ status = 'idle', trace = null, lastError = null } = {}) {
  const requesting = status === 'requesting';

  if (requesting && !trace) {
    return [{
      id: 'understand',
      label: PROCESS_STEP_LABELS.understand,
      state: 'active',
      detail: '正在等待模型返回结果',
    }];
  }

  if (!trace && lastError) {
    // 完全没有 trace（网络/鉴权/超时）：只说明「理解需求」没走完，不虚构后续步骤。
    return [{
      id: 'understand',
      label: PROCESS_STEP_LABELS.understand,
      state: 'failed',
      detail: '这一轮没有拿到模型结果',
    }];
  }

  if (!trace) {
    // 没有 trace 也没有错误：非 run 链路，不编造步骤。
    return [{
      id: 'understand',
      label: PROCESS_STEP_LABELS.understand,
      state: 'done',
      detail: '这一轮没有调用模型',
    }];
  }

  const calls = toolCallsOf(trace);
  const steps = [];

  const modelCalls = Number.isInteger(trace.modelCalls) ? trace.modelCalls : 0;
  steps.push({
    id: 'understand',
    label: PROCESS_STEP_LABELS.understand,
    state: modelCalls > 0 ? 'done' : 'pending',
    detail: modelCalls > 1 ? `分 ${modelCalls} 步理解` : '',
  });

  // 只展示真实发生过的工具步骤：trace 里没有的调用不补假步骤。
  const seen = new Set();
  for (const call of calls) {
    const stepId = TOOL_TO_STEP[call?.name];
    if (!stepId || seen.has(stepId)) continue;
    seen.add(stepId);
    const sameTool = calls.filter((item) => item?.name === call.name);
    const failed = sameTool.filter((item) => item?.ok !== true).length;
    const succeeded = sameTool.filter((item) => item?.ok === true).length;
    const truncated = sameTool.some((item) => item?.truncated === true);
    let state = 'done';
    let detail = '';
    if (failed > 0 && succeeded === 0) {
      state = 'failed';
      detail = `尝试 ${sameTool.length} 次未成功`;
    } else if (failed > 0) {
      state = 'failed';
      detail = `${succeeded} 次成功、${failed} 次未成功`;
    } else {
      detail = sameTool.length > 1 ? `执行 ${sameTool.length} 次` : '';
    }
    if (truncated) {
      detail = detail ? `${detail}，结果被截断` : '结果被截断';
    }
    steps.push({ id: stepId, label: translateToolName(call.name), state, detail });
  }

  const stopReason = typeof trace.stopReason === 'string' ? trace.stopReason : null;
  const finishedNormally = stopReason === 'final_answer';
  steps.push({
    id: 'validate',
    label: PROCESS_STEP_LABELS.validate,
    state: finishedNormally ? 'done' : 'partial',
    detail: finishedNormally ? '' : '这一轮没有正常收尾，结果可能不完整',
  });

  return steps;
}

const OUTCOME_TITLES = Object.freeze({
  running: '处理中',
  partial: '部分完成',
  done: '完成',
  failed: '失败',
  idle: '等待输入',
});

function fulfillmentLabel(fulfillment) {
  const dineIn = fulfillment?.dineIn === true;
  const takeaway = fulfillment?.takeaway === true;
  if (dineIn && takeaway) return '堂食和自取';
  if (dineIn) return '仅堂食';
  if (takeaway) return '仅自取';
  return '';
}

function priceLabel(cents) {
  if (!Number.isInteger(cents) || cents < 0) return '未填写价格';
  return `${formatCents(cents)} 元`;
}

/**
 * 本轮修改摘要（人话）。只比较归一化后的字段，不涉及服务端参数或工具结果。
 */
export function summarizeDraftChanges(before, after, limit = 8) {
  const from = normalizeAgentDraft(before);
  const to = normalizeAgentDraft(after);
  const changes = [];

  const textFields = [
    ['storeName', '店名', '补充了店名'],
    ['category', '品类', '补全了品类'],
    ['businessHours', '营业时间', '补全了营业时间'],
  ];
  for (const [field, , verb] of textFields) {
    if (from[field] === to[field]) continue;
    if (!to[field]) continue;
    if (from[field]) {
      changes.push(`${verb.replace('补充了', '更新了').replace('补全了', '更新了')}：${to[field]}`);
    } else {
      changes.push(`${verb}：${to[field]}`);
    }
  }

  const fromFulfillment = fulfillmentLabel(from.fulfillment);
  const toFulfillment = fulfillmentLabel(to.fulfillment);
  if (fromFulfillment !== toFulfillment && toFulfillment) {
    changes.push(`取餐方式：${toFulfillment}`);
  }

  const fromById = new Map(from.dishes.map((dish) => [dish.id, dish]));
  for (const dish of to.dishes) {
    const previous = fromById.get(dish.id);
    if (!previous) {
      changes.push(`新增菜品：${dish.name || '未命名菜品'}`);
      continue;
    }
    if (previous.name !== dish.name && dish.name) {
      changes.push(`菜品改名：${previous.name || '未命名菜品'} → ${dish.name}`);
    }
    if (previous.priceCents !== dish.priceCents) {
      changes.push(`${dish.name || '菜品'} 价格：${priceLabel(dish.priceCents)}`);
    }
    if (previous.description !== dish.description && dish.description) {
      changes.push(`补充了「${dish.name || '菜品'}」的说明`);
    }
  }

  if (changes.length > limit) {
    return [...changes.slice(0, limit), `另有 ${changes.length - limit} 项调整`];
  }
  return changes;
}

/**
 * 统一的四种状态判定 + 视图模型。
 *
 * @returns {{
 *   tone: 'running'|'partial'|'done'|'failed'|'idle',
 *   title: string,
 *   headline: string,
 *   steps: Array<{id:string,label:string,state:string,detail:string}>,
 *   notice: string,
 *   summary: string[],
 *   retryable: boolean,
 *   stopReason: string|null,
 *   degraded: boolean,
 *   roundId: string|null,
 *   tools: {ok:number, failed:number, total:number},
 * }}
 */
export function buildProcessView({
  status = 'idle',
  trace = null,
  degradation = null,
  lastError = null,
  changeSummary = [],
  runId = null,
} = {}) {
  const calls = toolCallsOf(trace);
  const okCount = calls.filter((call) => call?.ok === true).length;
  const failedCount = calls.filter((call) => call?.ok !== true).length;
  const stopReason = typeof trace?.stopReason === 'string'
    ? trace.stopReason
    : (isObject(degradation) && typeof degradation.stopReason === 'string' ? degradation.stopReason : null);
  const degraded = (isObject(degradation) && degradation.degraded === true)
    || (trace?.degraded === true)
    || failedCount > 0;
  const steps = buildProcessSteps({ status, trace, lastError });
  const summary = Array.isArray(changeSummary) ? changeSummary.filter((item) => typeof item === 'string' && item) : [];

  let tone = 'idle';
  let headline = '';
  let notice = '';
  let retryable = false;

  if (status === 'requesting') {
    tone = 'running';
    headline = '正在整理资料，不会保存或发布任何内容。';
  } else if (lastError) {
    tone = 'failed';
    retryable = lastError.retryable !== false;
    headline = String(lastError.message || '请求失败，请重试。');
    notice = '这一轮没有改动你的草稿。';
  } else if (degraded) {
    tone = 'partial';
    const parts = [];
    if (failedCount > 0) parts.push(`${failedCount} 个步骤没有完成`);
    if (stopReason && stopReason !== 'final_answer') parts.push(stopReasonHint(stopReason));
    headline = parts.length ? parts.join('；') : '这一轮只完成了部分步骤。';
    notice = '草稿按已收到的资料更新，可能还不完整。';
  } else if (trace) {
    tone = 'done';
    headline = calls.length
      ? `这一轮完成了 ${calls.length} 项处理。`
      : '这一轮只理解了需求，没有改动资料。';
    notice = '';
  } else if (status && status !== 'idle') {
    // 没有 trace 的成功轮次：不假装有工具过程。
    tone = 'done';
    headline = '这一轮没有调用模型。';
    notice = '';
  }

  return {
    tone,
    title: OUTCOME_TITLES[tone] || OUTCOME_TITLES.idle,
    headline,
    steps,
    notice,
    summary,
    retryable,
    stopReason,
    degraded,
    roundId: typeof runId === 'string' && runId ? runId : null,
    tools: { ok: okCount, failed: failedCount, total: calls.length },
  };
}

function cleanProcessText(value, limit = MAX_PROCESS_TEXT) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '<image>')
    .replace(/\b(?:prompt|authorization|api[-_]?key|secret|token)\s*[:=]\s*[^，；,\s]+/gi, '<secret>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<secret>')
    .replace(/[A-Za-z]:[\\/][^\s，；,）)]*/g, '<local-path>')
    .replace(/\\\\[^\s，；,）)]+/g, '<local-path>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function cleanRunId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return RUN_ID_PATTERN.test(text) ? text : null;
}

function resolveFrontendDurationMs(options) {
  const explicit = Number(options.durationMs);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.min(Math.floor(explicit), MAX_PROCESS_DURATION_MS);
  }
  const started = Number(options.startedAt);
  const ended = Number(options.endedAt);
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    return Math.min(Math.floor(ended - started), MAX_PROCESS_DURATION_MS);
  }
  return null;
}

function formatDurationMs(durationMs) {
  if (!Number.isInteger(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 60_000)}min`;
}

function frontendToolSteps(trace) {
  const calls = toolCallsOf(trace);
  const steps = [];
  const unknown = calls.filter((call) => !FRONTEND_TOOL_STEP_IDS[call?.name]);
  for (const name of Object.keys(FRONTEND_TOOL_STEP_LABELS)) {
    const sameTool = calls.filter((call) => call?.name === name);
    if (sameTool.length === 0) continue;
    const failed = sameTool.filter((call) => call?.ok !== true).length;
    const succeeded = sameTool.filter((call) => call?.ok === true).length;
    const truncated = sameTool.some((call) => call?.truncated === true);
    let state = 'done';
    let detail = '';
    if (failed > 0 && succeeded === 0) {
      state = 'failed';
      detail = `尝试 ${sameTool.length} 次未成功`;
    } else if (failed > 0) {
      state = 'failed';
      detail = `${succeeded} 次成功、${failed} 次未成功`;
    } else if (sameTool.length > 1) {
      detail = `执行 ${sameTool.length} 次`;
    }
    if (truncated) detail = detail ? `${detail}，结果被截断` : '结果被截断';
    steps.push({
      id: FRONTEND_TOOL_STEP_IDS[name],
      label: FRONTEND_TOOL_STEP_LABELS[name],
      state,
      detail,
    });
  }
  if (unknown.length > 0) {
    const failed = unknown.filter((call) => call?.ok !== true).length;
    steps.push({
      id: 'frontend-aux',
      label: UNKNOWN_TOOL_LABEL,
      state: failed > 0 ? 'failed' : 'done',
      detail: failed > 0 ? `${failed} 次辅助调用未成功` : '',
    });
  }
  return steps;
}

function frontendStageStep(progress, status, existingSteps) {
  if (!isObject(progress)) return null;
  const stage = typeof progress.stage === 'string' ? progress.stage : '';
  const label = FRONTEND_STAGE_STEP_LABELS[stage];
  if (!label) return null;
  // 工具步骤已经表达过同一件事时不重复（阶段仍是真实进度，不伪造）。
  const stageId = `stage:${stage}`;
  if (existingSteps.some((step) => step.id === stageId)) return null;
  let state = 'done';
  if (FRONTEND_BUSY.has(status)) state = 'active';
  else if (status === 'failed' || status === 'rejected') state = 'failed';
  else if (status === 'partial' || status === 'needs_input') state = 'partial';
  return { id: stageId, label, state, detail: '' };
}

/**
 * P6：把 `frontend-reconstruct.v1` 的**真实** trace 与进度事件转成安全过程卡视图。
 *
 * 输入只允许：
 * - `trace`：服务端真实返回的 `{modelCalls, toolCalls:[{name,ok,truncated}], stopReason}`；
 * - `progress`：主进程真实 `frontend:progress` 的 `{stage, attempt, runId, at}`；
 * - 真实耗时（`durationMs` 或 `startedAt/endedAt`）与状态。
 *
 * 硬约束：
 * - 不展示工具参数/结果、原始 JSON、源码、base64、完整 prompt、密钥或本机绝对路径；
 * - 没有真实 trace/进度时不编造步骤；未知工具只显示「辅助步骤」；
 * - runId/attempt/状态/耗时只在真实存在时展示，不用 0 或“约”伪造。
 */
export function buildFrontendProcessView(options = {}) {
  const opts = isObject(options) ? options : {};
  const status = FRONTEND_STATUS_SET.has(opts.status) ? opts.status : 'idle';
  const trace = isObject(opts.trace) ? opts.trace : null;
  const progress = isObject(opts.progress) ? opts.progress : null;
  const runId = cleanRunId(opts.runId)
    || cleanRunId(progress?.runId)
    || cleanRunId(trace?.runId);
  const rawAttempt = Number.isInteger(opts.attempt) ? opts.attempt : (Number.isInteger(progress?.attempt) ? progress.attempt : null);
  const attempt = Number.isInteger(rawAttempt) && rawAttempt >= 1 && rawAttempt <= 9999 ? rawAttempt : null;
  const durationMs = resolveFrontendDurationMs(opts);
  const durationLabel = formatDurationMs(durationMs);

  const steps = frontendToolSteps(trace);
  const stageStep = frontendStageStep(progress, status, steps);
  if (stageStep) steps.push(stageStep);

  const calls = toolCallsOf(trace);
  const failedCount = calls.filter((call) => call?.ok !== true).length;
  const tone = FRONTEND_STATUS_TONES[status];
  const title = FRONTEND_STATUS_LABELS[status];
  let headline = '';
  if (opts.lastError) {
    const errorText = typeof opts.lastError === 'string'
      ? opts.lastError
      : (opts.lastError.message || opts.lastError.code);
    headline = cleanProcessText(errorText);
  } else if (calls.length > 0) {
    headline = failedCount > 0
      ? `这一轮完成了 ${calls.length} 项处理，其中 ${failedCount} 项没有成功。`
      : `这一轮完成了 ${calls.length} 项处理。`;
  } else if (progress && FRONTEND_STAGE_STEP_LABELS[progress.stage]) {
    headline = `当前阶段：${FRONTEND_STAGE_STEP_LABELS[progress.stage]}`;
  } else if (status !== 'idle') {
    headline = FRONTEND_STATUS_LABELS[status];
  }

  let notice = '';
  if (status === 'partial') notice = '微信验证未完成或部分步骤未成功；采用前需要单独确认。';
  else if (status === 'needs_input') notice = '需要补充具体信息后才能生成候选。';
  else if (status === 'rejected') notice = '缺少必需能力，本轮没有写任何候选文件。';
  else if (status === 'failed') notice = '这一轮没有成功；输入与当前版本都没有被改动。';
  else if (status === 'cancelled') notice = '任务已取消，输入与当前版本都没有变化。';

  const meta = { runId, attempt, status, durationMs, durationLabel };
  const metaLines = [];
  if (durationLabel) metaLines.push(`用时 ${durationLabel}`);

  return { tone, title, headline, notice, steps, meta, metaLines };
}

function stopReasonHint(stopReason) {
  const hints = {
    empty_reply: '模型没有给出有效回复',
    max_model_calls: '达到模型调用上限',
    max_tool_calls: '处理步骤太多，已提前结束',
    loop_detected: '检测到重复调用已提前结束',
    time_limit: '达到本轮时间上限',
    aborted: '本轮被取消',
  };
  return hints[stopReason] || '本轮没有正常收尾';
}

/** 历史轮次只保留可展示摘要，默认折叠，避免抢占本轮注意力。 */
export function compactProcessRound(view, at = null) {
  if (!isObject(view) || !view.roundId) return null;
  const labels = Array.isArray(view.steps)
    ? view.steps.filter((step) => step.state === 'done').map((step) => step.label)
    : [];
  return {
    roundId: view.roundId,
    at: typeof at === 'string' ? at : null,
    tone: view.tone,
    title: view.title,
    headline: view.headline,
    degraded: view.degraded === true,
    stopReason: view.stopReason ?? null,
    changeCount: Array.isArray(view.summary) ? view.summary.length : 0,
    doneStepLabels: labels,
  };
}

export const PROCESS_HISTORY_LIMIT = 3;
