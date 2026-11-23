'use strict';

/**
 * T0：Electron 全局缩放（视图缩放）唯一实现。
 *
 * 背景：之前整个应用没有自建菜单，Ctrl+= / Ctrl+- / Ctrl+0 全靠 Electron 默认菜单的
 * zoomIn / zoomOut / resetZoom 角色。那套角色以 zoomLevel 步进、无上下限、且 Chromium 会把
 * 每个 host 的 zoomLevel 写进 Preferences；用户按几次 Ctrl+- 之后，界面就永久停在极小比例，
 * 重启也回不来（Ctrl++ 又因为键盘布局拿不到 '+' 而失效）。
 *
 * 现在的规则：
 * - 只有这里能改缩放，统一用 zoomFactor（不是 zoomLevel），步进 0.1、范围 50%–200%；
 * - Ctrl+- 缩小；Ctrl+= / Ctrl+Shift+= / 数字小键盘 Ctrl+Add 放大；Ctrl+0 立即回到 100%；
 * - 偏好写回 Chromium 的 per_host_zoom_levels，读取时逐项校验并钳制，
 *   非法/损坏/越界值一律落回安全范围，绝不把界面锁死在不可操作的比例。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM_FACTOR = 1;
/** zoomFactor 只用到两位小数，避免 0.1 步进的浮点误差累加。 */
const FACTOR_PRECISION = 2;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundFactor(value) {
  const factor = 10 ** FACTOR_PRECISION;
  return Math.round(value * factor) / factor;
}

function clampZoomFactor(value) {
  if (!isFiniteNumber(value)) return DEFAULT_ZOOM_FACTOR;
  return roundFactor(Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value)));
}

function nextZoomFactor(current, direction) {
  const base = clampZoomFactor(current);
  const next = roundFactor(base + direction * ZOOM_STEP);
  return clampZoomFactor(next);
}

/** Chromium 的 zoomLevel 与 zoomFactor 的换算（1.2 为 Chromium 固定底数）。 */
function zoomFactorFromLevel(level) {
  if (!isFiniteNumber(level)) return DEFAULT_ZOOM_FACTOR;
  return clampZoomFactor(Math.pow(1.2, level));
}

function zoomLevelFromFactor(factor) {
  return Math.log(clampZoomFactor(factor)) / Math.log(1.2);
}

/**
 * 判断一次键盘输入是不是缩放快捷键。
 *
 * 只认 keyDown、Ctrl、且不带 Alt/Meta：文本框里的普通输入、以及 Ctrl+C/V 之类全不受影响。
 * 放大必须同时覆盖 '='、'+'（Shift+= 的产物）和数字小键盘 Add，否则「Ctrl++ 无效」的老问题会复发。
 */
function classifyZoomShortcut(input) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.meta) return null;
  if (!input.control || typeof input.key !== 'string') return null;
  const key = input.key.toLowerCase();
  const code = typeof input.code === 'string' ? input.code : '';
  if (key === '-' || key === '_' || key === 'subtract' || code === 'NumpadSubtract') return 'out';
  if (key === '=' || key === '+' || key === 'add' || code === 'NumpadAdd') return 'in';
  if (key === '0' || code === 'Numpad0') return 'reset';
  return null;
}

const PREFERENCE_FILE = 'zoom-preference.json';

/**
 * 读取缩放偏好。优先读应用自己的 `zoom-preference.json`（唯一事实源），
 * 没有时再兼容历史遗留的 Chromium per_host_zoom_levels（只做钳制后参考）。
 * 任何异常都退回 100%，绝不返回越界值。
 */
function readPersistedZoomFactor(userDataDir) {
  try {
    const own = JSON.parse(fs.readFileSync(path.join(userDataDir, PREFERENCE_FILE), 'utf8'));
    if (own && typeof own === 'object' && isFiniteNumber(own.factor)) return clampZoomFactor(own.factor);
    return DEFAULT_ZOOM_FACTOR;
  } catch (error) {
    // 没有自己的偏好文件时才回落到 Chromium 的历史值。
  }
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Preferences'), 'utf8'));
    const levels = preferences && preferences.partition && preferences.partition.per_host_zoom_levels;
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) return DEFAULT_ZOOM_FACTOR;
    const hostLevels = Object.values(levels)
      .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
      .flatMap((value) => Object.values(value))
      .filter(isFiniteNumber);
    if (hostLevels.length === 0) return DEFAULT_ZOOM_FACTOR;
    return clampZoomFactor(Math.max(...hostLevels.map(zoomFactorFromLevel)));
  } catch (error) {
    return DEFAULT_ZOOM_FACTOR;
  }
}

function formatPercent(factor) {
  return `${Math.round(clampZoomFactor(factor) * 100)}%`;
}

function buildZoomMenuTemplate(factor, change) {
  return [
    { id: 'zoom-status', label: `当前缩放：${formatPercent(factor)}`, enabled: false },
    { type: 'separator' },
    { label: '放大', accelerator: 'CommandOrControl+=', click: () => change('in') },
    { label: '放大（Shift + =）', accelerator: 'CommandOrControl+Shift+=', click: () => change('in'), visible: false, acceleratorWorksWhenHidden: true },
    { label: '放大（数字小键盘）', accelerator: 'CommandOrControl+numadd', click: () => change('in'), visible: false, acceleratorWorksWhenHidden: true },
    { label: '缩小', accelerator: 'CommandOrControl+-', click: () => change('out') },
    { label: '缩小（数字小键盘）', accelerator: 'CommandOrControl+numsub', click: () => change('out'), visible: false, acceleratorWorksWhenHidden: true },
    { label: '实际大小（100%）', accelerator: 'CommandOrControl+0', click: () => change('reset') },
  ];
}

function createZoomMenu({ webContents, onChange }) {
  const change = (direction) => {
    const previous = webContents.getZoomFactor();
    const factor = direction === 'reset'
      ? DEFAULT_ZOOM_FACTOR
      : nextZoomFactor(previous, direction === 'in' ? 1 : -1);
    if (factor === previous) return factor;
    webContents.setZoomFactor(factor);
    onChange({ factor, previous, direction });
    return factor;
  };
  // 缩放也可能来自滚轮或系统手势：不叠加步进，只把当前值拉回安全范围并记录。
  const sync = () => {
    const current = webContents.getZoomFactor();
    const factor = clampZoomFactor(current);
    if (factor !== current) webContents.setZoomFactor(factor);
    onChange({ factor, previous: current, direction: 'sync' });
    return factor;
  };
  return {
    change,
    sync,
    template: buildZoomMenuTemplate(webContents.getZoomFactor(), change),
  };
}

/**
 * 顺手把缩放写进 Chromium 的 per_host_zoom_levels，让下次加载在 did-finish-load 之前也不会闪回旧值。
 * 这只是尽力而为的镜像：Chromium 退出时可能覆盖它，所以读的时候以 zoom-preference.json 为准。
 */
function mirrorToChromiumPreferences(userDataDir, factor, logger) {
  try {
    const preferencesPath = path.join(userDataDir, 'Preferences');
    const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return;
    const partition = preferences.partition || (preferences.partition = {});
    const levels = partition.per_host_zoom_levels || (partition.per_host_zoom_levels = {});
    if (clampZoomFactor(factor) === DEFAULT_ZOOM_FACTOR) {
      for (const [partitionKey, hosts] of Object.entries(levels)) {
        if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) continue;
        delete hosts['127.0.0.1'];
        delete hosts.localhost;
        if (Object.keys(hosts).length === 0) delete levels[partitionKey];
      }
    } else {
      const defaultPartition = levels[''] || (levels[''] = {});
      defaultPartition['127.0.0.1'] = zoomLevelFromFactor(factor);
      defaultPartition.localhost = zoomLevelFromFactor(factor);
    }
    const temporaryPath = `${preferencesPath}.zoom-tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(preferences), 'utf8');
    fs.renameSync(temporaryPath, preferencesPath);
  } catch (error) {
    logger.warn('[zoom] Chromium 缩放镜像写入跳过；真实比例仍以 zoom-preference.json 为准');
  }
}

function registerWindowZoom(window, { userDataDir, onZoomChange = () => {}, logger = console }) {
  const initialFactor = readPersistedZoomFactor(userDataDir);
  let pendingFactor = null;
  let persistTimer = null;

  const persist = () => {
    if (pendingFactor === null) return;
    const factor = pendingFactor;
    pendingFactor = null;
    // 唯一事实源：应用自己的偏好文件。Chromium 退出时可能重写 Preferences，
    // 所以不能把 Chromium 的文件当作持久化依据。
    try {
      const preferencePath = path.join(userDataDir, PREFERENCE_FILE);
      const temporaryPath = `${preferencePath}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryPath, JSON.stringify({ factor }), 'utf8');
      fs.renameSync(temporaryPath, preferencePath);
    } catch (error) {
      // 保存失败不影响可用性：Ctrl+0 永远能回到 100%。
      logger.warn('[zoom] 缩放偏好保存失败；Ctrl+0 仍可恢复 100%');
    }
    mirrorToChromiumPreferences(userDataDir, factor, logger);
  };

  const queuePersist = (factor) => {
    pendingFactor = clampZoomFactor(factor);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 250);
  };

  let zoomMenu = null;

  const setInitialZoom = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.setZoomFactor(initialFactor);
    onZoomChange(initialFactor);
  };

  zoomMenu = createZoomMenu({
    webContents: window.webContents,
    onChange: ({ factor }) => { queuePersist(factor); onZoomChange(factor); },
  });
  const buildTemplate = (factor) => buildZoomMenuTemplate(factor, zoomMenu.change);

  window.webContents.on('did-finish-load', setInitialZoom);
  window.webContents.on('before-input-event', (event, input) => {
    const action = classifyZoomShortcut(input);
    if (!action) return;
    event.preventDefault();
    zoomMenu.change(action);
  });
  window.webContents.on('zoom-changed', () => { zoomMenu.sync(); });
  window.on('closed', () => { clearTimeout(persistTimer); persist(); });

  return {
    menuTemplate: buildTemplate(initialFactor),
    buildTemplate,
    initialFactor,
    change: zoomMenu.change,
    sync: zoomMenu.sync,
  };
}

module.exports = {
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  ZOOM_STEP,
  DEFAULT_ZOOM_FACTOR,
  PREFERENCE_FILE,
  clampZoomFactor,
  nextZoomFactor,
  zoomFactorFromLevel,
  zoomLevelFromFactor,
  classifyZoomShortcut,
  readPersistedZoomFactor,
  formatPercent,
  buildZoomMenuTemplate,
  createZoomMenu,
  registerWindowZoom,
};
