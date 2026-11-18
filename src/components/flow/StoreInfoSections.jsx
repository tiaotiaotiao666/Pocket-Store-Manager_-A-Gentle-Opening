const ZONES = [
  {
    id: 'store-basic',
    title: '门店基本资料',
    description: '店名、品类、联系方式、营业时间、取餐方式、门店介绍与装修风格。',
    prop: 'basic',
  },
  {
    id: 'store-dishes',
    title: '菜品资料与菜单图片',
    description: '手动维护菜品，或上传菜单图片识别菜名、价格与描述并回写；菜单图片不参与页面布局。',
    prop: 'dishes',
  },
  {
    id: 'store-environment',
    title: '门店环境图片',
    description: '最多 6 张，选择 1 张用于氛围分析；不识别菜品、不决定布局，也不会打入导出工程。',
    prop: 'environment',
  },
  {
    id: 'store-reference',
    title: '参考小程序截图',
    description: '上传 1 张首页或菜单页截图，只参考布局、组件与风格，不提取菜品、地址或电话。',
    prop: 'reference',
  },
];

export default function StoreInfoSections({ basic, dishes, environment, reference }) {
  const content = { basic, dishes, environment, reference };
  return (
    <div className="store-info-sections" aria-label="门店资料四分区">
      {ZONES.map((zone, index) => (
        <section
          className="store-info-zone"
          id={zone.id}
          aria-label={zone.title}
          key={zone.id}
        >
          <header className="store-info-zone-head">
            <span className="store-info-zone-index" aria-hidden="true">{index + 1}</span>
            <div>
              <h3>{zone.title}</h3>
              <p>{zone.description}</p>
            </div>
          </header>
          <div className="store-info-zone-body">{content[zone.prop]}</div>
        </section>
      ))}
    </div>
  );
}