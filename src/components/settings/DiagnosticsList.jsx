import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCw, Save, XCircle } from 'lucide-react';

import { RESULT_LABELS } from '../../domain/diagnosticFormat.mjs';

const ICONS = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
};

export default function DiagnosticsList({
  status = 'idle',
  lines = [],
  summary = null,
  copyStatus = null,
  snapshotPath = null,
  onRun,
  onCopy,
  onSaveSnapshot,
}) {
  const running = status === 'running';
  const list = Array.isArray(lines) ? lines : [];
  const headline = summary?.headline || (running ? '正在自检…' : '尚未自检');

  return (
    <section className="settings-section diagnostics-section">
      <header className="settings-section-head">
        <div>
          <h2>运行自检</h2>
          <p>五项检查：运行环境、本地数据目录、模板资源、后端服务、模型通道。不会发起真实模型调用。</p>
        </div>
        <div className="diagnostics-actions">
          <button type="button" className="ghost-button diagnostics-action" onClick={onRun} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {running ? '自检中…' : '重新自检'}
          </button>
          <button type="button" className="ghost-button diagnostics-action" onClick={onCopy} disabled={running || list.length === 0}>
            {copyStatus === 'done' ? '已复制' : '复制诊断 JSON'}
          </button>
          <button type="button" className="ghost-button diagnostics-action" onClick={onSaveSnapshot} disabled={running || list.length === 0}>
            <Save size={14} />
            保存快照
          </button>
        </div>
      </header>

      <div className={`diagnostics-headline is-${summary?.failed ? 'fail' : (summary?.warned ? 'warn' : (status === 'done' ? 'pass' : 'idle'))}`}>
        <span className="diagnostics-headline-dot" />
        <strong>{headline}</strong>
        {summary?.checkedAt ? <span className="diagnostics-checked">检查于 {formatClock(summary.checkedAt)}</span> : null}
      </div>

      {snapshotPath ? <p className="diagnostics-note">快照已保存到诊断目录：{snapshotPath}</p> : null}

      {list.length === 0 && !running ? (
        <div className="diagnostics-empty">
          <CircleDashed size={18} />
          <span>点击「重新自检」查看当前环境是否可用于导出与真实模型。</span>
        </div>
      ) : null}

      {running && list.length === 0 ? (
        <div className="diagnostics-empty">
          <Loader2 size={18} className="spin" />
          <span>正在检查本机环境与后端服务…</span>
        </div>
      ) : null}

      <ul className="diagnostics-list">
        {list.map((line) => {
          const Icon = ICONS[line.result] || CircleDashed;
          return (
            <li key={line.id} className={`diagnostics-line is-${line.result}`}>
              <span className="diagnostics-icon">
                <Icon size={16} />
              </span>
              <div className="diagnostics-body">
                <span className="diagnostics-title">
                  {line.title}
                  <em>{RESULT_LABELS[line.result] || line.result}</em>
                  {line.latencyMs ? <small>{line.latencyMs} ms</small> : null}
                </span>
                <span className="diagnostics-message">{line.message}</span>
                {line.action ? <span className="diagnostics-action-hint">下一步：{line.action}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatClock(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}