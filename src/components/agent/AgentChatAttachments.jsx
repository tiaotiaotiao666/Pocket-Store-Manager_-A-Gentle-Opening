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
    hint: '发送后会先写回文字资料，再自动构建并验证候选前端；现有模板只在你明确采用后才更新。',
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

/**
 * 压缩标签与业务用途分离。
 *
 * `prepareImageFile` 只认 `menu` / `store` 两种压缩标签（它描述的是“这张图怎么压”，
 * 不是“这张图用来干什么”）。侧栏允许 `auto` / `reference`，如果直接把业务用途传进去，
 * 上传参考界面截图会立刻被判成 `AGENT_IMAGE_INVALID`，看起来就是“选了图却没反应”。
 * 因此这里只按“人像/门店环境”选压缩参数，真正的业务 kind 在 draft 上覆盖。
 */
const COMPRESS_KIND = Object.freeze({
  auto: 'menu',
  menu: 'menu',
  store: 'store',
  reference: 'menu',
});

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
  triggerRef = null,
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
        message: `本轮「${config.label}」最多 ${config.limit} 张，已选 ${activeCount} 张；先移除一张再添加。`,
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
        const draft = await prepareImageFile(file, { kind: COMPRESS_KIND[activeKind] || 'menu' });
        // draft.kind 始终是真实业务用途：auto / reference 也按用户选择传下去，
        // 由 App 的附件分流决定它走参考图重构还是统一会话。
        drafts.push({ ...draft, kind: activeKind });
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

  // 0 张图片时本组件不渲染任何卡片：入口是输入区工具行里的「＋ 上传图片」按钮，
  // 拖拽也挂到输入区上，两个入口都复用这里的校验与逐图逐用途确认。
  useEffect(() => {
    if (!triggerRef) return undefined;
    triggerRef.current = {
      open: () => inputRef.current?.click(),
      ingest: (files) => {
        ingestFiles(files);
      },
    };
    return () => {
      triggerRef.current = null;
    };
  }, [triggerRef, isDisabled, isBusy, activeKind, list.length]);

  return (
    <section
      className={`agent-chat-attachments${dragging ? ' is-dragging' : ''}${
        list.length === 0 ? (activeError ? ' is-error' : ' is-bare') : ' is-compact'
      }`}
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

      {list.length === 0 ? null : (
        <>
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
                title={KIND_CONFIG[item].hint}
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
        <span className="agent-chat-attachments-count">
          已选 {list.length}/{AGENT_IMAGE_LIMITS.maxTotalImages} 张
        </span>
      </div>

      <p
        className="agent-chat-attachments-hint"
        title={`${config.hint} 也可以把图片直接拖进来；图片不会写进项目文件。`}
      >
        {config.hint}
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

        </>
      )}

      {activeError ? (
        <p className="agent-chat-attachments-error" role="alert">{activeError.message}</p>
      ) : null}
    </section>
  );
}