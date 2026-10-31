# 智能开店桌面端 · 当前架构与扩展指引

> 面向后续 AI / 开发者。本文描述当前桌面代码，不再逐轮堆积构建历史。
> 项目全局现状先读 `docs/项目概览.md`，未提交工作读 `docs/handoff/当前工作区交接.md`。

## 1. 当前形态

桌面端是 Electron + React 的三栏会话式工作台：

- 左栏：品牌、“轻启”、项目和主会话/阶段会话树。
- 中栏：会话流、阶段面板、固定推进操作和 Composer。
- 右栏：上下文卡、模板与实时效果预览等。

会话树固定为：主会话 → 店铺装修 → 视觉生成 → 部署小程序。机械引导、DeepSeek 资料收集、本地模板规则匹配和视觉占位可以共存，UI 必须准确标识各自能力，不把占位服务称为真实云端任务。

## 2. 技术栈与运行

- Electron 33、React 18、Vite 6、lucide-react。
- 原生 CSS，按职责拆分，由 `src/styles/index.css` 聚合。
- 不引入路由库或全局状态库，使用 `useReducer` + 纯函数 reducer。
- 根目录测试使用 `node:test`，不假设存在 React 组件渲染测试。

```powershell
npm install
npm run desktop:dev
npm run dev
npm test
npm run build
```

开发态 `/api` 由 Vite 代理到本机 NestJS。Agent HTTP 模式由 `VITE_AGENT_TRANSPORT=http` 等公开变量启用，密钥不能放入 Vite 变量。

## 3. 目录与职责

```text
src/
  App.jsx                      组合根：服务调用、状态接线和阶段渲染
  state/
    constants.mjs              phase、角色、会话类型和文案
    sessionMachine.mjs         纯 reducer、初始状态和 selectors
  domain/
    agentDraft.mjs             开店草稿、校验、金额和契约投影
    catalog.mjs                当前静态功能/模板/主题目录
    onboardingScript.mjs       固定引导脚本
    handoff.mjs                阶段会话交接消息
    storeBrief.mjs             门店和风格预设
  services/
    agentTurn/                 资料收集唯一服务入口及 mock/http transport
    agentService.js            模板、提示词、生图等本地占位服务
  hooks/
    useSequentialReveal.js     消息逐条揭示
    revealTransition.mjs       revealKey/flushKey 调度纯函数
  components/
    layout/                    三栏骨架、侧栏、标题栏、右栏
    chat/                      会话流、气泡、Composer、跳过提示
    flow/                      首页、功能、构建、模板、满意确认
    build/                     店铺表单、提示词、审核、部署演示
    agent/                     草稿面板、编辑器、摘要、固定操作条
    preview/                   React 小程序效果预览
  styles/                      Token 与各模块 CSS
desktop/                       Electron 主进程和有限 IPC
scripts/                       本地模板复制与配置导出
```

## 4. 分层纪律

```text
App.jsx / 页面组合根
  → 调用 service
  → dispatch action
  → 将 state 和回调作为 props 传给组件

React Component
  → 只接收 props
  → 只通过回调/事件表达用户意图
```

- 组件不直接 `fetch`、不 import service、不读取全局业务状态、不计算订单金额。
- reducer 和 domain 不执行 IO、不读随机数或时间；异步结果通过 action 进入状态。
- 服务层统一处理 transport、超时、响应校验和错误归一化。
- 价格对外只用 `priceCents`，`priceText` 只允许存在于本地编辑态。

## 5. 会话状态与关键不变量

主要状态切片：

```text
seq / phase / activeSessionId / sessions
store / features / build / visual / deploy
agentDraft / agent
```

phase 包括 home、onboarding、features、building、template-pick、store-info、prompt-studio、image-review、deploy。

必须保持：

1. `CONFIRM_TEMPLATE` 新建店铺装修会话。
2. `SUBMIT_STORE_INFO` 新建视觉生成会话。
3. `CONFIRM_PROMPT` 只切换 phase，提示词与效果审核仍共用视觉生成会话。
4. `APPROVE_IMAGE` 新建部署小程序会话。
5. 阶段会话首条 system 消息来自 `buildHandoff`，旧会话标记 done。
6. 消息 ID 由全局 `seq` 稳定递增，必选功能不可取消。
7. STORE_INFO 的 Agent 子状态不新增顶层 phase。

## 6. 消息揭示与跳过

`useSequentialReveal` 默认按消息 delay 逐条增加 `visibleCount`，用户消息可 instant 显示。

为支持“跳过后一次性展示全部剩余提示”，会话包含 `revealFlush`：

- `SKIP_INTRO` 递增当前会话 `revealFlush`，保留所有消息。
- `ChatStream` 将 `flushKey` 传给 hook。
- `revealTransition.mjs` 决定：会话切换优先归零；同会话 flushKey 变化则补齐到 messageCount；普通追加不打断节奏。
- 手动跳过和既有自动跳过共用 SKIP_INTRO 语义。

修改此逻辑必须同时覆盖“会话切换”和“flush”测试，不能只核对最终消息数量。

## 7. STORE_INFO 资料收集与固定操作

资料收集链路：

```text
自然语言 / 结构化编辑
→ agentTurnService
→ mock 或 POST /api/v1/agent/turn
→ AgentDraft 本地校验
→ collecting / reviewing / confirmed
```

前端不信任服务端 ready 状态，仍以本地 `validateAgentDraft` 为最终确认门槛。请求期间 DraftEditor 只读，Composer 保持输入能力；失败后可手动重试。

“添加菜品”和“资料无误，继续”放在 `.workspace-actions`，位于滚动会话区之外、Composer 之前：

- 菜品增多不会把主操作推出视口。
- requesting 禁用推进。
- reviewing 且校验通过才允许确认。
- 草稿编辑器收起时仍保留推进操作。

Agent 后端真实 Provider 是 DeepSeek；ModelArts/盘古、Skill、多 Agent 和动态代码生成尚未接入。完整契约见 `docs/agent-turn-contract.md`。

## 8. 模板、预览和导出边界

当前 `catalog.mjs` 提供静态功能、模板和主题，`agentService.js` 用本地规则生成候选。`MiniProgramPreview` 使用 React DOM 实时呈现效果，不是 WXML 渲染器。

本地 `generator:export` IPC 和 `scripts/generate-mini-program.cjs` 已存在，但当前会话式 UI 的部署进度只是动画，没有调用真实导出。真实导出仍可用 `npm run mini:example` 独立验证。

后续模板平台必须以同一 CompositionPlan 驱动桌面预览和确定性 Composer；React 预览始终只是快速效果预览，微信开发者工具才是原生运行验收。

## 9. 扩展方式

### 新增阶段

1. 在 constants 增加 phase 和文案。
2. 在 reducer 增加纯状态迁移和测试。
3. 在 App 组合根接阶段面板与服务。
4. 组件使用独立目录和 CSS 前缀，不在组件中触网。
5. 更新本文件、项目概览和活动交接。

### 新增模板资产

不要只向 `catalog.mjs` 添加名称和截图。模板库落地后必须同时提供可信源码、Manifest、兼容声明、预览数据、组合约束和测试，由 Composer 生成真实工程。详见 `docs/模板库与组合生成规划.md`。

### 替换占位服务

保持服务入口返回结构，补充加载、失败、取消和重试；组件无需知道 HTTP 细节。长任务需要明确状态机，不得继续用无真实任务的进度动画冒充完成。

## 10. 当前验证重点

- 根目录 `npm test`、`npm run build`。
- 修改导出时运行 `npm run test:generator`，并检查真实生成工程。
- 桌面 IPC 修改时补齐 `test/desktop-contract.test.cjs`，当前 `npm run test:desktop` 因文件缺失不可用。
- 需要人工走查：跳过动画、STORE_INFO 固定操作、窄窗口、多分辨率、真实导出和安装包。
- 微信小程序产物必须在微信开发者工具中另行编译与预览。