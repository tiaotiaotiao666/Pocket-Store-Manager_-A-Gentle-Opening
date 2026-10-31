/**
 * 微信开发者工具探测服务。
 * 只做只读探测与「打开安装目录」；不自动拉起工具、不注入项目。
 */

const INSTALL_GUIDE = '微信开发者工具官方下载：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html';

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  return api && api.isDesktop ? api : null;
}

export function createDevtoolsService() {
  const mode = bridge() ? 'desktop' : 'browser';

  async function probe() {
    const api = bridge();
    if (mode !== 'desktop' || !api || typeof api.probeDevtools !== 'function') {
      return { status: 'desktop-required', found: false, via: 'none', message: '需在桌面应用中探测开发者工具' };
    }
    const result = await api.probeDevtools();
    if (!result || result.ok !== true) {
      return { status: 'failed', found: false, via: 'none', message: result?.message || '探测失败' };
    }
    return { status: 'ok', found: Boolean(result.data?.found), path: result.data?.path || null, via: result.data?.via || 'none' };
  }

  function installGuide() {
    return INSTALL_GUIDE;
  }

  async function copyGuide() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(INSTALL_GUIDE);
      return true;
    } catch (error) {
      return false;
    }
  }

  return { mode, probe, installGuide, copyGuide };
}

export const devtoolsService = createDevtoolsService();
export { INSTALL_GUIDE };