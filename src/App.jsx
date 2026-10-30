import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeInfo, Check, CircleHelp, ClipboardList, CloudUpload, CookingPot, Download, FileImage, FolderOpen, House, ImagePlus, LayoutTemplate, LoaderCircle, Palette, RefreshCw, Rocket, ScanLine, Settings2, Sparkles, Store, Upload, WandSparkles, X } from 'lucide-react';
import { features, templates, themes, iconCatalog, matchTemplate, makeProjectConfig } from './domain/catalog.mjs';
import { generateIcon, hasCloudImageModel } from './services/imageService.js';

const steps = [
  { id: 'brief', label: '门店资料', icon: Store, caption: '先定义这家店' },
  { id: 'features', label: '功能选择', icon: Settings2, caption: '勾选经营需要' },
  { id: 'template', label: '模板匹配', icon: LayoutTemplate, caption: '选择页面骨架' },
  { id: 'style', label: '风格与图标', icon: Palette, caption: '生成视觉资产' },
  { id: 'preview', label: '预览与导出', icon: Rocket, caption: '交付独立工程' },
];

const initialIcons = iconCatalog.map((icon) => ({ ...icon, dataUrl: null, status: 'idle', provider: 'placeholder', disclaimer: '' }));

function money(value) { return `¥${(value / 100).toFixed(2)}`; }
function classNames(...values) { return values.filter(Boolean).join(' '); }

function Icon({ name, ...props }) {
  const icons = { House, CookingPot, ClipboardList, Store, BadgeInfo };
  const Component = icons[name] || Sparkles;
  return <Component {...props} />;
}

function App() {
  const [stepIndex, setStepIndex] = useState(0);
  const [storeName, setStoreName] = useState('');
  const [storeType, setStoreType] = useState('社区餐馆');
  const [notes, setNotes] = useState('');
  const [selectedFeatures, setSelectedFeatures] = useState(['table-dining', 'takeaway', 'merchant-orders', 'product-availability', 'store-profile']);
  const [templateId, setTemplateId] = useState('warm-bistro');
  const [themeId, setThemeId] = useState('citrus');
  const [icons, setIcons] = useState(initialIcons);
  const [materials, setMaterials] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [exportState, setExportState] = useState('idle');
  const [notice, setNotice] = useState(null);

  const selectedTheme = themes.find((theme) => theme.id === themeId) || themes[0];
  const match = useMemo(() => matchTemplate(selectedFeatures), [selectedFeatures]);
  const selectedTemplate = templates.find((template) => template.id === templateId) || match.template;
  const configuredFeatureIds = useMemo(() => [...new Set([...features.filter((feature) => feature.required).map((feature) => feature.id), ...selectedFeatures])], [selectedFeatures]);
  const projectPayload = useMemo(() => makeProjectConfig({ storeName, selectedFeatures: configuredFeatureIds, templateId, themeId, selectedStyleIcons: icons, images: materials }), [storeName, configuredFeatureIds, templateId, themeId, icons, materials]);

  function toggleFeature(id) {
    const current = new Set(selectedFeatures);
    if (current.has(id)) current.delete(id); else current.add(id);
    setSelectedFeatures([...current]);
  }

  function goTo(next) {
    setNotice(null);
    setStepIndex(Math.max(0, Math.min(steps.length - 1, next)));
  }

  async function addMaterials() {
    if (!window.smartStore?.pickMaterials) {
      setNotice({ type: 'info', text: '浏览器原型暂不读取本机图片；打包为 Windows 应用后可打开文件选择器。' }); return;
    }
    const picked = await window.smartStore.pickMaterials();
    if (picked.length) { setMaterials(picked); setAnalysis(null); setNotice({ type: 'success', text: `已选择 ${picked.length} 张门店资料图。发送给模型前仍需由你确认。` }); }
  }

  async function analyzeMaterials() {
    if (!materials.length) { setNotice({ type: 'info', text: '先选择至少一张门店图片，再请求风格建议。' }); return; }
    let recommendation = templates.find(({ id }) => id === 'warm-bistro');
    let reason = `本地演示建议：根据你填写的“${storeType}”与门店说明推荐样板；当前未连接云端视觉模型，因此尚未识别照片内容。`;
    if (hasCloudImageModel()) {
      const consent = window.confirm(`将通过已配置的云端模型分析 ${materials.length} 张门店图片和文字资料，用于推荐风格。是否发送？`);
      if (!consent) return;
      setAnalysis({ status: 'analyzing' });
      try {
        const response = await fetch(`${import.meta.env.VITE_IMAGE_MODEL_ENDPOINT.replace(/\/$/, '')}/recommend-style`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeType, storeName, notes, referenceImages: materials.map(({ dataUrl }) => dataUrl).filter(Boolean) }) });
        if (!response.ok) throw new Error('云端风格分析服务暂时不可用');
        const result = await response.json();
        recommendation = templates.find(({ id }) => id === result.templateId);
        if (!recommendation) throw new Error('风格分析服务返回了未支持的模板');
        reason = `${result.reason || '云端模型已根据你主动选择的门店照片提出建议。'} ${result.disclaimer || '最终由你决定是否采用。'}`;
      } catch (error) { setAnalysis(null); setNotice({ type: 'error', text: error.message }); return; }
    } else if (storeType === '咖啡茶饮' || storeType === '烘焙甜品') {
      recommendation = templates.find(({ id }) => id === 'modern-coffee');
    } else if (storeType === '特色餐馆') {
      recommendation = templates.find(({ id }) => id === 'signature-kitchen');
    }
    setAnalysis({ status: 'done', templateId: recommendation.id, reason });
    setTemplateId(recommendation.id);
    setNotice({ type: hasCloudImageModel() ? 'success' : 'info', text: hasCloudImageModel() ? '云端模型已完成风格建议，是否采用仍由你决定。' : '本地规则演示已给出建议；尚未联网识别图片或调用 AI 生图。' });
  }

  async function regenerateIcon(iconId) {
    const icon = icons.find((item) => item.id === iconId);
    if (!icon) return;
    if (hasCloudImageModel() && materials.length && !window.confirm(`重新生成“${icon.label}”时，将把 ${materials.length} 张你选中的门店图片发送给云端图像模型。是否继续？`)) return;
    setIcons((items) => items.map((item) => item.id === iconId ? { ...item, status: 'loading' } : item));
    try {
      const result = await generateIcon({ name: icon.label, theme: selectedTheme.name, seed: Date.now(), referenceImages: materials.map(({ dataUrl }) => dataUrl).filter(Boolean) });
      setIcons((items) => items.map((item) => item.id === iconId ? { ...item, ...result, status: 'ready' } : item));
      setNotice({ type: result.provider === 'local-demo' ? 'info' : 'success', text: `${icon.label} 已生成。${result.disclaimer}` });
    } catch (error) {
      setIcons((items) => items.map((item) => item.id === iconId ? { ...item, status: 'error' } : item));
      setNotice({ type: 'error', text: error.message });
    }
  }

  function submitStore(event) {
    event.preventDefault();
    if (!storeName.trim()) { setNotice({ type: 'error', text: '请先输入门店名称。' }); return; }
    goTo(1);
  }

  async function exportProject() {
    setExportState('exporting'); setNotice(null);
    if (!window.smartStore?.exportProject) { setExportState('idle'); setNotice({ type: 'info', text: '浏览器原型只展示导出结果；打包为 Windows 应用后可选择文件夹导出。' }); return; }
    try {
      const result = await window.smartStore.exportProject(projectPayload);
      setExportState('idle');
      if (result.cancelled) return;
      setNotice({ type: 'success', text: `已导出独立小程序工程：${result.projectPath}` });
    } catch (error) { setExportState('idle'); setNotice({ type: 'error', text: `导出失败：${error.message}` }); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><div><strong>智能开店</strong><span>独立小程序生成器</span></div></div>
      <div className="workspace-label">创建工作台 <span>V0.2</span></div>
      <nav className="step-nav">{steps.map((step, index) => <button key={step.id} className={classNames('step-item', index === stepIndex && 'active', index < stepIndex && 'completed')} onClick={() => goTo(index)}><span className="step-number">{index < stepIndex ? <Check size={15} /> : index + 1}</span><span className="step-copy"><b>{step.label}</b><small>{step.caption}</small></span>{index === stepIndex && <span className="step-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="cloud-status"><span className={classNames('status-dot', hasCloudImageModel() && 'online')} /><div><b>{hasCloudImageModel() ? '云端模型已配置' : '本地演示模式'}</b><small>{hasCloudImageModel() ? '请求将由服务端转发' : '未连接生图服务'}</small></div></div><button className="help-link"><CircleHelp size={16} /> 使用说明</button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div><span className="eyebrow">WINDOWS WORKSPACE / NEW PROJECT</span><h1>{steps[stepIndex].label}</h1></div><div className="topbar-actions"><span className="draft-pill"><span className="status-dot" />草稿自动保存在本机</span><button className="icon-button" title="设置"><Settings2 size={18} /></button><div className="avatar">店</div></div></header>
      <div className="content-wrap">
        {notice && <div className={classNames('notice', `notice-${notice.type}`)}><span>{notice.text}</span><button onClick={() => setNotice(null)}><X size={16} /></button></div>}
        {stepIndex === 0 && <BriefStep storeName={storeName} storeType={storeType} notes={notes} setStoreName={setStoreName} setStoreType={setStoreType} setNotes={setNotes} onSubmit={submitStore} materials={materials} addMaterials={addMaterials} analyzeMaterials={analyzeMaterials} analysis={analysis} />}
        {stepIndex === 1 && <FeatureStep selectedFeatures={selectedFeatures} toggleFeature={toggleFeature} onBack={() => goTo(0)} onNext={() => goTo(2)} />}
        {stepIndex === 2 && <TemplateStep match={match} selectedTemplate={selectedTemplate} templateId={templateId} setTemplateId={setTemplateId} onBack={() => goTo(1)} onNext={() => goTo(3)} />}
        {stepIndex === 3 && <StyleStep theme={selectedTheme} themeId={themeId} setThemeId={setThemeId} icons={icons} regenerateIcon={regenerateIcon} materials={materials} addMaterials={addMaterials} analyzeMaterials={analyzeMaterials} analysis={analysis} onBack={() => goTo(2)} onNext={() => goTo(4)} />}
        {stepIndex === 4 && <PreviewStep storeName={storeName} template={selectedTemplate} theme={selectedTheme} icons={icons} payload={projectPayload} exportState={exportState} exportProject={exportProject} onBack={() => goTo(3)} />}
      </div>
    </main>
  </div>;
}

function BriefStep({ storeName, storeType, notes, setStoreName, setStoreType, setNotes, onSubmit, materials, addMaterials, analyzeMaterials, analysis }) {
  return <section className="step-layout brief-layout"><div className="step-intro"><span className="section-kicker">01 / 建立门店档案</span><h2>先把这家店说清楚。</h2><p>这些资料会进入生成配置，帮助你挑选模板和生成小程序。只有主动发起云端分析或云端图标生成时，选中的图片才会发送给配置的模型服务；本地演示不会上传图片。</p><form onSubmit={onSubmit} className="form-panel"><label>门店名称 <span className="required">必填</span><input value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="例如：松月食堂" maxLength={48} /></label><label>门店类型 <select value={storeType} onChange={(event) => setStoreType(event.target.value)}><option>社区餐馆</option><option>咖啡茶饮</option><option>烘焙甜品</option><option>特色餐馆</option><option>其他餐饮</option></select></label><label>一句话介绍 <span className="optional">可选</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="例如：主打下班后也能快速吃到的家常饭。" maxLength={180} /></label><button className="primary-button" type="submit">继续选择功能 <ArrowRight size={17} /></button></form></div><div className="material-card"><div className="card-heading"><div><span className="section-kicker">参考资料</span><h3>准备一些门店素材</h3></div><FileImage size={21} /></div><p>选择门店外观、菜单、招牌或室内照片，仅在当前 Windows 应用进程中预览。最多 5 张，每张不超过 5 MB。</p>{materials.length ? <div className="material-grid">{materials.map((image) => <div className="material-thumb" key={image.name}><img src={image.previewUrl} alt="" /><span>{image.name}</span></div>)}</div> : <div className="upload-empty"><ImagePlus size={27} /><b>还没有添加图片</b><small>本机预览不会上传图片</small></div>}<div className="material-actions"><button className="secondary-button" onClick={addMaterials}><Upload size={16} />选择图片</button><button className="text-button" onClick={analyzeMaterials} disabled={analysis?.status === 'analyzing'}>{analysis?.status === 'analyzing' ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}分析风格</button></div>{analysis?.status === 'done' && <div className="analysis-result"><Check size={15} /><span>{hasCloudImageModel() ? '模型推荐' : '本地规则建议'}：{templates.find(({ id }) => id === analysis.templateId)?.name}</span><small>{analysis.reason}</small></div>}<div className="privacy-note"><CloudUpload size={14} />{hasCloudImageModel() ? '发起云端分析时先确认；原图不会写入导出工程。' : '当前使用本地演示规则，不会识别或发送图片。'}</div></div></section>;
}

function FeatureStep({ selectedFeatures, toggleFeature, onBack, onNext }) {
  const groups = [...new Set(features.map((feature) => feature.group))];
  return <section className="step-layout"><div className="wide-intro"><span className="section-kicker">02 / 选择你要经营的能力</span><h2>功能先由你决定，模板再来适配。</h2><p>带有“必选”标记的是所有餐饮小程序的基础能力。可选能力会参与模板匹配，没有完整匹配时只使用已经验证过的安全模块。</p></div><div className="feature-board">{groups.map((group) => <div className="feature-group" key={group}><div className="group-heading"><h3>{group}</h3>{features.find((feature) => feature.group === group)?.required && <span>基础能力</span>}</div><div className="feature-grid">{features.filter((feature) => feature.group === group).map((feature) => { const checked = feature.required || selectedFeatures.includes(feature.id); return <button key={feature.id} className={classNames('feature-card', checked && 'checked', feature.required && 'required-card')} onClick={() => !feature.required && toggleFeature(feature.id)}><span className="feature-check">{checked ? <Check size={15} /> : null}</span><div><div className="feature-title"><b>{feature.label}</b>{feature.required ? <em>必选</em> : <em className="muted">可选</em>}</div><p>{feature.description}</p></div></button>; })}</div></div>)}</div><BottomActions onBack={onBack} onNext={onNext} nextText="查看匹配模板" /></section>;
}

function TemplateStep({ match, selectedTemplate, templateId, setTemplateId, onBack, onNext }) {
  return <section className="step-layout"><div className="wide-intro template-intro"><div><span className="section-kicker">03 / 模板匹配</span><h2>这组功能，最适合哪种门店骨架？</h2><p>匹配结果只决定页面结构，不会替你改变功能选择。你可以切换样板，生成器会同步说明缺失项。</p></div><div className="fit-summary"><strong>{match.score}%</strong><span>功能匹配度</span></div></div><div className="template-grid">{templates.map((template) => <button key={template.id} className={classNames('template-card', template.id === templateId && 'selected')} onClick={() => setTemplateId(template.id)}><div className={classNames('template-visual', `visual-${template.layout}`)}><span className="visual-brand">{storeNameShort(template.name)}</span><div className="visual-line wide" /><div className="visual-line" /><div className="visual-products"><i /><i /><i /></div><div className="visual-bottom" /></div><div className="template-meta"><div><span className="template-badge">{template.badge}</span><h3>{template.name}</h3><p>{template.summary}</p></div><span className="radio-check">{template.id === templateId && <Check size={14} />}</span></div></button>)}</div><div className="match-notice"><Sparkles size={18} /><div><b>当前建议：{match.template.name}</b><span>根据所选功能得出 {match.score}% 匹配度。{match.addons.length ? `可安全拼装：${match.addons.join('、')}。` : ''}{match.unsupported.length ? `暂未实现：${match.unsupported.join('、')}。` : '当前功能均有已验证模板支持。'}</span></div></div><BottomActions onBack={onBack} onNext={onNext} nextText="调整视觉风格" /></section>;
}

function storeNameShort(name) { return String(name).slice(0, 4); }

function StyleStep({ theme, themeId, setThemeId, icons, regenerateIcon, materials, addMaterials, analyzeMaterials, analysis, onBack, onNext }) {
  return <section className="step-layout"><div className="wide-intro style-intro"><div><span className="section-kicker">04 / 风格与页面图标</span><h2>先看整体气质，再逐个调整图标。</h2><p>这些占位图标对应导出小程序中的页面名称。未配置云端图像生成服务时，可以查看本地演示图；只有接通模型后，按钮才会生成真正的模型图像。</p></div><div className="model-pill"><span className={classNames('status-dot', hasCloudImageModel() && 'online')} />{hasCloudImageModel() ? '云端生图已配置' : '本地占位预览'}</div></div><div className="style-workspace"><div className="style-controls"><div className="panel-title"><b>视觉方向</b><span>选择一个基础风格</span></div><div className="theme-list">{themes.map((item) => <button key={item.id} className={classNames('theme-choice', item.id === themeId && 'selected')} onClick={() => setThemeId(item.id)}><span className="theme-swatch"><i style={{ background: item.preview[1] }} /><i style={{ background: item.preview[2] }} /><i style={{ background: item.preview[3] }} /></span><span><b>{item.name}</b><small>{item.caption}</small></span>{item.id === themeId && <Check size={16} />}</button>)}</div><div className="reference-mini"><div className="panel-title"><b>参考资料</b><span>{materials.length ? `${materials.length} 张已添加` : '可选'}</span></div><div className="reference-actions"><button className="secondary-button" onClick={addMaterials}><Upload size={15} />添加图片</button><button className="text-button" onClick={analyzeMaterials} disabled={!materials.length || analysis?.status === 'analyzing'}><WandSparkles size={15} />{analysis?.status === 'analyzing' ? '分析中…' : '生成风格建议'}</button></div></div></div><div className="icon-preview-panel"><div className="panel-title"><b>页面图标预览</b><span>每个图标独立生成</span></div><div className="icon-grid">{icons.map((icon) => <div className="icon-card" key={icon.id}><div className="icon-image" style={{ background: icon.dataUrl ? `url(${icon.dataUrl}) center/cover` : icon.tint }}><Icon name={icon.icon} size={34} strokeWidth={1.6} /></div><div className="icon-card-footer"><span>{icon.label}</span><button title={`重新生成${icon.label}`} onClick={() => regenerateIcon(icon.id)} disabled={icon.status === 'loading'}>{icon.status === 'loading' ? <LoaderCircle className="spin" size={15} /> : icon.status === 'error' ? <RefreshCw size={15} /> : <WandSparkles size={15} />}</button></div>{icon.provider !== 'local-demo' && icon.dataUrl && <small className="asset-label">AI 生成图像</small>}{icon.provider === 'local-demo' && <small className="asset-label">本地演示，不是 AI 生图</small>}</div>)}</div><div className="icon-note"><Sparkles size={15} /><span>{hasCloudImageModel() ? '逐个图标采用云端图像模型生成；涉及门店图片时将先征得同意。' : '本地占位图用于预览生成流程，不能当作 AI 图像生成结果。'}</span></div></div></div><BottomActions onBack={onBack} onNext={onNext} nextText="查看完整预览" /></section>;
}

function PreviewStep({ storeName, template, theme, icons, payload, exportState, exportProject, onBack }) {
  const [tab, setTab] = useState('home');
  return <section className="step-layout"><div className="wide-intro preview-intro"><div><span className="section-kicker">05 / 预览与导出</span><h2>确认后，导出属于这家店的工程。</h2><p>这是独立小程序项目的效果预览。导出后可用微信开发者工具打开；正式发布仍需要店主自己的 AppID、主体认证和审核。</p></div><button className="primary-button export-button" onClick={exportProject} disabled={exportState === 'exporting'}>{exportState === 'exporting' ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{exportState === 'exporting' ? '正在导出…' : '导出独立小程序'}</button></div><div className="preview-stage"><div className="preview-summary"><div className="summary-block"><span className="summary-label">门店</span><b>{storeName || '我的餐馆'}</b></div><div className="summary-block"><span className="summary-label">模板</span><b>{template.name}</b></div><div className="summary-block"><span className="summary-label">风格</span><b>{theme.name}</b></div><div className="summary-block"><span className="summary-label">能力</span><b>{payload.features.length} 项已配置</b></div></div><div className="phone-wrap"><div className="phone-frame"><div className="phone-notch" /><div className="phone-screen" style={{ background: theme.preview[0] }}><div className="phone-status"><span>9:41</span><span>▮▮▮ ◉</span></div><div className="mini-store-header"><span className="mini-logo" style={{ background: theme.preview[1] }}><Store size={13} /></span><div><b>{storeName || '我的餐馆'}</b><small>营业中 · 预计 20 分钟</small></div><span className="mini-more">•••</span></div><div className="mini-hero" style={{ background: `linear-gradient(135deg, ${theme.preview[2]}, ${theme.preview[1]})` }}><span>今日菜单已准备好</span><b>从一份招牌开始</b><button style={{ background: theme.preview[3] }}>开始点餐 <ArrowRight size={12} /></button></div><div className="mini-section-title"><b>{tab === 'home' ? '本店推荐' : tab === 'menu' ? '全部菜单' : '订单进度'}</b><span>查看全部</span></div><div className="mini-product-list"><div className="mini-product"><div className="mini-product-art" style={{ background: theme.preview[1] }}><CookingPot size={22} /></div><div><b>门店招牌饭</b><small>现做热卖 · 今日推荐</small><strong>{money(2800)}</strong></div><button style={{ color: theme.preview[1] }}>＋</button></div><div className="mini-product"><div className="mini-product-art" style={{ background: theme.preview[2] }}><Sparkles size={22} /></div><div><b>时令小食拼盘</b><small>轻松分享 · 配餐推荐</small><strong>{money(1600)}</strong></div><button style={{ color: theme.preview[1] }}>＋</button></div></div><div className="mini-tabbar">{icons.slice(0, 4).map((icon) => <button key={icon.id} className={tab === icon.id ? 'active' : ''} onClick={() => setTab(icon.id)}><div style={{ background: tab === icon.id ? theme.preview[1] : icon.tint }}><Icon name={icon.icon} size={13} /></div><span>{icon.label.replace('门店', '').replace('美味', '').replace('订单进度', '订单').replace('店主', '店主')}</span></button>)}</div></div></div></div><div className="preview-details"><div className="details-card"><div className="panel-title"><b>交付内容</b><span>导出时自动写入</span></div><ul className="deliver-list"><li><Check size={15} />独立 `miniprogram/` 工程</li><li><Check size={15} />门店配置与已选功能清单</li><li><Check size={15} />模板颜色与页面图标资源</li><li><Check size={15} />微信开发者工具导入说明</li></ul></div><div className="details-card warning-card"><div className="panel-title"><b>发布前仍需完成</b><span>不是生成器自动代办</span></div><ul className="todo-list"><li><span>01</span>店主注册并认证自己的微信小程序</li><li><span>02</span>在导出工程中配置自己的 AppID</li><li><span>03</span>准备 HTTPS 合法域名和正式业务后端</li><li><span>04</span>按微信要求提交审核与发布</li></ul></div></div></div><div className="preview-footer"><button className="ghost-button" onClick={onBack}><ArrowLeft size={16} />返回调整</button><span><FolderOpen size={15} />导出后可直接在微信开发者工具中打开</span></div></section>;
}

function BottomActions({ onBack, onNext, nextText }) { return <div className="bottom-actions"><button className="ghost-button" onClick={onBack}><ArrowLeft size={16} />返回</button><button className="primary-button" onClick={onNext}>{nextText}<ArrowRight size={17} /></button></div>; }

export default App;
