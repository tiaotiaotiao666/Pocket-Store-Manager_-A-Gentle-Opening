import { AlertTriangle, CheckCircle2, ChevronDown, Info, RotateCw, ShieldCheck, XCircle } from 'lucide-react';

/**
 * 导出前体检面板。
 *
 * B4 规则 7、8 的界面约定：
 * - 默认只讲人话：一句结论 + 一句「会发生什么」+ 一个可执行动作；
 * - `ruleId`、`fieldPath`、Plan 摘要等技术字段一律收进底部「技术详情」；
 * - 缺 AppID、基础能力说明这类常规信息只做披露，不再要求用户逐条点「我已了解」；
 *   只有「你选了但这次真的不会交付」的能力保留一次明确的后果确认。
 */

const TONE = {
  error: 'fail',
  warn: 'warn',
  info: 'info',
};

function RuleRow({ rule, acknowledged, onToggleAck, onGoto }) {
  const isWarn = rule.level === 'warn';
  const requiresAck = isWarn && rule.requiresAck !== false;
  const Icon = rule.level === 'error' ? XCircle : (isWarn ? AlertTriangle : Info);
  const acked = acknowledged.includes(rule.ruleId);
  return (
    <li className={`preflight-row is-${TONE[rule.level]}`}>
      <span className="preflight-icon">
        <Icon size={15} />
      </span>
      <div className="preflight-body">
        <div className="preflight-row-main">
          <span className="preflight-message">{rule.message}</span>
          {rule.consequence ? <span className="preflight-row-action">{rule.consequence}</span> : null}
        </div>
      </div>
      <div className="preflight-tail">
        {requiresAck ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={acked}
            aria-label={`我已了解：${rule.message}`}
            className="preflight-ack"
            onClick={() => onToggleAck?.(rule.ruleId)}
          >
            <span className="preflight-ack-box" aria-hidden="true">
              {acked ? '✓' : ''}
            </span>
            我已了解
          </button>
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

function TechnicalDetails({ errors, warns, infos, planDigest, signature }) {
  const rows = [...errors, ...warns, ...infos];
  if (rows.length === 0 && !planDigest && !signature) return null;
  // 与面板上的分组保持一致：error 阻断、需要确认的是 warn、其余都只是披露。
  const levelLabel = (rule) => {
    if (rule.level === 'error') return '阻断';
    if (rule.level === 'warn' && rule.requiresAck !== false) return '需确认';
    return '披露';
  };
  return (
    <details className="preflight-tech">
      <summary>技术详情</summary>
      <div className="preflight-tech-list">
        {rows.map((rule) => (
          <div key={`tech-${rule.level}-${rule.ruleId}-${rule.fieldPath || ''}`}>
            <code>{rule.ruleId}</code>
            {rule.fieldPath ? <> · <code>{rule.fieldPath}</code></> : null}
            <span> · {levelLabel(rule)}</span>
          </div>
        ))}
        {planDigest ? <div><code>Plan 摘要</code> <code>{String(planDigest)}</code></div> : null}
        {signature ? <div><code>导出签名</code> <code>{String(signature)}</code></div> : null}
      </div>
    </details>
  );
}

export default function PreflightPanel({
  status = 'idle',
  errors = [],
  warns = [],
  infos = [],
  acknowledged = [],
  planDigest = null,
  signature = null,
  checkedAt = null,
  canExport = null,
  stale = false,
  staleReason = null,
  onRerun,
  onToggleAck,
  onGoto,
}) {
  const checking = status === 'checking';
  const errorCount = errors.length;
  const ackedSet = new Set(acknowledged || []);
  const ackWarns = warns.filter((item) => item && item.requiresAck !== false);
  const pendingAck = ackWarns.filter((item) => !ackedSet.has(item.ruleId));
  const disclosureWarns = warns.filter((item) => item && item.requiresAck === false);
  const targetConflict = errors.some((item) => item && item.ruleId === 'E-TARGET-EXISTS');
  const errorHeadline = errorCount > 0
    ? `有 ${errorCount} 项需要先修正`
    : (stale
      ? '资料或导出位置已变化，这份体检结果不再有效'
      : (pendingAck.length > 0
        ? `可以继续，但有 ${pendingAck.length} 项后果需要你确认`
        : `可以导出${ackWarns.length ? `（已确认 ${ackWarns.length} 项）` : ''}`));

  return (
    <section className="preflight">
      <header className="preflight-head">
        <div className="preflight-heading">
          <span className={`preflight-mark${errorCount === 0 && pendingAck.length === 0 && status === 'done' && !stale ? ' is-ok' : ''}`}>
            {errorCount === 0 && pendingAck.length === 0 && status === 'done' && !stale ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
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
            <span className={`preflight-badge is-${errorCount > 0 ? 'fail' : (pendingAck.length > 0 ? 'warn' : 'pass')}`}>
              {errorCount > 0 ? `${errorCount} 项阻断` : (pendingAck.length > 0 ? `${pendingAck.length} 项待确认` : (stale ? '需重新体检' : '可以导出'))}
            </span>
          ) : null}
          <button type="button" className="ghost-button preflight-rerun" onClick={onRerun} disabled={checking}>
            {checking ? <RotateCw size={13} className="spin" /> : <RotateCw size={13} />}
            {checking ? '体检中…' : (status === 'idle' ? '开始体检' : '重新体检')}
          </button>
        </div>
      </header>

      {stale ? (
        <p className="preflight-target-hint" role="note">
          {staleReason || '店铺资料、模板、素材或导出位置发生了变化'}，之前的体检结果和确认都已失效，请重新体检。
        </p>
      ) : null}

      {targetConflict ? (
        <p className="preflight-target-hint" role="note">
          目标目录已有同名工程，不会覆盖：先确认上方提示，再点「选择导出位置」换一个目录，或修改项目名。
        </p>
      ) : null}

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

      {ackWarns.length > 0 ? (
        <>
          <p className="preflight-consequence-note">
            下面这些是你自己选的能力，这次确实不会交付；只需要确认一次后果。
          </p>
          <ul className="preflight-list">
            {ackWarns.map((item) => (
              <RuleRow key={`${item.ruleId}-${item.fieldPath || ''}`} rule={item} acknowledged={acknowledged} onToggleAck={onToggleAck} onGoto={onGoto} />
            ))}
          </ul>
        </>
      ) : null}

      {status === 'done' && errors.length === 0 && warns.length === 0 ? (
        <div className="preflight-ok">
          <CheckCircle2 size={17} />
          <span>所有检查项通过，可以开始导出。</span>
        </div>
      ) : null}

      {disclosureWarns.length > 0 ? (
        <details className="preflight-infos">
          <summary>
            <ChevronDown size={14} />
            {disclosureWarns.length} 条说明（只是告知，不需要确认）
          </summary>
          <ul className="preflight-list is-compact">
            {disclosureWarns.map((item) => (
              <RuleRow key={`${item.ruleId}-${item.fieldPath || ''}`} rule={item} acknowledged={acknowledged} onToggleAck={onToggleAck} onGoto={onGoto} />
            ))}
          </ul>
        </details>
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

      <TechnicalDetails errors={errors} warns={warns} infos={infos} planDigest={planDigest} signature={signature} />

      {checkedAt || (canExport && !canExport.can) ? (
        <footer className="preflight-foot">
          {checkedAt ? <span>检查于 {formatClock(checkedAt)}</span> : null}
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
