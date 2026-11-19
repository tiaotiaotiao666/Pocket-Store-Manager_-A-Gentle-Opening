import { Sparkles } from 'lucide-react';

/**
 * G1：真实 AI 生图面板。
 *
 * - 提示词来自后端的唯一实现（按已确认的店名 / 品类 / 风格 / 菜品生成），用户可以改；
 * - 生成前明确告知：提示词与文字需求会发送到该第三方生图服务；
 * - 只有服务端确认返回了合法 PNG，调用方才会显示「AI 生成成功」，这里只负责按钮与文案。
 */
export default function PosterGeneratorPanel({
  prompt = '',
  onPromptChange,
  onGenerate,
  busy = false,
  disabled = false,
  disabledReason = '',
  error = '',
  success = null,
  providerLabel = '',
  model = '',
}) {
  return (
    <div className="poster-generator" role="group" aria-label="AI 生成海报">
      <label className="poster-generator-label" htmlFor="poster-prompt-input">
        海报提示词（可修改）
      </label>
      <textarea
        id="poster-prompt-input"
        className="poster-generator-input"
        value={prompt}
        rows={4}
        maxLength={1200}
        disabled={busy}
        onChange={(event) => onPromptChange?.(event.target.value)}
        placeholder="按已确认的门店资料自动生成，可以改成你想要的画面"
      />
      <p className="poster-generator-disclosure" id="poster-generator-disclosure">
        点击生成后，这段提示词和其中的文字需求会发送到第三方生图服务
        {providerLabel ? `（${providerLabel}）` : ''}，由它返回一张图片；
        服务端只保存脱敏摘要，不保存密钥。
      </p>
      <div className="poster-generator-actions">
        <button
          type="button"
          className="agent-btn agent-btn-primary"
          onClick={() => onGenerate?.()}
          disabled={busy || disabled || !String(prompt || '').trim()}
          aria-describedby="poster-generator-disclosure"
        >
          <Sparkles size={15} />
          {busy ? '正在生成（约 30 秒）' : '生成海报'}
        </button>
        {model ? <span className="poster-generator-model">模型：{model}</span> : null}
      </div>
      {disabled && disabledReason ? (
        <p className="material-empty-reason">{disabledReason}</p>
      ) : null}
      {error ? (
        <p className="poster-generator-error" role="alert">{error}</p>
      ) : null}
      {success ? (
        <p className="poster-generator-success">
          AI 生成成功 · {success.width}×{success.height} · {(success.latencyMs / 1000).toFixed(1)} 秒
          {success.model ? ` · ${success.model}` : ''}
        </p>
      ) : null}
    </div>
  );
}
