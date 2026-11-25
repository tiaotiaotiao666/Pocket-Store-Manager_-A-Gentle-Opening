'use strict';

/**
 * 模型可见工具定义（rev15 §14.3 的 11 个，命名固定）。
 *
 * 边界：
 * - 工具名只从 `../agent-workspace/run-coordinator.cjs` 的 `MODEL_TOOL_NAMES` 取，
 *   本文件**只补 JSON Schema**，不定义第二份名单；平台专用工具（derive_source_bundle /
 *   adopt_attempt / attach_image_asset）**永不出现**在模型工具列表里。
 * - schema 的字段与 Coordinator 的 args 白名单一致（多给一个键 → AGENT_PAYLOAD_INVALID），
 *   模型拿不到 root/attempt/versionId/路径这类平台值。
 * - 本文件不执行任何工具：执行唯一入口是 `coordinator.invokeTool`。
 */

const {
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  MODEL_TOOL_SET,
  PLATFORM_ONLY_TOOL_SET,
  RUNTIME_CODES,
} = require('./constants.cjs');

const stringSchema = (description) => ({ type: 'string', description });

const SCHEMAS = Object.freeze({
  get_context: {
    description: '读取当前 run/attempt 的只读上下文：项目、目标页、Base 版本、revision、treeDigest、能力快照摘要。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  list_files: {
    description: '列出当前 attempt 工作树中的文件（相对路径 + 字节数），可指定子目录。',
    parameters: {
      type: 'object',
      properties: { dir: stringSchema('相对目录，省略表示根目录') },
      additionalProperties: false,
    },
  },
  read_file: {
    description: '读取一个文件的内容与 sha256；只接受相对路径。读 Base 版本源码时用 subjectOverride（只读）。',
    parameters: {
      type: 'object',
      properties: {
        path: stringSchema('相对路径'),
        offset: { type: 'integer', minimum: 0, description: '按字节偏移' },
        limitBytes: { type: 'integer', minimum: 1, description: '最多读取字节数' },
        subjectOverride: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['version'] }, versionId: stringSchema('Base 版本 id') },
          required: ['kind', 'versionId'],
          additionalProperties: false,
          description: '只读 Base 版本源码；写入工具不接受该字段',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  search_files: {
    description: '在当前 attempt 工作树里按文本搜索，返回相对路径与命中行摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: stringSchema('搜索词（字面量）'),
        mode: { type: 'string', enum: ['literal', 'regex'], description: '默认 literal' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'integer', minimum: 1 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  write_files: {
    description: '写入/覆盖若干文件（必须给完整 content）。每次写入是一个事务，revision 与 treeDigest 会变化。',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: stringSchema('相对路径'),
              content: stringSchema('完整文件内容（不是 diff）'),
              expectedBaseSha256: stringSchema('可选：乐观锁，文件当前 sha256'),
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
  delete_files: {
    description: '删除若干文件（相对路径）。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: stringSchema('相对路径'),
              expectedBaseSha256: stringSchema('可选：乐观锁'),
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  get_diff: {
    description: '读取当前 attempt 相对 Base 版本的差异摘要（路径 + 状态 + sha256 + 字节数）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  run_check: {
    description: '执行一条平台检查（checkId 白名单内），返回 status（PASS/FAIL/BLOCKED/NOT_RUN）与 issues。不能指定 root/路径。',
    parameters: {
      type: 'object',
      properties: {
        checkId: stringSchema('检查 id，例如 source.check / composer.dry-run / mini.check / output.consistency'),
        params: { type: 'object', description: '只允许 timeoutMs / targetFiles / appId，其余键会被拒绝' },
      },
      required: ['checkId'],
      additionalProperties: false,
    },
  },
  verify_wechat: {
    description: '在派生导出树上跑微信开发者工具验证；工具缺失时返回 BLOCKED（不代表通过）。',
    parameters: {
      type: 'object',
      properties: { appId: stringSchema('小程序 AppID'), timeoutMs: { type: 'integer', minimum: 1000 } },
      additionalProperties: false,
    },
  },
  read_verification: {
    description: '读取已落盘的检查/验证证据摘要（只读，不含源码全文）。',
    parameters: {
      type: 'object',
      properties: { source: stringSchema('证据来源，例如 workspace / export') },
      additionalProperties: false,
    },
  },
  submit_candidate: {
    description: '提交当前 attempt 作为候选（平台会跑静态门禁：source.check / composer.dry-run / mini.check / output.consistency）。',
    parameters: {
      type: 'object',
      properties: {
        targetPage: stringSchema('目标页 id（8 页枚举）'),
        summary: stringSchema('一句话说明这次改动做了什么'),
      },
      required: ['targetPage'],
      additionalProperties: false,
    },
  },
});

/**
 * rev15 §14.13-3（F3）**唯一合法顺序**——这是 direct 循环的工具说明与停止条件都必须写明的硬契约：
 *
 * ```text
 * 写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt
 * ```
 *
 * 其中 derive bundle 是**平台步骤**（不在模型工具面里）：模型改完文件后只能跑检查，
 * 派生由平台在检查阶段完成。任何写入都会使既有检查证据失效，因此 submit 前必须重跑检查。
 */
const ORDER_CONTRACT = '写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt';

const ORDER_RULES = Object.freeze({
  /** 所有工具说明都带的一句。 */
  common: '顺序契约：' + ORDER_CONTRACT + '；任何写入（write_files/delete_files）都会使既有检查证据失效。',
  /** 写入类工具追加。 */
  write: '写入后既有检查证据立即失效：必须先重新派生 bundle 并重跑 source.check / composer.dry-run / mini/output，才能 submit；不得拿旧证据提交。',
  /** 检查类工具追加。 */
  recheck: '这是收到 AGENT_EVIDENCE_STALE 后必须执行的下一步（nextAction="rerun-checks"）：重跑检查刷新证据，而不是重复 submit 或改动证据。',
  /** 提交类工具追加。 */
  submit: '若证据与当前 revision/treeDigest 不一致，平台返回 AGENT_EVIDENCE_STALE + issue EVIDENCE_STALE_RERUN_CHECKS + nextAction="rerun-checks"：此时必须按 nextAction 重跑检查，不得重复 submit，也不得改证据。',
  /** 微信验证类追加。 */
  verify: '微信验证只在派生导出树上进行；写完后需先重新派生并重跑检查，验证结果才对新 revision 有效。',
});

const ORDER_RULES_BY_TOOL = Object.freeze({
  write_files: ORDER_RULES.write,
  delete_files: ORDER_RULES.write,
  run_check: ORDER_RULES.recheck,
  submit_candidate: ORDER_RULES.submit,
  verify_wechat: ORDER_RULES.verify,
});

/** 工具描述 = 基础说明 + 顺序契约（所有 11 个都带）+ 该工具的专属细则。 */
function toolDescription(name) {
  const schema = SCHEMAS[name];
  const base = schema ? schema.description : '';
  const extra = ORDER_RULES_BY_TOOL[name];
  return [base, ORDER_RULES.common, ...(extra ? [extra] : [])].filter(Boolean).join(' ');
}

/** 启动期自检：schema 必须与 §14.3 的 11 个工具一一对应，平台专用工具一个都不能有。 */
function assertToolCatalogConsistent() {
  for (const name of MODEL_TOOL_NAMES) {
    if (!SCHEMAS[name]) throw new Error('缺少模型工具 schema：' + name);
  }
  for (const name of Object.keys(SCHEMAS)) {
    if (!MODEL_TOOL_SET.has(name)) throw new Error('schema 里有非模型可见工具：' + name);
  }
  for (const name of PLATFORM_ONLY_TOOL_NAMES) {
    if (SCHEMAS[name]) throw new Error('平台专用工具不得出现在模型工具列表：' + name);
  }
  if (ORDER_RULES_BY_TOOL.derive_source_bundle) {
    throw new Error('派生是平台步骤，不得出现在模型工具说明里');
  }
}
assertToolCatalogConsistent();

/** 组装成 OpenAI 兼容的 tools 数组（顺序固定 = 冻结顺序，便于对齐证据）。 */
function buildToolDefinitions(filter) {
  const allow = Array.isArray(filter) && filter.length > 0 ? new Set(filter) : null;
  const out = [];
  for (const name of MODEL_TOOL_NAMES) {
    if (allow && !allow.has(name)) continue;
    const schema = SCHEMAS[name];
    out.push({
      type: 'function',
      function: { name, description: toolDescription(name), parameters: schema.parameters },
    });
  }
  return out;
}

/**
 * 工具名准入（在调用 Coordinator 之前先判一次，双保险）：
 * - 不在 11 个模型可见工具里 → `AGENT_TOOL_NOT_ALLOWED`
 * - 平台专用名（derive_source_bundle / adopt_attempt / attach_image_asset）→ 同上，且措辞点明
 */
function classifyModelToolName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, code: RUNTIME_CODES.TOOL_NOT_ALLOWED, message: '未知工具：' + String(name) };
  }
  if (MODEL_TOOL_SET.has(name)) return { ok: true };
  if (PLATFORM_ONLY_TOOL_SET.has(name)) {
    return { ok: false, code: RUNTIME_CODES.TOOL_NOT_ALLOWED, message: '平台专用工具不得由模型调用：' + name };
  }
  return { ok: false, code: RUNTIME_CODES.TOOL_NOT_ALLOWED, message: '未知工具：' + name };
}

module.exports = {
  SCHEMAS,
  ORDER_CONTRACT,
  ORDER_RULES,
  toolDescription,
  buildToolDefinitions,
  classifyModelToolName,
  assertToolCatalogConsistent,
};
