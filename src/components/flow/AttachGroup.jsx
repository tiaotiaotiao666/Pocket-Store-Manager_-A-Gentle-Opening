import { useState } from 'react';
import { ChevronDown, Paperclip } from 'lucide-react';

/**
 * P2：把「参考截图」和「图片识别」两块收进一个可折叠的附加材料区。
 *
 * 这两块在门店资料页是并列的两个上传面板，默认同时展开会让页面变成
 * 「卡片叠卡片」。收成一行标题后：资料已确认时默认折叠，需要时一键展开，
 * 功能一条不少，也没有被拿掉。
 */
export default function AttachGroup({ children, defaultOpen = true, hint = null }) {
  const [open, setOpen] = useState(defaultOpen === true);
  const toggle = () => setOpen((value) => !value);

  return (
    <section className={`attach-group${open ? ' is-open' : ''}`} aria-label="附加材料">
      <button
        type="button"
        className="attach-group-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <Paperclip size={13} aria-hidden="true" />
        <span className="attach-group-title">附加材料：参考截图 / 图片识别</span>
        <ChevronDown size={13} className="attach-group-chevron" aria-hidden="true" />
      </button>
      {hint ? <p className="attach-group-hint">{hint}</p> : null}
      {open ? <div className="attach-group-body">{children}</div> : null}
    </section>
  );
}
