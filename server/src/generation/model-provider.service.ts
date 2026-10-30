import { Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

type ProviderConfig = { baseUrl: string; apiKey: string; imageModel: string; visionModel: string; timeoutMs: number };

const supportedTemplates = new Set(['warm-bistro', 'modern-coffee', 'signature-kitchen']);
const supportedThemes = new Set(['citrus', 'jade', 'cherry', 'ink']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 5;
const ALLOWED_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i;

function getProviderConfig(): ProviderConfig {
  return {
    baseUrl: (process.env.IMAGE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.IMAGE_API_KEY || '',
    imageModel: process.env.IMAGE_MODEL_NAME || '',
    visionModel: process.env.VISION_MODEL_NAME || process.env.IMAGE_MODEL_NAME || '',
    timeoutMs: Math.min(90_000, Math.max(5000, Number(process.env.IMAGE_API_TIMEOUT_MS || 60_000))),
  };
}

@Injectable()
export class ModelProviderService {
  status() {
    const config = getProviderConfig();
    return {
      provider: process.env.IMAGE_PROVIDER_NAME || 'not-configured',
      configured: Boolean(config.baseUrl && config.apiKey),
      imageModel: Boolean(config.baseUrl && config.apiKey && config.imageModel),
      visionModel: Boolean(config.baseUrl && config.apiKey && config.visionModel),
      disclaimer: '图像请求需要可访问的模型端点与密钥。华为云接入只会在配置的端点通过实际 API 检查后显示已配置状态。',
    };
  }

  async generateIcon(input: { name?: string; theme?: string; seed?: number; referenceImages?: string[] }) {
    if (!input.name?.trim()) throw new UnprocessableEntityException({ code: 'ICON_NAME_REQUIRED', message: '请提供要生成的页面图标名称。' });
    if (!input.theme?.trim()) throw new UnprocessableEntityException({ code: 'THEME_REQUIRED', message: '请提供所选视觉风格。' });
    const config = this.requireProvider('image');
    const references = this.readImageReferences(input.referenceImages);
    const prompt = this.buildIconPrompt(input.name.trim(), input.theme.trim(), input.seed);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let response: Response;
      if (references.length) {
        const form = new FormData();
        form.append('model', config.imageModel);
        form.append('prompt', prompt);
        form.append('size', '512x512');
        form.append('response_format', 'b64_json');
        for (const reference of references) form.append('image[]', new Blob([reference.data], { type: reference.mimeType }), reference.fileName);
        response = await fetch(`${config.baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, signal: controller.signal });
      } else {
        response = await fetch(`${config.baseUrl}/images/generations`, {
          method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.imageModel, prompt, size: '512x512', n: 1, response_format: 'b64_json' }),
        });
      }
      const payload = await this.readResponse(response);
      if (!response.ok) throw new ServiceUnavailableException({ code: 'IMAGE_PROVIDER_FAILED', message: '图像模型请求失败。请检查模型服务配置和服务端日志。' });
      const image = payload?.data?.[0]?.b64_json;
      if (typeof image !== 'string' || image.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new ServiceUnavailableException({ code: 'IMAGE_RESPONSE_INVALID', message: '图像模型没有返回大小合适的 PNG 图片。' });
      return { dataUrl: `data:image/png;base64,${image}`, provider: process.env.IMAGE_PROVIDER_NAME || 'configured-image-api', disclaimer: '该图像由已配置的图像模型生成。' };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({ code: 'IMAGE_PROVIDER_UNAVAILABLE', message: '图像模型暂时不可访问，请稍后重试。' });
    } finally { clearTimeout(timer); }
  }

  async recommendStyle(input: { storeName?: string; storeType?: string; notes?: string; referenceImages?: string[] }) {
    const config = this.requireProvider('vision');
    const references = this.readImageReferences(input.referenceImages);
    if (!references.length) throw new UnprocessableEntityException({ code: 'STYLE_REFERENCE_REQUIRED', message: '云端视觉分析需要至少一张门店图片。' });
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: `分析餐饮门店的品牌视觉，推荐一个已有的小程序页面模板。门店名称：${String(input.storeName || '').slice(0, 48)}；类别：${String(input.storeType || '餐饮').slice(0, 48)}；介绍：${String(input.notes || '').slice(0, 400)}。仅能返回下列 JSON 格式，不要返回 Markdown：{"templateId":"warm-bistro|modern-coffee|signature-kitchen","reason":"简短的中文图片观察与适配理由"}。选择依据是照片真实呈现的空间、商品、光线和陈列。不要推断未拍到的信息；照片不足以判断时说明原因，并推荐最稳妥的默认模板。` }];
    for (const reference of references) content.push({ type: 'image_url', image_url: { url: `data:${reference.mimeType};base64,${reference.data.toString('base64')}`, detail: 'low' } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.visionModel, temperature: 0.2, max_tokens: 320, messages: [{ role: 'user', content }] }),
      });
      const payload = await this.readResponse(response);
      if (!response.ok) throw new ServiceUnavailableException({ code: 'VISION_PROVIDER_FAILED', message: '视觉模型请求失败。请检查模型服务配置。' });
      const reply = payload?.choices?.[0]?.message?.content;
      const text = typeof reply === 'string' ? reply : Array.isArray(reply) ? reply.map((item: { text?: string }) => item.text || '').join('\n') : '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end < start) throw new ServiceUnavailableException({ code: 'VISION_RESPONSE_INVALID', message: '视觉模型未返回有效的模板建议。' });
      const answer = JSON.parse(text.slice(start, end + 1)) as { templateId?: string; reason?: string };
      if (!answer.templateId || !supportedTemplates.has(answer.templateId)) throw new ServiceUnavailableException({ code: 'VISION_TEMPLATE_INVALID', message: '视觉模型推荐的模板不在当前已验证模板列表中。' });
      return { templateId: answer.templateId, reason: String(answer.reason || '根据门店资料提出建议。').slice(0, 400), disclaimer: '这是模型建议，不会直接修改已选功能或生成代码。' };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({ code: 'VISION_PROVIDER_UNAVAILABLE', message: '视觉模型暂时不可访问，请稍后重试。' });
    } finally { clearTimeout(timer); }
  }

  private requireProvider(capability: 'image' | 'vision'): ProviderConfig {
    const config = getProviderConfig();
    const available = config.baseUrl && config.apiKey && (capability === 'image' ? config.imageModel : config.visionModel);
    if (!available) throw new ServiceUnavailableException({ code: 'MODEL_PROVIDER_NOT_CONFIGURED', message: `未配置可用的${capability === 'image' ? '图像生成' : '图片分析'}模型，请检查服务端模型环境变量。` });
    try { new URL(config.baseUrl); } catch { throw new ServiceUnavailableException({ code: 'MODEL_PROVIDER_URL_INVALID', message: '服务端模型 API 地址格式无效。' }); }
    return config;
  }

  private readImageReferences(inputs?: string[]) {
    if (!inputs) return [];
    if (!Array.isArray(inputs) || inputs.length > MAX_REFERENCES) throw new UnprocessableEntityException({ code: 'REFERENCE_LIMIT_EXCEEDED', message: '最多可以上传 5 张图片。' });
    return inputs.map((value) => {
      if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES * 2) throw new UnprocessableEntityException({ code: 'REFERENCE_IMAGE_TOO_LARGE', message: '图片应小于 5 MB。' });
      const match = ALLOWED_IMAGE.exec(value);
      if (!match) throw new UnprocessableEntityException({ code: 'REFERENCE_IMAGE_INVALID', message: '只支持 PNG、JPEG、WebP 图片。' });
      const data = Buffer.from(match[1], 'base64');
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new UnprocessableEntityException({ code: 'REFERENCE_IMAGE_TOO_LARGE', message: '每张图片应为 1 byte 至 5 MB。' });
      const subtype = value.slice(11, value.indexOf(';')).toLowerCase();
      const mimeType = subtype === 'jpg' ? 'jpeg' : subtype;
      return { data, mimeType: `image/${mimeType}`, fileName: `store-reference.${mimeType}` };
    });
  }

  private buildIconPrompt(name: string, theme: string, seed?: number) {
    const variation = Number.isInteger(seed) ? ` Variation seed: ${seed}.` : '';
    return `Create one minimalist, elegant WeChat mini-program navigation icon for a restaurant. Page label: “${name}”. Visual theme: “${theme}”. Draw one centered, clearly recognizable pictographic object; consistent handcrafted editorial illustration, restrained Chinese restaurant branding, crisp edges, generous negative space, warm paper palette, legible at 81x81 pixels. Square 1:1 canvas. No text, no letters, no words, no border, no device mockup, no surrounding scene. Produce only the asset for this named page. Every navigation icon in this set should share the same visual style; make this icon distinct through its silhouette and one theme accent. Variation seed: ${seed ?? 1}.${variation}`.slice(0, 1200);
  }

  private async readResponse(response: Response): Promise<Record<string, any>> {
    const text = await response.text();
    try { return text ? JSON.parse(text) as Record<string, any> : {}; }
    catch { return {}; }
  }
}
