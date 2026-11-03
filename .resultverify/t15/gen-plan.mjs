// T15 门禁 11 输入：用当前生产代码生成一份带 presentation 的 composition.v1 Plan。
// 仅写入系统临时目录（由 argv 指定），不修改仓库内任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { buildPlanFromSession } from '../../src/composition/planFromSession.mjs';

const outDir = path.resolve(process.argv[2] || '');
if (!outDir) {
  console.error('缺少输出目录参数');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const state = {
  store: { name: '松月食堂', type: '社区餐馆', address: '上海市示例路 8 号', phone: '13800000000' },
  features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'store-gallery'] },
  visual: { styleId: 'warm' },
  build: { selectedId: 'signature-kitchen' },
  presentation: {
    patch: {
      theme: { primaryColor: '#1F6F5C', accentColor: '#155E4B' },
      sizes: { homeHero: 'lg', productCard: 'sm', carousel: 'lg' },
      slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }],
    },
  },
  agentDraft: {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-14:00,17:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [{ name: '招牌暖锅', priceCents: 6800, description: '两人份' }],
  },
};

const result = buildPlanFromSession(state);
const planPath = path.join(outDir, 'plan.json');
fs.writeFileSync(planPath, JSON.stringify(result.plan, null, 2), 'utf8');
console.log(JSON.stringify({
  planPath,
  recipeId: result.recipeId,
  presentationTokens: result.plan.presentationTokens || null,
  slotOrder: result.plan.slotOrder || null,
  primaryColor: result.plan.themeTokens.primaryColor,
  posterSize: result.plan.features?.[0]?.slots?.[0]?.props?.size || null,
  warnings: result.warnings,
}, null, 2));