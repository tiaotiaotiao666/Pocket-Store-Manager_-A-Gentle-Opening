import { templates as catalogTemplates, matchTemplate, templateModel, rankTemplatesByBrief } from '../domain/catalog.mjs';
import { STYLE_PRESETS } from '../domain/storeBrief.mjs';
import {
  IMAGE_PROMPT_MAX_LENGTH,
  IMAGE_PROMPT_PROVIDER_TIP,
  buildImagePromptSpec,
  reviseImagePrompt,
} from '../domain/imagePromptSpec.mjs';
import { getAgentTransportConfig } from './agentTurn/agentServiceConfig.js';
import {
  describeTemplateCandidatesError,
  requestTemplateCandidates,
} from './agentTurn/templateCandidatesService.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本地演示占位图/占位图的“生成耗时”；真实生图接入后由服务端决定。 */
const DEFAULT_IMAGE_DELAY_MS = 1400;
const DEFAULT_REVISE_IMAGE_DELAY_MS = 1100;

/** 降级时的候选来源标签（plan.md 2.2.9 语义 3，必须可见）。 */
const SOURCE_DEGRADED = '本地规则（模型不可用）';
const SOURCE_MOCK = '本地规则（Mock）';

function hash(value) {
  return [...String(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 360, 0);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(text) {
  return [...String(text ?? '')].length;
}

/**
 * 逐模板的确定性规则分（不使用模型返回的任何数字）。
 *
 * 规则（可在 UI 与测试里复述）：
 * - 基础分 = 功能覆盖率（请求功能 ∪ Base 必需功能 中该模板已支持的比例，满分 100）；
 * - 描述加分 = 命中该模板风格关键词数 × 5，最多 +15；
 * - 总分夹在 0..100。
 *
 * @returns {{score:number, matched:number, requestedSize:number, coverage:number,
 *   hits:number, keywordBonus:number, basis:string}}
 */
function explainTemplateScore(template, selectedFeatures, briefRank) {
  const requested = new Set([...templateModel.baseFeatures, ...selectedFeatures]);
  const matched = [...requested].filter((id) => template.features.includes(id)).length;
  const coverage = requested.size ? Math.round((matched / requested.size) * 100) : 100;
  const hits = briefRank.hits[template.id] || 0;
  const keywordBonus = hits > 0 ? Math.min(15, hits * 5) : 0;
  const score = Math.max(0, Math.min(100, coverage + keywordBonus));
  const basisParts = [`功能覆盖 ${matched}/${requested.size}（${coverage} 分）`];
  if (hits > 0) basisParts.push(`描述命中 ${hits} 个风格词（+${keywordBonus} 分）`);
  return { score, matched, requestedSize: requested.size, coverage, hits, keywordBonus, basis: basisParts.join(' + ') };
}

function refineNote({ template, keywords, brief, isTop }) {
  if (!isTop) return template.summary;
  const quoted = brief.length > 26 ? `${brief.slice(0, 26)}…` : brief;
  if (keywords.length > 0) {
    return `已按「${quoted}」调整：命中 ${keywords.slice(0, 3).join('、')}`;
  }
  return `已按「${quoted}」重新排序；这条描述里没有可识别的风格词，仍以功能匹配为先。`;
}

/**
 * 构造本地确定性候选（降级 / Mock / HTTP 成功路径共用的评分与说明来源）。
 *
 * @param {{selectedFeatures: string[], brief: string}} input
 * @returns {{ordered: object[], byId: Record<string, object>}}
 */
function buildLocalCandidateRows({ selectedFeatures, brief }) {
  const briefRank = rankTemplatesByBrief(brief);
  const match = matchTemplate(selectedFeatures);
  const baseOrder = [match.template, ...catalogTemplates.filter((template) => template.id !== match.template.id)];

  const rows = baseOrder.map((template) => {
    const explanation = explainTemplateScore(template, selectedFeatures, briefRank);
    const keywords = briefRank.matchedKeywords[template.id] || [];
    return {
      template,
      explanation,
      keywords,
      isTopCandidate: template.id === match.template.id,
    };
  });

  const ordered = briefRank.recognized
    ? [...rows].sort((a, b) => (
      (b.explanation.score - a.explanation.score)
      || (b.explanation.hits - a.explanation.hits)
      || (baseOrder.indexOf(a.template) - baseOrder.indexOf(b.template))
    ))
    : [...rows].sort((a, b) => (
      (b.explanation.score - a.explanation.score)
      || (baseOrder.indexOf(a.template) - baseOrder.indexOf(b.template))
    ));

  return {
    ordered,
    byId: Object.fromEntries(rows.map((row) => [row.template.id, row])),
    briefRank,
  };
}

function toCandidate(row, { index, brief, source, note, sourceLabel }) {
  const { template, explanation, keywords } = row;
  return {
    ...template,
    score: explanation.score,
    scoreBasis: explanation.basis,
    source,
    sourceLabel,
    customized: Boolean(brief),
    briefHits: keywords.length,
    briefKeywords: keywords,
    note: note ?? (brief ? refineNote({ template, keywords, brief, isTop: index === 0 }) : template.summary),
  };
}

/**
 * 把诊断信息挂在候选数组上。
 *
 * 数组本身仍是 `Array<Candidate>`，兼容 `BUILD_READY` / `TEMPLATE_REBUILD_READY`
 * 的既有 reducer 与 App 调用方；`meta` 是额外属性，不参与 JSON 数组序列化。
 */
function withMeta(candidates, meta) {
  Object.defineProperty(candidates, 'meta', {
    value: Object.freeze({ ...meta }),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return candidates;
}

function localSources(brief, rulesLabel) {
  if (rulesLabel) {
    return { top: rulesLabel, other: rulesLabel };
  }
  return brief
    ? { top: '按你的描述匹配', other: '备选骨架' }
    : { top: '功能匹配', other: '备选骨架' };
}

/**
 * 按功能清单 + 自然语言描述生成候选页面骨架。
 *
 * 数据来源（诚实标注，不得混淆）：
 * - HTTP 模式：`POST /api/v1/agent/template-candidates` 只决定**排序与理由**；
 * - `score` 永远由前端按功能覆盖率 + 关键词命中确定性计算（见 `explainTemplateScore`），
 *   不使用模型返回的任何数字，也不再使用 `topScore - index*9` 这类编造递减；
 * - 模型不可用 / 超时 / 响应非法：降级为本地确定性排序，
 *   候选 `source` 标为 `本地规则（模型不可用）`，并在返回数组上标注
 *   `meta.degraded = true` 与 `meta.degradedReason`（中文可读），绝不伪装成模型结果；
 * - 未配置 HTTP 的后端（Mock 模式）：候选 `source` 保持既有语义标签，
 *   数组 `meta` 标 `transport:'mock'` / `mock:true` / `source:'本地规则（Mock）'`。
 *
 * @param {object} options
 * @param {string[]} [options.selectedFeatures]
 * @param {string} [options.customPrompt] 用户在模板页重新描述的需求
 * @param {number} [options.delayMs] 仅测试注入用；生产路径恒为 0（已移除 1.6s 假延时）
 * @param {{send: Function}} [options.transport] 仅测试注入用的 transport 替身
 */
export async function buildTemplateCandidates({
  selectedFeatures = [],
  customPrompt = '',
  delayMs = 0,
  transport,
} = {}) {
  // 保留 delayMs 仅为了兼容旧的测试调用；默认 0，生产路径不会等待。
  if (Number.isFinite(delayMs) && delayMs > 0) await wait(delayMs);

  const features = Array.isArray(selectedFeatures) ? selectedFeatures.filter((id) => typeof id === 'string') : [];
  const brief = String(customPrompt ?? '').trim();
  const local = buildLocalCandidateRows({ selectedFeatures: features, brief });
  const config = getAgentTransportConfig();

  if (config.mode !== 'http') {
    const labels = localSources(brief, null);
    const candidates = local.ordered.map((row, index) => toCandidate(row, {
      index,
      brief,
      source: index === 0 ? labels.top : labels.other,
      sourceLabel: SOURCE_MOCK,
    }));
    return withMeta(candidates, {
      transport: 'mock',
      provider: 'local-rules',
      mock: true,
      model: null,
      latencyMs: 0,
      degraded: false,
      degradedReason: null,
      source: SOURCE_MOCK,
      scoredBy: '功能覆盖率 + 关键词命中（前端确定性计算）',
    });
  }

  const startedAt = Date.now();
  try {
    const response = await requestTemplateCandidates({ selectedFeatures: features, brief }, { transport });
    const candidates = response.orderedTemplateIds.map((id, index) => {
      const row = local.byId[id];
      return toCandidate(row, {
        index,
        brief,
        source: index === 0 ? '模型推荐（服务端排序）' : '模型备选（服务端排序）',
        sourceLabel: '模型推荐',
        note: response.reasons[id],
      });
    });
    return withMeta(candidates, {
      transport: 'http',
      provider: response.meta.provider,
      mock: false,
      model: response.meta.model,
      turnId: response.turnId,
      latencyMs: response.meta.latencyMs,
      degraded: false,
      degradedReason: null,
      source: '模型推荐（服务端排序）',
      scoredBy: '功能覆盖率 + 关键词命中（前端确定性计算）',
      roundTripMs: Math.max(0, Date.now() - startedAt),
    });
  } catch (error) {
    const degradedReason = describeTemplateCandidatesError(error);
    const candidates = local.ordered.map((row, index) => toCandidate(row, {
      index,
      brief,
      source: SOURCE_DEGRADED,
      sourceLabel: SOURCE_DEGRADED,
    }));
    return withMeta(candidates, {
      transport: 'http',
      provider: 'local-rules',
      mock: false,
      model: null,
      latencyMs: null,
      degraded: true,
      degradedReason,
      errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      source: SOURCE_DEGRADED,
      scoredBy: '功能覆盖率 + 关键词命中（前端确定性计算）',
      roundTripMs: Math.max(0, Date.now() - startedAt),
    });
  }
}

function resolveStoreSizeTokens(store) {
  if (!isPlainObject(store)) return {};
  if (isPlainObject(store.presentationTokens)) {
    return {
      homeHero: store.presentationTokens.homeHeroSize,
      productCard: store.presentationTokens.productCardSize,
    };
  }
  if (isPlainObject(store.sizes)) {
    return {
      homeHero: store.sizes.homeHero,
      productCard: store.sizes.productCard,
      carousel: store.sizes.carousel,
    };
  }
  return {};
}

/**
 * 生成结构化生图提示词（plan.md 2.2.10）。
 *
 * 不发起网络请求；`layout` 缺省时按门店类型推导（咖啡→catalog、特色/招牌→editorial、其余→menu）。
 * 返回值同时保留 `prompt`（纯文本，给现有 UI）与 `spec`（结构化约束，给后续生图 provider）。
 *
 * @param {{store?: object, styleId?: string, layout?: string, sizeTokens?: object}} options
 * @returns {Promise<{prompt: string, spec: object, tips: string[]}>}
 */
export async function composePrompt({ store, styleId, layout, sizeTokens } = {}) {
  const style = STYLE_PRESETS.find((item) => item.id === styleId) ?? STYLE_PRESETS[0];
  const result = buildImagePromptSpec({
    layout,
    storeProfile: isPlainObject(store) ? store : {},
    styleId: style.id,
    sizeTokens: isPlainObject(sizeTokens) ? sizeTokens : resolveStoreSizeTokens(store),
  });

  return {
    prompt: result.prompt,
    spec: result.spec,
    // tips 必须保留真实生图接入说明，避免把本地演示误当成已接模型。
    tips: result.tips.includes(IMAGE_PROMPT_PROVIDER_TIP) ? result.tips : [...result.tips, IMAGE_PROMPT_PROVIDER_TIP],
  };
}

/**
 * 按用户反馈修改提示词。
 *
 * 为兼容现有 `App.jsx` 调用（直接把返回值当作字符串写入 `prompt`），本函数返回 `prompt` 字符串；
 * 需要结构化结果时用 `revisePromptDetailed`。
 *
 * @param {{base?: string, basePrompt?: string, feedback?: string, baseSpec?: object,
 *   styleId?: string, sizeTokens?: object}} input
 * @returns {Promise<string>}
 */
export async function revisePrompt({
  base,
  basePrompt,
  feedback,
  baseSpec,
  styleId,
  sizeTokens,
} = {}) {
  const detailed = await revisePromptDetailed({
    base: base ?? basePrompt,
    feedback,
    baseSpec,
    styleId,
    sizeTokens,
  });
  return detailed.prompt;
}

/**
 * 结构化版本的提示词修订：反馈写入 `extraRequirement`，禁止项与 layout 约束保持不变。
 *
 * @param {{base?: string, basePrompt?: string, feedback?: string, baseSpec?: object,
 *   styleId?: string, sizeTokens?: object}} input
 * @returns {Promise<{prompt: string, spec: object, tips: string[]}>}
 */
export async function revisePromptDetailed({
  base,
  basePrompt,
  feedback,
  baseSpec,
  styleId,
  sizeTokens,
} = {}) {
  const baseText = String(base ?? basePrompt ?? '').trim();
  const feedbackText = String(feedback ?? '').trim();
  if (isPlainObject(baseSpec)) {
    const revised = reviseImagePrompt({ basePrompt: baseText, baseSpec, feedback: feedbackText });
    return revised;
  }

  const result = buildImagePromptSpec({
    styleId,
    sizeTokens: isPlainObject(sizeTokens) ? sizeTokens : {},
    extraRequirement: feedbackText,
  });
  // 结构缺省时以旧 prompt 为基线，避免把用户之前手动改过的文字全部丢掉。
  if (baseText) {
    const merged = `${baseText} 补充要求：${feedbackText}`;
    const prompt = codePointLength(merged) > IMAGE_PROMPT_MAX_LENGTH
      ? `${[...merged].slice(0, IMAGE_PROMPT_MAX_LENGTH - 1).join('')}…`
      : merged;
    return { prompt, spec: { ...result.spec, prompt, legacyBase: true }, tips: result.tips };
  }
  return { prompt: result.prompt, spec: result.spec, tips: result.tips };
}

function placeholderImage(seed) {
  const hue = hash(seed);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue}, 30%, 92%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360}, 46%, 74%)"/></linearGradient></defs><rect width="640" height="420" rx="28" fill="url(#g)"/><circle cx="320" cy="168" r="74" fill="none" stroke="hsl(${hue}, 26%, 32%)" stroke-width="12"/><path d="M226 262c62 52 132 52 198 0" fill="none" stroke="hsl(${(hue + 20) % 360}, 34%, 30%)" stroke-width="12" stroke-linecap="round"/><circle cx="288" cy="154" r="10" fill="hsl(${hue}, 26%, 32%)"/><circle cx="352" cy="154" r="10" fill="hsl(${hue}, 26%, 32%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

export async function generateImage({ prompt, seed = 1 }) {
  await wait(DEFAULT_IMAGE_DELAY_MS);
  return {
    dataUrl: placeholderImage(`${prompt}-${seed}`),
    provider: 'local-demo',
    note: '本地演示占位图；接入生图模型后由服务端返回真实图片。',
  };
}

export async function reviseImage({ prompt, seed = 2 }) {
  await wait(DEFAULT_REVISE_IMAGE_DELAY_MS);
  return {
    dataUrl: placeholderImage(`${prompt}-${seed}-revise`),
    provider: 'local-demo',
    note: '已按你的意见重新生成（本地演示占位图）。',
  };
}