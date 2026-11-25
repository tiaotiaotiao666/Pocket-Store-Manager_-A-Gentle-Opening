'use strict';

/**
 * direct Workspace Runtime（主进程，E0-R1 / rev15 §14.7）。
 *
 * 一个 run 的 direct 循环：
 *   模型（modelChat）→ assistant tool_calls → Coordinator.invokeTool（唯一执行入口）
 *   → 回填 `assistant.tool_calls` + `tool` 结果 → 下一轮 …… 直到 stop / 预算耗尽 / 取消 / 截断。
 *
 * 冻结约束（逐条对应 t6 验收）：
 * 1. **不复制第二套 Workspace/状态链**：本模块不碰文件系统、不写 attempt、不自己判状态；
 *    唯一执行入口是 `coordinator.invokeTool({ projectId, runId, turnId, attemptId, tool, args })`，
 *    工具名只允许 rev15 §14.3 的 11 个（平台专用名 → `AGENT_TOOL_NOT_ALLOWED`，且不触达 Coordinator）。
 * 2. **截断即停**：`truncated`/`finish_reason=length` 时**本批工具一个都不执行**，
 *    返回 `AGENT_OUTPUT_TRUNCATED`（`status:'output_truncated'`，可定向重试），不把截断内容写进工作树。
 * 3. **预算 / 取消 / loop detection** 与服务端 `agent-loop.ts` 同语义：
 *    maxModelCalls / maxToolCalls / maxWallClockMs / 相同签名 3 次判死循环；
 *    取消（signal 或 `coordinator.assertRunActive`）后**不再发起上游调用**，迟到结果直接丢弃。
 * 4. **安全 trace**：steps/toolCalls 只含 name/finishReason/latencyMs/计数/字节数/truncated，
 *    绝不含 prompt、模型正文、工具参数、图片 data URL 或 Key。
 * 5. **X9**：reply 原样透传（只做长度限幅），不做任何伪状态正则修正
 *    （模型说“已采用/已验证”就照原样给用户看，可信状态只由本地证据决定）；
 */

const {
  RUNTIME_CODES,
  MAX_TOKENS,
  STOP_REASONS,
  EMPTY_REPLY_NUDGE,
  EVIDENCE_STALE_ISSUE,
  NEXT_ACTION_RERUN_CHECKS,
  WRITE_TOOL_NAMES,
  RECHECK_TOOL_NAMES,
  resolveRuntimeLimits,
} = require('./constants.cjs');
const { buildToolDefinitions, classifyModelToolName, ORDER_CONTRACT } = require('./tools.cjs');
const { createModelChat } = require('./model-chat.cjs');
const { resolveAssetImages, imageInvalid, MAX_IMAGES_PER_TURN, ASSET_ID_PATTERN } = require('./images.cjs');
const { buildMultimodalContent, assertChannelAccepts, resolveVisionSupport } = require('./multimodal.cjs');

/**
 * rev15 §14.13-3（F3）顺序契约 + 停止条件，写进系统提示词（工具说明由 tools.cjs 负责）：
 * - 唯一合法顺序：写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt；
 * - 任何写入都会让既有检查证据失效；
 * - 收到 AGENT_EVIDENCE_STALE / EVIDENCE_STALE_RERUN_CHECKS 必须按 nextAction="rerun-checks" 重跑检查，
 *   不得重复 submit，也不得改证据。
 */
const DEFAULT_SYSTEM_PROMPT = [
  '你是智能开店桌面应用里的源码编辑助手，只能通过工具修改当前 attempt 工作树。',
  '改写文件时必须给出完整文件内容；不要输出绝对路径、密钥或与本次目标无关的内容。',
  '【唯一合法顺序】' + ORDER_CONTRACT + '。其中 derive bundle 是平台步骤，你不需要也不能自己调用。',
  '【写入即失效】任何 write_files / delete_files 成功后，既有检查证据立刻失效：必须重新派生并重跑',
  'source.check / composer.dry-run / mini/output，然后才能 submit_candidate。',
  '【证据陈旧】若工具返回 AGENT_EVIDENCE_STALE（issue EVIDENCE_STALE_RERUN_CHECKS，nextAction="rerun-checks"），',
  '你必须先按 nextAction 重跑检查（run_check），再考虑 submit；不要重复 submit，也不要试图修改或伪造证据。',
  '【停止条件】改完并跑完必要检查后，用一句简体中文说明你做了什么以及还剩什么风险。',
].join('\n');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAbortSignalLike(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function';
}

/** 稳定序列化：仅用于 loop detection 的签名，不落盘。 */
function canonicalJsonText(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonText).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJsonText(value[key])).join(',') + '}';
}

function truncateText(text, max) {
  const chars = Array.from(String(text));
  if (chars.length <= max) return String(text);
  return chars.slice(0, max).join('');
}

function textBytes(text) {
  return Buffer.byteLength(typeof text === 'string' ? text : '', 'utf8');
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ok: false, message: '工具参数必须是 JSON 对象。' };
    return { ok: true, args: parsed };
  } catch (error) {
    return { ok: false, message: '工具参数不是合法 JSON。' };
  }
}

/**
 * 工具结果回填给模型时的正文：合法 JSON、受字节上限约束、不含绝对路径（Coordinator 已脱敏）。
 *
 * 除了 Coordinator 的 ok/data/code/message 之外，还会带上模型**必须据此行动**的两个字段：
 * - `issues[].code`（例如 §14.13-3 的 `EVIDENCE_STALE_RERUN_CHECKS`）
 * - `nextAction`（例如 `rerun-checks`）
 * 以及运行时给模型的提示 `note`（例如“写入已生效 → 检查证据失效”）。
 * 这些只进消息，不进 trace。
 */
function toolResultContent(envelope, maxBytes, extras) {
  const source = isPlainObject(envelope) ? envelope : {};
  const extra = isPlainObject(extras) ? extras : {};
  const issues = (Array.isArray(source.issues) ? source.issues : [])
    .filter((issue) => isPlainObject(issue) && typeof issue.code === 'string')
    .map((issue) => ({
      code: issue.code,
      ...(typeof issue.nextAction === 'string' ? { nextAction: issue.nextAction } : {}),
    }));
  const nextAction = typeof source.nextAction === 'string' ? source.nextAction : null;

  const body = source.ok === true
    ? { ok: true, data: source.data === undefined ? null : source.data }
    : {
      ok: false,
      error: {
        code: typeof source.code === 'string' ? source.code : RUNTIME_CODES.TXN_ABORTED,
        message: typeof source.message === 'string' ? source.message : '工具执行失败',
        ...(nextAction ? { nextAction } : {}),
      },
    };
  if (issues.length > 0) body.issues = issues;
  if (typeof extra.note === 'string' && extra.note) body.note = extra.note;

  let text = JSON.stringify(body);
  if (textBytes(text) <= maxBytes) return { text, truncated: false };
  // 超限只保留稳定字段，绝不把源码大段回灌给模型（但 code/nextAction/issues 必须保住）。
  text = JSON.stringify(source.ok === true
    ? { ok: true, data: null, ...(issues.length > 0 ? { issues } : {}), note: 'tool_result_truncated' }
    : { ok: false, error: body.error, ...(issues.length > 0 ? { issues } : {}), note: 'tool_result_truncated' });
  return { text, truncated: true };
}

/**
 * X2：`request.images` 只接受 assetId —— 字符串或 `{ assetId }`。
 * 路径、base64、data URL、URL 一律拒绝（否则等于让渲染进程指定主进程要读的文件）。
 */
function normalizeImageRequest(raw) {
  if (raw === undefined || raw === null) return { ok: true, assetIds: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'images_not_array', message: '参考图必须是 assetId 数组。' };
  }
  const assetIds = [];
  for (const item of raw) {
    const assetId = typeof item === 'string'
      ? item
      : (isPlainObject(item) && typeof item.assetId === 'string' ? item.assetId : null);
    if (assetId === null) {
      return {
        ok: false,
        reason: 'raw_image_rejected',
        message: '参考图只接受 assetId，不接受路径、base64 或 data URL。',
      };
    }
    if (!ASSET_ID_PATTERN.test(assetId)) {
      return {
        ok: false,
        reason: 'raw_image_rejected',
        message: '参考图只接受 assetId（形如 a_0123456789abcdef），不接受路径、base64 或 data URL。',
      };
    }
    assetIds.push(assetId);
  }
  return { ok: true, assetIds };
}

/**
 * @param {object} options
 * @param {object} options.coordinator 必填（`createRunCoordinator()`）；提供 invokeTool/assertRunActive
 * @param {object} [options.modelChat] `createModelChat()` 结果，或 `{ chat }`
 * @param {object} [options.credentials] 省略 modelChat 时用 credentials 现场构造
 * @param {string} [options.systemPrompt]
 * @param {object} [options.limits] 覆盖默认预算
 * @param {() => number} [options.clock] 测试注入
 * @param {(event: {stage: string, status: string, detail?: string}) => void} [options.onProgress]
 * @param {string} [options.userDataDir] 应用私有根（X2 解析 assetId 用；主进程传入，不来自渲染进程）
 * @param {boolean|'auto'} [options.vision] 视觉能力声明；未声明 = 自动读 modelChat.describe().supportsVision
 * @param {(request: object) => {images: Array, meta: Array}} [options.resolveImages] 测试注入的资产解析器
 */
function createDirectWorkspaceRuntime(options) {
  const opts = isPlainObject(options) ? options : {};
  /**
   * Coordinator 允许传对象或 `() => coordinator`（惰性）：
   * `main.cjs` 里 Coordinator 先创建、directRuntime 后注入，用函数就不会形成循环依赖。
   */
  const coordinatorSource = opts.coordinator || null;
  const resolveCoordinator = () => {
    const resolved = typeof coordinatorSource === 'function' ? coordinatorSource() : coordinatorSource;
    return resolved && typeof resolved.invokeTool === 'function' ? resolved : null;
  };
  const modelChat = opts.modelChat && typeof opts.modelChat.chat === 'function'
    ? opts.modelChat
    : createModelChat({ credentials: opts.credentials, chat: opts.chat });
  const systemPrompt = typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim()
    ? opts.systemPrompt
    : DEFAULT_SYSTEM_PROMPT;
  const baseLimits = resolveRuntimeLimits(opts.limits);
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  /**
   * X2：图片资产解析器。默认按 rev15 §14.8 从 assetId 派生（canonical 在项目资产根内）；
   * 测试可注入；**没有任何“降级成纯文本”的分支**——解析失败就是 AGENT_IMAGE_INVALID。
   */
  const resolveImages = typeof opts.resolveImages === 'function'
    ? opts.resolveImages
    : (request) => resolveAssetImages({
      userDataDir: typeof opts.userDataDir === 'string' ? opts.userDataDir : '',
      projectId: request.projectId,
      assetIds: request.assetIds,
      limits: request.limits,
    });
  const visionSetting = opts.vision === true || opts.vision === false ? opts.vision : 'auto';

  function progress(stage, status, detail) {
    if (!onProgress) return;
    try {
      onProgress({ stage, status, ...(detail ? { detail } : {}) });
    } catch (error) {
      /* 进度回调失败不影响主流程 */
    }
  }

  /**
   * 取消门控（每轮上游调用前后各判一次）：
   * - signal 已 abort → 取消；
   * - Coordinator 侧 run 已取消/已完成（`assertRunActive`）→ 取消。
   */
  async function cancellationOf(context, signal, coordinator) {
    if (signal && signal.aborted) {
      return { ok: false, code: RUNTIME_CODES.CANCELLED, message: 'run 已取消，不再发起模型调用。' };
    }
    if (coordinator && typeof coordinator.assertRunActive === 'function' && typeof context.runId === 'string') {
      const gate = await coordinator.assertRunActive({ projectId: context.projectId, runId: context.runId });
      if (gate && gate.ok === false) {
        return {
          ok: false,
          code: gate.code || RUNTIME_CODES.CANCELLED,
          message: gate.message || 'run 已取消',
        };
      }
    }
    return null;
  }

  function cancelledResult(cancelled, extra) {
    const tails = extra || {};
    return {
      ok: false,
      code: cancelled.code || RUNTIME_CODES.CANCELLED,
      message: cancelled.message || 'run 已取消',
      issues: [{ code: 'cancelled' }],
      data: {
        status: 'aborted',
        stopReason: 'aborted',
        modelCalls: tails.modelCalls || 0,
        toolCalls: tails.toolTraces || [],
        steps: tails.steps || [],
      },
    };
  }

  /**
   * 一个 direct 回合。`request` 支持：
   * `{ utterance | messages, tools?, limits?, maxTokens?, timeoutMs?, model?, signal?, profile? }`
   */
  async function runTurn(input) {
    const payload = isPlainObject(input) ? input : {};
    const context = isPlainObject(payload.context) ? payload.context : {};
    const request = isPlainObject(payload.request) ? payload.request : {};
    const startedAt = clock();
    const limits = resolveRuntimeLimits({ ...baseLimits, ...(isPlainObject(request.limits) ? request.limits : {}) });
    const signal = isAbortSignalLike(request.signal) ? request.signal : null;
    const maxTokens = request.maxTokens; // 由 model-credentials 统一解析（6000/8000），这里不写数字

    const coordinator = resolveCoordinator();
    if (!coordinator) {
      return {
        ok: false,
        code: RUNTIME_CODES.RUNTIME_TOOL_MISSING,
        message: 'direct 通道缺少 Coordinator（工具执行唯一入口）。',
        issues: [{ code: 'runtime_tool_missing' }],
        data: null,
      };
    }

    /**
     * X2：本轮参考图。先做**视觉能力门**（fail-closed），再解析 assetId。
     * 任何一步失败都直接返回明确错误码，**绝不降级成纯文本生成**。
     */
    const imageRequest = normalizeImageRequest(request.images);
    if (!imageRequest.ok) {
      return {
        ok: false,
        code: RUNTIME_CODES.IMAGE_INVALID,
        message: imageRequest.message,
        issues: [{ code: imageRequest.reason }],
        data: { status: 'failed', stopReason: 'image_invalid', modelCalls: 0, toolCalls: [], steps: [], images: [] },
      };
    }
    let images = [];
    let imageMeta = [];
    if (imageRequest.assetIds.length > 0) {
      if (Array.isArray(request.messages) && request.messages.length > 0) {
        return {
          ok: false,
          code: RUNTIME_CODES.PAYLOAD_INVALID,
          message: '参考图只能随 utterance 发送，不能与自定义 messages 混用。',
          issues: [{ code: 'images_with_messages' }],
          data: null,
        };
      }
      if (typeof request.utterance !== 'string' || request.utterance.trim() === '') {
        return {
          ok: false,
          code: RUNTIME_CODES.PAYLOAD_INVALID,
          message: '发送参考图时必须同时给出用户指令。',
          issues: [{ code: 'images_without_utterance' }],
          data: null,
        };
      }
      const vision = resolveVisionSupport({
        vision: request.vision === true || request.vision === false ? request.vision : visionSetting,
        modelDescribe: typeof modelChat.describe === 'function' ? modelChat.describe() : {},
      });
      if (!vision.ok) {
        return {
          ok: false,
          code: RUNTIME_CODES.VISION_UNAVAILABLE,
          message: vision.error.message,
          issues: [{ code: vision.error.reason, nextAction: 'attach-vision-model' }],
          data: {
            status: 'needs_input',
            stopReason: 'vision_unavailable',
            modelCalls: 0,
            toolCalls: [],
            steps: [],
            images: [],
          },
        };
      }
      progress('image', 'running');
      try {
        const resolved = resolveImages({
          projectId: context.projectId,
          assetIds: imageRequest.assetIds,
          limits: request.imageLimits,
        });
        images = Array.isArray(resolved.images) ? resolved.images : [];
        imageMeta = Array.isArray(resolved.meta) ? resolved.meta : [];
      } catch (error) {
        progress('image', 'failed', (error && error.code) || RUNTIME_CODES.IMAGE_INVALID);
        return {
          ok: false,
          code: (error && error.code) || RUNTIME_CODES.IMAGE_INVALID,
          message: (error && error.message) || '图片不可用。',
          issues: [{ code: (error && error.reason) || 'image_invalid' }],
          data: {
            status: 'needs_input',
            stopReason: 'image_invalid',
            modelCalls: 0,
            toolCalls: [],
            steps: [],
            images: [],
          },
        };
      }
      progress('image', 'succeeded', imageMeta.map((item) => item.assetId).join(','));
    }

    const messages = [];
    if (Array.isArray(request.messages) && request.messages.length > 0) {
      messages.push(...request.messages);
    } else {
      messages.push({ role: 'system', content: systemPrompt });
      if (typeof request.utterance === 'string' && request.utterance.trim()) {
        let userContent = request.utterance;
        if (images.length > 0) {
          try {
            userContent = buildMultimodalContent({
              utterance: request.utterance,
              images,
              limits: { maxImages: MAX_IMAGES_PER_TURN },
            });
            // 通道口径（model-credentials 规范器）是唯一权威：不接受就当场报图片错，而不是把图丢掉。
            assertChannelAccepts([{ role: 'user', content: userContent }]);
          } catch (error) {
            progress('image', 'failed', (error && error.code) || RUNTIME_CODES.IMAGE_INVALID);
            return {
              ok: false,
              code: (error && error.code) || RUNTIME_CODES.IMAGE_INVALID,
              message: (error && error.message) || '图片无法作为多模态消息发送。',
              issues: [{ code: (error && error.reason) || 'image_invalid' }],
              data: {
                status: 'needs_input',
                stopReason: 'image_invalid',
                modelCalls: 0,
                toolCalls: [],
                steps: [],
                images: imageMeta,
              },
            };
          }
        }
        messages.push({ role: 'user', content: userContent });
      }
    }
    if (!messages.some((message) => message && message.role === 'user')) {
      return {
        ok: false,
        code: RUNTIME_CODES.PAYLOAD_INVALID,
        message: 'direct 回合缺少用户消息。',
        issues: [{ code: 'utterance_missing' }],
        data: null,
      };
    }

    const tools = buildToolDefinitions(request.tools);
    const steps = [];
    const toolTraces = [];
    const signatureCounts = new Map();
    const deadline = startedAt + limits.maxWallClockMs;

    let modelCalls = 0;
    let toolCallCount = 0;
    let reply = '';
    let modelName = '';
    let status = null;
    let stopReason = null;
    let timedOut = false;
    let nudged = false;
    let effectiveMaxTokens = null;
    let promptTokens = 0;
    let completionTokens = 0;
    /**
     * §14.13-3（F3）顺序契约的运行时闸门：
     * 一旦 Coordinator 报过 AGENT_EVIDENCE_STALE，`submit_candidate` 在**重跑检查成功之前**一律本地拒绝
     * （不触达 Coordinator），并把 nextAction 明确回填给模型；连续两次无视 → 终止本轮并保留原始码。
     */
    let evidenceStale = false;
    let staleRejections = 0;
    const WRITE_TOOLS = new Set(WRITE_TOOL_NAMES);
    const RECHECK_TOOLS = new Set(RECHECK_TOOL_NAMES);

    const cancelAtStart = await cancellationOf(context, signal, coordinator);
    if (cancelAtStart) return cancelledResult(cancelAtStart, {});

    progress('edit', 'running');

    try {
      while (modelCalls < limits.maxModelCalls) {
        const cancelled = await cancellationOf(context, signal, coordinator);
        if (cancelled) return cancelledResult(cancelled, { modelCalls, steps, toolTraces });
        if (clock() >= deadline) {
          timedOut = true;
          break;
        }

        modelCalls += 1;
        const step = modelCalls;
        const stepStartedAt = clock();
        let completion;
        try {
          completion = await modelChat.chat({
            messages: messages.slice(),
            tools,
            maxTokens,
            profile: request.profile === 'chat' ? 'chat' : 'direct-edit',
            timeoutMs: request.timeoutMs,
            model: request.model,
            signal,
          });
        } catch (error) {
          const cancelledMid = await cancellationOf(context, signal, coordinator);
          if (cancelledMid) return cancelledResult(cancelledMid, { modelCalls, steps, toolTraces });
          return {
            ok: false,
            code: RUNTIME_CODES.TXN_ABORTED,
            message: (error && error.message) || '模型调用失败。',
            issues: [{ code: 'model_call_failed', step }],
            data: {
              status: 'failed', stopReason: null, modelCalls, toolCalls: toolTraces, steps,
              images: imageMeta, multimodal: images.length > 0,
            },
          };
        }

        // 迟到结果：调用返回时已被取消 → 丢弃，不入库、不执行工具。
        const cancelledLate = await cancellationOf(context, signal, coordinator);
        if (cancelledLate) return cancelledResult(cancelledLate, { modelCalls, steps, toolTraces });

        if (completion.model) modelName = completion.model;
        if (Number.isInteger(completion.maxTokens)) effectiveMaxTokens = completion.maxTokens;
        if (completion.usage) {
          promptTokens += Number.isInteger(completion.usage.promptTokens) ? completion.usage.promptTokens : 0;
          completionTokens += Number.isInteger(completion.usage.completionTokens) ? completion.usage.completionTokens : 0;
        }

        const calls = Array.isArray(completion.toolCalls) ? completion.toolCalls : [];
        const finishReason = typeof completion.finishReason === 'string' ? completion.finishReason : '';
        const stepTrace = {
          step,
          model: modelName,
          finishReason,
          latencyMs: Math.max(0, clock() - stepStartedAt),
          hasToolCalls: calls.length > 0,
          toolCallCount: calls.length,
          promptTokens: Number.isInteger(completion.usage?.promptTokens) ? completion.usage.promptTokens : 0,
          completionTokens: Number.isInteger(completion.usage?.completionTokens) ? completion.usage.completionTokens : 0,
          truncated: completion.truncated === true || finishReason === 'length',
          ...(completion.finishReasonMissing ? { note: 'finish_reason_missing' } : {}),
        };

        // §14.7：截断（含“空正文 + finish_reason=length”）→ 立刻停，本批工具一个都不执行。
        if (stepTrace.truncated) {
          steps.push(stepTrace);
          progress('edit', 'failed', 'output_truncated');
          return {
            ok: false,
            code: RUNTIME_CODES.OUTPUT_TRUNCATED,
            message: '模型输出被截断（finish_reason=length），本批工具未执行；可以缩小目标后定向重试。',
            issues: [{ code: 'output_truncated', step }],
            data: {
              status: 'output_truncated',
              stopReason: 'output_truncated',
              retryable: true,
              modelCalls,
              toolCalls: [],
              steps,
              maxTokens: effectiveMaxTokens,
              images: imageMeta,
            },
          };
        }

        steps.push(stepTrace);

        const assistantText = typeof completion.content === 'string' ? completion.content : '';
        const assistantMessage = {
          role: 'assistant',
          content: assistantText.length > 0 ? assistantText : null,
          ...(calls.length > 0
            ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
            : {}),
        };
        messages.push(assistantMessage);

        // 1) 没有工具调用 → 收尾（空正文时给一次提示，与服务端同语义）。
        if (calls.length === 0) {
          const text = assistantText.trim();
          if (text.length === 0) {
            if (!nudged) {
              nudged = true;
              stepTrace.note = 'empty_reply_nudge';
              messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
              continue;
            }
            status = 'completed';
            stopReason = 'empty_reply';
            break;
          }
          reply = truncateText(text, limits.maxReplyCharacters);
          status = 'completed';
          stopReason = 'final_answer';
          break;
        }

        // 2) 工具名准入（平台专用名/未知名 → 立刻失败，不触达 Coordinator、不再发起上游调用）。
        for (const call of calls) {
          const verdict = classifyModelToolName(call.name);
          if (!verdict.ok) {
            return {
              ok: false,
              code: verdict.code,
              message: verdict.message,
              issues: [{ code: 'tool_not_allowed', step, tool: typeof call.name === 'string' ? call.name.slice(0, 64) : '' }],
              data: {
                status: 'failed',
                stopReason: null,
                modelCalls,
                toolCalls: toolTraces,
                steps,
              },
            };
          }
        }

        // 3) 工具次数预算。
        if (toolCallCount + calls.length > limits.maxToolCalls) {
          status = 'limit_reached';
          stopReason = 'max_tool_calls';
          break;
        }

        // 4) loop detection：同一工具 + 同一参数出现 3 次即终止。
        let repeated = false;
        for (const call of calls) {
          const signature = String(call.name) + '\u0000' + canonicalJsonText(call.arguments);
          const next = (signatureCounts.get(signature) || 0) + 1;
          signatureCounts.set(signature, next);
          if (next >= limits.loopSignatureLimit) repeated = true;
        }
        if (repeated) {
          status = 'limit_reached';
          stopReason = 'loop_detected';
          break;
        }

        // 5) 执行本批工具：唯一入口 Coordinator.invokeTool。
        toolCallCount += calls.length;
        for (const call of calls) {
          const cancelledBeforeTool = await cancellationOf(context, signal, coordinator);
          if (cancelledBeforeTool) return cancelledResult(cancelledBeforeTool, { modelCalls, steps, toolTraces });

          const parsed = parseToolArguments(call.arguments);
          const toolStartedAt = clock();

          // §14.13-3：证据已陈旧且还没重跑检查 → 本地拒绝 submit，不触达 Coordinator、不改证据。
          if (evidenceStale && call.name === 'submit_candidate' && parsed.ok) {
            staleRejections += 1;
            const blocked = {
              ok: false,
              code: RUNTIME_CODES.EVIDENCE_STALE,
              message: '证据已陈旧（AGENT_EVIDENCE_STALE / ' + EVIDENCE_STALE_ISSUE + '）：必须先按 nextAction="'
                + NEXT_ACTION_RERUN_CHECKS + '" 重跑检查（run_check），不得重复 submit，也不得修改证据。',
              nextAction: NEXT_ACTION_RERUN_CHECKS,
              issues: [{ code: EVIDENCE_STALE_ISSUE }],
            };
            const body = toolResultContent(blocked, limits.maxToolResultBytes);
            messages.push({ role: 'tool', tool_call_id: call.id, content: body.text });
            toolTraces.push({
              callId: call.id,
              name: call.name,
              ok: false,
              errorCode: RUNTIME_CODES.EVIDENCE_STALE,
              latencyMs: Math.max(0, clock() - toolStartedAt),
              attempts: 1,
              inputBytes: textBytes(typeof call.arguments === 'string' ? call.arguments : ''),
              outputBytes: textBytes(body.text),
              truncated: body.truncated,
              note: 'blocked_by_order_contract',
            });
            if (staleRejections >= 2) {
              return {
                ok: false,
                code: RUNTIME_CODES.EVIDENCE_STALE,
                message: '模型未按 nextAction="' + NEXT_ACTION_RERUN_CHECKS + '" 重跑检查就重复 submit，已终止本轮。',
                issues: [{ code: EVIDENCE_STALE_ISSUE, nextAction: NEXT_ACTION_RERUN_CHECKS }],
                data: {
                  status: 'failed', stopReason: null, modelCalls, toolCalls: toolTraces, steps,
                  images: imageMeta, multimodal: images.length > 0,
                },
              };
            }
            continue;
          }

          let envelope;
          if (!parsed.ok) {
            envelope = { ok: false, code: RUNTIME_CODES.ARGUMENT_INVALID, message: parsed.message };
          } else {
            envelope = await coordinator.invokeTool({
              projectId: context.projectId,
              runId: context.runId,
              turnId: context.turnId,
              attemptId: context.attemptId,
              tool: call.name,
              args: parsed.args,
            });
          }

          const cancelledAfterTool = await cancellationOf(context, signal, coordinator);
          if (cancelledAfterTool) {
            // 迟到工具结果：不入库、不回填给模型。
            return cancelledResult(cancelledAfterTool, { modelCalls, steps, toolTraces });
          }

          const ok = Boolean(envelope && envelope.ok === true);
          // 写入成功 → 提醒模型证据已失效；其余情况不加解读。
          const note = ok && WRITE_TOOLS.has(call.name)
            ? '写入已生效：既有检查证据失效，必须先重新派生 bundle 并重跑 source.check / composer.dry-run / mini/output，再 submit。'
            : undefined;
          const body = toolResultContent(envelope, limits.maxToolResultBytes, { note });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: body.text,
          });
          toolTraces.push({
            callId: call.id,
            name: call.name,
            ok,
            ...(ok ? {} : { errorCode: typeof envelope?.code === 'string' ? envelope.code : RUNTIME_CODES.TXN_ABORTED }),
            latencyMs: Math.max(0, clock() - toolStartedAt),
            attempts: 1,
            inputBytes: textBytes(typeof call.arguments === 'string' ? call.arguments : ''),
            outputBytes: textBytes(body.text),
            truncated: body.truncated,
          });

          if (envelope && envelope.code === RUNTIME_CODES.CANCELLED) {
            return cancelledResult(
              { code: RUNTIME_CODES.CANCELLED, message: envelope.message || 'run 已取消' },
              { modelCalls, steps, toolTraces },
            );
          }
          // 已提交/只读 attempt：整轮立刻停，不再让模型继续试写。
          if (!ok && envelope && envelope.code === RUNTIME_CODES.ATTEMPT_IMMUTABLE) {
            return {
              ok: false,
              code: RUNTIME_CODES.ATTEMPT_IMMUTABLE,
              message: envelope.message || '该 attempt 已提交/已采用，只读',
              issues: [{ code: 'attempt_immutable', step }],
              data: {
                status: 'failed', stopReason: null, modelCalls, toolCalls: toolTraces, steps,
                images: imageMeta, multimodal: images.length > 0,
              },
            };
          }
          // §14.13-3：观察证据陈旧 → 上闸；重跑检查成功 → 解锁。
          if (!ok && envelope && envelope.code === RUNTIME_CODES.EVIDENCE_STALE) {
            evidenceStale = true;
          }
          if (ok && RECHECK_TOOLS.has(call.name)) {
            evidenceStale = false;
            staleRejections = 0;
          }
        }
      }

      if (status === null) {
        status = 'limit_reached';
        stopReason = timedOut || clock() >= deadline ? 'time_limit' : 'max_model_calls';
      }
    } finally {
      progress('done', status === 'completed' ? 'succeeded' : 'failed');
    }

    const truncatedSteps = steps.some((step) => step.truncated);
    const stopReasonFinal = STOP_REASONS.includes(stopReason) ? stopReason : 'final_answer';
    return {
      ok: true,
      data: {
        status,
        stopReason: stopReasonFinal,
        reply,
        modelCalls,
        toolCalls: toolTraces,
        steps,
        usage: { promptTokens, completionTokens },
        model: modelName,
        truncated: truncatedSteps,
        degraded: status !== 'completed' || reply.length === 0,
        latencyMs: Math.max(0, clock() - startedAt),
        maxTokens: effectiveMaxTokens,
        // X2：只报元数据（assetId/mime/bytes/sha256），**data URL 绝不进结果/trace**。
        images: imageMeta,
        multimodal: images.length > 0,
      },
      issues: [],
    };
  }

  return {
    invoke: async (input) => {
      const payload = isPlainObject(input) ? input : {};
      return runTurn({ context: payload.context, request: payload.request });
    },
    runTurn,
    describe: () => ({
      transport: 'direct',
      available: Boolean(resolveCoordinator()),
      maxTokens: { default: MAX_TOKENS.directEditDefault, max: MAX_TOKENS.directEditMax },
      toolNames: buildToolDefinitions().map((tool) => tool.function.name),
      limits: { ...baseLimits },
      model: modelChat.describe ? modelChat.describe() : { transport: 'direct', wired: true },
      // §14.13-3：顺序契约与停止条件也在这里对外可查（工具说明里同一份文本）。
      orderContract: {
        sequence: ORDER_CONTRACT,
        writeInvalidatesEvidence: true,
        staleEvidenceIssue: EVIDENCE_STALE_ISSUE,
        staleEvidenceNextAction: NEXT_ACTION_RERUN_CHECKS,
        recheckTools: RECHECK_TOOL_NAMES.slice(),
      },
      stopConditions: [
        'final_answer', 'empty_reply', 'max_model_calls', 'max_tool_calls', 'loop_detected', 'time_limit',
        'aborted', 'output_truncated', 'evidence_stale_after_repeated_submit',
        'vision_unavailable', 'image_invalid',
      ],
      // X2：图片能力口径（图片只进调用内存，不落盘）。
      images: {
        transport: 'inline-data-url',
        maxImagesPerTurn: MAX_IMAGES_PER_TURN,
        mimes: ['image/png', 'image/jpeg', 'image/webp'],
        acceptsOnlyAssetId: true,
        vision: visionSetting,
        visionSupported: resolveVisionSupport({
          vision: visionSetting,
          modelDescribe: typeof modelChat.describe === 'function' ? modelChat.describe() : {},
        }).ok,
      },
    }),
  };
}

/**
 * X9：本地证据 → 状态词。`adopted / verified / exported` **只能**由证据决定，
 * 绝不从模型 reply 里读（因此本函数不接收 reply）。
 */
function deriveStatusFromEvidence(evidence) {
  const source = isPlainObject(evidence) ? evidence : {};
  const status = typeof source.status === 'string' ? source.status : 'NOT_RUN';
  return {
    adopted: source.adopted === true,
    verified: status === 'PASS',
    exported: source.exported === true,
    status: ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(status) ? status : 'NOT_RUN',
  };
}

module.exports = {
  createDirectWorkspaceRuntime,
  deriveStatusFromEvidence,
  DEFAULT_SYSTEM_PROMPT,
  ORDER_CONTRACT,
  canonicalJsonText,
  parseToolArguments,
  toolResultContent,
};
