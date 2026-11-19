import { PHASES } from '../state/constants.mjs';

export const PREVIEW_DOCK_LABELS = Object.freeze({
  idle: '使用微信开发者工具预览',
  generating: '正在准备预览工程…',
  launching: '正在启动微信开发者工具…',
  confirming: '正在确认工具窗口…',
});

const BLOCKED_REASONS = Object.freeze({
  [PHASES.ONBOARDING]: '还没有给小程序命名，先输入名字并开始，才能生成预览工程。',
  [PHASES.FEATURES]: '还没有生成页面骨架，先确认能力并完成构建，才能预览。',
  [PHASES.BUILDING]: '小程序正在构建中，构建完成后就能预览。',
});

const LAUNCH_FAILURE_TEXT = Object.freeze({
  DEVTOOLS_NOT_FOUND: '未找到微信开发者工具（cli.bat）。请先安装，或设置环境变量 WX_CLI_PATH 指向 cli.bat 后重启桌面端。',
  APPID_NOT_APPLIED: '预览工程仍是测试号 AppID，微信开发者工具不接受。请重新生成预览工程；若仍失败，先在交接步骤写入正式 AppID。',
  APPID_INVALID: '工程里的 AppID 格式不正确，无法打开。请检查项目 AppID 后重新生成预览工程。',
  OUTPUT_NOT_COMPOSER: '当前工程不是由本应用生成的小程序工程，无法直接打开。请按当前需求重新生成预览工程。',
  OUTPUT_VERIFY_FAILED: '预览工程的输出校验没有通过，为避免打开不完整工程，已停止启动。请重新生成。',
  PATH_MISSING: '预览工程目录已不存在，请重新生成预览工程。',
  PATH_INVALID: '预览工程路径不可用，请重新生成预览工程。',
  SERVICE_PORT_DISABLED: '微信开发者工具的服务端口没有开启。请到「设置 → 安全设置」打开服务端口后重试。',
  NOT_LOGGED_IN: '微信开发者工具还没有登录。请先在工具里扫码登录后重试。',
  DESKTOP_REQUIRED: '微信小程序预览需要在桌面应用中进行。',
});

const CONFIG_GUIDE = [
  '微信开发者工具配置：',
  '1. 安装微信开发者工具：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html',
  '2. 打开工具后扫码登录，并在「设置 → 安全设置」里开启服务端口。',
  '3. 工具目录下应有 cli.bat；如果不在默认目录，请设置环境变量 WX_CLI_PATH 指向该文件，然后重启桌面端。',
  '4. 「设置 → 代理设置」选择「不使用代理」，并在「详情 → 本地设置」勾选「不校验合法域名」。',
].join('\n');

export function describePreviewReadiness({ phase, storeName = '' } = {}) {
  if (!phase || phase === PHASES.HOME) {
    return { hidden: true, blocked: false, reason: '' };
  }
  if (BLOCKED_REASONS[phase]) {
    return { hidden: false, blocked: true, reason: BLOCKED_REASONS[phase] };
  }
  if (typeof storeName !== 'string' || !storeName.trim()) {
    return { hidden: false, blocked: true, reason: '还没有可预览的项目，先完成项目命名与门店资料。' };
  }
  return { hidden: false, blocked: false, reason: '' };
}

export function describeDevtoolsGate(probe) {
  if (!probe || probe.status === 'desktop-required') {
    return { ready: false, code: 'DESKTOP_REQUIRED', reason: '微信小程序预览需要在桌面应用中运行。' };
  }
  if (probe.status === 'failed') {
    return {
      ready: false,
      code: 'PROBE_FAILED',
      reason: '没能检测到微信开发者工具状态，请点「重新检测」，或在工具里打开小程序页面后再试。',
    };
  }
  if (!probe.found) {
    return { ready: false, code: 'NOT_INSTALLED', reason: '未检测到微信开发者工具。' };
  }
  if (probe.running === false) {
    return { ready: false, code: 'NOT_RUNNING', reason: '微信开发者工具还没有启动。' };
  }
  if (probe.projectOpen !== true) {
    return {
      ready: false,
      code: 'NO_PROJECT',
      reason: '微信开发者工具已启动，但还没有打开小程序页面。',
    };
  }
  return { ready: true, code: null, reason: '' };
}

export function describeProbeConfirmation(probe) {
  if (!probe || probe.status === 'desktop-required') {
    return {
      visible: false,
      running: false,
      tone: 'warn',
      text: '未能在桌面应用中确认微信开发者工具状态。',
    };
  }
  if (probe.projectOpen === true) {
    return {
      visible: true,
      running: true,
      tone: 'ok',
      text: '微信开发者工具已打开，并已显示小程序页面。',
    };
  }
  if (probe.running === true) {
    return {
      visible: false,
      running: true,
      tone: 'info',
      text: '微信开发者工具已启动。如果窗口里还没显示小程序页面，请稍等或在工具里点一次「编译」（Ctrl+B）。',
    };
  }
  return {
    visible: false,
    running: false,
    tone: 'info',
    text: '已发起打开请求，但暂时没有确认到微信开发者工具窗口。请查看任务栏，或点「重新检测」。',
  };
}

export function describeLaunchFailure(result) {
  const code = result && typeof result.code === 'string' ? result.code : null;
  const raw = result && typeof result.message === 'string' ? result.message.trim() : '';
  const text = LAUNCH_FAILURE_TEXT[code] || raw || '未能启动微信开发者工具，请稍后重试。';
  const needsConfig = code === 'DEVTOOLS_NOT_FOUND'
    || /WX_CLI_PATH|cli\.bat|未找到微信开发者工具/.test(text);
  return { code, tone: 'warn', text, needsConfig };
}

export function buildDevtoolsConfigGuide() {
  return CONFIG_GUIDE;
}