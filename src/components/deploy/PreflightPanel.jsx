import { AlertTriangle, CheckCircle2, ChevronDown, Info, RotateCw, ShieldCheck, XCircle } from 'lucide-react';

const TONE = {
  error: 'fail',
  warn: 'warn',
  info: 'info',
};

function RuleRow({ rule, acknowledged, onToggleAck, onGoto }) {
  const isWarn = rule.level === 'warn';
  const Icon = rule.level === 'error' ? XCircle : (isWarn ? AlertTriangle : Info);
  return (
    <li className={`preflight-row is-${TONE[rule.level]}`}>
      <span className="preflight-icon">
        <Icon size={15} />
      </span>
      <div className="preflight-body">
        <span className="preflight-rule">{rule.ruleId}</span>
        <span className="preflight-message">{rule.message}</span>
        {rule.fieldPath ? <code className="preflight-field">{rule.fieldPath}</code> : null}
      </div>
      <div className="preflight-tail">
        {isWarn ? (
          <label className="preflight-ack">
            <input
              type="checkbox"
              checked={acknowledged.includes(rule.ruleId)}
              onChange={() => onToggleAck?.(rule.ruleId)}
            />
            我已了解
          </label>
        ) : null}
        {rule.action?.phase ? (
          <button type="button" className="preflight-goto" onClick={() => onGoto?.(rule.action.phase)}>
            {rule.action.label || '去修改'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function PreflightPanel({
  status = 'idle',
  errors = [],
  warns = [],
  infos = [],
  acknowledged = [],
  planDigest = null,
  checkedAt = null,
  canExport = null,
  onRerun,
  onToggleAck,
  onGoto,
}) {
  const checking = status === 'checking';
  const errorCount = errors.length;
  const ackedSet = new Set(acknowledged || []);
  const pendingWarns = warns.filter((item) => !ackedSet.has(item.ruleId));
  const errorHeadline = errorCount > 0
    ? `有 ${errorCount} 项需要先修正`
    : (pendingWarns.length > 0 ? `可以继续，但有 ${pendingWarns.length} 项提示需要确认` : `可以导出${warns.length ? `（已确认 ${warns.length} 项提示）` : ''}`);

  return (
    <section className="preflight">
      <header className="preflight-head">
        <div className="preflight-heading">
          <span className={`preflight-mark${errorCount === 0 && pendingWarns.length === 0 && status === 'done' ? ' is-ok' : ''}`}>
            {errorCount === 0 && pendingWarns.length === 0 && status === 'done' ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
          </span>
          <div>
            <h3>导出前体检</h3>
            <p>
              {checking
                ? '正在检查店名、菜单、营业时间、取餐方式与模板契约…'
                : (status === 'done' ? errorHeadline : (status === 'failed' ? '体检未完成，请重试' : '点击「开始体检」检查是否具备导出条件'))}
            </p>
          </div>
        </div>
        <div className="preflight-head-actions">
          {status === 'done' ? (
            <span className={`preflight-badge is-${errorCount > 0 ? 'fail' : (pendingWarns.length > 0 ? 'warn' : 'pass')}`}>
              {errorCount > 0 ? `${errorCount} 项阻断` : (pendingWarns.length > 0 ? `${pendingWarns.length} 项待确认` : '可以导出')}
            </span>
          ) : null}
          <button type="button" className="ghost-button preflight-rerun" onClick={onRerun} disabled={checking}>
            {checking ? <RotateCw size={13} className="spin" /> : <RotateCw size={13} />}
            {checking ? '体检中…' : (status === 'idle' ? '开始体检' : '重新体检')}
          </button>
        </div>
      </header>

      {status === 'idle' ? (
        <div className="preflight-empty">
          <ShieldCheck size={18} />
          <span>体检只读本地数据与 Composer 校验，不写盘、不联网、不消耗模型额度。</span>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <ul className="preflight-list">
          {errors.map((item) => (
            <RuleRow key={`${item.ruleId}-${item.fieldPath || ''}`} rule={item} acknowledged={acknowledged} onToggleAck={onToggleAck} onGoto={onGoto} />
          ))}
        </ul>
      ) : null}

      {warns.length > 0 ? (
        <ul className="preflight-list">
          {warns.map((item) => (
            <RuleRow key={`${item.ruleId}-${item.fieldPath || ''}`} rule={item} acknowledged={acknowledged} onToggleAck={onToggleAck} onGoto={onGoto} />
          ))}
        </ul>
      ) : null}

      {status === 'done' && errors.length === 0 && warns.length === 0 ? (
        <div className="preflight-ok">
          <CheckCircle2 size={17} />
          <span>所有检查项通过，可以开始导出。</span>
        </div>
      ) : null}

      {infos.length > 0 ? (
        <details className="preflight-infos">
          <summary>
            <ChevronDown size={14} />
            {infos.length} 条提示（不影响导出）
          </summary>
          <ul className="preflight-list is-compact">
            {infos.map((item) => (
              <RuleRow key={`${item.ruleId}-${item.fieldPath || ''}`} rule={item} acknowledged={acknowledged} onToggleAck={onToggleAck} onGoto={onGoto} />
            ))}
          </ul>
        </details>
      ) : null}

      {checkedAt || planDigest ? (
        <footer className="preflight-foot">
          {checkedAt ? <span>检查于 {formatClock(checkedAt)}</span> : null}
          {planDigest ? <span className="preflight-digest">Plan 摘要 {String(planDigest).slice(0, 20)}…</span> : null}
          {canExport && !canExport.can ? <span className="preflight-blocked">当前不可导出：{canExport.reason}</span> : null}
        </footer>
      ) : null}
    </section>
  );
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}