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
      return { status: 'desktop-required', found: false, running: false, via: 'none', message: '需在桌面应用中探测开发者工具' };
    }
    let result;
    try {
      result = await api.probeDevtools();
    } catch (error) {
      // IPC 本身失败也是「检测失败」，不能抛出：抛出会让上层环境清单永远停在「检测中」。
      return {
        status: 'failed',
        found: false,
        running: false,
        via: 'none',
        message: (error && error.message) || '探测通道失败',
      };
    }
    if (!result || result.ok !== true) {
      return { status: 'failed', found: false, running: false, via: 'none', message: result?.message || '探测失败' };
    }
    // 探测本身抛错时主进程会带 status:'failed'：这是「检测失败」，不是「没安装」。
    if (result.data?.status === 'failed') {
      return {
        status: 'failed',
        found: false,
        running: false,
        via: 'none',
        message: result.data?.error || '探测失败',
      };
    }
    return {
      status: 'ok',
      found: Boolean(result.data?.found),
      running: Boolean(result.data?.found) && result.data?.running !== false,
      projectOpen: Boolean(result.data?.found) && result.data?.projectOpen === true,
      windowTitle: result.data?.windowTitle || '',
      path: result.data?.path || null,
      via: result.data?.via || 'none',
    };
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