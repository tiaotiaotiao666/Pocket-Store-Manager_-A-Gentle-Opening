import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';

import { HANDOFF_STEPS, findStep } from '../../domain/handoffMachine.mjs';

function inlineCopy(text) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
}

export default function HandoffWizard({
  open = false,
  handoff = null,
  progress = null,
  result = null,
  appid = '',
  apiHost = '',
  devtools = null,
  busy = false,
  error = null,
  blockedReason = '',
  onClose,
  onStepSelect,
  onCompleteStep,
  onApplyAppid,
  onOpenPath,
  onCopyPath,
  onProbeDevtools,
  onCopyGuide,
  onFinish,
}) {
  const [appidDraft, setAppidDraft] = useState(appid || '');
  const [appidError, setAppidError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    setAppidDraft(appid || '');
  }, [appid, open]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(''), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!open) return null;

  const current = handoff ? findStep(handoff.stepId) : HANDOFF_STEPS[0];
  const completed = new Set(handoff?.completedStepIds || []);
  const outputPath = result?.outputPath || '';
  const lockDigest = result?.lockDigest || '';

  const copy = async (label, text) => {
    const ok = await inlineCopy(text);
    setCopied(ok ? label : '复制失败');
  };

  const handleApply = () => {
    const value = appidDraft.trim().toLowerCase();
    if (!/^wx[0-9a-f]{16}$/.test(value)) {
      setAppidError('AppID 应为 wx + 16 位十六进制');
      return;
    }
    setAppidError('');
    onApplyAppid?.(value);
  };

  const renderStep = () => {
    switch (current.id) {
      case 'prepare':
        return (
          <>
            <p className="handoff-lead">先确认这次生成的产物是你要交付的那一份。</p>
            <dl className="handoff-facts">
              <div><dt>工程目录</dt><dd className="handoff-path">{outputPath || '—'}</dd></div>
              <div><dt>Lock 摘要</dt><dd className="handoff-mono">{lockDigest || '—'}</dd></div>
              <div><dt>仅预览能力</dt><dd>{(result?.previewOnly || []).join('、') || '无'}</dd></div>
              <div><dt>导出提示</dt><dd>{(result?.warnings || []).join('；') || '无'}</dd></div>
            </dl>
            <div className="handoff-inline-actions">
              <button type="button" className="ghost-button" onClick={() => onOpenPath?.(outputPath)}>
                <FolderOpen size={14} />
                打开目录
              </button>
              <button type="button" className="ghost-button" onClick={() => copy('已复制路径', outputPath)}>
                <Copy size={14} />
                {copied === '已复制路径' ? '已复制' : '复制路径'}
              </button>
              <span className="handoff-note">本应用不会上传或发布。</span>
            </div>
          </>
        );
      case 'import':
        return (
          <>
            <p className="handoff-lead">用微信开发者工具导入上面这个目录。三步：</p>
            <ol className="handoff-steps-list">
              <li><span>1</span>打开微信开发者工具</li>
              <li><span>2</span>选择「导入项目」，目录指向上面的工程目录</li>
              <li><span>3</span>AppID 先选「测试号」，正式号在第 3 步写入</li>
            </ol>
            <div className="handoff-inline-actions">
              <button type="button" className="ghost-button" onClick={() => onOpenPath?.(outputPath)}>
                <FolderOpen size={14} />
                打开工程目录
              </button>
              <button type="button" className="ghost-button" onClick={onProbeDevtools} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <MonitorSmartphone size={14} />}
                {devtools?.found ? '已找到开发者工具' : '探测开发者工具'}
              </button>
              {!devtools?.found ? (
                <button type="button" className="ghost-button" onClick={onCopyGuide}>
                  {copied === '已复制安装说明' ? '已复制' : '复制安装说明'}
                </button>
              ) : null}
            </div>
            {devtools && !devtools.found && devtools.status !== 'idle' ? (
              <p className="handoff-warn">未找到微信开发者工具，请手动打开；本应用不会自动启动或注入项目。</p>
            ) : null}
          </>
        );
      case 'appid':
        return (
          <>
            <p className="handoff-lead">
              把 AppID 写入 <code>project.config.json</code>。配方指纹与模板指纹不变，但产物摘要会变化，
              本应用会按清单口径回填 <code>composition.lock.json</code> 与 <code>generation-report.json</code>。
            </p>
            <label className="handoff-field">
              <span>AppID</span>
              <input
                type="text"
                value={appidDraft}
                placeholder="wx1234567890abcdef"
                onChange={(event) => { setAppidDraft(event.target.value); setAppidError(''); }}
                disabled={busy}
              />
              {appidError ? <em>{appidError}</em> : null}
            </label>
            <div className="handoff-inline-actions">
              <button type="button" className="primary-button" onClick={handleApply} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                {busy ? '写入并校验中…' : '写入 AppID'}
              </button>
              <button type="button" className="ghost-button" onClick={() => onCompleteStep?.('appid')} disabled={busy}>
                跳过，稍后在 IDE 内手填
              </button>
            </div>
            {handoff?.appidApplied ? (
              <div className="handoff-ok">
                <CheckCircle2 size={15} />
                已写入并完成自检。改写前 {String(handoff.appidDigestBefore || '').slice(0, 18)}… → 改写后 {String(handoff.appidDigestAfter || '').slice(0, 18)}…
              </div>
            ) : null}
            <p className="handoff-note">
              可复现性说明：相同方案 + 相同模板版本 + 相同 AppID → 完全相同的工程与 lockDigest；更换 AppID 只会改变产物指纹。
            </p>
          </>
        );
      case 'domain':
        return (
          <>
            <p className="handoff-lead">在开发者工具「详情 → 本地设置」里配置服务器域名。</p>
            <dl className="handoff-facts">
              <div><dt>request 合法域名</dt><dd className="handoff-mono">{apiHost || '127.0.0.1'}</dd></div>
            </dl>
            <div className="handoff-inline-actions">
              <button type="button" className="ghost-button" onClick={() => copy('已复制域名', apiHost || '127.0.0.1')}>
                <Copy size={14} />
                {copied === '已复制域名' ? '已复制' : '复制域名'}
              </button>
              <span className="handoff-note">本地联调可用测试号并勾选「不校验合法域名」。</span>
            </div>
          </>
        );
      case 'preview':
        return (
          <>
            <p className="handoff-lead">用开发者工具生成预览码，扫码在真机上走这四条路径：</p>
            <ul className="handoff-checklist">
              <li><Check size={14} />首页门店信息与菜单加载正常</li>
              <li><Check size={14} />菜单加购 → 结算 → 堂食/自取选择</li>
              <li><Check size={14} />演示支付成功 → 结果页显示取餐号</li>
              <li><Check size={14} />从订单列表进入详情，进度时间线正常</li>
            </ul>
            <p className="handoff-note">结果页会明确标注「演示付款，不产生真实扣款」。</p>
          </>
        );
      case 'next':
        return (
          <>
            <p className="handoff-lead">交接完成。以下是本轮明确的边界：</p>
            <ul className="handoff-bounds">
              <li>不代办微信认证、代码审核与发布；这些需在公众平台完成。</li>
              <li>支付为演示模式，不产生真实扣款，也不含退款/对账。</li>
              <li>门店图片与效果图只保存在项目里，本轮不会打进导出工程。</li>
              <li>未接入的能力会在「仅预览」区块列出，不对外宣称已上线。</li>
            </ul>
            <button type="button" className="primary-button" onClick={onFinish}>
              回到我的项目
              <ArrowRight size={14} />
            </button>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="handoff-backdrop" role="presentation">
      <div className="handoff" role="dialog" aria-modal="true" aria-label="导出交接向导">
        <header className="handoff-head">
          <div>
            <span className="handoff-eyebrow">导出交接</span>
            <h2>把工程交到微信开发者工具</h2>
            <p>{progress ? `第 ${progress.currentIndex + 1} / ${progress.total} 步 · 已完成 ${progress.completedCount} 项` : ''}</p>
          </div>
          <button type="button" className="handoff-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        {blockedReason ? <div className="handoff-blocked">{blockedReason}</div> : null}
        {error ? <div className="handoff-error">{error.message || String(error)}</div> : null}

        <div className="handoff-body">
          <nav className="handoff-nav">
            {HANDOFF_STEPS.map((step, index) => {
              const isActive = current.id === step.id;
              const isDone = completed.has(step.id);
              return (
                <button
                  key={step.id}
                  type="button"
                  className={`handoff-nav-item${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}`}
                  onClick={() => onStepSelect?.(step.id)}
                >
                  <span className="handoff-nav-index">{isDone ? <Check size={11} /> : index + 1}</span>
                  <span className="handoff-nav-text">
                    <strong>{step.title}</strong>
                    <small>{step.summary}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          <section className="handoff-content">
            <header className="handoff-content-head">
              <span className="handoff-content-icon">
                {current.id === 'preview' ? <Smartphone size={16} /> : <ShieldCheck size={16} />}
              </span>
              <div>
                <h3>{current.title}</h3>
                <p>{current.hint}</p>
              </div>
            </header>

            {renderStep()}

            <footer className="handoff-content-foot">
              <button
                type="button"
                className="ghost-button"
                onClick={() => onStepSelect?.(HANDOFF_STEPS[Math.max(0, progress?.currentIndex - 1)]?.id || 'prepare')}
                disabled={(progress?.currentIndex || 0) === 0}
              >
                <ArrowLeft size={14} />
                上一步
              </button>
              {current.id !== 'next' ? (
                <button type="button" className="primary-button" onClick={() => onCompleteStep?.(current.id)} disabled={busy}>
                  {current.completeText}
                  <ArrowRight size={14} />
                </button>
              ) : null}
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}