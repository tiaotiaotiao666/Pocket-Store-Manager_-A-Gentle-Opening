import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { AGENT_IMAGE_ERROR_CODES, AGENT_IMAGE_LIMITS } from '../../domain/agentImageInput.mjs';
import { prepareImageFile } from '../../services/agentTurn/agentImageUpload.js';

/**
 * 右侧「Agent 对话」的临时附件区。
 *
 * 边界（与侧栏契约一致）：
 * - 附件只在内存里存在，随本轮请求发送；不写项目快照，也不写回消息正文；
 * - 压缩与限制复用 `domain/agentImageInput.mjs` + `agentImageUpload.prepareImageFile`；
 * - 当前阶段能带哪几种图片由 App 计算后传入（`kinds`），组件不自己判断阶段；
 * - 图片不让发送按钮「点了没反应」：数量/类型问题就地显示原因。
 */

const KIND_CONFIG = Object.freeze({
  auto: {
    label: '自动判断',
    hint: '由项目 Agent 判断用途；不确定时会先追问（识别菜单 / 提取门店氛围 / 参考界面重构）。',
    limit: AGENT_IMAGE_LIMITS.maxTotalImages,
  },
  reference: {
    label: '参考界面',
    hint: '只进入「参考图重构」候选链，不会直接改动模板或采用候选。',
    limit: 1,
  },
  menu: {
    label: '菜单照',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxMenuImages} 张，用于识别菜名、价格与描述。`,
    limit: AGENT_IMAGE_LIMITS.maxMenuImages,
  },
  store: {
    label: '环境照',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxStoreImages} 张，用于理解门店氛围与展示风格。`,
    limit: AGENT_IMAGE_LIMITS.maxStoreImages,
  },
});

const ACCEPT = 'image/jpeg,image/png,image/webp';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(value / 1024))} KiB`;
}

function toReadableError(error, fallbackMessage) {
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message };
  }
  if (error && typeof error.message === 'string' && error.message) {
    return { code: AGENT_IMAGE_ERROR_CODES.invalid, message: error.message };
  }
  return { code: AGENT_IMAGE_ERROR_CODES.invalid, message: fallbackMessage };
}

export default function AgentChatAttachments({
  images = [],
  kinds = [],
  disabled = false,
  busy = false,
  error = null,
  onAdd,
  onRemove,
  onBusyChange,
}) {
  const allowedKinds = kinds.filter((kind, index) => KIND_CONFIG[kind] && kinds.indexOf(kind) === index);
  const inputRef = useRef(null);
  const [kind, setKind] = useState(allowedKinds[0] || 'menu');
  const [working, setWorking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    setKind((current) => (allowedKinds.includes(current) ? current : (allowedKinds[0] || 'menu')));
    setLocalError(null);
  }, [allowedKinds.join('|')]);

  if (allowedKinds.length === 0) return null;

  const list = Array.isArray(images) ? images : [];
  const activeKind = allowedKinds.includes(kind) ? kind : allowedKinds[0];
  const config = KIND_CONFIG[activeKind];
  const activeCount = list.filter((item) => item && item.kind === activeKind).length;
  const room = Math.max(0, Math.min(config.limit - activeCount, AGENT_IMAGE_LIMITS.maxTotalImages - list.length));
  const isBusy = Boolean(busy) || working;
  const isDisabled = Boolean(disabled);
  const activeError = localError
    ?? (error && typeof error === 'object' && typeof error.message === 'string' ? error : null);

  async function ingestFiles(fileList) {
    if (isDisabled || isBusy) return;
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    if (room === 0) {
      setLocalError({
        code: AGENT_IMAGE_ERROR_CODES.count,
        message: activeKind === 'menu'
          ? `本轮最多再带 ${AGENT_IMAGE_LIMITS.maxMenuImages} 张菜单照。`
          : '本轮最多再带 1 张环境照。',
      });
      return;
    }

    const accepted = files.slice(0, room);
    setLocalError(null);
    setWorking(true);
    onBusyChange?.(true);
    const drafts = [];
    let firstError = null;
    for (const file of accepted) {
      try {
        const draft = await prepareImageFile(file, { kind: activeKind });
        drafts.push(draft);
      } catch (caught) {
        if (!firstError) firstError = toReadableError(caught, '图片处理失败，请换一张图片重试。');
      }
    }
    setWorking(false);
    onBusyChange?.(false);

    if (firstError) setLocalError(firstError);
    else if (files.length > accepted.length) {
      setLocalError({
        code: AGENT_IMAGE_ERROR_CODES.count,
        message: `本轮最多再带 ${accepted.length} 张图片，多余的已忽略。`,
      });
    }
    if (drafts.length && typeof onAdd === 'function') onAdd(activeKind, drafts);
  }

  function handleChange(event) {
    ingestFiles(event?.target?.files);
    if (event?.target) event.target.value = '';
  }

  return (
    <section
      className={`agent-chat-attachments${dragging ? ' is-dragging' : ''}`}
      aria-label="本轮图片附件"
      onDragOver={(event) => {
        if (isDisabled || isBusy) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (isDisabled || isBusy) return;
        event.preventDefault();
        setDragging(false);
        ingestFiles(event.dataTransfer?.files);
      }}
    >
      <div className="agent-chat-attachments-head">
        <span className="agent-chat-attachments-title">
          <ImagePlus size={14} aria-hidden="true" />
          本轮图片
        </span>
        {allowedKinds.length > 1 ? (
          <span className="agent-chat-attachments-kinds" role="group" aria-label="图片用途">
            {allowedKinds.map((item) => (
              <button
                key={item}
                type="button"
                className={`agent-chat-attachments-kind${item === activeKind ? ' is-active' : ''}`}
                aria-pressed={item === activeKind}
                disabled={isDisabled || isBusy}
                onClick={() => setKind(item)}
              >
                {KIND_CONFIG[item].label}
              </button>
            ))}
          </span>
        ) : (
          <span className="agent-chat-attachments-kind-label">{config.label}</span>
        )}
      </div>

      <p className="agent-chat-attachments-hint">
        {config.hint} 可以点击添加，也可以把图片直接拖进来；图片不会写进项目文件。
      </p>

      {list.length > 0 ? (
        <ul className="agent-chat-attachments-list">
          {list.map((item) => (
            <li className="agent-chat-attachment" key={item.id}>
              {item.previewDataUrl ? (
                <img src={item.previewDataUrl} alt={`${item.name || '已选图片'} 预览`} />
              ) : (
                <span className="agent-chat-attachment-placeholder" aria-hidden="true">
                  <ImagePlus size={14} />
                </span>
              )}
              <span className="agent-chat-attachment-body">
                <span className="agent-chat-attachment-name" title={item.name}>{item.name || '图片'}</span>
                <span className="agent-chat-attachment-meta">
                  {KIND_CONFIG[item.kind]?.label || '图片'}
                  {formatBytes(item.bytes) ? ` · ${formatBytes(item.bytes)}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="agent-chat-attachment-remove"
                aria-label={`移除${item.name || '已选图片'}`}
                disabled={isDisabled || isBusy}
                onClick={() => onRemove?.(item.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={inputRef}
        className="agent-chat-attachments-input"
        type="file"
        accept={ACCEPT}
        multiple={activeKind === 'menu'}
        aria-label={`选择${config.label}`}
        disabled={isDisabled || isBusy}
        onChange={handleChange}
      />

      <div className="agent-chat-attachments-actions">
        <button
          type="button"
          className="agent-chat-attachments-add"
          disabled={isDisabled || isBusy || room === 0}
          onClick={() => inputRef.current?.click()}
        >
          {working ? (
            <><Loader2 size={14} className="agent-chat-attachments-spinner" aria-hidden="true" />压缩中…</>
          ) : (
            <><ImagePlus size={14} aria-hidden="true" />添加图片</>
          )}
        </button>
        <span className="agent-chat-attachments-count">
          已选 {list.length}/{AGENT_IMAGE_LIMITS.maxTotalImages} 张
        </span>
      </div>

      {activeError ? (
        <p className="agent-chat-attachments-error" role="alert">{activeError.message}</p>
      ) : null}
    </section>
  );
}