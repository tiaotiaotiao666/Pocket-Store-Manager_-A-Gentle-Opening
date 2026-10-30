import { Check, Rocket } from 'lucide-react';

export default function DeployStep({
  status = 'idle',
  steps = [],
  step = 0,
  progress = 0,
  storeName,
  templateName,
  styleName,
}) {
  const stepList = Array.isArray(steps) ? steps : [];
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const currentIndex = Number(step) || 0;
  const isDone = status === 'done';

  return (
    <section className="deploy-step">
      <header className="deploy-head">
        <span className="deploy-head-icon">
          <Rocket size={16} />
        </span>
        <div className="deploy-heading">
          <h3>{isDone ? '部署完成' : '正在部署'}</h3>
          <p>{isDone ? '这套小程序已经放到演示环境里了。' : '我正在把这套小程序发布到演示环境，很快就好了。'}</p>
        </div>
      </header>

      <div className="deploy-progress">
        <div className="deploy-progress-track">
          <div
            className="deploy-progress-bar"
            style={{ width: `${isDone ? 100 : safeProgress}%` }}
          />
        </div>
        <span className="deploy-progress-value">{isDone ? 100 : safeProgress}%</span>
      </div>

      <ol className="deploy-steps">
        {stepList.map((label, index) => {
          const isCurrent = !isDone && index === currentIndex;
          const isFinished = isDone || index < currentIndex;
          const className = `deploy-step-item${isCurrent ? ' is-current' : ''}${
            isFinished ? ' is-done' : ''
          }`;
          return (
            <li key={`deploy-step-${index}`} className={className}>
              <span className="deploy-step-index">
                {isFinished ? <Check size={11} /> : index + 1}
              </span>
              <span className="deploy-step-label">{label}</span>
              {isCurrent ? <span className="deploy-step-live">进行中</span> : null}
            </li>
          );
        })}
      </ol>

      {isDone ? (
        <div className="deploy-success">
          <div className="deploy-success-head">
            <span className="deploy-success-badge">
              <Check size={13} />
              部署成功
            </span>
          </div>
          <dl className="deploy-summary">
            <div className="deploy-summary-row">
              <dt>店铺</dt>
              <dd>{storeName || '未命名店铺'}</dd>
            </div>
            <div className="deploy-summary-row">
              <dt>页面骨架</dt>
              <dd>{templateName || '默认骨架'}</dd>
            </div>
            <div className="deploy-summary-row">
              <dt>装修风格</dt>
              <dd>{styleName || '默认风格'}</dd>
            </div>
          </dl>
          <p className="deploy-success-note">演示环境，不含真实发布</p>
        </div>
      ) : null}
    </section>
  );
}