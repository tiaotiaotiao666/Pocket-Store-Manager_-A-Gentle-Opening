/**
 * B5：给打包产物补一份克制的内容安全策略（CSP）。
 *
 * 只在 `vite build` 阶段注入到 index.html；开发态（vite dev + HMR 注入内联脚本）
 * 不受影响，避免为了 CSP 反而给开发环境放开 `unsafe-eval`。
 *
 * 策略取舍：
 * - script-src 只允许自身打包产物，不允许内联脚本与 eval；
 * - style-src 允许 inline（React 组件里有内联 style，第三方库也会注入 <style>）；
 * - img/media 允许 data: 与 blob:（上传预览、海报缩略图都在本地合成）；
 * - connect-src 只放开本机后端（127.0.0.1 / localhost 任意端口），不放公网；
 * - 不让本页被当成插件宿主或表单目标（object-src / base-uri / form-action 收紧）。
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function injectCspMeta() {
  return {
    name: 'pocket-store-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}" />`;
      if (typeof html !== 'string') return html;
      if (html.includes('Content-Security-Policy')) return html;
      return html.replace(/<head>/i, (match) => `${match}\n    ${tag}`);
    },
  };
}
