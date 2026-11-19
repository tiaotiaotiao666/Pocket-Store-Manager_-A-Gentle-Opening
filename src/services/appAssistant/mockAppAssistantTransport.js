import { APP_ASSISTANT_CONTRACT_VERSION } from './appAssistantConfig.js';

/**
 * 本地确定性 mock transport：只用于测试与离线演示。
 *
 * 规则刻意非常窄（店名、品类、新增菜品），保证同一输入永远得到同一提案。
 * 带图时只提出「用途不明确」的追问，**不伪造** `vision.analyzed` 或任何识别结果。
 */

const MAX_EVIDENCE_CHARS = 120;

function digest(text) {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function clip(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  return Array.from(text).slice(0, maxChars).join('');
}

function evidenceFor(excerpt) {
  return { source: 'utterance', excerpt: clip(excerpt, MAX_EVIDENCE_CHARS) };
}

function buildRuleChanges(utterance) {
  const text = String(utterance ?? '');
  const changes = [];
  let nextOpId = 1;

  const nameMatch = /(?:店名|门店名称)(?:改为|改成|叫|是)\s*([^，。；、\n]{1,48})/.exec(text);
  if (nameMatch) {
    changes.push({
      opId: `op_${nextOpId++}`,
      op: 'field.set',
      fieldId: 'store.name',
      value: nameMatch[1].trim(),
      evidence: evidenceFor(nameMatch[0]),
      reason: '用户明确指定店名',
    });
  }

  const categoryMatch = /(?:品类|类型)(?:改为|改成|是)\s*([^，。；、\n]{1,24})/.exec(text);
  if (categoryMatch) {
    changes.push({
      opId: `op_${nextOpId++}`,
      op: 'field.set',
      fieldId: 'store.category',
      value: categoryMatch[1].trim(),
      evidence: evidenceFor(categoryMatch[0]),
      reason: '用户明确指定品类',
    });
  }

  const dishMatch = /(?:加|新增|添加)(?:一道|一个)?\s*([^，。；、\d\s]{1,24})\s*(\d+(?:\.\d{1,2})?)\s*元/.exec(text);
  if (dishMatch) {
    changes.push({
      opId: `op_${nextOpId++}`,
      op: 'dish.upsert',
      name: dishMatch[1].trim(),
      priceCents: Math.round(Number(dishMatch[2]) * 100),
      evidence: evidenceFor(dishMatch[0]),
      reason: '用户明确新增菜品与价格',
    });
  }

  return changes;
}

export function createMockAppAssistantTransport() {
  return {
    name: 'mock',
    async send(request) {
      const utterance = typeof request.utterance === 'string' ? request.utterance : '';
      const attachments = Array.isArray(request.attachments) ? request.attachments : [];
      const runId = `run_mock_${digest(`${utterance}|${attachments.map((item) => item.id).join(',')}`)}`;
      const base = {
        contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
        requestId: request.requestId,
        runId,
        catalogVersion: request.catalogVersion,
        contextRevision: request.contextRevision,
        proposalId: `proposal_${runId}`,
        changes: [],
        questions: [],
        actionRequests: [],
        meta: {
          transport: 'mock',
          provider: 'mock',
          mock: true,
          model: 'mock-rules',
          latencyMs: 0,
          runId,
        },
      };

      if (attachments.length > 0) {
        return {
          ...base,
          status: 'needs-input',
          reply: '收到图片，但我还不确定用途，请先告诉我要做什么。',
          questions: [{ id: 'q_image_purpose', text: '这张图片要识别菜单、参考门店氛围，还是照图重构界面？' }],
          trace: { modelCalls: 1, toolCalls: [], stopReason: 'attachment_purpose_unknown', degraded: true },
        };
      }

      const changes = buildRuleChanges(utterance);
      return {
        ...base,
        status: 'proposal',
        reply: changes.length
          ? '已按本地演示规则整理出一版提案，请核对。'
          : '已收到你的描述；本地演示模式只识别店名、品类与新增菜品。',
        changes,
        actionRequests: changes.filter((item) => item.op === 'action.request'),
        trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
      };
    },
  };
}