const ZONES = [
  {
    id: 'operations',
    title: '门店经营资料',
    description: '填写门店与菜品资料，也可以上传菜单图片自动整理菜品。',
    parts: [
      { id: 'store-basic', prop: 'basic' },
      { id: 'store-dishes', prop: 'dishes' },
    ],
  },
  {
    id: 'appearance',
    title: '风格与图片素材',
    description: '选择整体配色，补充环境图片或参考截图；这些素材互不影响识别结果。',
    parts: [
      { id: 'store-style', prop: 'style' },
      { id: 'store-environment', prop: 'environment' },
      { id: 'store-reference', prop: 'reference' },
    ],
  },
];

export default function StoreInfoSections({ basic, dishes, style, environment, reference }) {
  const content = { basic, dishes, style, environment, reference };
  return (
    <div className="store-info-sections" aria-label="门店资料两分区">
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
          <div className="store-info-zone-body">
            {zone.parts.map((part) => (
              <div className="store-info-zone-part" id={part.id} key={part.id}>
                {content[part.prop]}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}