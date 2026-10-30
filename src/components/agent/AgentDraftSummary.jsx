import { PencilLine, ShieldCheck, Store } from 'lucide-react';

export default function AgentDraftSummary({
  storeName = '',
  category = '',
  businessHours = '',
  fulfillmentText = '',
  dishes = [],
  onReopen,
}) {
  return (
    <section className="agent-summary" aria-label="已确认的开店资料">
      <header className="agent-summary-head">
        <span className="agent-summary-icon" aria-hidden="true">
          <Store size={16} />
        </span>
        <div>
          <h3>开店资料已确认</h3>
          <p>接下来补充装修风格、地址与联系方式，再进入视觉生成。</p>
        </div>
      </header>

      <div className="agent-summary-grid">
        <div className="agent-summary-field">
          <span>店名</span>
          <strong>{storeName || '未填写'}</strong>
        </div>
        <div className="agent-summary-field">
          <span>品类</span>
          <strong>{category || '未填写'}</strong>
        </div>
        <div className="agent-summary-field">
          <span>营业时间</span>
          <strong>{businessHours || '未填写'}</strong>
        </div>
        <div className="agent-summary-field">
          <span>取餐方式</span>
          <strong>{fulfillmentText || '未填写'}</strong>
        </div>
      </div>

      <div className="agent-summary-dishes">
        <div className="agent-summary-dishes-head">
          <span>菜品</span>
          <em>共 {dishes.length} 道</em>
        </div>
        <ul>
          {dishes.map((dish) => (
            <li key={dish.id}>
              <span className="agent-summary-dish-name">{dish.name}</span>
              <span className="agent-summary-dish-price">{dish.priceDisplay}</span>
              {dish.description ? <span className="agent-summary-dish-desc">{dish.description}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <p className="agent-summary-note">
        <ShieldCheck size={14} />
        以下资料已在本地确认，尚未保存到云端，也未发布。
      </p>

      <button type="button" className="agent-btn agent-btn-ghost" onClick={() => onReopen?.()}>
        <PencilLine size={14} />
        返回修改资料
      </button>
    </section>
  );
}