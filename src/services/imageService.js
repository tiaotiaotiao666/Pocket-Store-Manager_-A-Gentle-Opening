const MODEL_ENDPOINT = import.meta.env.VITE_IMAGE_MODEL_ENDPOINT || '';

function hash(value) {
  return [...String(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 360, 0);
}

function localPlaceholder({ name, theme, seed }) {
  const hue = hash(`${name}-${theme}-${seed}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue}, 32%, 90%)"/><stop offset="1" stop-color="hsl(${(hue + 52) % 360}, 44%, 72%)"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="url(#g)"/><circle cx="256" cy="220" r="96" fill="none" stroke="hsl(${hue}, 28%, 30%)" stroke-width="15"/><path d="M164 318c55 45 115 45 184 0" fill="none" stroke="hsl(${(hue + 22) % 360}, 32%, 28%)" stroke-width="15" stroke-linecap="round"/><circle cx="221" cy="206" r="12" fill="hsl(${hue}, 28%, 30%)"/><circle cx="292" cy="206" r="12" fill="hsl(${hue}, 28%, 30%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

export async function generateIcon({ name, theme, seed = 1, referenceImages = [] }) {
  if (!MODEL_ENDPOINT) {
    await new Promise((resolve) => setTimeout(resolve, 420));
    return { dataUrl: localPlaceholder({ name, theme, seed }), provider: 'local-demo', disclaimer: '本地演示占位图。配置华为云或兼容模型后，生成请求会走安全的服务端适配器。' };
  }
  const response = await fetch(`${MODEL_ENDPOINT.replace(/\/$/, '')}/icons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, theme, seed, referenceImages }),
  });
  if (!response.ok) throw new Error('图标模型服务暂时不可用');
  const result = await response.json();
  if (!result.dataUrl) throw new Error('模型服务没有返回有效图片');
  return { dataUrl: result.dataUrl, provider: result.provider || 'cloud-model', disclaimer: result.disclaimer || '' };
}

export function hasCloudImageModel() { return Boolean(MODEL_ENDPOINT); }
