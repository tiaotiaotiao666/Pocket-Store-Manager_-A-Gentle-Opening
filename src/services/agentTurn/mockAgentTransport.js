import {
  applyDraftPatch,
  buildNextQuestion,
  fromContractDraft,
  normalizeAgentDraft,
  parsePriceTextToCents,
  toContractDraft,
  validateAgentDraft,
} from '../../domain/agentDraft.mjs';
import { AGENT_CONTRACT_VERSION } from './agentServiceConfig.js';
import { createAgentTurnError } from './agentTurnError.js';

const MAX_UTTERANCE = 500;
const MAX_DISHES = 5;
const MAX_HOURS_SEGMENTS = 3;
const TIME_RANGE_SOURCE = '(\\d{1,2})(?::(\\d{2}))?\\s*(?:点|时)?\\s*(半)?\\s*(?:到|至|~|—|-)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(?:点|时)?';
const DISH_SEGMENT = /^(.{1,24}?)\s*(?:¥|￥)?\s*(\d{1,6}(?:\.\d{1,2})?)\s*(?:元|块钱|块)?$/;
const STORE_NAME_EXPLICIT = /(?:店名|店铺名称|店铺名|名字|名称)\s*(?:是|叫|为|：|:)\s*([^，,。；;\n]{1,20})/;
const STORE_NAME_CALLED = /(?:叫做|叫)\s*([^，,。；;\n]{1,20})/;
const STORE_NAME_SUFFIX = /(?<![做营是为])([\u4e00-\u9fa5A-Za-z0-9]{1,12}(?:食堂|小馆|餐馆|饭店|面馆|粉店|咖啡|茶饮|烘焙|甜品|烧烤|火锅|小吃|轻食))/;
const CATEGORY_EXPLICIT = /(?:品类|类型|主营)\s*(?:是|为|：|:)\s*([^，,。；;\n]{1,24})/;
const DISH_PREFIX = /^(?:招牌菜是|招牌是|招牌|菜品有|菜单[:：]?|还有|推荐|包括)\s*/;

const CATEGORY_RULES = [
  { pattern: /咖啡|茶饮|奶茶/, label: '咖啡茶饮' },
  { pattern: /烘焙|甜品|蛋糕|面包/, label: '烘焙甜品' },
  { pattern: /火锅|烧烤|串串/, label: '火锅烧烤' },
  { pattern: /轻食|沙拉|健康餐/, label: '轻食' },
  { pattern: /特色菜|私房菜|主厨/, label: '特色餐馆' },
  { pattern: /面|粉|饭|家常|炒菜|食堂|小馆|社区餐饮/, label: '社区餐馆' },
];

function toHalfWidth(value) {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x3000) {
      result += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCharCode(code - 0xfee0);
    } else {
      result += character;
    }
  }
  return result;
}

function normalizeUtterance(utterance) {
  const raw = toHalfWidth(String(utterance ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(raw);
  const truncated = characters.length > MAX_UTTERANCE;
  return { text: characters.slice(0, MAX_UTTERANCE).join(''), truncated };
}

function codePointLength(value) {
  return Array.from(value).length;
}

function captureStoreName(text, base) {
  const explicit = STORE_NAME_EXPLICIT.exec(text);
  if (explicit) return explicit[1].trim();
  const called = STORE_NAME_CALLED.exec(text);
  if (called) return called[1].trim();
  const suffix = STORE_NAME_SUFFIX.exec(text);
  if (suffix) return suffix[1].trim();
  if (base) return '';
  const firstSegment = text.split(/[，,。；;\n]/)[0].trim();
  if (!firstSegment) return '';
  if (codePointLength(firstSegment) > 20) return '';
  if (/[\d:：]/.test(firstSegment)) return '';
  if (/(堂食|自取|营业|每天|品类|类型|外卖|打包|元|块|菜)/.test(firstSegment)) return '';
  return firstSegment;
}

function captureCategory(text) {
  const explicit = CATEGORY_EXPLICIT.exec(text);
  if (explicit) return explicit[1].trim();
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.label;
  }
  return '';
}

function captureBusinessHours(text) {
  const pattern = new RegExp(TIME_RANGE_SOURCE, 'g');
  const segments = [];
  for (const matched of text.matchAll(pattern)) {
    const startHour = String(Number(matched[1])).padStart(2, '0');
    const startMinute = matched[2] ?? (matched[3] ? '30' : '00');
    const endHour = String(Number(matched[4])).padStart(2, '0');
    const endMinute = matched[5] ?? '00';
    segments.push(`${startHour}:${startMinute}-${endHour}:${endMinute}`);
  }
  if (!segments.length) return { hours: '', tooMany: false };
  return { hours: segments.slice(0, MAX_HOURS_SEGMENTS).join(','), tooMany: segments.length > MAX_HOURS_SEGMENTS };
}

function captureFulfillment(text) {
  const patch = {};
  if (/(?:只|仅)\s*(?:做|提供)?\s*堂食|不(?:做|提供)?(?:自取|打包|外带)/.test(text)) {
    return { dineIn: true, takeaway: false };
  }
  if (/(?:只|仅)\s*(?:做|提供)?(?:自取|外带|打包|带走)|不堂食|只能打包/.test(text)) {
    return { dineIn: false, takeaway: true };
  }
  if (/堂食|店内吃|在店里吃/.test(text)) patch.dineIn = true;
  if (/自取|外带|打包|带走/.test(text)) patch.takeaway = true;
  return patch;
}

function isValidDishName(name) {
  if (!name) return false;
  if (codePointLength(name) > 24) return false;
  if (/[\d:：]/.test(name)) return false;
  if (/(堂食|自取|营业|店名|品类|每天|外卖|打包|块钱)/.test(name)) return false;
  return true;
}

function captureDishes(text, base) {
  const segments = text.split(/[、，,；;。\n]/);
  const candidates = [];
  const invalidNames = [];
  for (const raw of segments) {
    const segment = raw.trim().replace(DISH_PREFIX, '').trim();
    if (!segment) continue;
    const matched = DISH_SEGMENT.exec(segment);
    if (matched) {
      const name = matched[1].trim();
      if (!isValidDishName(name)) continue;
      const parsed = parsePriceTextToCents(matched[2]);
      if (!parsed.ok) {
        invalidNames.push(name);
        continue;
      }
      candidates.push({ name, priceCents: parsed.cents });
      continue;
    }
    if (/\d/.test(segment) && !/[:：]/.test(segment) && segment.length <= 40 && !/[、，,；;。\n]/.test(segment)) {
      const guess = segment.replace(/[\d.]+.*$/, '').trim();
      if (guess && isValidDishName(guess)) invalidNames.push(guess);
    }
  }
  const seen = new Set();
  const unique = candidates.filter((dish) => {
    if (seen.has(dish.name)) return false;
    seen.add(dish.name);
    return true;
  });
  const existingNames = new Set(base.dishes.map((dish) => dish.name));
  const updates = unique.filter((dish) => existingNames.has(dish.name));
  const additions = unique.filter((dish) => !existingNames.has(dish.name));
  const room = Math.max(0, MAX_DISHES - base.dishes.length);
  const kept = additions.slice(0, room);
  return {
    dishes: [...updates, ...kept],
    recognized: unique.length > 0,
    tooMany: additions.length > room,
    invalidNames,
  };
}

export function parseMockUtterance(utterance, currentDraft) {
  const base = normalizeAgentDraft(fromContractDraft(currentDraft));
  const { text, truncated } = normalizeUtterance(utterance);
  const notes = {
    truncated,
    extraHours: false,
    extraDishes: false,
    invalidPriceNames: [],
  };
  if (!text) {
    return { draft: base, recognized: [], notes };
  }

  const recognized = [];
  const patch = {};

  const storeName = captureStoreName(text, base.storeName);
  if (storeName) {
    const mayReplace = !base.storeName || /改|换成|叫做|叫|店名|名称/.test(text);
    if (mayReplace) {
      patch.storeName = Array.from(storeName).slice(0, 48).join('');
      recognized.push('storeName');
    }
  }

  const category = captureCategory(text);
  if (category) {
    patch.category = Array.from(category).slice(0, 24).join('');
    recognized.push('category');
  }

  const hours = captureBusinessHours(text);
  if (hours.hours) {
    patch.businessHours = hours.hours;
    notes.extraHours = hours.tooMany;
    recognized.push('businessHours');
  }

  const fulfillment = captureFulfillment(text);
  if (Object.keys(fulfillment).length) {
    patch.fulfillment = fulfillment;
    recognized.push('fulfillment');
  }

  const dishes = captureDishes(text, base);
  if (dishes.dishes.length) {
    patch.dishes = dishes.dishes;
    recognized.push('dishes');
  }
  notes.extraDishes = dishes.tooMany;
  notes.invalidPriceNames = dishes.invalidNames;

  if (patch.storeName && patch.category && patch.storeName === patch.category) {
    delete patch.storeName;
    const index = recognized.indexOf('storeName');
    if (index !== -1) recognized.splice(index, 1);
  }

  return { draft: applyDraftPatch(base, patch), recognized, notes };
}

function fulfillmentText(fulfillment) {
  if (fulfillment.dineIn && fulfillment.takeaway) return '堂食和自取';
  if (fulfillment.dineIn) return '仅堂食';
  if (fulfillment.takeaway) return '仅自取';
  return '取餐方式未定';
}

function recognizedSummary(draft, recognized) {
  const parts = [];
  if (recognized.includes('storeName') && draft.storeName) parts.push(`店名 ${draft.storeName}`);
  if (recognized.includes('category') && draft.category) parts.push(`品类 ${draft.category}`);
  if (recognized.includes('businessHours') && draft.businessHours) parts.push(`营业时间 ${draft.businessHours}`);
  if (recognized.includes('fulfillment')) parts.push(`取餐方式 ${fulfillmentText(draft.fulfillment)}`);
  if (recognized.includes('dishes')) parts.push(`${draft.dishes.length} 道菜`);
  return parts.join('、') || '部分资料';
}

function buildMockReply({ draft, validation, recognized, notes }) {
  const suffix = [];
  if (notes.truncated) suffix.push('输入较长，我只处理了前 500 字。');
  if (notes.extraHours) suffix.push('营业时间最多保留 3 段。');
  if (notes.extraDishes) suffix.push('本轮只保留前 5 道菜。');
  if (notes.invalidPriceNames.length) {
    suffix.push(`${notes.invalidPriceNames.join('、')}的价格格式不正确，请在右侧改成 28 或 28.50。`);
  }

  let main;
  if (validation.readyForReview) {
    main = `资料齐了：${draft.storeName}，${draft.category}，${draft.businessHours}，${fulfillmentText(draft.fulfillment)}，${draft.dishes.length} 道菜。请检查后确认。`;
  } else if (recognized.length === 0) {
    main = '这次没有识别到新的资料。可以说“店名是…，营业时间…，招牌菜… 28 元”。';
  } else {
    const question = buildNextQuestion(validation);
    main = `记下了：${recognizedSummary(draft, recognized)}。还差${question?.label ?? '部分资料'}。${question?.text ?? ''}`.trim();
  }
  return [main, ...suffix].join(' ');
}

export function createMockTransport(options = {}) {
  let turnCounter = 0;
  return {
    name: 'mock',
    async send(request, context = {}) {
      if (context.failOnce === true) {
        throw createAgentTurnError('AGENT_MOCK_FAILURE');
      }
      turnCounter += 1;
      const contractDraft = request && request.draft ? request.draft : {};
      const parsed = parseMockUtterance(request?.utterance ?? '', contractDraft);
      const validation = validateAgentDraft(parsed.draft);
      const nextQuestion = buildNextQuestion(validation);
      const reply = buildMockReply({
        draft: parsed.draft,
        validation,
        recognized: parsed.recognized,
        notes: parsed.notes,
      });
      return {
        contractVersion: request?.contractVersion ?? AGENT_CONTRACT_VERSION,
        turnId: `${options.turnIdPrefix ?? 'turn-mock'}-${turnCounter}`,
        status: validation.readyForReview ? 'reviewing' : 'collecting',
        reply,
        draft: toContractDraft(parsed.draft),
        missingFields: validation.missingFields,
        errors: validation.errors,
        nextQuestion,
        meta: {
          transport: 'mock',
          provider: 'local-mock',
          mock: true,
          model: null,
          latencyMs: 0,
        },
      };
    },
  };
}

export function createDraftForMock() {
  return createDishId([]);
}