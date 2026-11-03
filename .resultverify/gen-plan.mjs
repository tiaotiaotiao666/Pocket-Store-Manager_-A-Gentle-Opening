// 临时验证脚本：确认「选主厨推荐 → Plan 带 poster-carousel → Composer 真的注入首页」。
// 仅用于本轮端到端核对，不进入产品代码。
import fs from 'node:fs';
import path from 'node:path';
import { buildPlanFromSession } from '../src/composition/planFromSession.mjs';

const outDir = path.resolve(process.argv[2] || '.resultverify');
fs.mkdirSync(outDir, { recursive: true });

const baseState = {
  store: { name: '松月食堂', type: '社区餐馆', address: '上海市示例路 8 号', phone: '13800000000' },
  features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'store-gallery'] },
  visual: { styleId: 'warm' },
  agentDraft: {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-14:00,17:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [{ name: '招牌暖锅', priceCents: 6800, description: '两人份' }],
  },
};

for (const templateId of ['warm-bistro', 'signature-kitchen']) {
  const state = { ...baseState, build: { selectedId: templateId } };
  const result = buildPlanFromSession(state);
  fs.writeFileSync(
    path.join(outDir, `plan-${templateId}.json`),
    JSON.stringify(result.plan, null, 2),
    'utf8',
  );
  console.log(JSON.stringify({
    templateId,
    recipeId: result.recipeId,
    recipeDisplayName: result.recipeDisplayName,
    planId: result.plan.planId,
    features: result.plan.features.map((f) => ({
      id: f.id,
      slots: f.slots.map((s) => ({ slotId: s.slotId, dataKey: s.dataKey, itemCount: (s.props.items || []).length })),
    })),
    warnings: result.warnings,
  }, null, 2));
}