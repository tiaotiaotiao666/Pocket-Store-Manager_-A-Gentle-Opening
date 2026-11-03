import { useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  ImagePlus,
  Loader2,
  X,
} from 'lucide-react';
import {
  AGENT_IMAGE_ERROR_CODES,
  AGENT_IMAGE_LIMITS,
} from '../../domain/agentImageInput.mjs';
import { prepareImageFile } from '../../services/agentTurn/agentImageUpload.js';

/**
 * `C-VISION-UPLOADER@1` 的上传组件（plan.md 2.2.6）。
 *
 * props（契约）：
 * - images: { menu: AgentImageDraft[], store: AgentImageDraft[] }
 * - disabled / busy：整体禁用与外部忙碌态
 * - error: { code, message } | null：父组件传入的错误
 * - onAdd(kind, drafts)：**压缩成功后**回调，父组件只负责写入状态
 * - onRemove(kind, id)：移除某张图片
 *
 * 说明：契约里 `onAdd` 的类型写作 `FileList | File[]`，但行为 5 要求
 * “只在 onAdd 成功后回调；父组件负责把 AgentImageDraft 写入状态”。
 * 为避免父组件重复压缩，这里统一回调压缩完成的 `AgentImageDraft[]`。
 */

const KIND_CONFIG = Object.freeze({
  menu: {
    title: '菜单/菜品照',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxMenuImages} 张，用于识别菜名、价格与描述`,
    Icon: ImagePlus,
  },
  store: {
    title: '门店环境照',
    hint: `最多 ${AGENT_IMAGE_LIMITS.maxStoreImages} 张，用于了解门店氛围，不识别菜品`,
    Icon: Camera,
  },
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
  disabled = false,
  busy = false,
  error = null,
  onAdd,
  onRemove,
}) {
  const menuInputRef = useRef(null);
  const storeInputRef = useRef(null);
  const [workingKind, setWorkingKind] = useState(null);
  const [localError, setLocalError] = useState(null);

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
    const limits = kind === 'menu'
      ? AGENT_IMAGE_LIMITS.maxMenuImages
      : AGENT_IMAGE_LIMITS.maxStoreImages;
    const existing = imageMap[kind].length;
    const room = Math.max(0, limits - existing);

    if (room === 0) {
      setLocalError({
        code: AGENT_IMAGE_ERROR_CODES.count,
        message: `${config.title}最多 ${limits} 张，请先移除已有图片。`,
      });
      return;
    }

    const accepted = files.slice(0, room);
    setLocalError(null);
    setWorkingKind(kind);

    const drafts = [];
    let firstError = null;
    for (const file of accepted) {
      try {
        // 逐张压缩：单张失败不影响同批其它图片。
        const draft = await prepareImageFile(file, { kind });
        drafts.push(draft);
      } catch (caught) {
        if (!firstError) {
          firstError = toReadableError(caught, '图片处理失败，请换一张图片重试。');
        }
      }
    }

    setWorkingKind(null);

    if (firstError) setLocalError(firstError);
    else if (files.length > accepted.length) {
      setLocalError({
        code: AGENT_IMAGE_ERROR_CODES.count,
        message: `${config.title}最多 ${limits} 张，多余的图片已被忽略。`,
      });
    }

    if (drafts.length && typeof onAdd === 'function') {
      onAdd(kind, drafts);
    }
  }

  function handleChange(kind, event) {
    const files = event?.target?.files;
    handleFiles(kind, files);
    // 允许连续选择同一张图片时仍触发 change。
    if (event?.target) event.target.value = '';
  }

  function renderSection(kind) {
    const config = KIND_CONFIG[kind];
    const list = imageMap[kind];
    const limits = kind === 'menu'
      ? AGENT_IMAGE_LIMITS.maxMenuImages
      : AGENT_IMAGE_LIMITS.maxStoreImages;
    const sectionBusy = workingKind === kind;
    const sectionDisabled = isDisabled || (isBusy && !sectionBusy);
    const Icon = config.Icon;

    return (
      <section className="agent-image-section" aria-label={config.title}>
        <header className="agent-image-head">
          <span className="agent-image-title">
            <Icon size={15} aria-hidden="true" />
            {config.title}
          </span>
          <span className="agent-image-count">
            {list.length}/{limits} 张 · {formatBytes(sumBytes(list))}
          </span>
        </header>

        <p className="agent-image-hint">{config.hint}</p>

        <div className="agent-image-grid">
          {list.map((item) => (
            <figure className="agent-image-thumb" key={item.id}>
              <img src={item.previewDataUrl} alt={`${config.title}预览`} />
              <figcaption>
                <span className="agent-image-size">{formatBytes(item.bytes)}</span>
                <button
                  type="button"
                  className="agent-image-remove"
                  aria-label={`移除${config.title}`}
                  disabled={isDisabled || isBusy}
                  onClick={() => onRemove?.(kind, item.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </figcaption>
            </figure>
          ))}

          <button
            type="button"
            className="agent-image-add"
            disabled={sectionDisabled || list.length >= limits || sectionBusy}
            onClick={() => openPicker(kind)}
          >
            {sectionBusy ? (
              <>
                <Loader2 size={16} className="agent-image-spinner" aria-hidden="true" />
                压缩中…
              </>
            ) : (
              <>
                <Icon size={16} aria-hidden="true" />
                {list.length >= limits ? '已达上限' : '选择图片'}
              </>
            )}
          </button>
        </div>

        <input
          ref={inputRefs[kind]}
          className="agent-image-input"
          type="file"
          accept={ACCEPT}
          multiple={kind === 'menu'}
          disabled={sectionDisabled || sectionBusy}
          onChange={(event) => handleChange(kind, event)}
        />
      </section>
    );
  }

  return (
    <div
      className={`agent-image-uploader${isDisabled ? ' is-disabled' : ''}`}
      aria-busy={isBusy ? 'true' : 'false'}
    >
      <div className="agent-image-sections">
        {renderSection('menu')}
        {renderSection('store')}
      </div>

      {activeError?.message ? (
        <div className="agent-image-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{activeError.message}</span>
        </div>
      ) : null}

      {isWorking ? (
        <p className="agent-image-progress" role="status">正在本地压缩图片，不会上传预览原图。</p>
      ) : null}
    </div>
  );
}