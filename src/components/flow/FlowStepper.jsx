import { ArrowLeft, ArrowRight } from 'lucide-react';

/**
 * P2：主线步骤条。
 *
 * 一行说完三件事：现在在第几步、可以退回哪里、下一步是什么。
 * 只读展示 + 一个「返回修改」按钮；前进仍由各页自己的主按钮负责，
 * 避免和底部主操作抢同一个动作。
 */
export default function FlowStepper({ flow, onBack }) {
  if (!flow || flow.visible === false) return null;
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  if (steps.length === 0) return null;

  return (
    <nav className="flow-steps" role="navigation" aria-label="主流程进度">
      <ol className="flow-steps-list">
        {steps.map((step) => (
          <li
            key={step.key}
            className={`flow-step is-${step.state}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
            title={step.hint}
          >
            <span className="flow-step-index">{step.state === 'done' ? '✓' : step.index + 1}</span>
            <span className="flow-step-label">{step.label}</span>
          </li>
        ))}
      </ol>
      <div className="flow-steps-side">
        {flow.back ? (
          <button
            type="button"
            className="flow-step-back"
            onClick={() => onBack?.(flow.back)}
          >
            <ArrowLeft size={13} />
            {flow.back.label}
          </button>
        ) : null}
        {flow.next ? (
          <span className="flow-step-next">
            下一步：{flow.next.label}
            <ArrowRight size={13} aria-hidden="true" />
          </span>
        ) : (
          <span className="flow-step-next">最后一步</span>
        )}
      </div>
    </nav>
  );
}
