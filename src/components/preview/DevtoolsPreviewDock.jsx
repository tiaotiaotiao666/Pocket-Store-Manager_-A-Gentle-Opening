import { useEffect, useRef, useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';

import { devtoolsService } from '../../services/devtoolsService.js';
import {
  PREVIEW_DOCK_LABELS,
  buildDevtoolsConfigGuide,
  describeDevtoolsGate,
  describeLaunchFailure,
  describePreviewReadiness,
  describeProbeConfirmation,
} from '../../domain/devtoolsPreview.mjs';

const CONFIRM_DELAYS_MS = [0, 1600];

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default function DevtoolsPreviewDock({
  phase,
  storeName = '',
  onPrepareProject = null,
}) {
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [needsConfig, setNeedsConfig] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const readiness = describePreviewReadiness({ phase, storeName });

  function applyNotice(next) {
    if (aliveRef.current) setNotice(next);
  }

  function applyBusy(next) {
    if (aliveRef.current) setBusy(next);
  }

  function applyNeedsConfig(next) {
    if (aliveRef.current) setNeedsConfig(next);
  }

  function applyRechecking(next) {
    if (aliveRef.current) setRechecking(next);
  }

  async function confirmWindow() {
    let last = null;
    for (const delay of CONFIRM_DELAYS_MS) {
      if (delay) await wait(delay);
      last = await devtoolsService.probe();
      if (describeProbeConfirmation(last).visible) {
        return describeProbeConfirmation(last);
      }
    }
    return describeProbeConfirmation(last);
  }

  async function finishPipeline(outcome) {
    if (!outcome || outcome.ok !== true) {
      const failure = describeLaunchFailure(outcome);
      applyBusy(null);
      applyNotice({ tone: 'warn', text: failure.text });
      applyNeedsConfig(failure.needsConfig);
      return;
    }
    if (!outcome.path) {
      applyBusy(null);
      applyNotice({ tone: 'warn', text: '预览工程已生成，但没有返回工程路径，无法打开。' });
      return;
    }

    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || typeof api.openPreviewDevtools !== 'function') {
      applyBusy(null);
      applyNotice({ tone: 'warn', text: '桌面端未提供预览桥接，无法打开微信开发者工具。' });
      return;
    }

    if (outcome.opened !== true) {
      applyBusy('launching');
      applyNotice({ tone: 'info', text: '预览工程已生成，正在启动微信开发者工具…' });

      let opened;
      try {
        opened = await api.openPreviewDevtools({ projectPath: outcome.path });
      } catch (error) {
        applyBusy(null);
        applyNotice({
          tone: 'warn',
          text: `启动微信开发者工具失败：${(error && error.message) || '未知错误'}`,
        });
        return;
      }
      if (!opened || opened.ok !== true) {
        const failure = describeLaunchFailure(opened);
        applyBusy(null);
        applyNotice(failure);
        applyNeedsConfig(failure.needsConfig);
        return;
      }
    }

    applyBusy('confirming');
    applyNotice({ tone: 'info', text: '已发起启动请求，正在确认工具窗口…' });

    let confirmed;
    try {
      confirmed = await confirmWindow();
    } catch {
      confirmed = describeProbeConfirmation(null);
    }
    applyBusy(null);
    applyNotice(confirmed);
    applyNeedsConfig(false);
  }

  async function handleClick() {
    if (busy) return;
    applyNeedsConfig(false);

    if (readiness.hidden) return;
    if (readiness.blocked) {
      applyNotice({ tone: 'warn', text: readiness.reason });
      return;
    }

    const api = typeof window !== 'undefined' ? window.smartStore : null;
    if (!api || api.isDesktop !== true || typeof api.openPreviewDevtools !== 'function') {
      applyNotice({
        tone: 'warn',
        text: '微信小程序预览需要在桌面应用里进行：请用 npm run desktop:dev 启动桌面端后再点此按钮。',
      });
      return;
    }
    if (typeof onPrepareProject !== 'function') {
      applyNotice({ tone: 'warn', text: '当前界面没有接入预览准备能力，请重新打开桌面端。' });
      return;
    }

    applyBusy('generating');
    applyNotice({ tone: 'info', text: '正在按当前对话需求准备预览工程…' });

    let prepared;
    try {
      prepared = await onPrepareProject({
        onContinueResult: (outcome) => {
          void finishPipeline(outcome);
        },
      });
    } catch (error) {
      applyBusy(null);
      applyNotice({
        tone: 'warn',
        text: `准备预览工程失败：${(error && error.message) || '未知错误'}`,
      });
      return;
    }

    if (prepared && prepared.code === 'ENV_GUIDE_OPENED') {
      applyBusy(null);
      applyNotice({
        tone: 'info',
        text: `${prepared.message || '还没有检测到可用的小程序页面。'} 请逐条勾选并按「已准备就绪」，之后会自动继续生成并打开预览。`,
      });
      return;
    }

    if (!prepared || prepared.ok !== true) {
      const failure = describeLaunchFailure(prepared);
      applyBusy(null);
      applyNotice({ tone: 'warn', text: failure.text });
      applyNeedsConfig(failure.needsConfig);
      return;
    }

    await finishPipeline(prepared);
  }

  async function handleRecheck() {
    if (rechecking) return;
    applyRechecking(true);
    let probe;
    try {
      probe = await devtoolsService.probe();
    } catch {
      probe = { status: 'failed', found: false, running: false, projectOpen: false };
    }
    applyRechecking(false);

    const gate = describeDevtoolsGate(probe);
    if (gate.ready) {
      applyNeedsConfig(false);
      applyNotice({ tone: 'ok', text: '已检测到微信开发者工具，并已显示小程序页面。' });
      return;
    }
    if (probe.found && probe.running !== false) {
      applyNotice({ tone: 'info', text: gate.reason });
      return;
    }
    applyNotice({ tone: 'warn', text: gate.reason });
    applyNeedsConfig(gate.code === 'NOT_INSTALLED' || gate.code === 'PROBE_FAILED');
  }

  async function handleCopyGuide() {
    const guide = buildDevtoolsConfigGuide();
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      applyNotice({ tone: 'info', text: guide });
      return;
    }
    try {
      await navigator.clipboard.writeText(guide);
      applyNotice({ tone: 'ok', text: '安装与配置说明已复制，可粘贴到记事本按步骤操作。' });
    } catch {
      applyNotice({ tone: 'info', text: guide });
    }
  }

  const label = PREVIEW_DOCK_LABELS[busy] || PREVIEW_DOCK_LABELS.idle;
  const hint = readiness.blocked
    ? readiness.reason
    : '和「预览新模块」同一套检查：微信工具里没显示小程序页面时，会先让你逐条勾选清单。';

  if (readiness.hidden) return null;

  return (
    <div className="preview-dock" role="group" aria-label="微信开发者工具预览入口">
      <div className="preview-dock-main">
        <button
          type="button"
          className="preview-dock-btn"
          onClick={handleClick}
          disabled={Boolean(busy)}
          title="在微信开发者工具中打开当前项目的预览工程"
        >
          {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Monitor size={13} aria-hidden="true" />}
          <span>{label}</span>
        </button>
        <span className={`preview-dock-hint${readiness.blocked ? ' is-blocked' : ''}`}>{hint}</span>
      </div>
      {notice ? (
        <p className={`preview-dock-note is-${notice.tone}`} role="status" aria-live="polite">
          {notice.text}
        </p>
      ) : null}
      {needsConfig ? (
        <div className="preview-dock-config" role="group" aria-label="微信开发者工具配置">
          <p className="preview-dock-config-text">{buildDevtoolsConfigGuide()}</p>
          <div className="preview-dock-config-actions">
            <button type="button" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? '正在检测…' : '重新检测'}
            </button>
            <button type="button" onClick={handleCopyGuide}>复制安装与配置说明</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}