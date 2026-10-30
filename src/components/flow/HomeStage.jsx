import { ArrowRight } from 'lucide-react';

export default function HomeStage({
  greeting = '选择一个方案以开始构建你自己的小程序',
  hint = '点击左侧「轻启」开始，用自然语言描述你想要的店铺小程序。',
  onStart,
}) {
  return (
    <section className="flow-home">
      <div className="flow-home-inner">
        <h1 className="flow-home-greeting">{greeting}</h1>
        <p className="flow-home-hint">{hint}</p>
        <button type="button" className="flow-home-start" onClick={onStart}>
          <span>开始</span>
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}