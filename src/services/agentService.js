import { templates as catalogTemplates, matchTemplate } from '../domain/catalog.mjs';
import { STYLE_PRESETS } from '../domain/storeBrief.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hash(value) {
  return [...String(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 360, 0);
}

function placeholderImage(seed) {
  const hue = hash(seed);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue}, 30%, 92%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360}, 46%, 74%)"/></linearGradient></defs><rect width="640" height="420" rx="28" fill="url(#g)"/><circle cx="320" cy="168" r="74" fill="none" stroke="hsl(${hue}, 26%, 32%)" stroke-width="12"/><path d="M226 262c62 52 132 52 198 0" fill="none" stroke="hsl(${(hue + 20) % 360}, 34%, 30%)" stroke-width="12" stroke-linecap="round"/><circle cx="288" cy="154" r="10" fill="hsl(${hue}, 26%, 32%)"/><circle cx="352" cy="154" r="10" fill="hsl(${hue}, 26%, 32%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

export async function buildTemplateCandidates({ selectedFeatures = [], customPrompt = '' }) {
  await wait(1600);
  const match = matchTemplate(selectedFeatures);
  const ordered = [match.template, ...catalogTemplates.filter((template) => template.id !== match.template.id)];
  const trimmed = customPrompt.trim();
  return ordered.map((template, index) => ({
    ...template,
    score: index === 0 ? match.score : Math.max(58, match.score - index * 9),
    source: index === 0 ? '功能匹配' : '备选骨架',
    customized: Boolean(trimmed),
    note: index === 0 && trimmed ? `已并入定制要求：${trimmed.slice(0, 48)}` : template.summary,
  }));
}

export async function composePrompt({ store, styleId }) {
  await wait(700);
  const style = STYLE_PRESETS.find((item) => item.id === styleId) ?? STYLE_PRESETS[0];
  const type = store.type || '餐饮门店';
  const prompt = [
    `${store.name || '这家店'}，一家${type}。`,
    `${style.name}风格，${style.caption}。`,
    `画面以招牌与温暖灯光为焦点，使用木质质感与${style.colors[1]}点缀，突出${store.notes || '新鲜、亲切的日常感'}。`,
    '构图留白，适合作为小程序首页主视觉。',
  ].join('');
  return {
    prompt,
    tips: ['可以补充店内的代表色', '可以指出想突出的招牌菜', '可以说明想要的时段氛围（白天 / 夜晚）'],
  };
}

export async function revisePrompt({ base, feedback }) {
  await wait(600);
  return `${base} 补充要求：${feedback}`;
}

export async function generateImage({ prompt, seed = 1 }) {
  await wait(1400);
  return {
    dataUrl: placeholderImage(`${prompt}-${seed}`),
    provider: 'local-demo',
    note: '本地演示占位图；接入生图模型后由服务端返回真实图片。',
  };
}

export async function reviseImage({ prompt, seed = 2 }) {
  await wait(1100);
  return {
    dataUrl: placeholderImage(`${prompt}-${seed}-revise`),
    provider: 'local-demo',
    note: '已按你的意见重新生成（本地演示占位图）。',
  };
}