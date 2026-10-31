import { SearchX, Sparkles } from 'lucide-react';

export default function WorkbenchEmpty({ variant = 'empty', query = '', onClear, onCreate }) {
  if (variant === 'search-empty') {
    return (
      <div className="workbench-empty">
        <span className="workbench-empty-mark">
          <SearchX size={26} />
        </span>
        <h3>没有匹配「{query}」的项目</h3>
        <p>换一个关键词，或者清除搜索看全部项目。</p>
        <button type="button" className="ghost-button workbench-empty-action" onClick={onClear}>
          清除搜索
        </button>
      </div>
    );
  }

  return (
    <div className="workbench-empty">
      <span className="workbench-empty-mark is-accent">
        <Sparkles size={26} />
      </span>
      <h3>创建你的第一家门店小程序</h3>
      <p>从一个店名开始，跟着「轻启」把菜单、装修、效果图和小程序工程一步步做出来。</p>
      <button type="button" className="primary-button workbench-empty-action" onClick={onCreate}>
        新建项目
      </button>
      <span className="workbench-empty-note">项目会保存在本机，关掉应用也不会丢。</span>
    </div>
  );
}