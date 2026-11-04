# 全链路 Agent 打通计划（full-chain-agent）

- **计划修订**：P1
- **目标文件**：`.codeartsdoer/plans/full-chain-agent/plan.md`
- **计划状态**：接口契约冻结后按任务分批派发
- **适用范围**：桌面端 React 渲染层、NestJS `server/`、Composer 导出链、微信小程序模板资产
- **文档语言**：中文；代码标识符、路径、契约 ID 保持英文原样

## 1. Requirements

> 本章只描述“做什么”和可验收行为，不写接口签名、文件结构或实现算法；技术细节统一见第 2 章。
> 需求 ID 稳定不变；验收标准采用 EARS 句式（触发词保留英文，变量部分用中文）。

### R1 垂直全链路打通（本轮最高优先级）

**R1.1** 系统 SHALL 支持店主在桌面端完成一条完整链路：本地对话输入 → 获得 3 套模板候选 → 对话式修改当前模板 → 实时预览变化 → 上传图片与门店信息由 agent 生成草稿 → 店主手工修改 → 确认 → 导出可编译的小程序工程。

**R1.2** 系统 SHALL 在链路的每个阶段展示明确的进行中、成功或失败状态；当某一步失败时，系统 SHALL 保留上一步可用结果并给出可读错误，不得静默跳过或伪装成功。

**R1.3** When 导出完成，the 导出工程 SHALL 与导出前预览使用同一份展示事实（主题色、尺寸档位、区块位置与文案），不得出现“预览是 A、导出是 B”。

**R1.4** 系统 SHALL 保持已有的“不满意 → 重新用语言描述候选”入口可用，不得因新增对话修改能力而回退该能力。

### R2 三套模板的展示前端

**R2.1** The 模板选择页 SHALL 始终展示现有的 3 套模板候选（`warm-bistro`、`modern-coffee`、`signature-kitchen`），不得新增或删除模板数量。

**R2.2** When 用户点选任一模板卡片，the 页面 SHALL 立即按该模板的布局、主题与容器结构刷新预览，无需刷新页面或重新请求。

**R2.3** The 模板选择页 SHALL 提供并排对比能力，允许用户同时查看任意两套模板的完整预览。

**R2.4** When 用户在模板页完成一次对话式修改，the 页面 SHALL 展示本次修改的可读变更清单（改了什么、从什么改成什么），并让预览立即反映新结果。

**R2.5** If 模型不可用、请求超时或返回内容无法解析，the 页面 SHALL 保留上一版模板展示状态，并显示醒目的失败提示，不得显示“已修改成功”。

### R3 对话式修改模板（Agent 能力）

**R3.1** When 用户在模板页输入一句自然语言修改要求，the Agent SHALL 返回一份仅包含白名单字段的展示补丁，并返回逐条中文变更说明。

**R3.2** The Agent SHALL 支持多轮累积：后一轮修改基于前一轮已接受的结果继续应用，不得丢失前轮结果。

**R3.3** When 展示补丁被接受，the 前端 SHALL 立即刷新预览，并把这次变更纳入既有的撤销/重做栈（`Ctrl+Z` / `Ctrl+Shift+Z`，栈深 20）。

**R3.4** If 补丁包含未知键、非法颜色、非法区块、超长文案、原型污染键、URL/HTML/CSS/脚本或超深超大结构，the 服务端 SHALL 整包拒绝并返回 422；系统 SHALL NOT 应用任何部分字段。

**R3.5** The Agent SHALL 只能修改以下范围：7 个主题色 token、首页/菜单页已有区块的位置顺序、三档组件尺寸（`sm|md|lg`）、以及 `storeProfile` 内的店名/品类/口号/菜品名称与描述。

**R3.6** The Agent SHALL NOT 增减组件数量、新增组件类型、新增 layout 变体、决定菜品价格、写入任意样式文本或执行任何代码。

**R3.7** The 服务端 SHALL 重新校验并重新计算补丁与变更说明，不得直接信任模型输出的“变更说明”或“是否成功”。

**R3.8** When 用户切换模板，the 系统 SHALL 只保留与新模板兼容的展示补丁；若补丁属于旧模板且会改变新模板语义，系统 SHALL 重置该补丁并在界面上说明。

**验收示例**

- 用户说“主色换成墨绿、商品卡小一点”：补丁只含 `theme.primaryColor` 与 `sizes.productCard`；预览立即变化；变更清单逐条列出旧值→新值。
- 用户说“把首页海报挪到菜单页”：若当前模板使用海报轮播，系统 SHALL 把它放到菜单页已有插槽并保持导出可用；若当前模板没有该区块，系统 SHALL 返回 422 并说明“当前模板没有可移动的区块”，不得假装成功。
- 模型返回 Markdown 或非 JSON：系统 SHALL 保留上一版并显示红色错误，撤销栈不新增记录。

### R4 图片输入与 Agent 自动填表

**R4.1** When 用户上传一张菜单或菜品照片，the Agent SHALL 识别其中的菜名、可读价格与可选描述，生成菜品草稿；价格 SHALL 为整数分（无法识别时留空，不得编造）。

**R4.2** When 用户上传一张门店环境照片，the 系统 SHALL 把它作为预览主视觉素材与生图提示词参考，SHALL NOT 对其做菜品识别。

**R4.3** The 上传界面 SHALL 在上传前压缩图片，并明确区分“菜单/菜品照”和“门店环境照”两类；上传失败时 SHALL 显示可见错误。

**R4.4** When Agent 完成填表，the 店主 SHALL 能在草稿编辑区逐项修改菜品名称、价格、描述与门店信息；修改后预览 SHALL 同步更新。

**R4.5** The 系统 SHALL 限制图片张数、单张解码后大小与请求体大小；When 超过限制，the 服务端 SHALL 返回可读的 413/422 错误，前端 SHALL 显示“图片过大，请压缩后重试”，不得白屏。

**R4.6** The 服务端 SHALL NOT 把 API Key、图片 base64 或完整模型原始响应写入日志、错误响应或前端状态。

**R4.7** When 视觉模型不可用，the 系统 SHALL 保留已填写的草稿，显示失败提示，并允许用户手动继续填写，不得用假识别结果冒充成功。

### R5 生图提示词约束（本轮不阻塞）

**R5.1** The 系统 SHALL 为 `menu`、`catalog`、`editorial` 三套模板分别提供结构化的生图提示词约束（构图、主体、色调、光源、留白、禁止项）。

**R5.2** The 提示词约束 SHALL 输出可被 `composePrompt` 直接消费的结构化对象，并同时生成不超过 1200 字符的最终提示词文本。

**R5.3** The 禁止项 SHALL 至少包含：不得出现可读文字/水印、不得出现人物正脸、不得出现品牌 Logo、不得出现违规或医疗功效暗示。

**R5.4** The 本轮 SHALL NOT 调用任何收费生图接口；占位图 SHALL 继续标注 `provider:'local-demo'`，不得伪装成 AI 生成。

**R5.5** The 系统 SHALL 在文档与界面中明确告知：接入真实生图模型需要用户提供服务商、Base URL、模型名与 API Key。

### R6 真实渲染预览通道（人工步骤明确）

**R6.1** The 应用 SHALL 提供“在微信开发者工具打开已生成工程”的入口，并在开发者工具不可用时给出可读原因与官方下载指引。

**R6.2** The 应用 SHALL 提供截图回传面板：用户可在微信开发者工具中截图后选择本地图片，在应用内查看并与 React 预览并排对照。

**R6.3** The 计划与界面 SHALL 明确标注：微信开发者工具导入/编译/真机预览、AppID 登录、IDE 代理设置属于人工步骤，不得声称应用内可完成真实微信运行时实时渲染。

**R6.4** 已知环境阻塞（IDE `proxyType=SYSTEM` 可能导致 CLI `auto` 卡 AppID 校验）SHALL 作为人工步骤写入交付说明，不得写成自动化已解决。

### R7 安全、兼容与工程约束

**R7.1** The 系统 SHALL 保持已冻结的 `agent-turn.v1` 请求/响应语义不变；新增能力 SHALL 通过 `agent-turn.v2` 或独立契约提供。

**R7.2** The 展示补丁 SHALL 在前端与服务端双重校验；服务端校验失败时 SHALL NOT 产生部分写入。

**R7.3** The API Key SHALL 只存在于 `server/.env` 或服务端密钥管理；SHALL NOT 出现在前端包、日志、错误响应、导出工程或文档示例中。

**R7.4** The 系统 SHALL NOT 增减组件数量、新增组件类型、修改 Composer 的确定性输出语义；同一输入重复导出 SHALL 得到相同结果。

**R7.5** The 系统 SHALL 继续通过现有门禁：`npm test`、`npm run build`、`npm run registry:check`、`npm run mini:check`、`npm run test:desktop`、`server` 的 `npm test`。

### R8 验证与验收

**R8.1** 所有实现任务 SHALL 在交付前完成其声明的本地检查；未执行的检查 SHALL 明确标记为“未验证”，不得写成“已通过”。

**R8.2** 系统 SHALL 由独立验收角色执行至少一次真实端到端走查，并输出 `VERDICT: PASS|FAIL` 与证据（命令、退出码、截图路径、失败原文）。

**R8.3** If 任何必需检查未通过或未执行，the 验收结论 SHALL 为 `FAIL` 或 `INCOMPLETE`，不得以“代码已写完”代替验收通过。

### 需求覆盖说明

| 需求 | 主要实现任务 | 主要验证任务 |
| --- | --- | --- |
| R1、R2 | T2、T4、T14 | T15、T16 |
| R3 | T1、T3、T4、T7、T10、T11、T14 | T15、T16 |
| R4 | T1、T5、T8、T9、T14 | T15、T16 |
| R5 | T13 | T15、T16 |
| R6 | T6、T14 | T16（人工步骤） |
| R7 | T1、T7、T8、T9、T10、T11、T12 | T15 |
| R8 | 全部 | T15、T16 |

## 2. Technical Design

### 2.1 Architecture and Implementation Boundaries

#### 2.1.1 现状基线（已核实，不重复探索）

| 层 | 现有事实 | 本计划是否改造 |
| --- | --- | --- |
| 桌面渲染层 | React + Vite；`src/state/sessionMachine.mjs` 已有 `TEMPLATE_PICK → STORE_INFO → PROMPT_STUDIO → IMAGE_REVIEW → DEPLOY` 链路；撤销栈深 20 | 扩展：新增 presentation 切片与对话修改动作 |
| 预览投影 | `src/composition/planFromSession.mjs` 产出 `composition.v1` Plan；`src/composition/previewViewModel.mjs` 按 `slotId` 投影 `blocks[]`；`MiniProgramPreview.jsx` 复刻渲染 | 扩展：消费 `presentationTokens`、区块落位与尺寸档位 |
| 导出链 | `scripts/composer/*`（CJS）做白名单校验 → 解析 → 确定性生成；`scripts/generate-mini-program.cjs` 已标记 deprecated，不在主链 | 扩展：Plan 增加 `presentationTokens`，emit 输出 CSS 变量与插槽 props |
| 模板资产 | `templates/base/ordering-base/1.0.0`、`templates/features/poster-carousel/1.0.0`、`templates/recipes/{order-classic,order-poster}/1.0.0`、`templates/registry/schema/composition.v1.json` | 扩展：新增 `menu-hero` 插槽、海报 `size` prop、主题 CSS 变量 |
| 后端 Agent | NestJS `server/src/agent` 只有 `POST /api/v1/agent/turn`（`agent-turn.v1`）；DeepSeek Provider 当前发送纯字符串 content | 扩展：v2 多模态 + 展示补丁校验 + 模板修改 + 候选推荐 |
| 生图 | `server/src/generation` 已有真实 imagelfk 适配，但 `IMAGE_PROVIDER_NAME=not-configured`、`IMAGE_MODEL_NAME` 为空 | 本轮不接入；只产出提示词约束 |
| 真实预览 | `desktop/main.cjs` 已有 `generator:pick-materials`、`generator:open-path`、`devtools:probe` 只读探测 | 扩展：打开已导出工程、截图回传面板 |

#### 2.1.2 目标链路与数据流

```
[模板页]
用户输入/上传图片
   ↓
TEMPLATE_PICK 会话 → agent-template-candidates.v1（排序 + 理由）
   ↓ 选中候选 templateId
TEMPLATE_PICK 对话 → agent-template-revise.v1（presentationPatch + changes）
   ↓ 前端校验 → 写入 state.presentation → 立即重渲染
planFromSession（theme 覆盖 + 尺寸 token + 区块落位）
   ↓
previewViewModel → MiniProgramPreview（毫秒级 React 复刻预览）
   ↓ 同一份 Plan
Composer validate → resolve → emit → 导出工程（真实微信小程序）
   ↓ 人工步骤
微信开发者工具打开 + 截图回传 → RealPreviewPanel 对照

[店铺资料页]
上传菜单照/环境照 → 前端压缩分类 → agent-turn.v2（多模态 content parts）
   ↓
服务端校验图片 → DeepSeek 视觉抽取 → ContractDraft 草稿
   ↓ 店主手工修改 → 确认 → 进入导出链路
```

#### 2.1.3 组件边界与责任

| 边界 | 负责 | 不负责 |
| --- | --- | --- |
| 展示补丁领域层（前端） | 白名单合并、字段裁剪、撤销入栈、可读变更 | 调用模型、写导出工程 |
| 模板修改服务（前端） | 单飞请求、失败保留上一版、错误态 | 绕过服务端自行改补丁 |
| 后端展示能力 | 二次校验、重算变更、模型调用、错误码 | 写业务库、发布、执行代码 |
| 后端视觉能力 | 图片校验、多模态 content parts、草稿抽取 | 决定 `readyForReview`、写库 |
| Plan 投影 | 把已接受状态投影成 `composition.v1` | 接受任意 patch 字段 |
| Composer | 白名单校验、确定性生成、CSS 变量与 props 落盘 | 读取前端状态、调用模型 |
| 真实预览通道 | 打开已导出工程、截图导入与展示 | 声称应用内实时渲染微信运行时 |

#### 2.1.4 关键既有约束（禁止破坏）

1. `recipeCatalog.cloneProps()` 是严格白名单；任何新 props 字段不在白名单会被静默丢弃，预览与导出会漂移。
2. Composer `resolve.cjs` 对未在 Feature Pack `interface.props` 声明的 prop 返回 `PROP_UNKNOWN`。
3. Composer `validateThemeTokens` 对 Base 未声明的主题 Token 返回 `THEME_TOKEN_UNKNOWN`；尺寸不得塞进 `themeTokens`。
4. `templates/registry/registry.lock.json` 的 `contentDigest` 覆盖资产目录树；修改任何 `templates/base|features|recipes` 文件后必须重新冻结。
5. `src/App.jsx` 是单文件接线点，必须只有一个写入者；`test/app-imports.test.cjs` 会因未导入标识符直接失败。
6. `agent-turn.v1` 已冻结；v2 不得改变 v1 的请求校验与响应字段含义。

#### 2.1.5 技术决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 版本化方式 | 同一路由 `POST /api/v1/agent/turn` 按 `contractVersion` 分派 v1/v2 | 与 `docs/后端待实现接口清单.md` §19.1 建议一致；避免重复 Controller；v1 请求仍返回 v1 形状 |
| 模板修改接口 | 独立路由 `POST /api/v1/agent/template-revise`，契约 `agent-template-revise.v1` | 展示修改与资料抽取的校验/失败语义不同；独立接口便于单独限流与测试 |
| 模板推荐接口 | 独立路由 `POST /api/v1/agent/template-candidates`，契约 `agent-template-candidates.v1` | 替换本地假延时与编造 score；服务端只给排序与理由，score 仍由前端确定性计算 |
| 尺寸 token 载体 | Plan 顶层 `presentationTokens` + 海报 `props.size` | 尺寸不属于主题色；props 可被 Feature Pack 消费，顶层 token 可被 Base 页面 CSS 变量消费 |
| 跨页移动 | 新增 Base 插槽 `menu-hero`（`accepts` 含 `feature-pack`） | 现有 `menu-aside` 只接受 `ui-block`，海报无法移动到菜单页；新增插槽不新增组件 |
| 服务端会话状态 | 本轮保持无状态；`basePatch` 随请求上传，前端单飞 + `requestId` 忽略晚响应 | 不引入新的持久化表；避免把未确认草稿写成业务数据 |
| 真实生图 | 本轮不接入 | 用户尚未提供服务商与 Key；只交付提示词约束，避免阻塞主链路 |
| 真实微信预览 | 人工步骤 + 截图回传 | 已知 IDE 代理/AppID 阻塞；不得虚构应用内实时渲染 |

### 2.2 Interface Contracts

> 计划修订：**P1**。下列契约在写入后冻结；后续只允许向后兼容的澄清。任何不兼容变更必须先经团队负责人协调受影响的 provider/consumer。
> 状态说明：`READY` 表示定义完整、可直接开工；`BLOCKED` 表示存在未决外部决策。

#### 2.2.0 契约索引

| 契约 ID@修订 | 类别 | Provider（任务） | Consumer（任务） | 需求 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `C-SIZE-TOKENS@1` | 共享数据表 | T1（`templates/presentation/size-tokens.v1.json`） | T2、T10、T11、T13 | R2、R3 | READY |
| `C-PLAN-PRESENTATION@1` | 持久化/Plan 结构 | T2（投影）、T10（Composer 消费） | T11、T12、T15 | R1.3、R3 | READY |
| `C-SESSION-PRESENTATION@1` | 前端状态机 | T3 | T4、T14 | R3.2、R3.3 | READY |
| `C-PRESENTATION-PATCH@1` | 共享类型/共享行为 | T1（前端）、T7（服务端） | T2、T3、T4、T10、T11、T14 | R3 | READY |
| `C-TEMPLATE-GALLERY@1` | View props | T4 | T14 | R2 | READY |
| `C-VISION-UPLOADER@1` | View props | T1（纯函数/限制）、T5（组件/压缩） | T5、T14 | R4.1–R4.5 | READY |
| `C-AGENT-TURN-V2@1` | HTTP/多模态 | T8 | T5、T14 | R4 | READY |
| `C-TEMPLATE-REVISE@1` | HTTP | T7 | T4、T14 | R3 | READY |
| `C-TEMPLATE-CANDIDATES@1` | HTTP | T7 | T13 | R1.1、R2.1 | READY |
| `C-IMAGE-PROMPT-SPEC@1` | 共享数据/可调用 | T13 | T13（`agentService.js`） | R5 | READY |
| `C-REAL-PREVIEW@1` | 桌面 IPC/View props | T6 | T14 | R6 | READY |
| `C-SERVER-ENV@1` | 配置 | T9 | T8、T7 | R4.5、R7.3 | READY |

---

#### 2.2.1 `C-SIZE-TOKENS@1`（`preview-size-tokens.v1`）

**Provider**：T1 创建 `templates/presentation/size-tokens.v1.json`，作为预览与导出的唯一尺寸事实。
**Consumer**：T2（React 预览）、T10（Composer 读取并输出 CSS 变量）、T11（小程序样式）、T13（生图提示词构图比例参考）。

**精确内容**

```json
{
  "contract": "preview-size-tokens.v1",
  "status": "frozen",
  "sizes": {
    "homeHero": {
      "sm": { "px": 72,  "rpx": 150, "label": "紧凑" },
      "md": { "px": 92,  "rpx": 190, "label": "标准" },
      "lg": { "px": 120, "rpx": 250, "label": "醒目" }
    },
    "productCard": {
      "sm": { "px": 52, "rpx": 110, "label": "紧凑" },
      "md": { "px": 68, "rpx": 140, "label": "标准" },
      "lg": { "px": 88, "rpx": 180, "label": "大图" }
    },
    "carousel": {
      "sm": { "px": 100, "rpx": 200, "label": "矮" },
      "md": { "px": 118, "rpx": 240, "label": "标准" },
      "lg": { "px": 150, "rpx": 310, "label": "高" }
    }
  },
  "defaults": {
    "homeHero": "md",
    "productCard": "md",
    "carousel": "md"
  }
}
```

**规则**

1. 只允许上述 3 组 × 3 档；不得出现任意数值 token。
2. `px` 只用于 React 预览，`rpx` 只用于小程序导出；两边不得交叉使用。
3. 缺省值固定为 `md`；Plan 缺省 `presentationTokens` 时按 `defaults` 补齐。
4. `carousel` 档位通过海报组件 `props.size` 传递，不写入 `presentationTokens`，避免双写。

---

#### 2.2.2 `C-PLAN-PRESENTATION@1`（`composition.v1` 扩展）

**Provider**：T2（`src/composition/planFromSession.mjs` 产出）、T10（Composer 校验与消费）。
**Consumer**：T11（emit/模板）、T12（门禁）、T15（集成验证）。

**Plan 新增可选字段**

```json
{
  "presentationTokens": {
    "homeHeroSize": "md",
    "productCardSize": "md"
  },
  "slotOrder": [
    { "featureId": "poster-carousel", "pageId": "home", "slotId": "home-hero" }
  ]
}
```

- `presentationTokens` 为**可选**字段，不加入 `required`；缺省时等价于 `{ "homeHeroSize":"md", "productCardSize":"md" }`。
- 两个值只能是 `sm|md|lg`。
- `slotOrder` 为**可选**字段；缺省表示使用 `features[].slots[]` 的声明落位。存在时必须是当前已占用 feature 的完整排列（每个 `featureId` 恰好一次，无重复）。
- 现有 4 个必填主题色 token 与 7 个 Base 主题 token 语义不变；**尺寸不得放进 `themeTokens`**（否则 Composer 返回 `THEME_TOKEN_UNKNOWN`）。

**区块落位（slot placement）**

`plan.features[].slots[]` **保持 Recipe 原样**，不因补丁改写；否则 `poster-carousel.requiresSlots=['home-hero']` 会因移动到 `menu-hero` 触发 `SLOT_REQUIRED_MISSING`。落位由顶层 `slotOrder` 覆盖：

- 校验 `requiresSlots` 时仍使用原始 `features[].slots[]`（保持不变）。
- 校验目标插槽容量/类型时使用 `slotOrder` 的目标 `pageId+slotId`。
- `slotOrder` 中同一目标插槽不得重复。
- 允许的目标插槽（必须与 Base manifest 完全一致）：

| pageId | slotId | accepts | maxItems | 配置键 |
| --- | --- | --- | --- | --- |
| `home` | `home-hero` | `feature-pack`, `ui-block` | 1 | `homeHero` |
| `home` | `home-marketing` | `feature-pack` | 2 | `homeMarketing` |
| `menu` | `menu-aside` | `ui-block` | 1 | `menuAside` |
| `menu` | `menu-hero` | `feature-pack`, `ui-block` | 1 | `menuHero`（T11 新增） |

> 配置键由 `plan.features[].slots[].dataKey` 与 target slotId 的固定映射共同决定；Base manifest 的 slot 声明**不新增 `dataKey` 字段**（现有 `slots` schema 不接受该字段）。

**海报尺寸 props**

`templates/recipes/order-poster/1.0.0/plan.json` 的 `poster-carousel` 插槽新增默认 prop：

```json
{ "size": "md" }
```

- `src/domain/recipeCatalog.mjs` 的 `cloneProps()` 必须把 `size` 加入白名单，否则 `recipe-catalog-sync` 会检测到漂移。
- Feature Pack `templates/features/poster-carousel/1.0.0/manifest.json` 的 `interface.props` 必须声明 `{ "name":"size","type":"string","required":false }`，并在组件 `properties` 中同步声明；否则 Composer 返回 `PROP_UNKNOWN`。

**导出消费**

1. Composer `buildThemeWxss(theme, presentationTokens)` 输出：
   - `--store-home-hero-min-height: <rpx>rpx;`
   - `--store-product-card-min-height: <rpx>rpx;`
2. `resolve` 先按 `features[].slots[]` 校验 `requiresSlots`，再用 `slotOrder` 的目标 `pageId+slotId` 作为 assignment key；目标插槽必须存在且 `accepts` 含该 feature 的 `kind`。
3. `buildSlotsModule()` 使用 `slot.dataKey` 作为配置键（不得再用 slotId 三元表达式），并原样透传 `props.size`；`menu-hero` 对应 `menuHero`。
4. `planDigest` 必须包含 `presentationTokens` 与 `slotOrder`；相同输入重复导出必须得到相同摘要。

**验收示例**

- `modern-coffee` + `homeHeroSize=lg` → 预览 hero 变高；导出 `theme.generated.wxss` 含 `--store-home-hero-min-height: 250rpx;`。
- `signature-kitchen` 把海报移动到 `menu-hero` → 导出 `pages/menu/index.wxml` 的 `@slot:menu-hero` 被替换为 `<poster-carousel>`，`config/slots.generated.js` 出现 `menuHero` 数组。
- 未提供 `presentationTokens` 的旧 Plan → Composer 仍通过校验，输出 `md` 默认值。

---

#### 2.2.3 `C-SESSION-PRESENTATION@1`

**Provider**：T3（`src/state/sessionMachine.mjs`）。
**Consumer**：T4（模板页 UI）、T14（App 接线）。

**状态切片**

```ts
interface PresentationState {
  templateId: string | null;          // 补丁所属候选模板
  patch: PresentationPatch;           // 已接受补丁，缺省 {}
  changes: PresentationChangeItem[];  // 最近一次变更，最多 20
  status: 'idle' | 'revising' | 'failed';
  requestId: string | null;
  lastUtterance: string;
  error: { code: string; message: string } | null;
}
```

初始值：`{ templateId: null, patch: {}, changes: [], status: 'idle', requestId: null, lastUtterance: '', error: null }`。

**动作**

| 动作 | 触发条件 | 语义 |
| --- | --- | --- |
| `TEMPLATE_REVISE_REQUEST { utterance, requestId }` | `phase === TEMPLATE_PICK` 且 `status !== 'revising'` 且 `build.status === 'ready'` | 追加用户消息；`status='revising'`；记录 `lastUtterance/requestId`；清空 `error`；`patch` 不变 |
| `TEMPLATE_REVISE_SUCCESS { requestId, templateId, patch, changes, reply }` | `requestId` 必须等于当前 `presentation.requestId` | `status='idle'`；`patch` 替换为服务端已校验结果；`changes` 截断 20；应用 `copy` 到 `store` 与 `agentDraft`；追加 agent 回复（`reply` 为空时用“已更新 N 项”） |
| `TEMPLATE_REVISE_FAILURE { requestId, error }` | 同上 | `status='failed'`；`patch/changes` 保持上一版；不追加成功消息；`error` 可读 |
| `TEMPLATE_REVISE_CLEAR` | 任意 | 清空 `error`，`status='idle'` |
| `SELECT_TEMPLATE { id }` | 现有动作 | 若 `presentation.templateId !== id` 且 `patch` 非空：重置 `patch={}`、`changes=[]`、`status='idle'`、`error=null`、`templateId=id` |
| `SET_STYLE { id }` | 现有动作 | 用户显式选择风格预设时，移除 `presentation.patch.theme`（保留 sizes/slotOrder/copy），确保用户选择优先于旧的 agent 主题覆盖；变更清单移除 `theme.*` 项 |

**copy 应用映射（只在 SUCCESS 时执行）**

| 补丁字段 | 写入 |
| --- | --- |
| `copy.storeName` | `state.store.name` 与 `state.agentDraft.storeName` |
| `copy.category` | `state.store.type` 与 `state.agentDraft.category` |
| `copy.tagline` | `state.store.notes`（Plan 的 `storeProfile.notes`） |
| `copy.dishes[].name/description` | 按 `id` 更新 `state.agentDraft.dishes[]`；价格不变 |

**撤销/重做**

- `TEMPLATE_REVISE_SUCCESS` 加入 `UNDOABLE_ACTIONS`。
- `undoSnapshot()` 增加 `presentation: cloneJson(state.presentation)`；`store`、`agentDraft` 已存在。
- `undoSnapshot()` 已有的 `build.selectedId` 会随撤销恢复，因此撤销回到旧模板时会同时恢复到该模板的补丁，避免“补丁属于 A、当前选中 B”的不一致。
- `TEMPLATE_REVISE_REQUEST/FAILURE/CLEAR` 不压栈。
- `SELECT_TEMPLATE` 不压栈；重置逻辑在 baseReducer 内完成。

**选择器**

```ts
selectPresentationState(state) => {
  canRevise: boolean;      // phase===TEMPLATE_PICK && build.status==='ready'
  patch: PresentationPatch;
  changes: PresentationChangeItem[];
  status: 'idle'|'revising'|'failed';
  error: {code:string;message:string} | null;
}
```

**验收**

- 连续两轮修改：第二轮请求携带第一轮已接受 `patch`；成功后可连续撤销两次回到初始展示。
- 晚响应（旧 `requestId`）不改变 `patch`、`changes`、`undo`。
- 切换模板后旧补丁不作用于新模板。

#### 2.2.4 `C-PRESENTATION-PATCH@1`（`agent-presentation-patch.v1`）

**Provider**
- 前端：T1 在 `src/domain/presentationPatch.mjs` 实现 `validatePresentationPatch`、`mergePresentationPatch`、`diffPresentationPatch`。
- 服务端：T7 在 `server/src/agent/presentation/presentation-patch.ts` 独立实现同构校验；**不信任模型输出、不 import 前端代码**。

**Consumer**：T2（投影）、T3（状态机）、T4（对话与变更展示）、T10（Composer 校验）、T11（模板道具）、T14（接线）。

**精确类型**

```ts
export type ThemeTokenKey =
  | 'pageBackground' | 'primaryColor' | 'accentColor' | 'textColor'
  | 'tabBarBackground' | 'tabBarColor' | 'tabBarSelectedColor';

export type SizeStep = 'sm' | 'md' | 'lg';

export interface SlotPlacementPatch {
  featureId: string;                       // 必须等于当前 Plan 已存在的 feature.id
  pageId: 'home' | 'menu';
  slotId: 'home-hero' | 'home-marketing' | 'menu-aside' | 'menu-hero';
}

export interface DishCopyPatch {
  id: string;                              // 必须等于 baseDraft.dishes[].id
  name?: string;                           // 1..24 个 Unicode 码点
  description?: string;                    // 0..60 个 Unicode 码点
}

export interface PresentationCopyPatch {
  storeName?: string;                      // 1..48 码点
  category?: string;                       // 1..24 码点
  tagline?: string;                        // 0..40 码点，映射 storeProfile.notes
  dishes?: DishCopyPatch[];                // 0..5，id 不得重复
}

export interface PresentationSizesPatch {
  homeHero?: SizeStep;
  productCard?: SizeStep;
  carousel?: SizeStep;                     // 仅当前 Plan 含 poster-carousel 时允许
}

export interface PresentationPatch {
  theme?: Partial<Record<ThemeTokenKey, string>>;  // 严格 /^#[0-9A-F]{6}$/
  sizes?: PresentationSizesPatch;
  slotOrder?: SlotPlacementPatch[];               // 0..4
  copy?: PresentationCopyPatch;
}

export interface PresentationChangeItem {
  path: string;              // 例如 theme.primaryColor / slotOrder.poster-carousel / copy.dishes[2].name
  label: string;             // 中文可读标签，来自固定映射表
  before: string | null;     // 统一序列化为字符串；新增为 null
  after: string | null;      // 删除为 null
}

export type PresentationPatchResult =
  | { ok: true; patch: PresentationPatch; changes: PresentationChangeItem[] }
  | { ok: false; code: string; details: Array<{ path: string; code: string; message: string }> };
```

**校验规则（前端与服务端必须一致）**

1. 顶层只允许 `theme`、`sizes`、`slotOrder`、`copy`；出现其他键（包括 `layout`、组件增删、样式文本、URL）→ 整包失败 `PRESENTATION_PATCH_INVALID`。
2. 任一层出现 `__proto__`、`constructor`、`prototype` → 整包失败；解析必须使用 `Object.create(null)`/自有属性访问。
3. 序列化后 ≤ 8192 bytes；嵌套深度 ≤ 4；总键数 ≤ 64；数组只允许 `slotOrder` 与 `copy.dishes`。
4. 字符串统一 `NFC` 规范化、去除首尾空白；禁止控制字符；命中 `/(javascript:|data:|https?:\/\/|<script|<\/|\{\{|\}\}|expression\(|url\()/i` → 整包失败。
5. `theme` 每个值必须严格匹配 `^#[0-9A-Fa-f]{6}$`；写入前统一转大写。
6. `sizes` 值只能是 `sm|md|lg`；`sizes.carousel` 仅当当前 Plan 含 `poster-carousel` 时允许，否则 `PATCH_SIZE_UNSUPPORTED`。
7. `slotOrder` 必须是当前 Plan **已占用 feature** 的完整排列：每个 `featureId` 恰好一次；目标 `pageId+slotId` 必须在 Base 声明中且 `accepts` 含该 feature 的 `kind`；同一目标插槽不得重复；`featureId` 必须属于当前 Plan。当前模板无 feature 时只能为 `[]`，否则 `PATCH_SLOT_ORDER_UNSUPPORTED`。
8. `copy.dishes[].id` 必须存在于 `baseDraft.dishes`；不得新增/删除菜品；不得出现 `priceCents`/`priceText`。模板页阶段 `agentDraft.dishes` 通常为空，此时 `copy.dishes` 不可用并返回 422；菜品信息由资料页的 `agent-turn.v2` 填表与手工编辑负责。
9. `copy.storeName`、`copy.category` 长度上限与 `src/domain/agentDraft.mjs` 一致（48/24 码点）；`tagline` ≤ 40 码点。
10. 未知键、非法值、超限、原型污染、超深结构一律返回 `ok:false`；**禁止部分应用**。

**合并语义（`mergePresentationPatch(base, next)`）**

- `theme`：按 token 浅合并；`next` 中出现即替换。
- `sizes`：按字段浅合并。
- `slotOrder`：整体替换；`undefined` 表示不改。
- `copy`：字段浅合并；`copy.dishes` 按 `id` 合并，未出现的菜品保持不变。
- 结果必须再次通过 `validatePresentationPatch`；任何非法结果直接失败。

**变更计算（`diffPresentationPatch(base, next)`）**

- 按固定顺序比较：`theme`（按 7 个 token 的固定顺序）→ `sizes`（homeHero、productCard、carousel）→ `slotOrder`（按 feature 声明顺序）→ `copy`（storeName、category、tagline、dishes 按 id）。
- 每项输出 `path/label/before/after`；颜色与尺寸输出新值，位置输出 `pageId/slotId` 字符串，文案输出前后文本。
- 上限 20 条；超过时截断并在最后一条追加 `{path:'...', label:'…等 N 项', before:null, after:null}`。

**固定 label 映射**

| path 前缀 | label |
| --- | --- |
| `theme.pageBackground` | 页面背景色 |
| `theme.primaryColor` | 主色 |
| `theme.accentColor` | 强调色 |
| `theme.textColor` | 文字色 |
| `theme.tabBarBackground` | 底栏背景 |
| `theme.tabBarColor` | 底栏文字 |
| `theme.tabBarSelectedColor` | 底栏选中色 |
| `sizes.homeHero` | 首屏主视觉尺寸 |
| `sizes.productCard` | 商品卡尺寸 |
| `sizes.carousel` | 轮播区尺寸 |
| `slotOrder.<featureId>` | 区块位置 |
| `copy.storeName` | 店名 |
| `copy.category` | 品类 |
| `copy.tagline` | 门店口号 |
| `copy.dishes[i].name` | 菜品名称 |
| `copy.dishes[i].description` | 菜品描述 |

**错误码**

| 码 | HTTP | 触发 |
| --- | --- | --- |
| `PRESENTATION_PATCH_INVALID` | 422 | 未知键、类型错误、超限、非法字符串、原型污染 |
| `PATCH_THEME_COLOR_INVALID` | 422 | 颜色不是 `#RRGGBB` |
| `PATCH_SLOT_ORDER_UNSUPPORTED` | 422 | 当前模板无可移动 feature，或 slotOrder 不是完整排列 |
| `PATCH_SLOT_TARGET_INVALID` | 422 | 目标插槽不存在/不接受该 kind/重复目标 |
| `PATCH_SIZE_UNSUPPORTED` | 422 | 当前模板没有轮播却修改 `carousel` |
| `PATCH_COPY_DISH_UNKNOWN` | 422 | 菜品 id 不存在 |

**验收示例**

- `{ theme: { primaryColor: 'red' } }` → 422，`patch` 不写入。
- `{ slotOrder: [{featureId:'poster-carousel',pageId:'menu',slotId:'menu-hero'}] }` 在 `signature-kitchen` 下 → READY；在 `warm-bistro` 下 → 422（无 poster-carousel）。
- `{ copy: { dishes: [{ id: 'ghost', name: 'x' }] } }` → 422。

---

#### 2.2.5 `C-TEMPLATE-GALLERY@1`

**Provider**：T4（`src/components/flow/TemplateGallery.jsx`、`TemplateCompare.jsx`、`TemplateRevisePanel.jsx`）。
**Consumer**：T14（`src/App.jsx`）。

**`TemplateGallery` props（现有 props 名称与语义必须保留）**

```ts
interface TemplateCandidate {
  id: 'warm-bistro' | 'modern-coffee' | 'signature-kitchen';
  name: string;
  layout: 'menu' | 'catalog' | 'editorial';
  score: number;
  summary: string;
  badge?: string;
  source?: string;
  note?: string;
  customized?: boolean;
  briefHits?: number;
}

interface TemplateGalleryProps {
  candidates: TemplateCandidate[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
  onConfirm?: () => void;
  viewModelsByTemplateId: Record<string, PreviewViewModel>;
  refineText?: string;
  onRefineChange?: (text: string) => void;
  onRefine?: (text: string) => void;          // 保留：重新用语言描述候选
  refining?: boolean;
  refineError?: { code?: string; message?: string } | string | null;
  presentation?: PresentationState;           // 新增，可选
  onRevise?: (utterance: string) => void;     // 新增，可选
  onClearReviseError?: () => void;            // 新增，可选
  compareIds?: [string, string] | null;       // 新增，可选
  onCompareChange?: (ids: [string, string] | null) => void; // 新增，可选
}
```

**`TemplateCompare` props**

```ts
interface TemplateCompareProps {
  viewModelsByTemplateId: Record<string, PreviewViewModel>;
  leftId: string;
  rightId: string;
  onChangeLeft?: (id: string) => void;
  onChangeRight?: (id: string) => void;
  onClose?: () => void;
}
```

**必须呈现的行为**

1. 3 张候选卡始终展示，选中态可切换。
2. “实时预览”使用 `viewModelsByTemplateId[selectedId]`，不得自行构造第二份展示事实。
3. “重新描述候选”表单保留；提交调用 `onRefine`，与“对话修改当前模板”是两个不同入口，文案必须区分。
4. “对话修改”入口展示 `presentation.changes`（逐条 before → after）、`status==='revising'` 的忙碌态、`status==='failed'` 的红色错误；错误可关闭。
5. 对比模式最多同时显示 2 个 `MiniProgramPreview size="full"`；不得显示 3 个以上。
6. 新增 props 全部可选；未传时组件保持现有行为（`test/template-refine.test.cjs` 与现有渲染测试不得回归）。

---

#### 2.2.6 `C-VISION-UPLOADER@1`

**Provider**：T5（`src/services/agentTurn/agentImageUpload.js`、`src/components/agent/VisionImageUploader.jsx`）。
**Consumer**：T14（`src/App.jsx`）。

**纯函数契约**

```ts
export type AgentImageKind = 'menu' | 'store';
export type AgentImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface AgentImageDraft {
  id: string;
  kind: AgentImageKind;
  name: string;
  mediaType: AgentImageMediaType;
  dataBase64: string;      // 不含 "data:" 前缀
  previewDataUrl: string;  // 仅用于本地预览
  bytes: number;           // 解码后字节数
}

export const AGENT_IMAGE_LIMITS = Object.freeze({
  maxMenuImages: 2,
  maxStoreImages: 1,
  maxTotalImages: 3,
  maxDecodedBytesPerImage: 409600,   // 400 KiB
  maxDecodedBytesTotal: 1048576,     // 1 MiB
  maxEdgePx: 1280,
  jpegQuality: 0.72,
});

export async function prepareImageFile(
  file: File | Blob,
  options: { kind: AgentImageKind; id?: string; name?: string }
): Promise<AgentImageDraft>;          // 抛出 IMAGE_TYPE_UNSUPPORTED / IMAGE_TOO_LARGE / IMAGE_DECODE_FAILED

export function toAgentTurnImages(drafts: AgentImageDraft[]):
  Array<{ kind: AgentImageKind; mediaType: AgentImageMediaType; data: string }>;
```

**组件 props**

```ts
interface VisionImageUploaderProps {
  images: { menu: AgentImageDraft[]; store: AgentImageDraft[] };
  disabled?: boolean;
  busy?: boolean;
  error?: { code: string; message: string } | null;
  onAdd?: (kind: AgentImageKind, files: FileList | File[]) => void;
  onRemove?: (kind: AgentImageKind, id: string) => void;
}
```

**行为**

1. 两个独立入口：“菜单/菜品照”与“门店环境照”，文案与图标必须不同。
2. 选定文件后先压缩到 `maxEdgePx` 长边、JPEG 质量 `0.72`；若压缩后仍超过 400 KiB，继续降质量到 0.55；仍超出则报 `IMAGE_TOO_LARGE`。
3. 校验 MIME 白名单；失败显示可读错误，不把异常抛到 React 渲染层。
4. 预览使用本地 `URL.createObjectURL`/`readAsDataURL`，不发起网络请求。
5. 只在 `onAdd` 成功后回调；父组件负责把 `AgentImageDraft` 写入状态。

---

#### 2.2.7 `C-AGENT-TURN-V2@1`（`agent-turn.v2`）

**Provider**：T8（`server/src/agent`）。
**Consumer**：T5（前端 transport/服务）、T14（店铺资料页）。

**版本协商**

- 同一路由：`POST /api/v1/agent/turn`。
- `contractVersion: "agent-turn.v1"` → 走现有 v1 校验与响应，字节级语义不变。
- `contractVersion: "agent-turn.v2"` → 走 v2 校验；响应 `contractVersion` 回显 `"agent-turn.v2"`。
- 其他值 → 400 `AGENT_CONTRACT_MISMATCH`；不得把 v1 请求静默升级为 v2。

**v2 请求（在 v1 基础上新增 `images`）**

```ts
interface AgentTurnV2Request {
  contractVersion: 'agent-turn.v2';
  utterance: string;                 // 1..500 码点
  draft: ContractDraft;              // 与 v1 完全一致
  images?: Array<{
    kind: 'menu' | 'store';
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    data: string;                    // 纯 base64，不含 data: 前缀
  }>;
  client: { surface: 'desktop'; phase: 'store-info' };
  projectId: null;
}
```

**限制与校验**

| 项 | 规则 | 失败码 |
| --- | --- | --- |
| 张数 | `menu` ≤ 2，`store` ≤ 1，合计 ≤ 3 | `AGENT_IMAGE_COUNT_EXCEEDED`（422） |
| MIME | 仅 `image/jpeg`、`image/png`、`image/webp` | `AGENT_IMAGE_TYPE_UNSUPPORTED`（422） |
| base64 | 严格 `^[A-Za-z0-9+/]*={0,2}$`，长度 %4==0 | `AGENT_IMAGE_INVALID`（422） |
| 单张解码 | ≤ 409600 bytes | `AGENT_IMAGE_TOO_LARGE`（422） |
| 合计解码 | ≤ 1048576 bytes | `AGENT_IMAGE_TOO_LARGE`（422） |
| 请求体 | ≤ 2097152 bytes | `AGENT_BODY_TOO_LARGE`（413） |
| 未知字段 | 整包拒绝 | `AGENT_REQUEST_INVALID`（400） |

- 服务端必须只用 `Buffer.from(data,'base64')` 解码后的真实字节数判断大小，不得相信客户端声明的 `bytes`。
- 日志只记录 `menuImages/storeImages/totalBytes/latencyMs`；不得记录 base64、dataUrl、Key 或模型原始 payload。

**Provider 多模态映射**

- 无 `images` 或空数组：`messages[0].content` 保持字符串（与 v1 请求完全一致）。
- 有 `images`：
  ```ts
  messages[0].content = [
    { type: 'text', text: `${SYSTEM_PROMPT}\n\n${userPrompt}` },
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
  ];
  ```
- 使用 `DEEPSEEK_VISION_MODEL`（默认 `deepseek-flash`）发起视觉请求；文本请求继续使用 `DEEPSEEK_MODEL`。
- 系统提示新增约束：菜单照只抽取可读菜名/价格/描述；环境照不抽取菜品；仍不得编造价格。

**v2 响应**

与 v1 响应完全相同的字段（`turnId/status/reply/draft/missingFields/errors/nextQuestion/meta`），另加：

```ts
interface AgentTurnV2Response extends AgentTurnV1Response {
  contractVersion: 'agent-turn.v2';
  vision: {
    menuImages: number;
    storeImages: number;
    analyzed: boolean;      // 是否真的发起了视觉模型请求
    degraded: boolean;      // 模型不可用但请求其余部分成功（当前实现应为 false，失败即失败）
  } | null;
}
```

**v2 错误语义**

| 码 | HTTP | 说明 |
| --- | --- | --- |
| `DEEPSEEK_NOT_CONFIGURED` | 503 | 服务端未配置 Key |
| `DEEPSEEK_TIMEOUT` | 504 | 超时 |
| `DEEPSEEK_RESPONSE_INVALID` | 502 | 非 JSON/无法解析 |
| `DEEPSEEK_VISION_UNAVAILABLE` | 502 | 视觉模型请求失败 |

任何错误都不得返回部分草稿；前端保留原草稿。

**验收**

- 只发 `contractVersion: 'agent-turn.v1'` 的旧请求：响应无 `vision` 字段，字段与当前实现一致。
- 2 张菜单照 + 1 张环境照：200，`vision.menuImages=2/storeImages=1/analyzed=true`。
- 单张解码 500 KiB：422 `AGENT_IMAGE_TOO_LARGE`，无草稿变更。
- 超大请求体：413，前端显示“图片过大，请压缩后重试”。

---

#### 2.2.8 `C-TEMPLATE-REVISE@1`（`agent-template-revise.v1`）

**Provider**：T7（`server/src/agent/presentation/template-revise.controller.ts`、`template-revise.service.ts`、`template-revise.provider.ts`）。
**Consumer**：T4（`src/services/agentTurn/templateReviseService.js`）、T14（App 接线）。

**路由**

```http
POST /api/v1/agent/template-revise
Content-Type: application/json; charset=utf-8
Accept: application/json
X-Agent-Contract: agent-template-revise.v1
Authorization: Bearer <可选；development 且 AGENT_REQUIRE_AUTH=false 时可省略>
```

**请求**

```ts
interface TemplateReviseRequest {
  contractVersion: 'agent-template-revise.v1';
  utterance: string;                       // 1..500 码点
  candidate: {
    templateId: 'warm-bistro' | 'modern-coffee' | 'signature-kitchen';
    layout: 'menu' | 'catalog' | 'editorial';
  };
  planFeatures: Array<{                    // 当前 Plan 的真实 feature 落位，服务端用于校验 slotOrder
    featureId: string;                     // 只允许 poster-carousel（当前唯一 feature）
    pageId: 'home' | 'menu';
    slotId: 'home-hero' | 'home-marketing' | 'menu-hero' | 'menu-aside';
  }>;                                      // 0..3
  basePatch: PresentationPatch;            // 当前已接受补丁；缺省 {}
  baseDraft: ContractDraft;                // 当前草稿；用于校验 copy.dishes 的 id
  images?: Array<{                          // 可选；本轮只允许门店环境照
    kind: 'store';
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    data: string;
  }>;
  client: { surface: 'desktop'; phase: 'template-pick' };
  projectId: null;
}
```

**响应**

```ts
interface TemplateReviseResponse {
  contractVersion: 'agent-template-revise.v1';
  turnId: string;                          // 服务端 UUID
  reply: string;                           // 1..200 码点；用于对话区
  patch: PresentationPatch;                // 已接受并校验的下一版补丁
  changes: PresentationChangeItem[];       // 服务端重算，最多 20
  meta: {
    transport: 'http';
    provider: string;
    mock: boolean;        // 服务端真实响应恒为 false；前端 Mock transport 可为 true，并在 UI 显示“本地 Mock 演示”
    model: string | null;
    latencyMs: number;
  };
}
```

**处理语义**

1. 先校验 `utterance`、`candidate`、`planFeatures`、`basePatch`、`baseDraft`、`images`；任一失败 → 400/422，**不调用模型**。
2. 调模型时发送结构化指令：只允许返回 `{ "reply": string, "presentationPatch": PresentationPatch }`；不得返回 Markdown/代码/解释。带 `images` 时使用 `DEEPSEEK_VISION_MODEL` 与多模态 content parts；无图片时使用 `DEEPSEEK_MODEL` 纯文本。
3. 模型输出必须能 `JSON.parse`；否则 502 `DEEPSEEK_RESPONSE_INVALID`，**保留上一版**。
4. `nextPatch = mergePresentationPatch(basePatch, modelPatch)`，再用与 `C-PRESENTATION-PATCH@1` 完全相同的规则校验；失败 → 422 `PRESENTATION_PATCH_INVALID`，无部分写入。
5. `changes = diffPresentationPatch(basePatch, nextPatch)`；**不采用模型自述的变更说明**。
6. `reply` 为模型回复的裁剪版；若为空，服务端用 `已更新 N 项展示。` 兜底（N 为 `changes.length`）。
7. 服务端无会话存储：不保存 `basePatch`、不生成 `baseRevision`；并发由前端单飞与 `requestId` 控制（见 2.3）。

**错误码**

| 码 | HTTP | 前端表现 |
| --- | --- | --- |
| `AGENT_REQUEST_INVALID` | 400 | 红色错误，保留上一版 |
| `PRESENTATION_PATCH_INVALID` / `PATCH_*` | 422 | 红色错误 + 可读原因，保留上一版 |
| `DEEPSEEK_NOT_CONFIGURED` | 503 | “模型未配置，请检查服务端” |
| `DEEPSEEK_TIMEOUT` | 504 | “模型超时，请重试” |
| `DEEPSEEK_RESPONSE_INVALID` | 502 | “模型返回无法解析，已保留上一版” |
| `AGENT_BODY_TOO_LARGE` | 413 | “图片过大，请压缩后重试” |

**前端单飞与晚响应**

- 同一时刻只允许一个 `TEMPLATE_REVISE_REQUEST`；`status==='revising'` 时忽略新提交。
- 响应必须匹配 `presentation.requestId`；不匹配则整包忽略（含 `changes` 与撤销栈）。

**验收**

- 连续两轮：第二轮请求携带第一轮 `patch`；结果累积。
- 模型返回非 JSON：502，`patch` 与 `changes` 不变，撤销栈不新增。
- 模型返回 `{theme:{primaryColor:'#123'}}`：422，无部分写入。
- 未配置 Key：503，前端显示红色错误，流程不前进。

---

#### 2.2.9 `C-TEMPLATE-CANDIDATES@1`（`agent-template-candidates.v1`）

**Provider**：T7（`server/src/agent/presentation/template-candidates.controller.ts`、`template-candidates.service.ts`）。
**Consumer**：T13（`src/services/agentService.js` 的 `buildTemplateCandidates`）。

**路由**：`POST /api/v1/agent/template-candidates`，`X-Agent-Contract: agent-template-candidates.v1`。

**请求**

```ts
interface TemplateCandidatesRequest {
  contractVersion: 'agent-template-candidates.v1';
  selectedFeatures: string[];        // 0..11，取自 src/domain/catalog.mjs 的 features[].id
  brief: string;                      // 0..500 码点；可为空
  client: { surface: 'desktop'; phase: 'template-pick' };
  projectId: null;
}
```

**响应**

```ts
interface TemplateCandidatesResponse {
  contractVersion: 'agent-template-candidates.v1';
  turnId: string;
  orderedTemplateIds: [string, string, string];  // 恰好 3 个且互不重复，均属于 3 套模板
  reasons: Record<string, string>;                 // 每个 templateId 一条 ≤ 80 码点中文理由
  meta: { transport:'http'; provider:string; mock:false; model:string|null; latencyMs:number };
}
```

**语义**

1. 服务端只决定**排序与理由**；`score`、`source`、`note` 仍由前端基于功能覆盖确定性计算（不使用模型给的数字）。
2. 模型不得新增模板 ID、不得遗漏任一模板。
3. 模型不可用/超时/非 JSON → 返回 502/503/504；前端降级到本地确定性排序，并把候选 `source` 标为 `本地规则（模型不可用）`、`degraded:true`，同时显示可见提示；**不得静默假装模型成功**。
4. 前端 `TEMPLATE_REBUILD_READY` 与 `BUILD_READY` 行为不变：仍原地替换候选、保留已选功能。

**验收**

- 模型返回 3 个合法 ID：候选顺序与理由来自服务端，`score` 由功能覆盖计算。
- 模型返回 2 个 ID 或未知 ID：502，不采用。
- 后端不可达：前端本地排序 + 可见降级提示。

---

#### 2.2.10 `C-IMAGE-PROMPT-SPEC@1`（`image-prompt-spec.v1`）

**Provider/Consumer**：T13（`templates/image-prompt-spec.v1.json`、`src/domain/imagePromptSpec.mjs`、`src/services/agentService.js`）。

**结构**

```json
{
  "contract": "image-prompt-spec.v1",
  "status": "frozen",
  "templates": {
    "menu": {
      "templateId": "warm-bistro",
      "composition": "近景平视，主体占画面 60%，左上留白给标题",
      "subject": "家常菜与木质餐桌",
      "palette": ["暖橙", "木色", "米白"],
      "lighting": "傍晚暖光，侧逆光",
      "negative": ["可读文字", "水印", "人物正脸", "品牌 Logo", "医疗功效暗示"]
    },
    "catalog": {
      "templateId": "modern-coffee",
      "composition": "俯拍/45 度，极简桌面，大量留白",
      "subject": "咖啡、烘焙与轻食",
      "palette": ["墨绿", "奶油白", "浅木"],
      "lighting": "清晨自然柔光",
      "negative": ["可读文字", "水印", "人物正脸", "品牌 Logo", "医疗功效暗示"]
    },
    "editorial": {
      "templateId": "signature-kitchen",
      "composition": "特写主厨招牌菜，浅景深，暗背景",
      "subject": "一道招牌菜与餐具细节",
      "palette": ["深棕", "琥珀", "暖白"],
      "lighting": "低位暖聚光",
      "negative": ["可读文字", "水印", "人物正脸", "品牌 Logo", "医疗功效暗示"]
    }
  },
  "defaults": { "aspect": "4:3", "maxPromptLength": 1200 }
}
```

**可调用接口**

```ts
export function buildImagePromptSpec(input: {
  layout: 'menu' | 'catalog' | 'editorial';
  storeName?: string;
  category?: string;
  notes?: string;
  styleName?: string;
  extraRequirement?: string;
}): { prompt: string; spec: Record<string, unknown>; tips: string[] };

export function reviseImagePrompt(input: {
  basePrompt: string;
  baseSpec: Record<string, unknown>;
  feedback: string;
}): { prompt: string; spec: Record<string, unknown> };
```

**规则**

1. 输出必须是结构化对象；`prompt` 由固定段落拼接：主体 + 构图 + 色调 + 光源 + 留白 + 禁止项 + 门店事实 + 风格。
2. `prompt` 长度 ≤ 1200 码点；超出时截断 `extraRequirement` 而不是删除禁止项。
3. 不调用任何网络接口；不改变 `generateImage/reviseImage` 的 `provider:'local-demo'` 标识。
4. `revisePrompt` 的反馈作为 `extraRequirement` 追加，并返回更新后的 spec。

---

#### 2.2.11 `C-REAL-PREVIEW@1`（`real-preview-channel.v1`）

**Provider**：T6（`desktop/main.cjs`、`desktop/preload.cjs`、`src/components/preview/RealPreviewPanel.jsx`）。
**Consumer**：T14（App 接线）。

**桌面 IPC**

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `preview:open-project` | `{ projectPath: string }` | `{ ok: true; message: string } \| { ok: false; code: 'PATH_INVALID'\|'PATH_MISSING'\|'DEVTOOLS_NOT_FOUND'; message: string }` | 只打开已导出工程目录；不得声称完成渲染 |
| `preview:pick-screenshot` | 无 | `{ cancelled: true } \| { cancelled: false; path: string; name: string; dataUrl: string; bytes: number }` | 仅 PNG/JPEG，≤ 8 MiB；取消返回 `cancelled:true` |

**preload 暴露**

```ts
window.smartStore.openPreviewProject(payload: { projectPath: string }): Promise<...>;
window.smartStore.pickPreviewScreenshot(): Promise<...>;
```

**组件 props**

```ts
interface RealPreviewPanelProps {
  projectPath: string | null;
  screenshot: { dataUrl: string; name: string } | null;
  busy?: boolean;
  error?: { code: string; message: string } | null;
  onOpen?: () => void;
  onPickScreenshot?: () => void;
  onClear?: () => void;
}
```

**必须呈现的人工步骤**

1. 在微信开发者工具中导入已导出工程目录（或使用“打开工程”按钮后手动导入）。
2. 若 CLI `auto` 因 AppID 校验卡住：在开发者工具设置中把代理改为直连（`proxyType` 不使用 `SYSTEM`），或手动登录/填入 AppID。
3. 在工具中编译并截图，回到应用点击“选择截图”回填。
4. 明确文案：这是**真实渲染截图回传**，不是应用内实时渲染；应用内实时预览仍是 React 复刻。

**安全**

- 路径必须是绝对路径、存在且为目录；不得执行任意命令。
- 截图只读本地文件；不得上传到任何服务。

---

#### 2.2.12 `C-SERVER-ENV@1`

**Provider**：T9（`server/src/common/config/env.validation.ts`、`server/src/main.ts`、`server/.env.example`）。
**Consumer**：T7、T8（读取配置）。

| 变量 | 默认 | 约束 | 用途 |
| --- | --- | --- | --- |
| `AGENT_MAX_BODY_BYTES` | `2097152` | 整数 262144–8388608 | Express JSON body 上限；agent v2 图片请求 |
| `DEEPSEEK_VISION_MODEL` | `deepseek-flash` | `^[A-Za-z0-9._:-]{1,64}$` | 有图片时使用的视觉模型 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 保持现状 | 纯文本请求 |
| `DEEPSEEK_API_KEY` | 空 | 允许为空；只在服务端 | 密钥 |
| `AGENT_REQUIRE_AUTH` | `false` | `true|false` | 现有鉴权开关 |

**实现要求**

1. `main.ts` 使用 `NestFactory.create(AppModule, { bodyParser: false })` 后显式 `app.use(json({ limit: AGENT_MAX_BODY_BYTES }))`；其他路由仍可解析 JSON。
2. 超过上限时统一返回 JSON `{ code: 'AGENT_BODY_TOO_LARGE', message, requestId }`，HTTP 413。
3. `.env.example` 不得包含真实 Key；新增变量必须写注释与默认值。
4. 环境校验失败时服务启动失败并输出缺失变量名（不输出值）。

---

### 2.3 Shared Behavior, Integration, and Open Decisions

#### 2.3.1 展示补丁端到端时序

1. 用户在模板页输入自然语言 → `TEMPLATE_REVISE_REQUEST`，前端单飞，携带当前 `presentation.patch`、`planFeatures`、`agentDraft`。
2. T7 服务端校验请求 → 调模型 → 取 `presentationPatch` → 与 `basePatch` 合并 → 重新校验 → 重算 `changes` → 返回。
3. 前端 `TEMPLATE_REVISE_SUCCESS`：校验 `requestId` → 写入 `presentation.patch/changes` → 应用 `copy` 到 `store/agentDraft` → 追加对话消息 → 压入撤销栈。
4. `planFromSession` 读取 `presentation`：主题 = preset 合并补丁主题；`presentationTokens` 由补丁尺寸 + 模板默认生成；`features[].slots[]` 按补丁落位改写。
5. `previewViewModel` 读取同一 Plan：`blocks[]` 增加 `pageId`、按 `slotOrder` 排序；尺寸从 props/`presentationTokens` 取。
6. 导出时 Composer 读取同一 Plan：主题 token、`presentationTokens`、slot 落位、props 原样消费。
7. 任何一步失败 → 停在该步，保留上一版；不得出现“状态已变但预览未变”或“预览已变但导出未变”。

#### 2.3.2 模板切换与补丁归属

- 补丁只属于一个候选模板（`presentation.templateId`）。
- 切换模板时：若 `templateId` 不同且补丁非空 → 重置补丁、变更清单、错误态；界面显示“已切换到新模板，旧模板的展示修改已清除”。
- 撤销可恢复被重置的补丁（因为 `presentation` 在撤销快照中）；但 `SELECT_TEMPLATE` 本身不入栈，避免选择动作污染撤销语义。
- “重新描述候选”只改变候选排序与内容，不清空补丁；若候选模板 ID 集合不变，补丁保持。
- 模板页阶段通常还没有 `agentDraft.dishes`，因此 `copy.dishes` 在该阶段不可用；菜品名称/描述/价格的编辑由资料页 `agent-turn.v2` 填表与手工编辑承担（见 R4）。

#### 2.3.3 预览/导出一致性检查点

| 检查点 | 预览侧 | 导出侧 | 必须一致的内容 |
| --- | --- | --- | --- |
| 主题色 | `previewViewModel.theme`（7 token） | `theme.generated.wxss` 7 个 CSS 变量 | 值完全相同 |
| 尺寸 | `homeHeroSize/productCardSize` → CSS 类 | `--store-home-hero-min-height` / `--store-product-card-min-height` | 档位映射来自同一 JSON |
| 轮播 | `block.props.size` | 组件 `properties.size` + wxss 类 | 同一 `sm|md|lg` |
| 区块位置 | `blocks[].pageId/slotId` | `pages/<page>/index.wxml` 锚点 + `config/slots.generated.js` | 同一 feature 出现在同一页面同一插槽 |
| 文案 | `store.name/category/subtitle`、`products[].name/note` | `store.generated.js` 的 `store.*` + `catalog` 数据 | 同一来源（`storeProfile`） |

#### 2.3.4 图片链路时序

1. 用户选择图片 → 前端按 `C-VISION-UPLOADER@1` 压缩、分类、校验 → 得到 `AgentImageDraft[]`。
2. 用户点击“让 agent 填表” → `agent-turn.v2`，携带最多 2 张菜单照 + 1 张环境照。
3. 服务端校验 → 拼多模态 content parts → 调视觉模型 → 白名单合并 `draftPatch`。
4. 前端把返回草稿写入 `agentDraft`，局部重新校验；店主在草稿编辑区修改。
5. 环境照同时进入 `state.assets.images`（带 `kind:'store'`），供生图提示词与真实预览参考；不进入 `draft.dishes`。

#### 2.3.5 失败与降级矩阵

| 场景 | 服务端 | 前端 | 是否可继续 |
| --- | --- | --- | --- |
| 模型未配置 | 503 `DEEPSEEK_NOT_CONFIGURED` | 红色提示；模板页保留上一版；资料页保留草稿 | 可手动继续 |
| 模型超时 | 504 | 可重试（模板修改与资料抽取各自保留 `lastUtterance`） | 是 |
| 模型返回非 JSON | 502 | 保留上一版；撤销栈不新增 | 是 |
| 补丁非法 | 422 + `details` | 显示字段级原因；不应用 | 是 |
| 图片过大 | 413/422 | “图片过大，请压缩后重试” | 是 |
| 导出失败 | Composer 稳定错误码 | 现有 `describeExportError` 文案 | 是 |

#### 2.3.6 人工步骤（不得写成自动化）

1. 微信开发者工具安装、登录、AppID 配置。
2. 导入已导出工程目录、编译、真机预览。
3. 若 CLI `auto` 卡 AppID 校验：手动把 IDE 代理改为直连（不使用 `SYSTEM`）。
4. 微信截图 → 回到应用选择截图。
5. 真实生图模型的服务商、Base URL、模型名与 Key 由用户提供后另行接入。

#### 2.3.7 开放决策

| 决策 | 影响契约/任务 | 当前处理 | 需要谁提供 |
| --- | --- | --- | --- |
| 真实生图服务商与 Key | R5.5；不影响本轮 T1–T16 | 本轮只交付 `C-IMAGE-PROMPT-SPEC@1`；占位图保持 `local-demo`。接入时优先使用现有 `server/src/generation` 适配的 OpenAI 兼容 `POST /images/generations`（`response_format=b64_json`、`size` 受控）与 `POST /images/edits` 参考图能力；若服务商协议不同，需要新增独立适配器 | 用户提供：服务商名称、Base URL、模型名、API Key、是否支持参考图编辑 |
| 是否引入服务端 Agent 会话持久化与 `baseRevision` | `C-TEMPLATE-REVISE@1` 的未来修订 | 本轮无状态；前端单飞 + `requestId`；不新增数据库表 | 产品/后端负责人 |
| 是否把模板修改能力扩展到店铺资料页 | 未来 `agent-turn.v3` | 本轮不扩展；避免资料抽取与展示修改耦合 | 产品 |
| 微信 CLI 自动化真实渲染 | R6 | 明确为人工步骤；不承诺自动化 | 环境/用户 |

#### 2.3.8 不适用类别说明

- **数据库持久化**：本轮不新增表、不写业务库；展示补丁只存在于前端会话与本机 `project.json` 草稿快照，故无表/列/事务契约。
- **消息队列/事件总线**：本轮不使用。
- **CLI 输出格式**：本轮无新增 CLI 契约；Composer CLI 只消费 Plan 文件。
- **共享可变资源**：`npm run build` 的 `dist/`、`server` 的测试数据库为共享资源；T15 统一串行执行构建与测试，避免并行写入。

## 3. Tasks

### 3.1 Implementation Tasks

#### T1 契约数据层：presentationPatch / 尺寸表 / 图片输入纯模块

- **owner_role**: coding-engineer
- **objective**: 交付可被前端预览、状态机与服务端同构参照的纯数据契约实现：补丁校验/合并/差异、尺寸 token 唯一表、图片输入校验与压缩参数常量。
- **requirement_refs**: R3.4、R3.5、R3.6、R3.7、R4.5、R7.2
- **write_set**:
  - `src/domain/presentationPatch.mjs`（新增）
  - `src/domain/previewSizeTokens.mjs`（新增，读取 `templates/presentation/size-tokens.v1.json`）
  - `src/domain/agentImageInput.mjs`（新增，纯校验；不依赖 DOM）
  - `templates/presentation/size-tokens.v1.json`（新增）
  - `test/presentation-patch.test.cjs`（新增）
  - `test/agent-image-input.test.cjs`（新增）
- **provides**: `C-PRESENTATION-PATCH@1`（前端实现）、`C-SIZE-TOKENS@1`、`C-VISION-UPLOADER@1`（纯函数与限制常量部分）
- **consumes**: 无
- **blocked_by**: 无
- **verify_after**: 无；本任务自身即可运行 `node --test test/presentation-patch.test.cjs test/agent-image-input.test.cjs`
- **acceptance_and_local_checks**:
  1. `validatePresentationPatch` 对未知键、`__proto__`、非法颜色、超长文案、非法 slot 目标、非完整排列、未知菜品 id 全部返回 `ok:false`，且不产生部分结果。
  2. `mergePresentationPatch` 按 2.2.4 的合并语义工作；合并结果再次校验。
  3. `diffPresentationPatch` 输出固定顺序与固定中文 label，最多 20 条。
  4. 尺寸 JSON 与 2.2.1 完全一致；默认值为 `md`。
  5. 图片校验：MIME 白名单、base64 格式、单张 400 KiB、合计 1 MiB、张数 2/1/3；超限返回稳定错误码。
  6. 测试全部通过，且不依赖浏览器 DOM。
- **delivery_evidence**: 两个测试文件的真实 `node --test` 输出（通过/失败数、退出码）；`git diff --stat` 中列出的新增文件。
- **dispatch_priority**: P0（所有前端/计划/导出任务的基础契约，优先派发）

#### T2 Plan 投影与 React 预览消费 presentation

- **owner_role**: coding-engineer
- **objective**: 让 `planFromSession` 把已接受的展示补丁投影进 `composition.v1`（主题覆盖、`presentationTokens`、区块落位、文案），让 `previewViewModel` 与预览组件按同一份 Plan 渲染尺寸、页面归属与区块顺序。
- **requirement_refs**: R1.3、R2.2、R2.4、R3.3、R7.5
- **write_set**:
  - `src/composition/planFromSession.mjs`（修改）
  - `src/composition/previewViewModel.mjs`（修改）
  - `src/components/preview/MiniProgramPreview.jsx`（修改）
  - `src/components/preview/PreviewTabs.jsx`（修改）
  - `src/components/preview/PreviewShared.jsx`（修改）
  - `src/components/preview/PosterCarouselBlock.jsx`（修改）
  - `src/styles/preview.css`（修改）
  - `test/preview-presentation.test.cjs`（新增）
  - `test/preview-view-model.test.cjs`（按需补充，不删除既有断言）
- **provides**: `C-PLAN-PRESENTATION@1`（Plan 投影部分与预览视图模型）
- **consumes**: `C-PRESENTATION-PATCH@1`、`C-SIZE-TOKENS@1`、`C-SESSION-PRESENTATION@1`（读取 `state.presentation`）
- **blocked_by**: 无（可依据冻结契约先写代码；文件存在性由 T1 交付）
- **verify_after**: T1 交付 `src/domain/presentationPatch.mjs` 与 `templates/presentation/size-tokens.v1.json` 后运行；同时运行 `node --test test/preview-*.test.cjs test/mini-program-preview-structure.test.cjs`
- **acceptance_and_local_checks**:
  1. `planFromSession`：主题 = `resolveThemeTokens(styleId)` 与 `presentation.patch.theme` 浅合并；`presentationTokens` 由 `sizes` 与缺省 `md` 生成；`slotOrder` 由补丁落位生成，**不修改** `features[].slots[]`；`copy` 不重复写入（由状态机负责写 `store/agentDraft`）。`buildSessionPreviewViewModels` 只对 `candidate.id === presentation.templateId` 的候选应用补丁，其它候选使用默认展示。
  2. `previewViewModel.blocks[]` 增加 `pageId` 与 `slotId`，按 `plan.slotOrder`（缺省按声明）输出；`sizes` 解析为 `sm|md|lg`；`store.tagline` 来自 `storeProfile.notes`。
  3. `MiniProgramPreview` / `PreviewTabs` 按 `pageId` 把块渲染到对应 tab（首页/菜单）；未识别的块继续安全忽略。
  4. `PosterCarouselBlock` 应用 `props.size` 对应的高度档位；无 `size` 时用 `md`。
  5. 预览样式只新增尺寸类，不改变现有布局的默认值；`md` 必须与现状视觉一致。
  6. 现有 `preview-view-model`、`preview-blocks`、`mini-program-preview-structure` 测试不回归。
- **delivery_evidence**: 新增测试的真实输出；`node --test` 相关文件退出码；`git diff --stat` 列出的修改文件。
- **dispatch_priority**: P0（与 T1 并行；T1 完成后即可跑通验证）

#### T3 会话状态机：presentation 切片、对话动作与撤销

- **owner_role**: coding-engineer
- **objective**: 在 `sessionMachine.mjs` 增加 `presentation` 业务切片与 `TEMPLATE_REVISE_*` 动作，支持多轮累积、失败保留、模板切换重置、撤销/重做，并把 `copy` 补丁写入 `store/agentDraft`。
- **requirement_refs**: R3.2、R3.3、R3.7、R3.8、R7.2
- **write_set**:
  - `src/state/sessionMachine.mjs`（修改）
  - `test/session-presentation.test.cjs`（新增）
- **provides**: `C-SESSION-PRESENTATION@1`
- **consumes**: `C-PRESENTATION-PATCH@1`（前端校验，拒绝非法已接受补丁）
- **blocked_by**: 无（按冻结契约编写；T1 模块用于编译）
- **verify_after**: T1 完成后运行 `node --test test/session-presentation.test.cjs test/template-refine.test.cjs test/session-machine.test.cjs`
- **acceptance_and_local_checks**:
  1. `createInitialState()` 含 `presentation` 初始切片；现有测试中的状态深比较如需更新，只做最小字段补充。
  2. 四个动作按 2.2.3 生效；`TEMPLATE_REVISE_SUCCESS` 的 `requestId` 不匹配时整包忽略（含 `changes` 与撤销）。
  3. `copy` 映射正确：店名/品类同时写 `store` 与 `agentDraft`，`tagline` 写 `store.notes`，菜品按 id 改名称/描述且价格不变。
  4. `SELECT_TEMPLATE` 切换不同模板时重置补丁；同模板重复选择不重置；`SET_STYLE` 清除补丁中的 `theme`，保留其它字段。
  5. `undoSnapshot()` 含 `presentation`；成功修改后可撤销/重做；失败/请求动作不压栈。
  6. `selectPresentationState` 返回 2.2.3 定义的字段。
  7. 现有 `template-refine` 与 `session-machine` 测试不回归。
- **delivery_evidence**: 新增测试输出与退出码；相关既有测试输出；`git diff` 中状态机变更摘要。
- **dispatch_priority**: P0（与 T1/T2 并行；T4/T14 依赖其动作契约）

#### T4 模板展示前端：切换 / 对比 / 对话修改面板

- **owner_role**: coding-engineer
- **objective**: 把 3 套模板的展示前端做扎实：保留切换与“重新描述候选”，新增并排对比与“对话修改当前模板”面板；实现前端 revise transport/service，严格按 `agent-template-revise.v1` 构造请求、校验响应、映射错误。
- **requirement_refs**: R1.4、R2.1–R2.5、R3.1、R3.4、R3.7
- **write_set**:
  - `src/components/flow/TemplateGallery.jsx`（修改）
  - `src/components/flow/TemplateCompare.jsx`（新增）
  - `src/components/flow/TemplateRevisePanel.jsx`（新增）
  - `src/styles/flow.css`（修改，模板页样式）
  - `src/services/agentTurn/templateReviseService.js`（新增）
  - `src/services/agentTurn/templateReviseTransport.js`（新增）
  - `src/services/agentTurn/agentServiceConfig.js`（修改，新增端点与契约版本导出）
  - `test/template-revise-service.test.cjs`（新增）
- **provides**: `C-TEMPLATE-GALLERY@1`、`C-TEMPLATE-REVISE@1`（前端 consumer/transport）
- **consumes**: `C-SESSION-PRESENTATION@1`、`C-PRESENTATION-PATCH@1`
- **blocked_by**: 无（按冻结契约编写；T1/T3 文件用于编译与联调）
- **verify_after**: T1、T3 完成后运行 `node --test test/template-revise-service.test.cjs test/template-refine.test.cjs`；再运行 `npm run build` 验证 JSX 可编译
- **acceptance_and_local_checks**:
  1. `TemplateGallery` 保留现有 props 与行为；新增 props 全部可选，未传时与现状一致。
  2. 3 张候选卡始终可切换；对比模式最多 2 个完整预览，可关闭。
  3. “重新描述候选”与“对话修改当前模板”是两个独立入口，文案、按钮、失败态不混淆。
  4. 对话面板展示 `changes` 逐条 before→after、忙碌态、红色错误与关闭按钮；失败时不显示成功文案。
  5. `templateReviseTransport` 构造请求字段与 2.2.8 完全一致（含 `planFeatures`、`basePatch`、`baseDraft`）；响应字段缺失/类型错误 → `AGENT_RESPONSE_INVALID`。
  6. `agentServiceConfig` 新增 `TEMPLATE_REVISE_ENDPOINT`（默认 `/api/v1/agent/template-revise`）与 `TEMPLATE_REVISE_CONTRACT_VERSION`，不改变现有导出。
  7. Mock 模式：返回 `meta.mock:true` 的确定性补丁并在 UI 显示“本地 Mock 演示”徽标；不得标成真实模型成功。
  8. `test/template-refine.test.cjs` 不回归。
- **delivery_evidence**: 新增测试输出；`npm run build` 退出码与构建摘要；`git diff --stat`。
- **dispatch_priority**: P0（与 T1/T2/T3 并行；T14 依赖本任务组件）

#### T5 图片上传与 `agent-turn.v2` 前端客户端

- **owner_role**: coding-engineer
- **objective**: 交付菜单照/环境照上传组件、浏览器压缩与分类、`AgentImageDraft` 生成，以及支持 v2 多模态请求的 transport 与服务层；旧 v1 调用保持可用。
- **requirement_refs**: R4.1–R4.6、R7.1、R7.2
- **write_set**:
  - `src/services/agentTurn/agentImageUpload.js`（新增，DOM 压缩）
  - `src/components/agent/VisionImageUploader.jsx`（新增）
  - `src/styles/agent.css`（修改，上传组件样式）
  - `src/services/agentTurn/httpAgentTransport.js`（修改，支持 v2）
  - `src/services/agentTurn/mockAgentTransport.js`（修改，支持 v2 形状）
  - `src/services/agentTurn/agentTurnService.js`（修改，接受 `images` 参数）
  - `test/agent-turn-v2.test.cjs`（新增）
- **provides**: `C-VISION-UPLOADER@1`（DOM 组件与压缩实现）、`C-AGENT-TURN-V2@1`（前端 client）
- **consumes**: `C-VISION-UPLOADER@1`（T1 纯函数与限制常量）、`C-AGENT-TURN-V2@1`
- **blocked_by**: 无（按冻结契约编写；T1 纯模块用于编译）
- **verify_after**: T1 完成后运行 `node --test test/agent-turn-v2.test.cjs test/agent-turn.test.cjs`；真实 HTTP 路径的联调由 T15/T16 负责（需 T8/T9）
- **acceptance_and_local_checks**:
  1. `prepareImageFile`：长边 ≤1280、JPEG 0.72→0.55 降质、超 400 KiB 报 `IMAGE_TOO_LARGE`；MIME 白名单失败报 `IMAGE_TYPE_UNSUPPORTED`；解码失败报 `IMAGE_DECODE_FAILED`。
  2. `VisionImageUploader`：菜单照 ≤2、环境照 ≤1；失败显示可读错误；禁用态与忙碌态可用。
  3. `httpAgentTransport`：有 `images` 时发送 `contractVersion:'agent-turn.v2'`、匹配的 `X-Agent-Contract` 头与 `images:[{kind,mediaType,data}]`；无图片时仍可发送 v1 或 v2（由调用方决定），响应校验兼容 v1/v2。`agent-turn.v2` 常量在 transport 文件内本地定义，**不修改 `agentServiceConfig.js`**（该文件由 T4 独占）。
  4. `agentTurnService.requestAgentTurn({ images })` 把草稿与图片一起发送；响应 `vision` 字段按 v2 校验；v1 响应无 `vision` 时仍可用。
  5. Mock transport：不伪造视觉识别结果，`vision.analyzed=false`，并保留现有规则解析行为。
  6. 错误映射：413 → “图片过大，请压缩后重试”；422 → 字段级原因；超时/网络错误沿用现有错误码。
  7. `test/agent-turn.test.cjs` 与 `test/agent-intake-flow.test.cjs` 不回归。
- **delivery_evidence**: 新增测试输出；`npm run build` 退出码；相关既有测试输出。
- **dispatch_priority**: P0（与 T1–T4 并行；T14 依赖上传组件）

#### T6 真实渲染预览通道：打开工程 + 截图回传面板

- **owner_role**: coding-engineer
- **objective**: 提供“在微信开发者工具打开已导出工程”的桌面入口与截图回传面板；把可测试的路径/截图校验抽成纯模块；明确人工步骤，不声称应用内实时渲染。
- **requirement_refs**: R6.1–R6.4、R7.3
- **write_set**:
  - `desktop/preview-channel.cjs`（新增，纯校验/读取）
  - `desktop/main.cjs`（修改，注册 IPC）
  - `desktop/preload.cjs`（修改，暴露 IPC）
  - `src/components/preview/RealPreviewPanel.jsx`（新增）
  - `src/components/preview/real-preview.css`（新增，组件级样式）
  - `test/real-preview-channel.test.cjs`（新增）
- **provides**: `C-REAL-PREVIEW@1`
- **consumes**: 无（复用现有 `devtools-probe` 能力，不修改其契约）
- **blocked_by**: 无
- **verify_after**: 无；运行 `node --test test/real-preview-channel.test.cjs && node --check desktop/main.cjs && node --check desktop/preload.cjs`，并运行 `npm run build`
- **acceptance_and_local_checks**:
  1. `preview:open-project` 只接受存在的绝对目录路径；非法/不存在返回稳定 code；不得执行任意 shell 命令。
  2. `preview:pick-screenshot` 只接受 PNG/JPEG 且 ≤8 MiB；取消返回 `{cancelled:true}`；读取失败返回可读错误。
  3. preload 暴露 `openPreviewProject` 与 `pickPreviewScreenshot`，且不影响现有 `smartStore` 方法。
  4. 面板显示：打开工程按钮、选择截图按钮、截图预览、清除、错误、人工步骤说明。
  5. 面板文案明确“真实渲染截图回传 ≠ 应用内实时渲染”，并列出代理/AppID 人工步骤。
  6. 截图不上传网络；不写入导出工程。
- **delivery_evidence**: 新增测试输出；`node --check` 退出码；`npm run build` 退出码；IPC 通道名与 preload 方法名清单。
- **dispatch_priority**: P1（可与 T1–T5 并行；T14 需要其组件）

#### T7 后端展示能力：补丁校验 + 模板修改 + 候选推荐

- **owner_role**: coding-engineer
- **objective**: 在 NestJS `agent` 模块内新增展示补丁服务端校验、`agent-template-revise.v1` 与 `agent-template-candidates.v1` 两个接口及其 Provider；服务端重算补丁与变更，不信任模型输出。
- **requirement_refs**: R2.1、R3.1、R3.4–R3.7、R7.2
- **write_set**:
  - `server/src/agent/presentation/presentation-patch.ts`（新增）
  - `server/src/agent/presentation/template-revise.service.ts`（新增）
  - `server/src/agent/presentation/template-revise.controller.ts`（新增）
  - `server/src/agent/presentation/template-revise.provider.ts`（新增）
  - `server/src/agent/presentation/template-candidates.service.ts`（新增）
  - `server/src/agent/presentation/template-candidates.controller.ts`（新增）
  - `server/src/agent/agent.module.ts`（修改，注册新增 Controller/Provider）
  - `server/test/presentation-patch.test.ts`（新增）
  - `server/test/template-revise.test.ts`（新增）
  - `server/test/template-candidates.test.ts`（新增）
- **provides**: `C-PRESENTATION-PATCH@1`（服务端实现）、`C-TEMPLATE-REVISE@1`、`C-TEMPLATE-CANDIDATES@1`
- **consumes**: `C-SERVER-ENV@1`（`DEEPSEEK_MODEL/VISION_MODEL` 与请求体上限，缺省按默认值）
- **blocked_by**: 无
- **verify_after**: T9 完成后可验证真实 413；本地单测用注入 `AGENT_FETCH` stub，不请求真实 DeepSeek
- **acceptance_and_local_checks**:
  1. 服务端补丁校验与 2.2.4 规则逐条一致；错误码与 details 路径精确；无部分应用。
  2. `POST /agent/template-revise`：请求校验 → Provider → 合并 → 再校验 → 重算 `changes` → 200；任何失败保留上一版。
  3. 模型输出非 JSON、缺字段、非法 patch → 502/422；日志不记录 base64、Key、完整模型 payload。
  4. `POST /agent/template-candidates`：强制 3 个已知模板 ID、不重复、理由 ≤80 码点；非法输出 502。
  5. 两个 Controller 使用 `AgentAuthGuard` 与 `AgentExceptionFilter`；错误体含 `requestId`。
  6. 不写数据库、不发布、不执行代码。
  7. `server` 的 `npm test` 通过；新增测试覆盖成功、422、502、503、超时分支。
- **delivery_evidence**: `server` 目录 `npm test` 的真实输出与退出码；新增测试文件清单；`git diff --stat`。
- **dispatch_priority**: P0（后端关键路径；与前端并行）

#### T8 后端视觉能力：`agent-turn.v2` 多模态与草稿抽取

- **owner_role**: coding-engineer
- **objective**: 在同一 `POST /api/v1/agent/turn` 路由按 `contractVersion` 分派 v1/v2；v2 接受受限图片、发送 OpenAI 多模态 content parts、使用视觉模型抽取草稿，同时保持 v1 完全兼容。
- **requirement_refs**: R4.1–R4.7、R7.1、R7.3、R7.5
- **write_set**:
  - `server/src/agent/agent.types.ts`（修改）
  - `server/src/agent/agent.service.ts`（修改）
  - `server/src/agent/agent.controller.ts`（修改）
  - `server/src/agent/provider/agent-provider.interface.ts`（修改）
  - `server/src/agent/provider/deepseek-agent.provider.ts`（修改）
  - `server/test/agent-turn-v2.test.ts`（新增）
  - `server/test/deepseek-agent.provider.test.ts`（按需补充）
- **provides**: `C-AGENT-TURN-V2@1`（服务端）
- **consumes**: `C-SERVER-ENV@1`（`DEEPSEEK_VISION_MODEL`，未配置时按默认 `deepseek-flash`）
- **blocked_by**: 无
- **verify_after**: T9 完成后验证环境变量校验与 413；本地单测注入 `AGENT_FETCH` stub
- **acceptance_and_local_checks**:
  1. v1 请求走原路径，响应字段与现有实现一致（无 `vision`）。
  2. v2 请求：图片张数/MIME/base64/解码大小/总大小/请求体校验全部生效；错误码与 2.2.7 一致。
  3. Provider：有图片时 `content` 为 `text + image_url` 数组；无图片时仍为字符串；视觉请求使用 `DEEPSEEK_VISION_MODEL`。
  4. 系统提示约束：菜单照只抽菜名/价格/描述，环境照不抽菜品，不编造价格。
  5. 响应含 `vision:{menuImages,storeImages,analyzed,degraded}`；失败不返回部分草稿。
  6. 日志只含计数与耗时，不含 base64/Key/原始 payload。
  7. `server` 的 `npm test` 通过；v1 既有测试不回归。
- **delivery_evidence**: `server` 的 `npm test` 输出与退出码；新增/补充测试文件；v1 兼容性测试结果。
- **dispatch_priority**: P0（后端关键路径；与 T7 并行）

#### T9 服务端请求体上限与环境变量

- **owner_role**: coding-engineer
- **objective**: 为 v2 图片请求提供可配置的 JSON body 上限与统一 413 错误；新增视觉模型环境变量并保持现有配置校验不回归。
- **requirement_refs**: R4.5、R7.3、R7.5
- **write_set**:
  - `server/src/main.ts`（修改）
  - `server/src/common/config/env.validation.ts`（修改）
  - `server/.env.example`（修改）
  - `server/test/body-limit.test.ts`（新增）
  - `server/test/env-validation.test.ts`（新增）
- **provides**: `C-SERVER-ENV@1`
- **consumes**: 无
- **blocked_by**: 无
- **verify_after**: 无；运行 `server` 的 `npm test` 与 `npm run build`
- **acceptance_and_local_checks**:
  1. `AGENT_MAX_BODY_BYTES` 默认 2097152，范围 262144–8388608；非法值启动失败并指出变量名。
  2. `DEEPSEEK_VISION_MODEL` 默认 `deepseek-flash`；非法格式启动失败。
  3. `main.ts` 显式启用 body parser，其他路由 JSON 解析不回归。
  4. 超过上限返回 413 `{ code:'AGENT_BODY_TOO_LARGE', message, requestId }`。
  5. `.env.example` 不含真实 Key；新增变量有注释。
  6. `server` 的 `npm test` 与 `npm run build` 通过。
- **delivery_evidence**: `server` 的 `npm test`、`npm run build` 输出与退出码；`.env.example` 变更摘要。
- **dispatch_priority**: P1（T7/T8 可先按契约编写；真实 413 验证依赖本任务）

#### T10 Composer：Plan 尺寸 token 校验、摘要与解析

- **owner_role**: coding-engineer
- **objective**: 让 Composer 接受并校验 `presentationTokens`，把它纳入 `planDigest` 与解析结果；同步 Recipe 镜像与 `cloneProps` 白名单，保证“预览/导出同源”门禁通过。
- **requirement_refs**: R1.3、R3.5、R7.4、R7.5
- **write_set**:
  - `scripts/composer/schema.cjs`（修改）
  - `scripts/composer/digest.cjs`（修改）
  - `scripts/composer/resolve.cjs`（修改）
  - `templates/registry/schema/composition.v1.json`（修改）
  - `templates/recipes/order-poster/1.0.0/plan.json`（修改，新增 `props.size:"md"`）
  - `src/domain/recipeCatalog.mjs`（修改：RECIPES 镜像 `size`；`cloneProps` 白名单加入 `size`）
  - `test/composer-presentation.test.cjs`（新增）
- **provides**: `C-PLAN-PRESENTATION@1`（Composer 校验/摘要/解析）
- **consumes**: `C-SIZE-TOKENS@1`、`C-PRESENTATION-PATCH@1`（字段形状）
- **blocked_by**: 无（按冻结契约编写；T1 尺寸表用于取值）
- **verify_after**: T1 完成后运行 `node --test test/composer-*.test.cjs test/recipe-catalog-sync.test.cjs test/compose-plan-from-session.test.cjs`
- **acceptance_and_local_checks**:
  1. `validatePlan`：`presentationTokens` 与 `slotOrder` 均可选；`presentationTokens` 值必须是 `sm|md|lg`；`slotOrder` 必须是完整排列且目标插槽合法；未知键仍按 `PLAN_FIELD_FORBIDDEN` 处理。
  2. 缺省 `presentationTokens`/`slotOrder` 时 Composer 仍通过，并按 `md` 与原声明落位处理。
  3. `planDigest` 包含 `presentationTokens` 与 `slotOrder`；相同输入重复导出摘要一致。
  4. `resolve` 把 `presentationTokens` 带入 graph；先按原始 `features[].slots[]` 校验 `requiresSlots`，再用 `slotOrder` 目标插槽作为 assignment key；目标 `accepts` 不匹配时返回 `SLOT_TYPE_REJECTED`。
  5. `templates/recipes/order-poster/1.0.0/plan.json` 的 `props.size` 与 `RECIPES['order-poster']` 完全一致；`cloneProps` 不再丢弃 `size`。
  6. `test/recipe-catalog-sync.test.cjs` 通过（预览/导出同源门禁）。
  7. 现有 Composer 测试不回归。
- **delivery_evidence**: 相关测试输出与退出码；`git diff --stat` 列出的 Plan/Composer 修改。
- **dispatch_priority**: P0（导出关键路径；与前端/后端并行）

#### T11 模板资产与 emit：尺寸 CSS 变量、菜单插槽、海报 `size` prop

- **owner_role**: coding-engineer
- **objective**: 让导出工程真正消费尺寸与区块落位：emit 输出尺寸 CSS 变量、按 `dataKey` 生成插槽配置；Base 新增 `menu-hero` 插槽与菜单页锚点；海报组件声明并应用 `size` prop。
- **requirement_refs**: R1.3、R2.2、R3.5、R7.4、R7.5
- **write_set**:
  - `scripts/composer/emit.cjs`（修改）
  - `scripts/composer/index.cjs`（修改，把 `presentationTokens` 传给 emit）
  - `templates/base/ordering-base/1.0.0/manifest.json`（修改，新增 `menu-hero`）
  - `templates/base/ordering-base/1.0.0/src/pages/menu/index.wxml`（修改，新增 `@slot:menu-hero` 锚点与 fallback）
  - `templates/base/ordering-base/1.0.0/src/components/store-header/index.wxss`（修改，消费 `--store-home-hero-min-height`）
  - `templates/base/ordering-base/1.0.0/src/components/product-card/index.wxss`（修改，消费 `--store-product-card-min-height`）
  - `templates/features/poster-carousel/1.0.0/manifest.json`（修改，声明 `size` prop）
  - `templates/features/poster-carousel/1.0.0/src/components/poster-carousel/index.js`（修改，声明 `size` 属性）
  - `templates/features/poster-carousel/1.0.0/src/components/poster-carousel/index.wxml`（修改，绑定尺寸类）
  - `templates/features/poster-carousel/1.0.0/src/components/poster-carousel/index.wxss`（修改，新增 `--sm/--md/--lg` 高度）
  - `test/composer-presentation-emit.test.cjs`（新增）
- **provides**: `C-PLAN-PRESENTATION@1`（导出侧实现）
- **consumes**: `C-SIZE-TOKENS@1`、`C-PLAN-PRESENTATION@1`（T10 的校验结果）
- **blocked_by**: 无（可先编辑模板与 emit；最终验证需 T10 + T1）
- **verify_after**: T10 与 T1 完成后运行 `node --test test/composer-presentation-emit.test.cjs test/composer-emit.test.cjs test/miniprogram-components.test.cjs test/miniprogram-domain.test.cjs`；再运行 `npm run composer:verify`（如可用）
- **acceptance_and_local_checks**:
  1. `buildThemeWxss(theme, presentationTokens)` 输出 `--store-home-hero-min-height` 与 `--store-product-card-min-height`，值来自 `size-tokens.v1.json` 的 `rpx`。
  2. `buildSlotsModule()` 使用 `slot.dataKey`（含 `menuHero`），不再用 slotId 三元表达式；`props.size` 原样透传；assignment key 使用 `slotOrder` 目标页面/插槽。
  3. Base manifest 新增 `menu-hero`：`pageId=menu`、`maxItems=1`、`accepts=[feature-pack,ui-block]`；菜单页 wxml 有完整锚点与 fallback；Base manifest 不新增 `dataKey` 字段；导出后 `pages/menu/index.json` 的 `usingComponents` 含 `poster-carousel`。
  4. 海报 manifest 声明 `size`，组件 `properties.size` 同步声明；wxml 输出 `poster-carousel--{{size}}` 类；wxss 三档高度与尺寸表一致。
  5. 现有 Composer/mini-program 组件测试不回归；确定性输出不变（除新增变量与 props）。
- **delivery_evidence**: 相关测试输出与退出码；`git diff --stat` 中模板资产清单；生成样例工程的 `theme.generated.wxss` 与 `config/slots.generated.js` 片段。
- **dispatch_priority**: P0（导出关键路径；与 T10 可并行，最终验证依赖 T10）

#### T12 刷新注册表锁并恢复门禁

- **owner_role**: coding-engineer
- **objective**: 在 T10/T11 完成所有模板资产变更后，重新冻结 `registry.lock.json`，并跑通注册表、Composer 与小程序门禁，避免资产摘要漂移。
- **requirement_refs**: R7.4、R7.5、R8.1
- **write_set**:
  - `templates/registry/registry.lock.json`（由命令重新生成，禁止手工编辑）
- **provides**: 无新契约；恢复 `C-PLAN-PRESENTATION@1` 的资产完整性
- **consumes**: `C-SIZE-TOKENS@1`、`C-PLAN-PRESENTATION@1`
- **blocked_by**: T10、T11（必须等所有 `templates/**` 与 `scripts/composer/**` 修改落地）
- **verify_after**: T10、T11 完成后执行
- **acceptance_and_local_checks**:
  1. `npm run registry:check -- --write` 成功生成新锁。
  2. 紧接着 `npm run registry:check` 退出码为 0。
  3. `npm run composer:verify`（若本机可用）通过。
  4. `npm run mini:check` 通过。
  5. 锁文件只包含版本与摘要，不含凭据。
- **delivery_evidence**: 四条命令的真实输出与退出码；锁文件 `contentDigest` 的前后值对比。
- **dispatch_priority**: P1（串行收尾；不阻塞前端并行工作）

#### T13 生图提示词 spec 与真实模板推荐接线

- **owner_role**: coding-engineer
- **objective**: 用结构化 `image-prompt-spec.v1` 替换固定文案拼接；用 `agent-template-candidates.v1` 替换本地假延时与编造 score；保留可读的本地降级并明确标注。
- **requirement_refs**: R1.1、R2.1、R5.1–R5.5
- **write_set**:
  - `templates/image-prompt-spec.v1.json`（新增）
  - `src/domain/imagePromptSpec.mjs`（新增）
  - `src/services/agentTurn/templateCandidatesService.js`（新增）
  - `src/services/agentService.js`（修改）
  - `test/image-prompt-spec.test.cjs`（新增）
  - `test/template-candidates-service.test.cjs`（新增）
- **provides**: `C-IMAGE-PROMPT-SPEC@1`、`C-TEMPLATE-CANDIDATES@1`（前端 consumer）
- **consumes**: `C-TEMPLATE-CANDIDATES@1`、`C-SIZE-TOKENS@1`
- **blocked_by**: 无（按冻结契约编写；HTTP 路径联调需 T7）
- **verify_after**: T7 完成后验证真实 HTTP；本地测试用 fetch stub
- **acceptance_and_local_checks**:
  1. `buildImagePromptSpec` 对 3 种 layout 返回不同结构化 spec；`prompt` ≤1200 码点，禁止项完整。
  2. `reviseImagePrompt` 把反馈写入 `extraRequirement`，保留禁止项。
  3. `composePrompt({ store, styleId, layout })` 使用 spec；保留 `tips`，且 `tips` 必须包含“接入真实生图需要服务商/Base URL/模型名/API Key”；不调用网络。
  4. `revisePrompt({ basePrompt, baseSpec, feedback })` 返回结构化结果；`agentService.revisePrompt` 的调用方兼容（返回字符串或对象需在 App 侧同步，见 T14）。
  5. `buildTemplateCandidates`：删除 1.6s 假延时；HTTP 模式调用 `template-candidates.v1`；`score` 由功能覆盖逐模板确定性计算，不使用 `topScore - index*9`。
  6. 模型失败：本地确定性排序 + `source:'本地规则（模型不可用）'` + `degraded:true` + 可见提示；Mock 模式标 `本地规则（Mock）`。
  7. `generateImage/reviseImage` 仍返回 `provider:'local-demo'`。
  8. 新增测试通过；`test/template-refine.test.cjs` 不回归。
- **delivery_evidence**: 两个新增测试输出与退出码；`npm run build` 退出码；`agentService.js` 变更摘要。
- **dispatch_priority**: P1（不阻塞主链路；R5 本轮可不接真实生图）

#### T14 `App.jsx` 接线：模板对话、图片上传、真实预览面板

- **owner_role**: coding-engineer
- **objective**: 在唯一入口 `App.jsx` 把 T3/T4/T5/T6/T13 的组件与服务接起来：模板页对话修改、实时预览刷新、图片上传与 v2 填表、导出后的真实截图回传。
- **requirement_refs**: R1.1、R1.2、R2.2–R2.4、R3.1–R3.3、R4.3、R4.4、R6.1–R6.3
- **write_set**:
  - `src/App.jsx`（修改）
  - `test/app-presentation-wiring.test.cjs`（新增，静态检查关键 dispatch/组件接线）
- **provides**: 集成接线（无新契约）
- **consumes**: `C-SESSION-PRESENTATION@1`、`C-TEMPLATE-GALLERY@1`、`C-VISION-UPLOADER@1`、`C-AGENT-TURN-V2@1`、`C-REAL-PREVIEW@1`、`C-TEMPLATE-REVISE@1`、`C-IMAGE-PROMPT-SPEC@1`
- **blocked_by**: T3、T4、T5、T6、T13（必须等这些组件/服务/状态动作实际存在，否则 App 无法导入）
- **verify_after**: T3/T4/T5/T6/T13 全部完成
- **acceptance_and_local_checks**:
  1. 模板页：`TemplateGallery` 收到 `presentation`、`compareIds`、`onRevise`；`onRevise` 触发 `TEMPLATE_REVISE_REQUEST`，请求携带当前 `patch`、候选、`planFeatures`、`agentDraft`；成功后 `TEMPLATE_REVISE_SUCCESS`，失败后 `TEMPLATE_REVISE_FAILURE`。
  2. `handleComposerSubmit` 在 `TEMPLATE_PICK` 时走模板修改，不再静默落空；在 `STORE_INFO` 时仍走 agent turn。
  3. 店铺资料页：渲染 `VisionImageUploader`；上传成功写入本地图片状态并传给 `requestAgentTurn({ images })`；环境照进入 `state.assets.images`。
  4. 导出完成视图：渲染 `RealPreviewPanel`，打开工程与选择截图分别调用 preload 方法；错误可见。
  5. `composePrompt` 调用新增 `layout` 参数（取当前选中候选的 `layout`）并消费返回的 `prompt/spec/tips`；`revisePrompt` 返回结构化对象时，`handlePromptFeedback` 使用 `nextPrompt.prompt ?? nextPrompt` 保持兼容。
  6. 所有新增 JSX 组件与 `await` 函数都有导入/本地定义；`test/app-imports.test.cjs` 通过。
  7. 现有模板页“重新描述候选”、撤销快捷键、deploy/handoff 行为不回归。
- **delivery_evidence**: `test/app-presentation-wiring.test.cjs` 输出；`test/app-imports.test.cjs` 输出；`npm run build` 退出码；`git diff --stat src/App.jsx`。
- **dispatch_priority**: P0（集成收口；必须等依赖任务完成，是主链路关键路径）

### 3.2 Ownership and Dispatch Readiness

| Task ID | Provides / consumes revisions | Contract evidence | Ownership result | Genuine start prerequisites | Planning readiness / blocker | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | provides `C-PRESENTATION-PATCH@1`、`C-SIZE-TOKENS@1`、`C-VISION-UPLOADER@1`（纯函数部分）；consumes 无 | 2.2.1、2.2.4、2.2.6 | 独占 6 个新增文件，无重叠 | 无 | PLANNING_READY | P0 |
| T2 | provides `C-PLAN-PRESENTATION@1`（投影/预览）；consumes `C-PRESENTATION-PATCH@1`、`C-SIZE-TOKENS@1`、`C-SESSION-PRESENTATION@1` | 2.2.1、2.2.2、2.2.3、2.2.4 | 独占 `src/composition/*` 与 `src/components/preview/*`、`src/styles/preview.css`；不与 T4/T5 重叠 | 无（T1 文件用于编译/测试） | PLANNING_READY；验证等待 T1 | P0 |
| T3 | provides `C-SESSION-PRESENTATION@1`；consumes `C-PRESENTATION-PATCH@1` | 2.2.3、2.2.4 | 独占 `src/state/sessionMachine.mjs`；不与 T4/T14 重叠 | 无（T1 模块用于编译） | PLANNING_READY；验证等待 T1 | P0 |
| T4 | provides `C-TEMPLATE-GALLERY@1`、`C-TEMPLATE-REVISE@1`（前端）；consumes `C-SESSION-PRESENTATION@1`、`C-PRESENTATION-PATCH@1` | 2.2.5、2.2.8 | 独占 `src/components/flow/*`、`src/styles/flow.css`、`src/services/agentTurn/templateRevise*.js`、`agentServiceConfig.js` | 无（T1/T3 文件用于编译） | PLANNING_READY；验证等待 T1/T3 | P0 |
| T5 | provides `C-VISION-UPLOADER@1`（DOM）、`C-AGENT-TURN-V2@1`（client）；consumes `C-VISION-UPLOADER@1`（纯函数）、`C-AGENT-TURN-V2@1` | 2.2.6、2.2.7 | 独占 `src/components/agent/*`、`src/styles/agent.css`、`src/services/agentTurn/{httpAgentTransport,mockAgentTransport,agentTurnService,agentImageUpload}.js` | 无（T1 纯模块用于编译） | PLANNING_READY；验证等待 T1 | P0 |
| T6 | provides `C-REAL-PREVIEW@1`；consumes 无 | 2.2.11 | 独占 `desktop/preview-channel.cjs`、`desktop/main.cjs`、`desktop/preload.cjs`、`src/components/preview/RealPreviewPanel.jsx`、`real-preview.css` | 无 | PLANNING_READY | P1 |
| T7 | provides `C-PRESENTATION-PATCH@1`（服务端）、`C-TEMPLATE-REVISE@1`、`C-TEMPLATE-CANDIDATES@1`；consumes `C-SERVER-ENV@1` | 2.2.4、2.2.8、2.2.9、2.2.12 | 独占 `server/src/agent/presentation/**` 与 `agent.module.ts`；不与 T8/T9 重叠 | 无 | PLANNING_READY；真实 413 验证等待 T9 | P0 |
| T8 | provides `C-AGENT-TURN-V2@1`（服务端）；consumes `C-SERVER-ENV@1` | 2.2.7、2.2.12 | 独占 `server/src/agent/{agent.types.ts,agent.service.ts,agent.controller.ts,provider/*}`；不与 T7/T9 重叠 | 无 | PLANNING_READY；验证等待 T9 | P0 |
| T9 | provides `C-SERVER-ENV@1`；consumes 无 | 2.2.12 | 独占 `server/src/main.ts`、`server/src/common/config/env.validation.ts`、`server/.env.example` | 无 | PLANNING_READY | P1 |
| T10 | provides `C-PLAN-PRESENTATION@1`（Composer 校验/摘要/解析）；consumes `C-SIZE-TOKENS@1`、`C-PRESENTATION-PATCH@1` | 2.2.1、2.2.2、2.2.4 | 独占 `scripts/composer/{schema,digest,resolve}.cjs`、`templates/registry/schema/composition.v1.json`、`templates/recipes/order-poster/1.0.0/plan.json`、`src/domain/recipeCatalog.mjs` | 无（T1 尺寸表用于取值） | PLANNING_READY；验证等待 T1 | P0 |
| T11 | provides `C-PLAN-PRESENTATION@1`（导出侧）；consumes `C-SIZE-TOKENS@1`、`C-PLAN-PRESENTATION@1` | 2.2.1、2.2.2 | 独占 `scripts/composer/{emit,index}.cjs` 与 `templates/base/*`、`templates/features/poster-carousel/*` | 无（最终验证需 T10/T1） | PLANNING_READY；验证等待 T10/T1 | P0 |
| T12 | provides 无（恢复资产完整性）；consumes `C-SIZE-TOKENS@1`、`C-PLAN-PRESENTATION@1` | 2.2.1、2.2.2 | 独占 `templates/registry/registry.lock.json` | T10、T11 的所有模板/Composer 修改已落地，否则锁会再次漂移 | BLOCKED until T10/T11 | P1 |
| T13 | provides `C-IMAGE-PROMPT-SPEC@1`、`C-TEMPLATE-CANDIDATES@1`（前端）；consumes `C-TEMPLATE-CANDIDATES@1`、`C-SIZE-TOKENS@1` | 2.2.9、2.2.10 | 独占 `templates/image-prompt-spec.v1.json`、`src/domain/imagePromptSpec.mjs`、`src/services/agentTurn/templateCandidatesService.js`、`src/services/agentService.js` | 无 | PLANNING_READY；真实 HTTP 验证等待 T7 | P1 |
| T14 | provides 集成接线；consumes `C-SESSION-PRESENTATION@1`、`C-TEMPLATE-GALLERY@1`、`C-VISION-UPLOADER@1`、`C-AGENT-TURN-V2@1`、`C-REAL-PREVIEW@1`、`C-TEMPLATE-REVISE@1`、`C-IMAGE-PROMPT-SPEC@1` | 2.2.3–2.2.11 | 独占 `src/App.jsx` | T3、T4、T5、T6、T13 的实际组件/服务/动作存在 | BLOCKED until T3/T4/T5/T6/T13 | P0 |

#### 3.2.1 文件所有权矩阵（write_set 冲突检查）

| 文件/目录 | 唯一写入任务 | 说明 |
| --- | --- | --- |
| `src/domain/presentationPatch.mjs`、`previewSizeTokens.mjs`、`agentImageInput.mjs`、`templates/presentation/size-tokens.v1.json` | T1 | 基础契约 |
| `src/composition/planFromSession.mjs`、`previewViewModel.mjs`、`src/components/preview/{MiniProgramPreview,PreviewTabs,PreviewShared,PosterCarouselBlock}.jsx`、`src/styles/preview.css` | T2 | 预览投影 |
| `src/state/sessionMachine.mjs` | T3 | 状态机 |
| `src/components/flow/*`、`src/styles/flow.css`、`src/services/agentTurn/templateRevise*.js`、`src/services/agentTurn/agentServiceConfig.js` | T4 | 模板页与 revise client |
| `src/components/agent/*`、`src/styles/agent.css`、`src/services/agentTurn/{httpAgentTransport,mockAgentTransport,agentTurnService,agentImageUpload}.js` | T5 | 图片与 v2 client |
| `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/preview-channel.cjs`、`src/components/preview/RealPreviewPanel.jsx`、`real-preview.css` | T6 | 真实预览通道 |
| `server/src/agent/presentation/**`、`server/src/agent/agent.module.ts` | T7 | 后端展示能力 |
| `server/src/agent/{agent.types.ts,agent.service.ts,agent.controller.ts,provider/*}` | T8 | 后端视觉能力 |
| `server/src/main.ts`、`server/src/common/config/env.validation.ts`、`server/.env.example` | T9 | 配置与 body 上限 |
| `scripts/composer/{schema,digest,resolve}.cjs`、`templates/registry/schema/composition.v1.json`、`templates/recipes/order-poster/1.0.0/plan.json`、`src/domain/recipeCatalog.mjs` | T10 | Plan 校验/摘要/解析 |
| `scripts/composer/{emit,index}.cjs`、`templates/base/ordering-base/1.0.0/**`、`templates/features/poster-carousel/1.0.0/**` | T11 | 导出与模板资产 |
| `templates/registry/registry.lock.json` | T12 | 仅命令生成 |
| `templates/image-prompt-spec.v1.json`、`src/domain/imagePromptSpec.mjs`、`src/services/agentTurn/templateCandidatesService.js`、`src/services/agentService.js` | T13 | 提示词与推荐 |
| `src/App.jsx` | T14 | 唯一接线点 |
| `tests` | 各自任务新增自己的测试文件；T1/T2/T3/T4/T5/T6/T10/T11/T13 的测试文件互不重名 | 读取共享，写入独立 |

**共享只读**：`package.json`、`docs/*`、`templates/registry/registry.v1.json`（除 T12 的锁）。
**共享可变资源**：`dist/`、`server/dist/`、`server` 测试数据库由 T15 串行执行，避免并行写入。

#### 3.2.2 候选初始就绪集合与补充顺序

- **初始可并行就绪集合**（契约 READY、文件所有权清晰、无未完成执行依赖）：`T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T13`。
- **依赖 T1 的验证等待**（可先写代码）：T2、T3、T4、T5、T10、T11、T13。
- **补充顺序**：
  1. T1 优先（基础数据结构）。
  2. T12 在 T10、T11 完成后。
  3. T14 在 T3、T4、T5、T6、T13 完成后。
  4. T15 在全部实现任务完成后。
  5. T16 在 T15 通过后。
- **未就绪**：T12（BLOCKED by T10/T11）、T14（BLOCKED by T3/T4/T5/T6/T13）。

#### 3.2.3 派发交接规则

> The team leader must inspect the relevant contract definitions and ownership evidence before dispatch. After that check, launch ready tasks consecutively up to available capacity. Do not wait or perform blocking output collection between independent launches. Refill capacity as tasks finish; do not wait for an entire wave. Recheck affected entries after contract, ownership, or prerequisite changes.

中文执行要求：团队负责人必须先核对 2.2 契约与 3.2.1 所有权矩阵，再按实际并发容量连续派发 `PLANNING_READY` 任务；独立任务之间不得等待或阻塞收结果；任务结束即补位；契约、所有权或前置条件变化后必须重新核对受影响行。

#### 3.2.4 审批检查点

- 计划层面只保留一次用户确认（本计划是否覆盖预期功能）；不要求逐任务、逐契约审批。
- 契约变更（尤其 `C-PRESENTATION-PATCH@1`、`C-AGENT-TURN-V2@1`、`C-TEMPLATE-REVISE@1`）必须先经团队负责人协调，再更新受影响任务与验证证据；不得静默替换已被编码使用中的接口。

### 3.3 Validation and Testing Tasks

#### T15 构建、门禁与安全扫描集成验证

- **owner_role**: team-result-verifier
- **objective**: 在全部实现任务完成后，独立执行项目门禁与安全扫描，记录真实命令、退出码与关键输出；不修改生产代码。
- **requirement_refs**: R7.1–R7.5、R8.1、R8.3
- **write_set**: 无（只读验证；不得修改 `src/`、`server/src/`、`scripts/`、`templates/`）
- **provides**: 无（验证证据）
- **consumes**: 全部实现任务产物
- **blocked_by**: T1–T14（含 T12）
- **verify_after**: 全部实现完成
- **acceptance_and_local_checks**（按顺序执行，记录每条命令的退出码与关键输出）:
  1. `npm test`
  2. `npm run build`
  3. `npm run test:desktop`
  4. `npm run registry:check`
  5. `npm run mini:check`
  6. 在 `server/` 执行 `npm test`
  7. 在 `server/` 执行 `npm run build`
  8. `node --check desktop/main.cjs` 与 `node --check desktop/preload.cjs`
  9. 扫描 `dist/` 与 `server/dist/`，确认不含 `DEEPSEEK_API_KEY` 的值、`sk-` 前缀密钥、`data:image` 的 base64 大块（构建产物不应内联真实图片）。
  10. 如本机具备 MySQL/Redis：启动 `npm run server:dev`（`CACHE_DRIVER=memory`），请求 `GET /api/v1/health` 与 `GET /api/v1/ready`，记录状态码；不具备则标记 `INCOMPLETE`，不得写通过。
- **acceptance**: 1–9 全部退出码 0 且输出无失败；第 10 项按环境如实记录。
- **delivery_evidence**: 每条命令的完整命令、退出码、通过/失败计数、失败原文（不得润色）；安全扫描命中的文件路径。
- **notes**: 本任务只证明“门禁与构建通过”，不证明端到端业务可用；后者由 T16 负责。

#### T16 端到端全链路验收（真实走查 + VERDICT）

- **owner_role**: team-result-verifier
- **objective**: 真实跑通“本地对话 → 模板候选 → 对话修改模板 → 实时预览 → 传图填表 → 用户修改 → 确认 → 导出”，并对微信开发者工具截图回传与人工步骤给出明确结论。
- **requirement_refs**: R1.1–R1.4、R2.4、R3.1–R3.3、R4.1–R4.4、R5.1、R6.1–R6.4、R8.2、R8.3
- **write_set**: 无（只读验收；不修改生产代码）
- **provides**: 端到端验收结论（`VERDICT: PASS|FAIL|INCOMPLETE`）
- **consumes**: T14 接线、T7/T8/T9 后端、T12 导出资产、T13 提示词
- **blocked_by**: T15（门禁通过后才能进入真实走查）
- **verify_after**: T15 通过且服务端可用
- **验收步骤**:
  1. 以测试模式启动后端（`npm run server:dev`，`CACHE_DRIVER=memory`），确认 `/api/v1/health`、`/api/v1/ready`。
  2. 启动桌面端（`npm run desktop:dev` 或已构建的桌面应用）；设置 `VITE_AGENT_TRANSPORT=http` 指向本机后端。
  3. 从首页开始：输入店名/品类/营业时间/取餐方式 → 功能选择 → 模板页出现 3 套候选与理由。
  4. 在模板页切换 3 套候选，确认预览按 layout 刷新；进入对比模式，确认两套并排显示。
  5. 输入一次自然语言修改（例如“主色换成墨绿，商品卡小一点”）；确认预览立即变化、变更清单逐条显示、`Ctrl+Z` 可撤销。
  6. 上传 1 张菜单照 + 1 张环境照；确认菜单照生成菜品草稿、环境照不生成菜品；手工修改草稿后预览同步。
  7. 确认资料 → 选择风格 → 生成提示词（检查为结构化 spec 生成的文本）→ 生成占位图（确认 `local-demo` 标注）→ 导出工程。
  8. 运行 `npm run mini:check` 与 Composer verify，确认导出工程可静态校验。
  9. 人工步骤：在微信开发者工具中导入导出工程、编译、截图；回到应用通过 `RealPreviewPanel` 回填截图。记录代理/AppID 处理情况。
  10. 若第 9 步因本机环境无法执行，必须明确写 `INCOMPLETE` 并列出阻塞原因；不得写 PASS。
- **判定规则**:
  - 自动化步骤 1–8 全部通过，且人工步骤 9 真实执行并附截图路径 → `VERDICT: PASS`。
  - 任一必需步骤失败或未执行 → `VERDICT: FAIL` 或 `VERDICT: INCOMPLETE`，附失败原文与未执行原因。
- **delivery_evidence**: 每条命令/操作的命令、退出码、截图绝对路径、关键输出、失败原文；导出工程路径；完整 `VERDICT` 与未决问题清单。
- **notes**: 严禁用 React 预览截图冒充微信运行时截图；严禁在未执行 GUI 走查时声称全链路打通。
