import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Cpu,
  KeyRound,
  Monitor,
  Save,
  Server,
  ShieldCheck,
} from 'lucide-react';

import DiagnosticsList from './DiagnosticsList.jsx';
import StorageSection from './StorageSection.jsx';

const APPID_RE = /^wx[0-9a-f]{16}$/;

const MODEL_OPTIONS = [
  { value: 'deepseek-flash', label: 'deepseek-flash（V4.1 Flash，支持看图与工具调用）' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更强推理，不支持看图）' },
];

/** 旧配置可能仍是 deepseek-chat / deepseek-reasoner：保留可读项，避免下拉显示成第一项。 */
function modelOptionsFor(current) {
  const value = typeof current === 'string' ? current.trim() : '';
  if (!value || MODEL_OPTIONS.some((item) => item.value === value)) return MODEL_OPTIONS;
  return [...MODEL_OPTIONS, { value, label: `${value}（当前配置）` }];
}

function Field({ label, hint, error, children, wide = false }) {
  return (
    <label className={`settings-field${wide ? ' is-wide' : ''}${error ? ' is-invalid' : ''}`}>
      <span className="settings-field-label">{label}</span>
      {children}
      {error ? <span className="settings-field-error">{error}</span> : hint ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
}

function formatSavedAt(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (input) => String(input).padStart(2, '0');
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SettingsPanel({
  config = null,
  mode = 'desktop',
  diagnostics = null,
  summary = null,
  copyStatus = null,
  snapshotPath = null,
  saving = false,
  saveError = null,
  projectCount = 0,
  activeProjectId = null,
  modelKey = null,
  modelKeySaving = false,
  modelKeyError = null,
  modelKeyNotice = null,
  modelTest = null,
  onPatch,
  onSave,
  onSaveModelKey,
  onClearModelKey,
  onTestModel,
  onRunDiagnostics,
  onCopyDiagnostics,
  onSaveSnapshot,
  onBack,
  onOpenDataDir,
  onOpenProjectDirectory,
}) {
  const [draft, setDraft] = useState(config);
  const [appidError, setAppidError] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const update = (field, value) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    onPatch?.({ [field]: value });
  };

  if (!draft) {
    return (
      <div className="settings-page">
        <header className="settings-top">
          <button type="button" className="settings-back" onClick={onBack}>
            <ArrowLeft size={15} />
            返回项目
          </button>
          <h1>设置与自检</h1>
        </header>
        <div className="settings-loading">正在读取应用设置…</div>
      </div>
    );
  }

  const isBrowser = mode === 'browser';
  const dirty = config && JSON.stringify(config) !== JSON.stringify(draft);
  const keyConfigured = modelKey?.configured === true;
  const keySupported = modelKey?.supported !== false;
  const savedAt = formatSavedAt(modelKey?.updatedAt);
  const channel = draft.modelChannel === 'server' ? 'server' : 'deepseek';
  const testBusy = modelTest?.status === 'testing';

  const handleSave = () => {
    if (draft.defaultAppid && !APPID_RE.test(draft.defaultAppid)) {
      setAppidError('AppID 应为 wx + 16 位十六进制');
      return;
    }
    setAppidError('');
    onSave?.(draft);
  };

  const handleSaveKey = () => {
    const value = apiKeyInput.trim();
    if (!value) return;
    onSaveModelKey?.(value, () => setApiKeyInput(''));
  };

  return (
    <div className="settings-page">
      <header className="settings-top">
        <button type="button" className="settings-back" onClick={onBack}>
          <ArrowLeft size={15} />
          返回项目
        </button>
        <div className="settings-heading">
          <span className="settings-eyebrow">设置</span>
          <h1>模型、存储与自检</h1>
          <p>在这里填自己的 DeepSeek API Key、调整自动保存，并检查本机环境是否就绪。</p>
        </div>
        <div className="settings-top-actions">
          <span className={`settings-mode${isBrowser ? ' is-browser' : ''}`}>
            {isBrowser ? <Monitor size={14} /> : <Cpu size={14} />}
            {isBrowser ? '浏览器预览' : '桌面版'}
          </span>
          <button type="button" className="primary-button settings-save" onClick={handleSave} disabled={saving || !dirty}>
            <Save size={14} />
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </header>

      <div className="settings-body">
        <section className="settings-section" aria-label="模型与 API">
          <header className="settings-section-head">
            <div>
              <h2>模型与 API</h2>
              <p>填写你自己的 DeepSeek API Key 就能直接用。Key 加密保存在这台电脑上，只由应用主程序读取，不会出现在页面、日志或导出的工程里。</p>
            </div>
          </header>

          {saveError ? <div className="settings-error">{saveError.message}</div> : null}

          <div className="settings-form">
            <Field label="使用方式" hint="目前只支持 DeepSeek 官方 API；其他厂商协议不同，暂未接入。" wide>
              <select value={channel} onChange={(event) => update('modelChannel', event.target.value)}>
                <option value="deepseek">直连 DeepSeek（填自己的 API Key，推荐）</option>
                <option value="server">本机服务（由本机部署的模型服务提供）</option>
              </select>
            </Field>

            {channel === 'deepseek' ? (
              <>
                <Field label="API 地址" hint="默认 https://api.deepseek.com ，一般不用改">
                  <input
                    type="text"
                    value={draft.modelApiBaseUrl}
                    onChange={(event) => update('modelApiBaseUrl', event.target.value.trim())}
                    placeholder="https://api.deepseek.com"
                  />
                </Field>

                <Field label="模型" hint="带图片时只能用 deepseek-flash；deepseek-v4-pro 不支持看图">
                  <select value={draft.modelName} onChange={(event) => update('modelName', event.target.value)}>
                    {modelOptionsFor(draft.modelName).map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </Field>

                <Field label="超时（毫秒）" hint="8000–120000，网络慢可以调大">
                  <input
                    type="number"
                    min={5000}
                    max={120000}
                    step={1000}
                    value={draft.modelTimeoutMs}
                    onChange={(event) => update('modelTimeoutMs', Number(event.target.value))}
                  />
                </Field>

                <div className="settings-key-block is-wide">
                  <div className="settings-key-head">
                    <span className="settings-key-icon" aria-hidden="true"><KeyRound size={14} /></span>
                    <div className="settings-key-text">
                      <strong>API Key</strong>
                      <small>
                        {keyConfigured
                          ? `已保存${savedAt ? ` · ${savedAt}` : ''}，只会显示这行状态`
                          : '还没有保存。在 DeepSeek 开放平台创建后粘贴到这里。'}
                      </small>
                    </div>
                    {keyConfigured ? (
                      <span className="settings-key-badge">
                        <ShieldCheck size={13} aria-hidden="true" />
                        已加密保存
                      </span>
                    ) : null}
                  </div>
                  {keySupported ? (
                    <div className="settings-key-row">
                      <label className="settings-field settings-key-field">
                        <span className="settings-field-label">
                          {keyConfigured ? '替换为新的 Key' : '填写 API Key'}
                        </span>
                        <input
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={apiKeyInput}
                          onChange={(event) => setApiKeyInput(event.target.value)}
                          placeholder="sk-..."
                          aria-label="DeepSeek API Key"
                        />
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={handleSaveKey}
                        disabled={modelKeySaving || !apiKeyInput.trim()}
                      >
                        {modelKeySaving ? '保存中…' : '保存密钥'}
                      </button>
                      {keyConfigured ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => onClearModelKey?.()}
                          disabled={modelKeySaving}
                        >
                          清除
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="settings-key-hint">浏览器预览里不能保存 API Key；请在桌面应用里填写。</p>
                  )}
                  {modelKeyError ? <p className="settings-field-error">{modelKeyError}</p> : null}
                  {modelKeyNotice ? (
                    <p className="settings-inline-ok">
                      <CheckCircle2 size={13} aria-hidden="true" />
                      {modelKeyNotice}
                    </p>
                  ) : null}
                  <div className="settings-key-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onTestModel?.(draft)}
                      disabled={testBusy || !keyConfigured}
                    >
                      {testBusy ? '正在连接…' : '测试连接'}
                    </button>
                    {modelTest?.status === 'ok' ? (
                      <span className="settings-inline-ok">
                        <CheckCircle2 size={13} aria-hidden="true" />
                        连接正常 · {modelTest.model || draft.modelName}
                        {Number.isFinite(modelTest.latencyMs) ? ` · ${(modelTest.latencyMs / 1000).toFixed(1)} 秒` : ''}
                      </span>
                    ) : null}
                    {modelTest?.status === 'failed' ? (
                      <span className="settings-field-error">{modelTest.message}</span>
                    ) : null}
                  </div>
                  <p className="settings-key-hint">
                    这一栏接管「开店资料」对话，也支持直接看图（需要 deepseek-flash）。菜单识别、参考截图重构仍走各自的专用入口。
                  </p>
                </div>
              </>
            ) : (
              <>
                <Field label="本机服务地址" hint="默认 http://127.0.0.1:3000/api/v1" wide>
                  <input
                    type="text"
                    value={draft.apiBaseUrl}
                    onChange={(event) => update('apiBaseUrl', event.target.value)}
                    placeholder="http://127.0.0.1:3000/api/v1"
                  />
                </Field>
                <Field label="对话端点" hint="一般不用改">
                  <input
                    type="text"
                    value={draft.agentEndpoint}
                    onChange={(event) => update('agentEndpoint', event.target.value)}
                    placeholder="/api/v1/agent/turn"
                  />
                </Field>
                <Field label="超时（毫秒）" hint="对话与模板修改用；截图识别单独最长等 120 秒，不受这里影响">
                  <input
                    type="number"
                    min={1000}
                    max={120000}
                    step={1000}
                    value={draft.agentTimeoutMs}
                    onChange={(event) => update('agentTimeoutMs', Number(event.target.value))}
                  />
                </Field>
              </>
            )}
          </div>
        </section>

        <StorageSection
          mode={mode}
          projectCount={projectCount}
          maxBackups={draft.maxBackups}
          autoSaveEnabled={draft.autoSaveEnabled}
          autoSaveDebounceMs={draft.autoSaveDebounceMs}
          onOpenDataDir={onOpenDataDir}
          onOpenProjectDirectory={activeProjectId ? onOpenProjectDirectory : null}
        />

        <section className="settings-section">
          <header className="settings-section-head">
            <div>
              <h2>其他</h2>
              <p>这些设置只影响本机。</p>
            </div>
          </header>
          <div className="settings-form">
            <Field label="默认 AppID" hint="新建项目时继承，可留空" error={appidError}>
              <input
                type="text"
                value={draft.defaultAppid}
                onChange={(event) => {
                  setAppidError('');
                  update('defaultAppid', event.target.value.trim());
                }}
                placeholder="wx1234567890abcdef"
              />
            </Field>

            <Field label="自动保存间隔（毫秒）" hint="300–5000">
              <input
                type="number"
                min={300}
                max={5000}
                step={100}
                value={draft.autoSaveDebounceMs}
                onChange={(event) => update('autoSaveDebounceMs', Number(event.target.value))}
                disabled={!draft.autoSaveEnabled}
              />
            </Field>

            <Field label="每项目备份份数" hint="1–10">
              <input
                type="number"
                min={1}
                max={10}
                value={draft.maxBackups}
                onChange={(event) => update('maxBackups', Number(event.target.value))}
              />
            </Field>

            <label className="settings-toggle is-wide">
              <input
                type="checkbox"
                checked={draft.autoSaveEnabled}
                onChange={(event) => update('autoSaveEnabled', event.target.checked)}
              />
              <span>
                <strong>自动保存</strong>
                <small>关闭后仅在切换项目、关闭窗口或手动保存时写盘。</small>
              </span>
            </label>
          </div>
        </section>

        <DiagnosticsList
          status={diagnostics?.status || 'idle'}
          lines={diagnostics?.lines || []}
          summary={summary}
          copyStatus={copyStatus}
          snapshotPath={snapshotPath}
          onRun={onRunDiagnostics}
          onCopy={onCopyDiagnostics}
          onSaveSnapshot={onSaveSnapshot}
        />

        <p className="settings-foot-note">
          <Server size={13} aria-hidden="true" />
          设置保存在本机应用数据目录；API Key 单独加密存放，导出工程与日志都不包含它。
        </p>
      </div>
    </div>
  );
}
