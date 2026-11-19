import { useRef, useState } from 'react';
import { AlertCircle, Camera, ImagePlus, Loader2, X } from 'lucide-react';
import { AGENT_IMAGE_ERROR_CODES, AGENT_IMAGE_LIMITS } from '../../domain/agentImageInput.mjs';
import { prepareImageFile } from '../../services/agentTurn/agentImageUpload.js';

const KIND_CONFIG = Object.freeze({
  menu: {
    title: '菜单图片',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxMenuImages} 张，只用于识别菜名、价格与描述，不决定页面布局`,
    Icon: ImagePlus,
  },
  store: {
    title: '门店环境照',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxStoreImages} 张，用于了解门店氛围，不识别菜品`,
    Icon: Camera,
  },
});

const STATUS_LABELS = Object.freeze({
  idle: '待识别',
  replaced: '重新上传后待识别',
  recognizing: '识别中',
  written_back: '已回写',
  analyzed: '已分析',
  needs_input: '需补充',
  failed: '识别失败',
});

const ACCEPT = 'image/jpeg,image/png,image/webp';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 KiB';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function sumBytes(list) {
  return list.reduce((total, item) => total + (Number(item?.bytes) || 0), 0);
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

export default function VisionImageUploader({
  images,
  kinds = ['menu', 'store'],
  disabled = false,
  busy = false,
  error = null,
  recognition = null,
  onAdd,
  onRemove,
  onRecognize,
}) {
  const menuInputRef = useRef(null);
  const storeInputRef = useRef(null);
  const [workingKind, setWorkingKind] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [dragKind, setDragKind] = useState(null);
  const visibleKinds = kinds.filter((kind, index) => KIND_CONFIG[kind] && kinds.indexOf(kind) === index);

  const menuImages = Array.isArray(images?.menu) ? images.menu : [];
  const storeImages = Array.isArray(images?.store) ? images.store : [];
  const imageMap = { menu: menuImages, store: storeImages };
  const inputRefs = { menu: menuInputRef, store: storeInputRef };

  const isWorking = workingKind !== null;
  const isDisabled = Boolean(disabled);
  const isBusy = Boolean(busy) || isWorking;
  const activeError = localError ?? (error && typeof error === 'object' ? error : null);

  function openPicker(kind) {
    if (isDisabled || isBusy) return;
    const input = inputRefs[kind].current;
    if (input) input.click();
  }

  async function handleFiles(kind, fileList) {
    if (isDisabled || isBusy) return;
    const files = Array.from(fileList ?? []);
    if (!files.length) return;

    const config = KIND_CONFIG[kind];
    const limits = kind === 'menu' ? AGENT_IMAGE_LIMITS.maxMenuImages : AGENT_IMAGE_LIMITS.maxStoreImages;
    const existing = imageMap[kind].length;
    const room = Math.max(0, limits - existing);
    if (room === 0) {
      setLocalError({ code: AGENT_IMAGE_ERROR_CODES.count, message: `${config.title}最多 ${limits} 张，请先移除已有图片。` });
      return;
    }

    const accepted = files.slice(0, room);
    setLocalError(null);
    setWorkingKind(kind);
    const drafts = [];
    let firstError = null;
    for (const file of accepted) {
      try {
        const draft = await prepareImageFile(file, { kind });
        drafts.push(draft);
      } catch (caught) {
        if (!firstError) firstError = toReadableError(caught, '图片处理失败，请换一张图片重试。');
      }
    }
    setWorkingKind(null);

    if (firstError) setLocalError(firstError);
    else if (files.length > accepted.length) {
      setLocalError({ code: AGENT_IMAGE_ERROR_CODES.count, message: `${config.title}最多 ${limits} 张，多余的图片已被忽略。` });
    }
    if (drafts.length && typeof onAdd === 'function') onAdd(kind, drafts);
  }

  function handleChange(kind, event) {
    handleFiles(kind, event?.target?.files);
    if (event?.target) event.target.value = '';
  }

  function renderSection(kind) {
    const config = KIND_CONFIG[kind];
    const list = imageMap[kind];
    const limits = kind === 'menu' ? AGENT_IMAGE_LIMITS.maxMenuImages : AGENT_IMAGE_LIMITS.maxStoreImages;
    const sectionBusy = workingKind === kind;
    const sectionDisabled = isDisabled || (isBusy && !sectionBusy);
    const Icon = config.Icon;
    const status = recognition?.status || 'idle';

    return (
      <section
        className={`agent-image-section${dragKind === kind ? ' is-drop-target' : ''}`}
        aria-label={config.title}
        onDragOver={(event) => {
          if (sectionDisabled || sectionBusy) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDragKind(kind);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setDragKind(null);
        }}
        onDrop={(event) => {
          if (sectionDisabled || sectionBusy) return;
          event.preventDefault();
          setDragKind(null);
          handleFiles(kind, event.dataTransfer?.files);
        }}
      >
        <header className="agent-image-head">
          <span className="agent-image-title"><Icon size={15} aria-hidden="true" />{config.title}</span>
          <span className="agent-image-count">{list.length}/{limits} 张 · {formatBytes(sumBytes(list))}</span>
        </header>
        <p className="agent-image-hint">{config.hint}</p>

        <div className="agent-image-grid">
          {list.map((item, index) => (
            <figure className="agent-image-thumb" key={item.id}>
              <img src={item.previewDataUrl} alt={`${config.title} ${index + 1} 预览`} />
              <figcaption>
                <span className="agent-image-file">
                  <span className="agent-image-filename" title={item.name}>{item.name || `图片 ${index + 1}`}</span>
                  <span className="agent-image-size">{formatBytes(item.bytes)}</span>
                </span>
                <button
                  type="button"
                  className="agent-image-remove"
                  aria-label={`移除${config.title} ${index + 1}`}
                  disabled={isDisabled || isBusy}
                  onClick={() => onRemove?.(kind, item.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </figcaption>
            </figure>
          ))}

        </div>

        <input
          ref={inputRefs[kind]}
          className="agent-image-input"
          type="file"
          accept={ACCEPT}
          aria-label={`选择${config.title}`}
          multiple={kind === 'menu'}
          disabled={sectionDisabled || sectionBusy}
          onChange={(event) => handleChange(kind, event)}
        />

        {list.length > 0 ? (
          <p className={`agent-image-status is-${status}`} role="status">
            {STATUS_LABELS[status] || '待识别'}
            {status === 'failed' && recognition?.message ? `：${recognition.message}` : ''}
          </p>
        ) : null}

        <div className="agent-image-actions">
          {list.length < limits ? (
            <button
              type="button"
              className="agent-image-add"
              aria-label={`添加${config.title}`}
              disabled={sectionDisabled || sectionBusy}
              onClick={() => openPicker(kind)}
            >
              {sectionBusy ? (
                <><Loader2 size={15} className="agent-image-spinner" aria-hidden="true" />压缩中…</>
              ) : (
                <><Icon size={15} aria-hidden="true" />添加</>
              )}
            </button>
          ) : null}
          {kind === 'menu' && typeof onRecognize === 'function' ? (
            <button
              type="button"
              className="agent-btn agent-btn-confirm"
              disabled={sectionDisabled || sectionBusy || list.length === 0 || status === 'recognizing'}
              onClick={onRecognize}
            >
              {status === 'recognizing' ? '正在识别并回写…' : '识别菜品并回写'}
            </button>
          ) : null}
          {kind === 'menu' && list.length === 0 ? (
            <span className="agent-image-hint">请先上传菜单图片，再开始识别。</span>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <div className={`agent-image-uploader${isDisabled ? ' is-disabled' : ''}`} aria-busy={isBusy ? 'true' : 'false'}>
      <div className="agent-image-sections">{visibleKinds.map(renderSection)}</div>
      {activeError?.message ? (
        <div className="agent-image-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{activeError.message}</span>
        </div>
      ) : null}
      {isWorking ? <p className="agent-image-progress" role="status">正在本地压缩图片，不会上传预览原图。</p> : null}
    </div>
  );
}