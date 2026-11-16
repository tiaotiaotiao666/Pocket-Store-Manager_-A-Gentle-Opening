import { Fragment, useMemo } from 'react';
import { parseMarkdown, resolveLinkAction } from '../../domain/markdownView.mjs';

/**
 * Markdown 白名单渲染（W4）。
 *
 * 只消费 `markdownView.mjs` 产出的 AST，逐个映射成 React 元素：
 * 不把任何字符串当 HTML 注入，原始 HTML 因此永远只是文本。
 * 链接一律 preventDefault，交给桌面端受控通道打开。
 */

function openExternal(url) {
  const bridge = typeof window !== 'undefined' ? window.smartStore : null;
  const handler = bridge && typeof bridge.openExternalLink === 'function'
    ? bridge.openExternalLink.bind(bridge)
    : undefined;
  const action = resolveLinkAction(url, { openExternal: handler });
  if (action.kind !== 'external') return false;
  try {
    const result = handler(action.url);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (error) {
    /* 打不开就保持当前页面，不做任何导航兜底。 */
  }
  return true;
}

function renderInline(nodes, keyPrefix = 'inl') {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === 'text') return <Fragment key={key}>{node.text}</Fragment>;
    if (node.type === 'br') return <br key={key} />;
    if (node.type === 'code') return <code key={key} className="md-code">{node.text}</code>;
    if (node.type === 'strong') return <strong key={key}>{renderInline(node.children, key)}</strong>;
    if (node.type === 'em') return <em key={key}>{renderInline(node.children, key)}</em>;
    if (node.type === 'link') {
      return (
        <a
          key={key}
          className="md-link"
          href={node.href}
          rel="noopener noreferrer"
          onClick={(event) => {
            // 绝不让页面自己导航；也不开新窗口，外链只走桌面桥。
            event.preventDefault();
            openExternal(node.href);
          }}
          title={node.href}
        >
          {renderInline(node.children, key)}
        </a>
      );
    }
    return null;
  });
}

function renderBlock(block, index) {
  const key = `blk-${index}`;
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      const Tag = `h${level}`;
      return <Tag key={key} className="md-heading">{renderInline(block.children, key)}</Tag>;
    }
    case 'codeBlock':
      return (
        <pre key={key} className="md-pre">
          <code className={block.lang ? `md-lang-${block.lang}` : undefined}>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key} className="md-quote">{renderInline(block.children, key)}</blockquote>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} className="md-list">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-i${itemIndex}`}>{renderInline(item.children, `${key}-i${itemIndex}`)}</li>
          ))}
        </Tag>
      );
    }
    case 'paragraph':
    default:
      return <p key={key} className="md-p">{renderInline(block.children, key)}</p>;
  }
}

export default function MarkdownView({ text = '', className = '' }) {
  const { blocks } = useMemo(() => parseMarkdown(text), [text]);
  if (!blocks.length) return null;
  return (
    <div className={`md-view${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}
