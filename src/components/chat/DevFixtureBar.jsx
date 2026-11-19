import { Wrench } from 'lucide-react';

/**
 * 开发者测试夹具条：只在 Vite dev server 里渲染（由 App.jsx 门控）。
 *
 * 它只做一件事——把一句「用户真的说出完整开店资料」的话填进输入框。
 * 点完仍然由开发者自己按发送，消息以普通 user turn 进入 agent，
 * 所以 agent 记录资料的依据依旧是用户输入，而不是任何旁路指令。
 */
export default function DevFixtureBar({ fixtures = [], disabled = false, onPick }) {
  if (!fixtures.length) return null;

  return (
    <section className="dev-fixture-bar" aria-label="开发者测试夹具">
      <p className="dev-fixture-head">
        <Wrench size={12} aria-hidden="true" />
        <span className="dev-fixture-tag">开发者测试夹具</span>
        <span className="dev-fixture-note">填入后仍需你手动发送；仅 dev 可见，不进打包产物</span>
      </p>
      <div className="dev-fixture-actions">
        {fixtures.map((fixture) => (
          <button
            key={fixture.id}
            type="button"
            className="dev-fixture-btn"
            disabled={disabled}
            aria-label={`填入测试资料：${fixture.label}`}
            onClick={() => onPick?.(fixture.utterance)}
          >
            填入：{fixture.label}
          </button>
        ))}
      </div>
    </section>
  );
}
