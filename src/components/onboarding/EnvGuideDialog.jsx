import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Copy,
  Loader2,
  RefreshCw,
  Smartphone,
  XCircle,
} from 'lucide-react';

const STATUS_META = {
  pass: { icon: CheckCircle2, label: '已就绪', tone: 'pass' },
  warn: { icon: AlertTriangle, label: '需准备', tone: 'warn' },
  fail: { icon: XCircle, label: '未就绪', tone: 'fail' },
  manual: { icon: CircleHelp, label: '请确认', tone: 'manual' },
  checking: { icon: Loader2, label: '检测中', tone: 'checking' },
};

/**
 * 首次使用 / 关键步骤前的环境引导。
 *
 * 只做展示与按钮事件，检测逻辑由调用方提供；不自动安装、不注入工程。
 * 风格沿用应用统一的白卡片、圆角与状态色。
 */
const PREVIEW_STEPS = [
  {
    title: '安装微信开发者工具',
    body: '打开官方下载页 developers.weixin.qq.com/miniprogram/dev/devtools/download.html，安装 Windows 64 位稳定版，并至少启动一次。',
  },
  {
    title: '扫码登录',
    body: '在开发者工具右上角用微信扫码登录。未登录时命令行无法打开工程，也会影响真机预览。',
  },
  {
    title: '开启服务端口',
    body: '设置 → 安全设置 → 打开「服务端口」。这是命令行调起开发者工具的前提。',
  },
  {
    title: '代理设为不使用代理',
    body: '设置 → 代理设置 → 选择「不使用代理」，避免本地 127.0.0.1 请求被系统代理拦截。',
  },
  {
    title: '勾选不校验合法域名',
    body: '详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。',
  },
  {
    title: '确认本地后端与数据库',
    body: '后端 3000 与 MySQL 3306 必须在运行；MySQL 未启动时页面会显示数据库不可用。',
  },
];

const PREVIEW_CHECKS = [
  {
    id: 'install',
    title: '已安装微信开发者工具',
    body: '官方下载并安装 Windows 64 位稳定版，安装后至少启动过一次。',
  },
  {
    id: 'login',
    title: '已扫码登录',
    body: '在开发者工具右上角用微信扫码登录。未登录时命令行无法打开工程。',
  },
  {
    id: 'port',
    title: '已开启服务端口',
    body: '设置 → 安全设置 → 打开「服务端口」。',
  },
  {
    id: 'proxy',
    title: '代理设为不使用代理',
    body: '设置 → 代理设置 → 选择「不使用代理」，避免本地请求被代理拦截。',
  },
  {
    id: 'domain',
    title: '已勾选不校验合法域名',
    body: '详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。',
  },
];

export default function EnvGuideDialog({
  open = false,
  mode = 'first-run',
  deploymentMode = 'local',
  checks = [],
  busy = false,
  onRefresh,
  onStart,
  onSkip,
  onCopyGuide,
}) {
  const [checked, setChecked] = useState({});

  useEffect(() => {
    if (!open) setChecked({});
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onSkip?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onSkip]);

  if (!open) return null;

  const isFirstRun = mode === 'first-run';
  const isPreviewMode = mode === 'preview';
  const allChecked = PREVIEW_CHECKS.every((item) => checked[item.id]);
  const isCloud = deploymentMode === 'cloud';
  const list = Array.isArray(checks) ? checks : [];
  const serverChecks = list.filter((item) => item.group !== 'local');
  const localChecks = list.filter((item) => item.group === 'local');
  const steps = isCloud
    ? PREVIEW_STEPS.map((step) => (
      step.title === '确认本地后端与数据库'
        ? {
          title: '云端服务由部署方维护',
          body: '云端后端或数据库不可达时，请联系部署方或检查云端 health；本地无需启动 MySQL。',
        }
        : step
    ))
    : PREVIEW_STEPS;

  const renderCheck = (item) => {
    const meta = STATUS_META[item.status] || STATUS_META.manual;
    const Icon = meta.icon;
    return (
      <div className={`env-guide-check is-${meta.tone}`} key={item.id}>
        <span className="env-guide-check-icon">
          <Icon size={16} className={item.status === 'checking' ? 'spin' : undefined} />
        </span>
        <div className="env-guide-check-body">
          <div className="env-guide-check-title">
            <b>{item.title}</b>
            <em>{meta.label}</em>
          </div>
          {item.detail ? <p>{item.detail}</p> : null}
        </div>
      </div>
    );
  };

  return (
    <div className="env-guide-backdrop" role="presentation">
      <div className="env-guide-card" role="dialog" aria-modal="true" aria-label="环境准备">
        <header className="env-guide-head">
          <span className="env-guide-icon">
            <Smartphone size={18} />
          </span>
          <div>
            <h2>{isPreviewMode ? '预览前，逐条确认微信工具' : (isFirstRun ? '开始前，先把环境准备好' : '到这一步了，先检查这几项')}</h2>
            <p>
              {isPreviewMode
                ? '全部勾选后才能继续；勾选表示你已经在微信开发者工具里完成该项。'
                : (isCloud
                  ? '服务端以云端 API 为准；微信开发者工具仍检查本机，本地无需启动 MySQL。'
                  : (isFirstRun
                    ? '大件工具装好一次即可；后面到具体步骤还会再提醒，不会一次塞满。'
                    : '微信开发者工具与本地后端就绪后，才能打开真实预览或导出工程。'))}
            </p>
          </div>
        </header>

        {isPreviewMode ? (
          <div className="env-guide-checklist">
            {PREVIEW_CHECKS.map((item) => (
              <label
                className={`env-guide-check-item${checked[item.id] ? ' is-checked' : ''}`}
                key={item.id}
              >
                <input
                  type="checkbox"
                  checked={Boolean(checked[item.id])}
                  disabled={busy}
                  onChange={() => setChecked((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                />
                <span className="env-guide-check-item-body">
                  <b>{item.title}</b>
                  <em>{item.body}</em>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <>
            <div className="env-guide-checks">
              {serverChecks.length > 0 ? (
                <>
                  <div className="env-guide-group">服务端就绪</div>
                  {serverChecks.map(renderCheck)}
                </>
              ) : null}
              {localChecks.length > 0 ? (
                <>
                  <div className="env-guide-group">本机工具就绪</div>
                  {localChecks.map(renderCheck)}
                </>
              ) : null}
            </div>

            <details className="env-guide-steps" open={isFirstRun ? undefined : true}>
              <summary>详细步骤</summary>
              <ol>
                {steps.map((step) => (
                  <li key={step.title}>
                    <b>{step.title}</b>
                    <span>{step.body}</span>
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}

        <footer className="env-guide-actions">
          {!isPreviewMode ? (
            <button type="button" className="ghost-button" onClick={onRefresh} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {busy ? '检测中…' : '重新检测'}
            </button>
          ) : null}
          <button type="button" className="ghost-button" onClick={onCopyGuide}>
            <Copy size={14} />
            复制安装说明
          </button>
          <span className="env-guide-spacer" />
          {isPreviewMode && !allChecked ? (
            <span className="env-guide-hint">全部勾选后才能继续</span>
          ) : null}
          <button type="button" className="ghost-button" onClick={onSkip} disabled={busy}>
            稍后再做
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onStart}
            disabled={busy || (isPreviewMode && !allChecked)}
          >
            已准备就绪
          </button>
        </footer>
      </div>
    </div>
  );
}