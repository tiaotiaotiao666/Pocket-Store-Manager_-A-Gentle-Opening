import { describe, expect, it } from 'vitest';
import { STORE_SETUP_SYSTEM_PROMPT } from '../src/agent/store-setup/store-setup.prompt';
import {
  DEEPSEEK_SYSTEM_PROMPT,
  DEEPSEEK_VISION_PROMPT_ADDENDUM,
} from '../src/agent/provider/deepseek-agent.provider';

/**
 * 把「资料代拟」的边界钉在提示词上。
 *
 * 背景：旧提示词用一句兜底话术 `只把本轮用户明确提供的信息…写入`，
 * 把可选的 dishes[].description 也一起管死了，真实模型会以
 * “需要您提供具体文案，我不能替您编写”拒绝写介绍——而校验器里
 * description 根本不是缺项，所以这是措辞事故，不是产品要求。
 *
 * 现在的边界：
 * - 事实字段（店名/品类/营业时间/取餐方式/菜名/价格）默认只认用户输入；
 * - 用户明确授权代拟（“随便填”“你定”“给点建议”）时，可代填菜名与价格，但必须标为建议值；
 * - description 可直接代写，但受绝对化/功效性用语约束。
 */
describe('开店资料提示词：代拟边界', () => {
  it('不再使用会把 description 一起管死的兜底话术', () => {
    expect(STORE_SETUP_SYSTEM_PROMPT).not.toContain('只把本轮用户明确提供的信息');
  });

  it('事实字段默认仍只认用户输入', () => {
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('默认只能来自用户本轮明确提供的内容');
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('用户没说就不要猜，改为追问');
  });

  it('用户明确授权代拟时允许代填菜名与价格，并要求标注建议值', () => {
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('明确授权你代拟');
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('建议值');
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('请核对后修改');
    // 未获授权时必须回到追问，不能默认代拟。
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('未获授权时一律回到追问');
  });

  it('description 可直接代写，但封死绝对化与功效性用语', () => {
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('description 是可选营销文案');
    for (const banned of ['最', '第一', '纯天然', '零添加', '养生', '治疗']) {
      expect(STORE_SETUP_SYSTEM_PROMPT).toContain(banned);
    }
    // 缺介绍不能阻塞资料确认。
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('缺介绍不算资料不全');
  });

  it('代拟的内容必须在回复里点明是建议值', () => {
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('凡是代拟的菜名、价格或介绍');
    expect(STORE_SETUP_SYSTEM_PROMPT).toContain('必须点明是建议值');
  });

  it('turn 通道（含视觉）与 run 通道保持同一套边界', () => {
    // 保留原有的硬约束原文，避免两条通道行为分叉。
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('不得臆造价格、营业时间、菜品或取餐方式');
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('明确授权你代拟');
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('description 可以代写');
    expect(DEEPSEEK_SYSTEM_PROMPT).toContain('纯天然');

    // 视觉路径仍不得从环境照推断菜品与价格（这条不能被代拟例外放宽）。
    expect(DEEPSEEK_VISION_PROMPT_ADDENDUM).toContain('不要从中抽取任何菜品或价格');
  });
});
