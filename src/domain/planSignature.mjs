/**
 * 导出签名的纯函数实现（B4 规则 6）。
 *
 * 目的只有一个：让「体检结果」和「最终生成内容确认」绑定到**当前这一份** Plan 与目标位置。
 * 用户改了菜品、营业时间、模板、素材或目标目录之后，签名就变了，旧的体检结果与旧确认
 * 必须立刻失效，而不是继续显示「可以导出」。
 *
 * 这里刻意不引入加密库：签名只用于本机状态失效判定，不承担防篡改职责。
 * 真正的内容摘要由 Composer 的 `planDigest`（sha256）负责，两者互不替代。
 */

/** 稳定序列化：对象键排序，保证同一语义的输入得到同一字符串。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys
    .filter((key) => value[key] !== undefined)
    .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
    .join(',') + '}';
}

/** FNV-1a 双通道 32 位散列 → 16 位十六进制，足够区分本机会话内的两次资料状态。 */
function hashText(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + code + ((b << 5) >>> 0)) >>> 0;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * 导出相关状态的签名：Plan 内容 + 海报素材 + 目标位置。
 *
 * @param {{plan?: object|null, posterAssetId?: string|null, directory?: string|null, projectName?: string|null}} input
 * @returns {string} 形如 `export:1f2e3d4c`；缺 Plan 时返回固定文案，调用方据此判为「不可导出」。
 */
export function buildExportSignature(input) {
  const source = input || {};
  if (!source.plan || typeof source.plan !== 'object') return 'export:none';
  const payload = {
    version: 'b4-export-signature.v1',
    plan: source.plan,
    posterAssetId: source.posterAssetId || null,
    directory: String(source.directory || '').trim(),
    projectName: String(source.projectName || '').trim(),
  };
  return 'export:' + hashText(stableStringify(payload));
}

/**
 * 只给界面用的人话差异说明：签名不一致时告诉用户「哪一类内容变了」。
 *
 * @param {{planSignature?: string|null, targetSignature?: string|null}} previous
 * @param {{planSignature?: string|null, targetSignature?: string|null}} current
 * @returns {string|null} 人类可读的原因；一致时返回 null。
 */
export function describeSignatureDrift(previous, current) {
  const before = previous || {};
  const after = current || {};
  const planChanged = Boolean(before.planSignature) && before.planSignature !== after.planSignature;
  const targetChanged = Boolean(before.targetSignature) && before.targetSignature !== after.targetSignature;
  if (planChanged && targetChanged) return '店铺资料、模板或导出位置发生了变化';
  if (planChanged) return '店铺资料、模板或素材发生了变化';
  if (targetChanged) return '导出位置或项目名发生了变化';
  return null;
}

/** 计划签名 / 目标签名分别计算，便于界面判断是哪一类变了。 */
export function buildSignatureParts(input) {
  const source = input || {};
  const planSignature = source.plan && typeof source.plan === 'object'
    ? 'plan:' + hashText(stableStringify({ version: 'b4-plan.v1', plan: source.plan, posterAssetId: source.posterAssetId || null }))
    : 'plan:none';
  const targetSignature = 'target:' + hashText(stableStringify({
    version: 'b4-target.v1',
    directory: String(source.directory || '').trim(),
    projectName: String(source.projectName || '').trim(),
  }));
  return {
    planSignature,
    targetSignature,
    signature: buildExportSignature(source),
  };
}
