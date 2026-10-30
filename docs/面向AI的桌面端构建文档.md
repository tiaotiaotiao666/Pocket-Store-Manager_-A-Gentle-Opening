# 智能开店桌面端 · 会话式 Agent 工作台构建文档

> 面向后续接手的 AI / 开发者。阅读本文件即可理解本轮重构的结构、契约、状态流与扩展方式，无需回溯对话。

## 1. 本轮目标与结论

把原本的「五步向导页」桌面端（`门店资料 → 功能选择 → 模板匹配 → 风格 → 预览导出`）整体重构为**类 codex 的三栏会话式 Agent 工作台**：

- 左栏：品牌、「轻启」主按钮、「待命名项目」子项、会话记录树。
- 中栏：大幅留白的首页、逐条弹出的会话流、底部输入框、阶段内联面板。
- 右栏：上下文面板（引导卡、状态卡、候选模板、效果图、部署进度）。

引导**完全机械执行**，不依赖大模型；所有后端能力用本地占位模拟。部署步骤只播放演示动画，真实导出/发布留给后端。

## 2. 运行与验证

```powershell
npm install
npm run desktop:dev   # Electron + Vite 桌面端
npm run dev           # 仅浏览器原型
npm run build         # Vite 生产构建
npm test              # node:test 单元测试
```

本轮真实验证结果：

- `npm run build`：通过，1603 modules，产物 `dist/assets/index-*.css` 与 `index-*.js`。
- `npm test`：18/18 通过（2 个原有生成器测试 + 16 个新增会话/交接/引导脚本测试）。
- Vite 开发服务器：`/`、`/src/App.jsx`、`/src/styles/index.css`、`/src/components/layout/RightPanel.jsx` 均返回 200，模块可被 Vite 正常转译。
- 未执行人工视觉走查（无头环境），交互手感需在 `npm run desktop:dev` 中确认。

## 3. 技术栈

- Electron 33 + React 18 + Vite 6 + `lucide-react`。
- 不引入路由库 / 全局状态库；状态用 `useReducer` + **纯函数 reducer**。
- 样式为原生 CSS，按职责拆分并通过 `@import` 聚合。
- 端侧 IPC 仍保留（`desktop/preload.cjs`），但本轮 UI **未调用**导出接口。

## 4. 目录结构

```text
src/
  App.jsx                        组合根：接线状态机、占位服务、全部组件
  main.jsx                       挂载 React，引入 styles/index.css
  state/
    constants.mjs                PHASES / ROLES / SESSION_KIND / 文案表
    sessionMachine.mjs           纯函数状态机（createInitialState / reducer / selectors）
  domain/
    catalog.mjs                  功能、模板、主题、图标目录（沿用旧数据）
    onboardingScript.mjs         机械引导脚本（命名、介绍、跳过、部署步骤）
    handoff.mjs                  会话交接文档生成（纯函数）
    storeBrief.mjs               门店类型与装修风格预设
  services/
    agentService.js              占位「大模型/生图」服务（后端替换点）
    imageService.js              旧的图标生图占位（本轮未接入 UI）
  hooks/
    useSequentialReveal.js       逐条揭示 + typing 状态
  components/
    layout/  AppShell / Sidebar / TitleBar / RightPanel
    chat/    ChatStream / MessageBubble / TypingDots / Composer / SkipNotice
    flow/    HomeStage / FeaturePicker / BuildLoading / TemplateGallery / SatisfactionPrompt
    build/   StoreInfoStep / PromptStudio / ImageReview / DeployStep
  styles/
    tokens.css                   设计变量与全局 keyframes / reset
    layout.css                   三栏骨架、侧栏、标题栏
    chat.css                     会话流、气泡、输入框、跳过框
    flow.css                     首页、功能选择、构建加载、模板挑选、满意确认
    build.css                    店铺信息、提示词、效果图审核、部署
    panel.css                    右栏上下文卡 + workspace 布局 + 构建上移覆盖
    index.css                    统一 @import 入口
test/
  generator.test.cjs             原有导出测试
  session-machine.test.cjs       本轮新增：状态机 / 交接 / 引导脚本
```

> `src/styles.css` 是上一轮遗留样式，已不再被入口引用，可安全删除。

## 5. 分层与数据流

```text
App.jsx
  ├── useReducer(sessionMachine.reducer)
  ├── useEffect 驱动阶段副作用（占位服务、进度动画）
  ├── 从 state 派生 props 传给组件
  └── 组件只通过 props 收数据、通过回调向上发事件
```

约束（沿用项目偏好）：

- 组件不直接调用 API、不读取全局业务状态、不写死路由。
- 领域计算与状态迁移集中在 `state/` 与 `domain/`，可被 Node 直接单测。
- 服务层（`services/agentService.js`）是唯一的外部能力出口，便于后端替换。

## 6. 会话状态机

### 6.1 state 形状

```js
{
  seq: 0,                       // 消息自增序号，保证 id 稳定
  phase: 'home',
  activeSessionId: 'session-main',
  sessions: [{
    id, title, kind: 'main'|'step', status: 'active'|'done',
    messages: [{ id, role: 'agent'|'user'|'system', text, staged, delay, instant, meta }],
    handoff: string|null,
  }],
  store: { name, type, notes, address, phone },
  features: { selected: string[], custom: string },
  build: { status, candidates: [], selectedId: null },
  visual: { styleId, promptRounds: [], imageRounds: [], image: null, prompt: '' },
  deploy: { status: 'idle'|'running'|'done', step: 0, progress: 0 },
}
```

### 6.2 phase 枚举

| phase | 含义 | 中栏 | 右栏 |
| --- | --- | --- | --- |
| `home` | 未开始 | 大幅留白 + 欢迎语 | 轻启引导卡 |
| `onboarding` | 命名与介绍 | 会话流 + 跳过框 | 命名引导 / 流程清单 |
| `features` | 功能选择 | 会话流 + 功能卡网格 | 已选能力、定制提示 |
| `building` | 构建等待 | 消息上移 + 构建加载页 | 待加载小程序 |
| `template-pick` | 模板挑选 | 会话流 + 候选模板 + 满意确认 | 候选骨架 |
| `store-info` | 店铺装修 | 会话流 + 店铺信息/风格表单 | 店铺引导、当前风格 |
| `prompt-studio` | 生图提示词 | 会话流 + 提示词工作台 | 提示词、建议 |
| `image-review` | 效果审核 | 会话流 + 效果图审核 | 效果图 |
| `deploy` | 部署 | 会话流 + 部署进度 | 部署步骤 |

### 6.3 action 清单

| action | 作用 |
| --- | --- |
| `RESET` | 回到初始状态 |
| `START_ONBOARDING` | 进入引导，追加命名提问 |
| `SUBMIT_NAME` | 写入店名、改会话标题、追加介绍脚本 |
| `SKIP_INTRO` / `ENTER_FEATURES` | 进入功能选择，追加功能引导 |
| `TOGGLE_FEATURE` | 切换可选功能（必选锁定） |
| `SET_FEATURES_CUSTOM` | 编辑定制输入 |
| `SUBMIT_CUSTOMIZE` | 进入构建，记录定制要求 |
| `BUILD_READY` | 写入候选模板，进入模板挑选 |
| `SELECT_TEMPLATE` | 选中候选 |
| `CONFIRM_TEMPLATE` | 新建「店铺装修」会话，进入 store-info |
| `SET_STORE_FIELD` / `SET_STYLE` | 编辑店铺字段 / 风格 |
| `SUBMIT_STORE_INFO` | 新建「视觉生成」会话，进入 prompt-studio |
| `SET_PROMPT` / `ADD_PROMPT_ROUND` | 编辑提示词 / 记录一轮打磨 |
| `CONFIRM_PROMPT` | 进入 image-review（**保持同一「视觉生成」会话**） |
| `SET_IMAGE` / `ADD_IMAGE_ROUND` | 写入效果图 / 记录一轮修改 |
| `APPROVE_IMAGE` | 新建「部署小程序」会话，进入 deploy |
| `DEPLOY_PROGRESS` / `DEPLOY_DONE` | 部署进度 |
| `SWITCH_SESSION` | 切换左侧会话 |

### 6.4 关键不变量（改动时务必保持）

1. **生图提示词与效果审核共用同一会话**：`SUBMIT_STORE_INFO` 新建「视觉生成」会话（`session-visual`），`CONFIRM_PROMPT` 只改 phase，不修改 `activeSessionId`。
2. **阶段完成生成子会话**：`CONFIRM_TEMPLATE`（店铺装修）、`SUBMIT_STORE_INFO`（视觉生成）、`APPROVE_IMAGE`（部署小程序）通过 `createStepSession` 新建 `kind:'step'` 会话，旧会话 `status` 置 `done`，新会话首条为 `system` 交接消息（`buildHandoff` 产物）。左侧最终为：主会话 → 店铺装修 → 视觉生成 → 部署小程序。
3. **左侧会话树 = `sessions` 数组顺序**，主会话在前、阶段会话按创建顺序追加。
4. **必选功能不可取消**：`REQUIRED_FEATURE_IDS` 来自 `catalog.mjs` 的 `required` 字段。
5. **消息 id 连续**：由 `state.seq` 递增生成，跨会话不重复。

## 7. 交互与动画

- **逐条弹出**：`useSequentialReveal` 按 `delay`（默认 720ms）逐条递增 `visibleCount`；`instant` 消息立即显示（用于用户输入）。
- **三点加载**：`TypingDots` 使用 `dot-pulse`，三个点 `animation-delay` 分别为 0 / 0.16s / 0.32s，实现逐个高亮。
- **跳过框**：命名后出现灰底「已经了解？想跳过」+ 紫色「跳过」按钮；`ONBOARDING` 且已命名时可见，5.2s 后自动进入功能选择，也可手动提前跳过。定位由 `App.jsx` 的 `.workspace-skip` 包裹层负责居中，`SkipNotice` 自身**不使用 transform 定位**（避免与 `pop-in` 动画争用 transform）。
- **构建上移**：进入 `building` 时 `chat-stream` 播放 `lift-out`，`BuildLoading` 以 `rise-in` 覆盖中栏；`BUILD_READY` 后移除动画类恢复消息流。
- **实时预览**：`TemplateGallery` 的候选卡片与选中详情都用 `MiniProgramPreview` 真实渲染小程序页面；切换模板 / 风格会立即重绘，`full` 模式可点按底部标签切换首页 / 菜单 / 订单。
- **满意确认**：`TemplateGallery` 内置 `SatisfactionPrompt`（「对于当前页面满意？」+ 紫色「下一步」）。
- **构建/部署进度**：`App.jsx` 中 `setInterval` 推进本地进度，非真实任务。

## 8. 组件契约

| 组件 | props |
| --- | --- |
| `AppShell` | `sidebar, main, panel` |
| `TitleBar` | `title, caption, badge, onReset` |
| `Sidebar` | `appName, sessions, activeSessionId, currentStoreName, onStartOnboarding, onSelectSession, onReset` |
| `RightPanel` | `meta:{label,caption}, cards:[{id,type,icon,tone,title,body,items,image,node}]`；`node` 用于内嵌 React 节点（如实时预览） |
| `ChatStream` | `messages, revealKey, children` |
| `MessageBubble` | `message` |
| `TypingDots` | `label` |
| `Composer` | `value, placeholder, submitLabel, disabled, hint, onChange, onSubmit` |
| `SkipNotice` | `visible, question, action, onSkip` |
| `HomeStage` | `greeting, hint, onStart` |
| `FeaturePicker` | `groups, features, selectedIds, requiredIds, onToggle, custom, onCustomChange, onCustomize, busy` |
| `BuildLoading` | `title, message, steps, progress, active` |
| `TemplateGallery` | `candidates, selectedId, onSelect, onConfirm, theme, storeName, features` |
| `MiniProgramPreview` | `template, theme, storeName, features, size:'full'\|'compact'`；纯 DOM 实时渲染，无图片依赖 |
| `SatisfactionPrompt` | `question, action, onConfirm, disabled` |
| `StoreInfoStep` | `store, storeTypes, styles, styleId, onFieldChange, onStyleChange, onSubmit` |
| `PromptStudio` | `prompt, tips, rounds, busy, onPromptChange, onFeedback, onConfirm` |
| `ImageReview` | `image, rounds, busy, onFeedback, onRegenerate, onApprove` |
| `DeployStep` | `status, steps, step, progress, storeName, templateName, styleName` |

注意：`StoreInfoStep` 的「一句话介绍」字段名是 `intro`，而状态机里叫 `notes`；`App.jsx` 在传入时做了 `{ ...store, intro: store.notes }` 映射，回写时把 `intro` 映射回 `notes`。

## 9. 视觉设计 token

定义在 `src/styles/tokens.css`：

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#faf9f7` | 主背景（暖白） |
| `--bg-elev` | `#ffffff` | 卡片/右栏 |
| `--bg-rail` | `#f6f4f0` | 左栏 |
| `--ink` | `#1f1d1a` | 主文字 |
| `--muted` | `#8c887f` | 次文字 |
| `--line` | `#e9e5df` | 分割线 |
| `--accent` | `#6d5efc` | 紫色主 CTA |
| `--accent-soft` | `#efeafe` | 紫色浅底 |
| `--gray-box` | `#f1efeb` | 跳过框灰底 |
| `--radius*` / `--shadow*` | — | 圆角与阴影层级 |

全局 keyframes：`fade-rise`、`pop-in`、`dot-pulse`、`lift-out`、`rise-in`、`spin`、`sheen`。

## 10. 占位服务与后端替换点

`src/services/agentService.js`：

| 函数 | 当前行为 | 后端接手后 |
| --- | --- | --- |
| `buildTemplateCandidates({selectedFeatures, customPrompt})` | 本地规则匹配 + 延时 1.6s | 调模板候选接口 |
| `composePrompt({store, styleId})` | 模板化文案 | 调提示词生成接口 |
| `revisePrompt({base, feedback})` | 文本拼接 | 调多轮提示词接口 |
| `generateImage({prompt, seed})` | 本地 SVG 占位 | 调异步生图任务 |
| `reviseImage({prompt, seed})` | 本地 SVG 占位 | 调生图迭代接口 |

替换时保持函数签名与返回结构即可，`App.jsx` 无需改动。

## 11. 如何扩展

**新增一个阶段**：

1. `state/constants.mjs` 增加 `PHASES.*` 与 `PHASE_META`。
2. `state/sessionMachine.mjs` 增加 action 分支（保持纯函数）。
3. `App.jsx` 的 `renderStage()` 与 `buildPanelCards()` 增加分支；必要时加入 `COMPOSER_PHASES`。
4. 新增组件放在对应分组，CSS 使用独立前缀。
5. 在 `test/session-machine.test.cjs` 增加迁移测试。

**新增一个功能项**：改 `domain/catalog.mjs` 的 `features` 数组，必选/可选由 `required` 决定，`FeaturePicker` 自动渲染分组。

**接真实后端**：只改 `services/agentService.js`，并处理加载/错误态；不要把 fetch 写进组件。

## 12. 已知边界

- 部署步骤为演示动画，**不导出**小程序工程；`desktop/main.cjs` 的 `exportProject` IPC 仍存在但未被 UI 调用。
- 无真实大模型、无真实生图，全部本地占位。
- 无会话持久化，刷新即丢失。
- 无登录与鉴权。
- 旧 `src/styles.css` 与 `src/services/imageService.js` 未被新 UI 使用，保留但可清理。
- 未做人工视觉走查与多分辨率适配验证；响应式仅有 `1180px` 断点（表单单列）。

## 13. 给下一个 AI 的建议

1. 先执行 `npm test` 与 `npm run build`，确认基线。
2. 在 `npm run desktop:dev` 中逐阶段走查：命名 → 介绍 → 功能 → 构建 → 模板 → 店铺 → 提示词 → 审核 → 部署。
3. 桌面生成器云端接口见 `docs/后端待实现接口清单.md`；整个后端的阶段和套餐见 `docs/后端实现方案与套餐.md`。点餐业务接口以 `docs/api.md` 为准。
4. 保持 reducer 纯函数与现有 20 项测试通过；新增行为同步补测试。

## 14. 2026-10-31 修订记录

针对首轮效果反馈的三项修改：

1. **会话拆分**：`SUBMIT_STORE_INFO` 现在新建「视觉生成」会话（`session-visual`），生图提示词与效果审核都在该会话内完成；`APPROVE_IMAGE` 再新建「部署小程序」会话。左侧会话树为「主会话 → 店铺装修 → 视觉生成 → 部署小程序」。
2. **实时小程序预览**：新增 `src/components/preview/MiniProgramPreview.jsx` 与 `src/styles/preview.css`。模板候选卡片、选中详情、店铺装修阶段的右栏都使用真实 DOM 渲染的小程序页面（按模板 layout、风格配色、功能项实时变化），不再使用静态占位图；`full` 模式可点按底部标签切换首页 / 菜单 / 订单。
3. **跳过框定位**：改为 `App.jsx` 的 `.workspace-skip` 包裹层负责居中，`SkipNotice` 不再用 `transform: translateX(-50%)` 定位，避免被自身 `pop-in` 动画覆盖。

其他调整：

- 功能选择阶段不再显示底部 `Composer`，只保留 `FeaturePicker` 内联的「没有想要的功能？」输入，避免两处重复输入。
- `RightPanel` 新增 `node` 字段，可在卡片内嵌 React 节点（用于实时预览）。
- 测试从 18 项增加到 20 项，新增「视觉生成独立会话」「提示词与审核同会话」两条断言。
- 验证：`npm test` 20/20 通过；`npm run build` 成功（1604 modules，CSS 42.20 kB / JS 207.59 kB）。