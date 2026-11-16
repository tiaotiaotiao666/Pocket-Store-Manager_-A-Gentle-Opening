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

const TOOL_TO_STEP = Object.freeze({
  get_store_draft: 'read',
  update_store_draft: 'update',
});

/** 未知工具统一折叠成「辅助步骤」，不回显工具真名，避免把内部实现细节抛给店主。 */
export const UNKNOWN_TOOL_LABEL = '辅助步骤';

export function translateToolName(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return TOOL_STEP_LABELS[key] || UNKNOWN_TOOL_LABEL;
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
      detail: '正在等待模型与本轮工具结果',
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
    // 没有 trace 也没有错误：本地规则模式（Mock）或非 run 链路，不编造工具步骤。
    return [{
      id: 'understand',
      label: PROCESS_STEP_LABELS.understand,
      state: 'done',
      detail: '本地规则模式，本轮没有模型调用记录',
    }];
  }

  const calls = toolCallsOf(trace);
  const steps = [];

  const modelCalls = Number.isInteger(trace.modelCalls) ? trace.modelCalls : 0;
  steps.push({
    id: 'understand',
    label: PROCESS_STEP_LABELS.understand,
    state: modelCalls > 0 ? 'done' : 'pending',
    detail: modelCalls > 0 ? `调用模型 ${modelCalls} 次` : '等待模型响应',
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
    detail: finishedNormally ? '' : '本轮没有正常收尾，校验结果可能不完整',
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
    if (failedCount > 0) parts.push(`${failedCount} 次工具调用未成功`);
    if (stopReason && stopReason !== 'final_answer') parts.push(stopReasonHint(stopReason));
    headline = parts.length ? parts.join('；') : '本轮只完成了部分步骤。';
    notice = '草稿按已收到的资料更新，可能还不完整；这代表本轮没有全部成功。';
  } else if (trace) {
    tone = 'done';
    headline = calls.length
      ? `本轮共 ${calls.length} 次工具调用，全部成功。`
      : '本轮只完成需求理解，没有调用工具。';
    notice = '';
  } else if (status && status !== 'idle') {
    // 本地规则模式（Mock）等没有 trace 的成功轮次：不假装有工具过程。
    tone = 'done';
    headline = '本地规则模式：本轮没有真实模型运行记录。';
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

function stopReasonHint(stopReason) {
  const hints = {
    empty_reply: '模型没有给出有效回复',
    max_model_calls: '达到模型调用上限',
    max_tool_calls: '达到工具调用上限',
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
