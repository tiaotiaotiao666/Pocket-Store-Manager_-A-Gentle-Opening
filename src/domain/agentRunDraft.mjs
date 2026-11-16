import {
  createDishId,
  formatCents,
  normalizeAgentDraft,
  normalizeBusinessHoursText,
  parsePriceTextToCents,
} from './agentDraft.mjs';

/**
 * `agent-run.v1` 草稿合并规则（W2）。
 *
 * 与 `agent-turn` 的整份替换不同，多轮 run 的草稿是服务端会话内的权威值，
 * 但客户端仍要防止「模型少写一个字段就把用户手改的内容清空」：
 *
 * 1. 菜品按已有 `id` 优先匹配；没有匹配到 id 时按「精确 name」匹配；改名不换 id。
 * 2. 未出现在响应里的字段一律保留当前值（不覆盖）。
 * 3. 空字符串不清空已有值。
 * 4. 不做删除：响应里没有的菜品继续留在草稿里。
 *
 * 合并后再交给 `normalizeAgentDraft` / `validateAgentDraft`，不在这里做校验结论。
 */

const TEXT_FIELDS = ['storeName', 'category', 'businessHours'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolvePriceCents(raw) {
  if (hasOwn(raw, 'priceCents') && Number.isInteger(raw.priceCents) && raw.priceCents >= 0) {
    return raw.priceCents;
  }
  const priceText = trimText(raw.priceText);
  if (!priceText) return undefined;
  const parsed = parsePriceTextToCents(priceText);
  return parsed.ok ? parsed.cents : undefined;
}

export function mergeAgentRunDraft(current, incoming) {
  const base = normalizeAgentDraft(current);
  if (!isPlainObject(incoming)) return base;

  const next = {
    ...base,
    fulfillment: { ...base.fulfillment },
    dishes: base.dishes.map((dish) => ({ ...dish })),
  };

  for (const field of TEXT_FIELDS) {
    if (!hasOwn(incoming, field)) continue;
    const value = trimText(incoming[field]);
    // 空字符串不清值：模型没写就保留用户已填的内容。
    if (!value) continue;
    next[field] = field === 'businessHours' ? normalizeBusinessHoursText(value) : value;
  }

  if (isPlainObject(incoming.fulfillment)) {
    for (const flag of ['dineIn', 'takeaway']) {
      if (!hasOwn(incoming.fulfillment, flag)) continue;
      if (typeof incoming.fulfillment[flag] !== 'boolean') continue;
      next.fulfillment[flag] = incoming.fulfillment[flag];
    }
  }

  if (Array.isArray(incoming.dishes)) {
    const merged = next.dishes;
    const seenPatchKeys = new Set();
    for (const raw of incoming.dishes) {
      if (!isPlainObject(raw)) continue;
      const id = trimText(raw.id);
      const name = trimText(raw.name);
      const patchKey = id ? `id:${id}` : (name ? `name:${name}` : '');
      if (!patchKey) continue;
      if (seenPatchKeys.has(patchKey)) continue;
      seenPatchKeys.add(patchKey);

      // id 优先，其次精确 name；两者都不命中才算新菜。
      let index = id ? merged.findIndex((dish) => dish.id === id) : -1;
      if (index === -1 && name) index = merged.findIndex((dish) => dish.name === name);

      if (index === -1) {
        if (name && merged.some((dish) => dish.name === name)) continue;
        const dishId = id && !merged.some((dish) => dish.id === id) ? id : createDishId(merged);
        const priceCents = resolvePriceCents(raw);
        merged.push({
          id: dishId,
          name,
          priceCents: priceCents === undefined ? null : priceCents,
          priceText: priceCents === undefined ? trimText(raw.priceText) : formatCents(priceCents),
          description: trimText(raw.description),
        });
        continue;
      }

      const currentDish = merged[index];
      const updated = { ...currentDish };
      if (hasOwn(raw, 'name')) {
        const nextName = trimText(raw.name);
        if (nextName) updated.name = nextName;
      }
      if (hasOwn(raw, 'description')) {
        const nextDescription = trimText(raw.description);
        if (nextDescription) updated.description = nextDescription;
      }
      const priceCents = resolvePriceCents(raw);
      if (priceCents !== undefined) {
        updated.priceCents = priceCents;
        updated.priceText = formatCents(priceCents);
      }
      // 刻意不写 updated.id：模型改了名字或另给 id，客户端的菜品 id 保持不变。
      merged[index] = updated;
    }
    next.dishes = merged;
  }

  return normalizeAgentDraft(next);
}

export const AGENT_RUN_MERGE_STRATEGY = 'merge-by-id-then-name';
