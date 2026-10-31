import { useEffect, useState } from 'react';
import { ArrowLeft, Cpu, Monitor, Save, Server } from 'lucide-react';

import DiagnosticsList from './DiagnosticsList.jsx';
import StorageSection from './StorageSection.jsx';

const APPID_RE = /^wx[0-9a-f]{16}$/;

function Field({ label, hint, error, children, wide = false }) {
  return (
    <label className={`settings-field${wide ? ' is-wide' : ''}${error ? ' is-invalid' : ''}`}>
      <span className="settings-field-label">{label}</span>
      {children}
      {error ? <span className="settings-field-error">{error}</span> : hint ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
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
  onPatch,
  onSave,
  onRunDiagnostics,
  onCopyDiagnostics,
  onSaveSnapshot,
  onBack,
  onOpenDataDir,
  onOpenProjectDirectory,
}) {
  const [draft, setDraft] = useState(config);
  const [appidError, setAppidError] = useState('');

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

  const handleSave = () => {
    if (draft.defaultAppid && !APPID_RE.test(draft.defaultAppid)) {
      setAppidError('AppID 应为 wx + 16 位十六进制');
      return;
    }
    setAppidError('');
    onSave?.(draft);
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
          <h1>运行环境与自检</h1>
          <p>确认本机存储、模板资源与后端服务是否可用，并调整自动保存与 Agent 通道。</p>
        </div>
        <span className={`settings-mode${isBrowser ? ' is-browser' : ''}`}>
          {isBrowser ? <Monitor size={14} /> : <Cpu size={14} />}
          {isBrowser ? '浏览器预览' : '桌面模式'}
        </span>
      </header>

      <div className="settings-body">
        <section className="settings-section">
          <header className="settings-section-head">
            <div>
              <h2>运行环境</h2>
              <p>桌面模式拥有完整的项目落盘、图片资产与导出能力；浏览器预览只用于查看界面。</p>
            </div>
          </header>
          <div className="settings-facts">
            <div className="settings-fact">
              <span className="settings-fact-icon"><Monitor size={15} /></span>
              <div>
                <strong>当前模式</strong>
                <span>{isBrowser ? '浏览器预览 · 项目存 localStorage' : '桌面应用 · Electron + 本机文件系统'}</span>
              </div>
            </div>
            <div className="settings-fact">
              <span className="settings-fact-icon"><Server size={15} /></span>
              <div>
                <strong>当前项目</strong>
                <span>{activeProjectId ? `已打开 ${activeProjectId}` : '未打开项目'}</span>
              </div>
            </div>
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
              <h2>后端与模型</h2>
              <p>这些设置只保存在本机，不包含任何密钥；真实模型 Key 始终只存在服务端。</p>
            </div>
            <button type="button" className="primary-button settings-save" onClick={handleSave} disabled={saving || !dirty}>
              <Save size={14} />
              {saving ? '保存中…' : '保存设置'}
            </button>
          </header>

          {saveError ? <div className="settings-error">{saveError.message}</div> : null}

          <div className="settings-form">
            <Field label="后端接口地址" hint="默认 http://127.0.0.1:3000/api/v1" wide>
              <input
                type="text"
                value={draft.apiBaseUrl}
                onChange={(event) => update('apiBaseUrl', event.target.value)}
                placeholder="http://127.0.0.1:3000/api/v1"
              />
            </Field>

            <Field label="模型通道">
              <select value={draft.agentTransport} onChange={(event) => update('agentTransport', event.target.value)}>
                <option value="mock">本地 Mock（未接入真实模型）</option>
                <option value="http">DeepSeek 后端（真实模型）</option>
              </select>
            </Field>

            <Field label="Agent 端点" hint="必须以 / 开头">
              <input
                type="text"
                value={draft.agentEndpoint}
                onChange={(event) => update('agentEndpoint', event.target.value)}
                placeholder="/api/v1/agent/turn"
              />
            </Field>

            <Field label="Agent 超时（毫秒）">
              <input
                type="number"
                min={1000}
                max={120000}
                step={1000}
                value={draft.agentTimeoutMs}
                onChange={(event) => update('agentTimeoutMs', Number(event.target.value))}
              />
            </Field>

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
      </div>
    </div>
  );
}