# Agent 资料收集（agent-turn.v1）编码任务清单

> 文档状态：待执行（本文件只做任务规划，不含业务实现代码）
> 设计依据：`docs/agent-turn-design.md`（2026-10-31 设计评审稿，本轮唯一技术设计依据）
> 需求依据：`docs/product-scope.md`、`docs/上一轮构建问题审计与修复交接.md`、`docs/后端待实现接口清单.md`、`docs/api.md`、根目录需求文档中「初赛 MVP 功能」与「不要一开始就做自主规划、多 Agent 协作或动态生成代码」的约束
> 适用阶段：`STORE_INFO` 阶段接入自然语言资料收集、结构化草稿确认、Mock 失败态与重试
> 说明：当前仓库没有 `.codeartsdoer/specs/` 下的 spec/design 目录；本清单以用户指定的 `docs/agent-turn-design.md` 作为等价设计文档生成。若后续迁移到 SDD 目录，可原样复制本文件，任务编号不变。

---

## 0. 总览

### 0.1 阶段划分、任务与交付物

| 阶段 | 主任务编号 | 主任务数 | 交付物 | 阶段验收门槛 |
| --- | --- | --- | --- | --- |
| 阶段 0：基线 | 1 | 1 | 基线记录、禁止项清单 | 旧测试与构建结果有真实记录 |
| 阶段 A：领域层 | 2–4 | 3 | `src/domain/agentDraft.mjs`、`test/agent-draft.test.cjs` | D1–D28 全绿 |
| 阶段 B：服务层 | 5–9 | 5 | `src/services/agentTurn/*`、`test/agent-turn.test.cjs` | T1–T19 全绿、无真实网络 |
| 阶段 C：状态层 | 10–15 | 6 | `sessionMachine.mjs` 增量、`constants.mjs` 增量、`test/agent-intake-flow.test.cjs` | F1–F15 全绿、旧 20 项不回归 |
| 阶段 D：组件与接线 | 16–21 | 6 | `src/components/agent/*`、`agent.css`、`App.jsx` 接线 | 构建通过、组件无 `fetch`、人工走查通过 |
| 阶段 E：文档 | 22–24 | 3 | 契约、后端待实现清单、待完成目标、交接、构建介绍 | 契约冻结、明确未接入真实模型 |
| 阶段 F：全量验证 | 25–26 | 2 | 真实验证输出、交付核对 | `npm test`、`npm run build` 通过 |

**总计：26 个主任务、125 个二级子任务、约 590 条勾选检查（含验收标准）。**

### 0.2 依赖图

```text
1 基线
└─ 2 领域基础 → 3 领域校验 → 4 领域合并/投影
                              ├─ 5 服务配置/错误 → 6 Mock → 7 HTTP → 8 Service → 9 服务测试
                              └─ 10 状态初始化 → 11 请求生命周期 → 12 草稿编辑
                                                   → 13 确认/兼容 → 14 Composer 选择器 → 15 流程测试
15 ─ 16 AgentIntakePanel → 17 DraftEditor → 18 AgentDraftSummary → 19 样式
                                                              → 20 App 接线 → 21 组件约束/人工走查
21 → 22 契约文档 → 23 项目状态文档（后端清单/待完成目标/交接）→ 24 构建介绍
24 → 25 全量测试与构建 → 26 交付核对
```

依赖约束：
- 任务 5 可复用任务 2 的价格解析；任务 6 依赖任务 3 的营业时间归一化；任务 8 依赖任务 4 的投影/反投影。
- 任务 10–15 必须串行，因为都修改 `src/state/sessionMachine.mjs`。
- 任务 16–20 必须串行，因为组件被 `App.jsx` 引用后才进入构建；任务 19 的样式可在 16–18 后单独完成。
- 文档任务必须在代码任务完成后执行，以便写入真实测试数量与构建输出。

### 0.3 全局验收门槛

- [ ] **G1 旧测试不回归**：`npm test` 中原有 20 项全部通过（2 项导出 + 18 项状态机/交接/引导）。
- [ ] **G2 领域边界**：`test/agent-draft.test.cjs` 覆盖 D1–D28，全部通过。
- [ ] **G3 传输与服务**：`test/agent-turn.test.cjs` 覆盖 T1–T19，全部通过；测试中不出现真实网络请求。
- [ ] **G4 流程四条交互**：`test/agent-intake-flow.test.cjs` 覆盖 F1–F15，至少明确覆盖：
  - 资料不完整时追问；
  - 资料完整进入可编辑确认；
  - 修改价格或菜品后重新校验；
  - Mock 请求失败后可重试。
- [ ] **G5 生产构建**：`npm run build` 退出码 0，无未解析 import。
- [ ] **G6 组件纪律**：`src/components/agent/` 下无 `fetch`、无 `agentTurnService`/`requestAgentTurn` import、无价格换算与校验实现。
- [ ] **G7 文档收口**：新增 `docs/agent-turn-contract.md`、`docs/本轮Agent接入前准备交接.md`；更新 `docs/后端待实现接口清单.md`、`docs/待完成目标.md`、`docs/本轮构建介绍.md`；文档明确写「真实 ModelArts 尚未接入」。
- [ ] **G8 禁止文件零新增改动**：与任务 1 的 `git diff --name-only` 快照对比，`server/`、`templates/`、`miniprogram/`、`package.json`、`src/services/agentService.js` 无新增差异。
- [ ] **G9 无新依赖**：`package.json` 与 lockfile 不变；不引入表单库、校验库、HTTP 库、状态库、React 测试库。
- [ ] **G10 无越界副作用**：不写 `localStorage`、不调用后端、不写库、不读取/写入任何云凭据、不调用真实模型。

### 0.4 通用执行纪律（每个任务都适用）

- 只做局部 `Edit` 与新增文件；**禁止** `git reset`、`git checkout`、`git clean`、`git stash`、全文件重排、全仓格式化。
- 开始任务前用 `git diff -- <文件>` 核对该文件当前内容，避免覆盖用户未提交改动。
- 任务结束运行该任务列出的测试；失败不得进入下一任务。
- **不运行** `server/` 下任何命令（`npm run build`、`npm test`、`npm run start:*`）。
- **不运行** `npm run build:win`（Electron 打包不是本轮范围，且上一轮已知 GitHub 下载阻塞）。
- 不修改 `src/services/agentService.js` 的既有占位行为；新服务放在独立 `agentTurn` 目录，两者不互相 import。
- 所有新增样式使用 `.agent-*` 命名空间，不改 `tokens.css` 与既有组件类。
- 每完成一个阶段，在最终报告中记录：改动文件、执行命令、真实输出、未解决问题。

### 0.5 明确不做（红线）

- 不新增顶层 phase；`STORE_INFO` 仍是「店铺装修」阶段，Agent 只作为该阶段的前置资料收集。
- 不做通用 Agent 框架、Skill/插件注册、工具调用编排、多 Agent、自主规划、动态执行模型输出。
- 不调用真实模型、不接入 ModelArts Studio/盘古、不配置或伪造华为云 AK/SK、不读取任何真实凭据。
- 不做认证、登录、会话持久化、业务写库、门店/菜品落库；店主确认前不保存、不发布。
- 不修改 B1 点餐模块、`server/`、`templates/mini-program/`、`miniprogram/`。
- 不做 Electron 打包、菜单系统、自动上传审核发布。
- 不做语音输入、图片上传、多语言、多人协作、审批流。
- 不做菜品拖拽排序、规格/加料、库存、分类管理。
- 不引入任何新依赖。

### 0.6 需要人工确认的两个决策点

#### D-1（必须先确认）：`requesting` 期间草稿编辑与响应覆盖冲突

设计文档存在一处内部张力：
- `docs/agent-turn-design.md:344` 与 `:1243` 允许 `requesting` 期间编辑草稿，并注明「下次请求使用最新草稿」；
- 但 `AGENT_TURN_SUCCESS` 用 transport 返回的 `draft` 覆盖整个草稿（`:673`），请求期间的手工编辑会被静默覆盖；
- `AGENT_TURN_RETRY` 又要求复用「当前最新草稿」（`:1085`）。

可选方案：

| 方案 | 行为 | 代价 | 建议 |
| --- | --- | --- | --- |
| A | 请求期间 `DraftEditor` 只读（`disabled=true`），`Composer` 仍可输入；响应后恢复编辑 | 与设计表格「草稿编辑可用」文字不一致，但最保守、可测试 | **默认执行 A**，除非用户明确选 B |
| B | 允许编辑；在 `agent` 切片增加 `draftRevision`，`REQUEST` 记录版本，`SUCCESS` 若版本变化则保留本地草稿、只合并 `reply/meta`，缺项本地重算 | 需要新增字段、额外测试 F-EDIT；复杂度上升 | 若坚持设计原文选 B |
| C | 按设计字面实现但不处理覆盖 | 请求期间编辑丢失，演示时可能被追问 | 不推荐 |

**执行约定**：未获用户确认时按 A 实施；任务 20 的 `DraftEditor disabled` 取值按 A；若选 B，任务 11/12/20 需补充 revision 逻辑与测试，任务 15 增加对应用例。该差异必须写入 `docs/本轮Agent接入前准备交接.md`。

#### D-2：`AgentTurnError` 的模块归属

设计文件清单（`docs/agent-turn-design.md:1505-1521`）未单独列出错误模块，但 HTTP transport 与 service 都需要构造/识别 `AgentTurnError`。

| 方案 | 做法 | 代价 | 建议 |
| --- | --- | --- | --- |
| A | 新增 `src/services/agentTurn/agentTurnError.js`，集中错误码、`createAgentTurnError`、`isAgentTurnError`、`normalizeAgentTurnError` | 新增 1 个文件（总新增文件 16 个） | **默认执行 A** |
| B | 在 `httpAgentTransport.js` 内实现并导出错误构造，service 复用 | 不新增文件，但 HTTP 模块承担非 HTTP 错误职责 | 若要求严格文件清单选 B |

**执行约定**：未获确认时按 A 实施；若选 B，任务 5/7/8 的 import 与验收命令相应调整，并在交接文档记录。

### 0.7 文件清单与数量

**新增（16 个，含条件新增的 `agentTurnError.js` 与本任务文档）**

| 文件 | 所属任务 |
| --- | --- |
| `src/domain/agentDraft.mjs` | 2–4 |
| `src/services/agentTurn/agentServiceConfig.js` | 5 |
| `src/services/agentTurn/agentTurnError.js`（D-2 方案 A） | 5 |
| `src/services/agentTurn/mockAgentTransport.js` | 6 |
| `src/services/agentTurn/httpAgentTransport.js` | 7 |
| `src/services/agentTurn/agentTurnService.js` | 8 |
| `src/components/agent/AgentIntakePanel.jsx` | 16 |
| `src/components/agent/DraftEditor.jsx` | 17 |
| `src/components/agent/AgentDraftSummary.jsx` | 18 |
| `src/styles/agent.css` | 19 |
| `test/agent-draft.test.cjs` | 2–4 |
| `test/agent-turn.test.cjs` | 5–9 |
| `test/agent-intake-flow.test.cjs` | 10–15 |
| `docs/agent-turn-contract.md` | 22 |
| `docs/本轮Agent接入前准备交接.md` | 23 |
| `docs/tasks-agent-turn.md` | 本文件 |

**修改（8 个）**

| 文件 | 改动范围 | 所属任务 |
| --- | --- | --- |
| `src/state/constants.mjs` | `STORE_INFO` 的 Composer 文案、`AGENT_STATUS` 常量 | 10 |
| `src/state/sessionMachine.mjs` | `agentDraft/agent` 切片、`AGENT_*` action、选择器、预填/同步/防御、交接 payload | 10–14 |
| `src/components/chat/Composer.jsx` | 可选 `submitDisabled`，默认等于 `disabled` | 16 前（任务 16 的前置小改动，归入任务 16） |
| `src/App.jsx` | `STORE_INFO` 渲染、Composer 分流、请求 handler、右栏卡片、`storeTypes` 注入 | 20 |
| `src/styles/index.css` | 末尾追加 `@import './agent.css';` | 19 |
| `docs/后端待实现接口清单.md` | 新增「Agent 资料收集」章节 | 23 |
| `docs/待完成目标.md` | 追加本轮目标与验证证据 | 23 |
| `docs/本轮构建介绍.md` | 追加本轮构建说明 | 24 |

**不改**：`src/services/agentService.js`、`src/components/build/StoreInfoStep.jsx`、`src/domain/catalog.mjs`、`src/domain/storeBrief.mjs`、`server/**`、`templates/mini-program/**`、`miniprogram/**`、`package.json`、lockfile、`desktop/**`。

### 0.8 测试矩阵与四条交互映射

| 测试编号 | 测试文件 | 覆盖任务 | 主要断言 |
| --- | --- | --- | --- |
| D1–D28 | `test/agent-draft.test.cjs` | 2–4 | 领域边界、价格、营业时间、菜品、投影/反投影、纯函数性 |
| T1–T19 | `test/agent-turn.test.cjs` | 5–9 | Mock 解析、Mock 失败、HTTP 契约、超时、错误归一化、本地校验覆盖 |
| T20 | `test/agent-turn.test.cjs` 或任务 21 静态检查 | 21 | 组件不触网、不 import service |
| F1–F15 | `test/agent-intake-flow.test.cjs` | 10–15 | reducer + service 流程、确认映射、失败重试、旧流程兼容 |

四条必需交互的测试落点：

| 交互 | 自动化测试 | 人工走查 |
| --- | --- | --- |
| 资料不完整追问 | F1、T1、T3 | 任务 21 第 2 步 |
| 资料完整进入可编辑确认 | F2、F12 | 任务 21 第 3 步 |
| 修改价格或菜品后重新校验 | F3、F4、F5 | 任务 21 第 4 步 |
| Mock 请求失败后可重试 | T6、T7、F6、F7、F14、F15 | 任务 21 第 5–6 步 |

---

# 阶段 0：基线

## 1. 记录基线并锁定改动边界

| 项目 | 内容 |
| --- | --- |
| 依赖 | 无 |
| 涉及文件 | 只读；新增本任务文档 `docs/tasks-agent-turn.md` |
| 对应测试 | 无新增；运行现有 `npm test` 与 `npm run build` |
| 明确不做 | 不修改任何源码、不修复既有失败、不运行 `server/` 与 `build:win`、不执行任何 git 写操作 |
| 风险与回退 | 基线可能因用户未提交改动而失败：只记录、不修；回退无（全部只读） |

### 1.1 记录旧测试基线

- [ ] 在仓库根目录运行 `npm test`，记录通过/失败数量与失败用例名。
- [ ] 对照设计预期：现有应为 20 项（2 项导出 + 18 项状态机/交接/引导）；若数量不同，记录差异但不修改测试。

### 1.2 记录构建基线

- [ ] 运行 `npm run build`，记录退出码、模块数、CSS/JS 产物大小。
- [ ] 若失败，记录首个错误信息；不进入修复，交给用户决定是否先处理既有问题。

### 1.3 记录改动前快照

- [ ] 运行 `git status --porcelain` 与 `git diff --name-only`，把输出保存到本轮执行记录（不新建仓库文件）。
- [ ] 在记录中标注禁止文件当前状态：`server/`、`templates/`、`miniprogram/`、`package.json`、`src/services/agentService.js`。

### 1.4 锁定禁止项

- [ ] 确认后续任务不执行：`git reset`、`git checkout`、`git clean`、`git stash`、全仓格式化、`npm run build:win`、`server/` 下任何命令。
- [ ] 确认不新增依赖、不读取凭据、不真实联网、不写 `localStorage`。

**验收标准（可执行检查）**

- [ ] `npm test` 有真实输出记录，且明确写出通过数。
- [ ] `npm run build` 有真实输出记录，且明确写出退出码。
- [ ] `git status --porcelain` 与 `git diff --name-only` 快照已记录。
- [ ] 除本任务文档外，工作区没有因本任务产生的新改动。

---

# 阶段 A：领域层

## 2. 领域基础：空草稿、规范化、价格与菜品 id

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 1 |
| 涉及文件 | 新增 `src/domain/agentDraft.mjs`；新增 `test/agent-draft.test.cjs` |
| 对应测试 | D1（空草稿形状部分）、D19、D20、D21、D28 |
| 明确不做 | 不实现 `validateAgentDraft`、`buildNextQuestion`、`applyDraftPatch`、契约投影/反投影；不读写 DOM、网络、时间、随机数；不引入依赖 |
| 风险与回退 | 价格浮点误差：全程字符串解析整数分，禁止 `Number(text) * 100`；若边界仍不稳，回退为「只允许整数元输入」并记录。回退方式：删除新增文件与对应测试，不影响其他模块 |

### 2.1 建立草稿模型与空草稿工厂

- [ ] 在 `agentDraft.mjs` 顶部用注释固定 `AgentDraft` 形状：`storeName`、`category`、`businessHours`、`fulfillment{dineIn,takeaway}`、`dishes[{id,name,priceCents,priceText,description}]`。
- [ ] 实现 `createEmptyAgentDraft()`：所有字符串为空串，`fulfillment` 双 `false`，`dishes` 为空数组；每次返回新对象，不复用同一引用。
- [ ] 实现 `normalizeAgentDraft(input)`：丢弃未知字段；字符串 `trim`；布尔强制；`priceCents` 只接受整数或 `null`；缺失 `fulfillment` 补双 `false`；缺失 `dishes` 补空数组；不截断超过 5 道的数组（上限交给校验报 `DISHES_TOO_MANY`）。

### 2.2 实现价格文本解析与金额格式化

- [ ] 实现 `parsePriceTextToCents(text)`：支持 `28`、`28.5`、`28.50`、`¥28`、`￥28`、`28元`、`28块`、`28块钱`、全角数字与全角符号；返回 `{ ok, cents, code }`。
- [ ] 解析规则：trim 后空串返回 `{ ok:false, cents:null, code:'PRICE_REQUIRED' }`；其它非法返回 `{ ok:false, cents:null, code:'PRICE_INVALID' }`；只接受 0–6 位整数与 0–2 位小数，不自动猜测。
- [ ] 实现 `formatCents(cents)`：整数分转两位小数字符串；`2800 → "28.00"`、`0 → "0.00"`、`1 → "0.01"`、`999999 → "9999.99"`；`null`、负数、非整数、非数字返回 `""`。
- [ ] 实现 `createDishId(dishes)`：返回 `dish-<当前最大编号+1>`；删除中间菜品后不复用旧编号；空数组返回 `dish-1`。
- [ ] 金额换算只用整数运算或字符串拼接，不使用浮点乘法。

### 2.3 编写基础断言

- [ ] 在 `test/agent-draft.test.cjs` 中按现有 `node:test` + 动态 `import()` 风格编写 D1 的形状断言。
- [ ] 编写 D19：六种价格文本的 `cents` 断言。
- [ ] 编写 D20：`abc`、`-1`、`28.999`、空串的 `ok=false` 与 `code` 断言。
- [ ] 编写 D21：`formatCents` 五个边界断言。
- [ ] 编写 D28 的第一部分：同一输入调用两次结果深相等、入参未被修改。

### 2.4 运行并记录

- [ ] 运行 `node --test test/agent-draft.test.cjs`，记录通过数。
- [ ] 运行静态检查：`grep -nE "fetch|XMLHttpRequest|localStorage|Date\\.now|Math\\.random" src/domain/agentDraft.mjs`，应无输出。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-draft.test.cjs` 通过。
- [ ] `node -e "import('./src/domain/agentDraft.mjs').then(m=>{const d=m.createEmptyAgentDraft(); console.log(JSON.stringify(d))})"` 输出的字段与设计 2.3.2 一致。
- [ ] `grep -nE "parseFloat|Number\\(.*\\)\\s*\\*\\s*100" src/domain/agentDraft.mjs` 无价格浮点换算。
- [ ] 领域文件无网络、DOM、存储、时间、随机依赖。
- [ ] `test/agent-draft.test.cjs` 中 D19–D21 的断言全部存在且通过。

---

## 3. 领域校验：缺项、错误与 `readyForReview`

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 2 |
| 涉及文件 | 修改 `src/domain/agentDraft.mjs`；修改 `test/agent-draft.test.cjs` |
| 对应测试 | D2–D18、D26、D1（缺项顺序完整） |
| 明确不做 | 不实现追问文案、草稿合并、契约投影；不产生 IO；不把空值同时报为缺项与错误；不引入“跨天营业”字段 |
| 风险与回退 | 营业时间交叉规则误判：以设计 2.3.4 的边界表为准，先排序再校验；回退时保留单段校验、关闭多段支持并记录。校验异常兜底为字段错误，不抛异常 |

### 3.1 实现缺项与长度规则

- [ ] 实现 `validateAgentDraft(draft)`，返回 `{ missingFields, errors, readyForReview }`；`readyForReview` 仅在两者都空时为 `true`。
- [ ] 长度一律按 Unicode 码点计数（`Array.from(value).length`），先 `trim`；空值优先判缺项，同一字段不同时出现在缺项与错误中。
- [ ] 实现 `storeName`：空 → 缺项 `REQUIRED`；1–48 字合法；49 字 → `NAME_TOO_LONG`。
- [ ] 实现 `category`：空 → 缺项 `REQUIRED`；1–24 字合法；25 字 → `CATEGORY_TOO_LONG`；自由文本，不限定 `STORE_TYPES`。
- [ ] 缺项对象包含 `{ field, label, detail }`，标签使用中文（店名、品类、营业时间、取餐方式、菜品）。

### 3.2 实现营业时间规则

- [ ] 将全角冒号、中文逗号、顿号、`~`、`—`、`到`、`至` 归一化为英文冒号、英文逗号与 `-`；小时/分钟补零。
- [ ] 支持 1–3 段；每段必须匹配 `HH:MM-HH:MM`，小时 00–23、分钟 00–59；格式错误 → `HOURS_FORMAT`。
- [ ] 起止相同、倒置、跨午夜（如 `22:00-02:00`）→ `HOURS_RANGE`；`start === 前一段 end` 视为连续，允许。
- [ ] 多段按 start 升序排序后校验；后一段 start 小于前一段 end → `HOURS_OVERLAP`；超过 3 段 → `HOURS_TOO_MANY`。
- [ ] 若新增营业时间归一化辅助函数，只允许 `normalizeBusinessHoursText` 这一个纯函数，并写入契约文档；不得把规则散落到组件或 mock 之外。

### 3.3 实现履约与菜品规则

- [ ] 履约：`dineIn` 与 `takeaway` 双 `false` → 缺项 `FULFILLMENT_REQUIRED`；至少一个 `true` 合法。
- [ ] 菜品数量：0–2 道 → 缺项 `DISHES_TOO_FEW`（只报一条 `dishes`，不逐道报）；3–5 道合法；6 道及以上 → 错误 `DISHES_TOO_MANY`。
- [ ] 已有 3–5 道时逐道校验：菜名空 → 缺项 `dishes[i].name`；菜名 25 字 → `DISH_NAME_TOO_LONG`；价格 `null` → 缺项 `dishes[i].priceCents`；非整数 → `PRICE_INVALID`；不在 1–999999 → `PRICE_RANGE`；描述 61 字 → `DESCRIPTION_TOO_LONG`。
- [ ] `id` 缺失或重复 → `DISH_ID_INVALID`（内部防御）；不把 id 缺失报成缺项。
- [ ] 错误对象包含 `{ field, code, message }`，`message` 为中文可读文案；不包含堆栈、内部路径。

### 3.4 编写校验断言

- [ ] 编写 D1 完整断言：空草稿 `missingFields[0].field === 'storeName'`、`readyForReview === false`。
- [ ] 编写 D2–D5：店名 1/48/49 字、48 个 emoji（按码点）、品类 0/24/25 字。
- [ ] 编写 D6–D12：单段/多段合法、起止相同、倒置/跨午夜、格式错误、多段重叠、超过 3 段。
- [ ] 编写 D13：双 `false` 缺项、单 `true` 合法、双 `true` 合法。
- [ ] 编写 D14–D18：菜品 2/3/5/6 道、菜名 1/24/25 字、价格 0/1/999999/1000000、非整数、描述 60/61 字。
- [ ] 编写 D26：全字段合法时 `readyForReview === true`；任一缺项或错误为 `false`。

### 3.5 运行并记录

- [ ] 运行 `node --test test/agent-draft.test.cjs`，记录通过数。
- [ ] 检查空草稿的 `missingFields` 顺序为：店名 → 品类 → 营业时间 → 取餐方式 → 菜品。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-draft.test.cjs` 通过，D2–D18、D26 均有对应断言。
- [ ] `node -e` 对 49 字店名输出含 `NAME_TOO_LONG`，对 48 个 emoji 不输出该错误。
- [ ] `node -e` 对 `10:00-14:00,13:00-21:00` 输出 `HOURS_OVERLAP`，对 `22:00-02:00` 输出 `HOURS_RANGE`。
- [ ] 校验函数对 `null`、`undefined`、数组等非法输入不抛异常（兜底为空草稿结果）。
- [ ] 所有错误码与设计 2.3.6 B 表逐字一致。

---

## 4. 领域合并、追问与契约投影

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 3 |
| 涉及文件 | 修改 `src/domain/agentDraft.mjs`；修改 `test/agent-draft.test.cjs` |
| 对应测试 | D22–D25、D27、D28 |
| 明确不做 | 不实现 transport/service；不做字段校验以外的业务判断；不修改入参；不生成假 `projectId` |
| 风险与回退 | 菜品合并可能误覆盖已有价格：以 D23 为准，已有价格不被空值覆盖；回退为「只按 id 合并」并记录。投影遗漏 `priceText`：以 D24 的 JSON 断言守住 |

### 4.1 实现草稿合并

- [ ] 实现 `applyDraftPatch(draft, patch)`：只接受白名单字段 `storeName`、`category`、`businessHours`、`fulfillment`、`dishes`；未知字段忽略。
- [ ] 字符串字段 `trim`；`fulfillment` 只接受 `dineIn/takeaway` 布尔；`dishes` 按 `id` 合并，缺失 id 时按名称匹配。
- [ ] 菜品价格文本变化时同步 `priceCents`（调用 `parsePriceTextToCents`）；非法文本保留 `priceText` 并把 `priceCents` 置 `null`。
- [ ] 已有菜品价格不被空值或缺失值覆盖；同名菜去重，保留第一次出现的价格。
- [ ] 返回新草稿，不修改入参。

### 4.2 实现下一问生成

- [ ] 实现 `buildNextQuestion(validation)`：先遍历 `missingFields`，再取 `errors[0]`，两者都空返回 `null`。
- [ ] 优先级固定：店名 → 品类 → 营业时间 → 取餐方式 → 菜品数量 → 第 i 道菜名 → 第 i 道菜价格 → 其它错误。
- [ ] 中文文案与设计 2.3.4 的示例一致；菜品数量追问包含「还差 N 道」「一共 3–5 道」。
- [ ] 返回 `{ field, label, text }`；不抛异常。

### 4.3 实现契约投影与反投影

- [ ] 实现 `toContractDraft(draft)`：输出只含 `storeName/category/businessHours/fulfillment/dishes[{id,name,priceCents,description}]`，不得含 `priceText`。
- [ ] 实现 `fromContractDraft(contractDraft)`：补齐 `priceText = formatCents(priceCents)`；缺失 `id` 用 `createDishId` 补齐；非法结构按空草稿处理，非法价格归 `null`，交由校验报错；不抛异常。
- [ ] 投影结果必须可 `JSON.stringify`，不得含函数、`undefined` 或循环引用。
- [ ] `fromContractDraft(toContractDraft(draft))` 的金额与 `priceCents` 保持一致。

### 4.4 编写合并与投影断言

- [ ] 编写 D22：部分字段 patch 只覆盖对应字段，未知字段忽略。
- [ ] 编写 D23：已有菜品 + 新增菜品按 id/名称合并不重复，价格不被空值覆盖。
- [ ] 编写 D24：含 `priceText` 的草稿投影后无 `priceText`，`priceCents` 为整数或 `null`。
- [ ] 编写 D25：缺 id 补齐、非法价格归 `null` 且后续校验报错。
- [ ] 编写 D27：同时缺店名与营业时间时先问店名。
- [ ] 补完 D28：所有领域函数同一输入两次调用深相等、入参不变。

### 4.5 运行并记录

- [ ] 运行 `node --test test/agent-draft.test.cjs`，D1–D28 全部通过。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-draft.test.cjs` 通过。
- [ ] `node -e` 断言 `JSON.stringify(toContractDraft(draft)).includes('priceText') === false`。
- [ ] `node -e` 断言 `buildNextQuestion(validateAgentDraft(createEmptyAgentDraft())).field === 'storeName'`。
- [ ] 所有领域函数对非法输入不抛异常。
- [ ] 领域层仍无网络、DOM、存储、时间、随机依赖。

---

# 阶段 B：服务层

## 5. 服务配置与错误归一化

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 2（价格解析）；决策点 D-2 |
| 涉及文件 | 新增 `src/services/agentTurn/agentServiceConfig.js`；新增 `src/services/agentTurn/agentTurnError.js`（D-2 方案 A）；新增 `test/agent-turn.test.cjs` |
| 对应测试 | T17、错误结构断言 |
| 明确不做 | 不创建 mock/http transport；不读取 `.env`、`import.meta.env`、`localStorage`、任何 AK/SK；不发起网络请求 |
| 风险与回退 | 若用户选择 D-2 方案 B，错误构造合并到 `httpAgentTransport.js` 并导出，任务 5 不新增错误文件；回退删除新增文件即可 |

### 5.1 固定传输配置常量

- [ ] 新增 `AGENT_TRANSPORT = 'mock'`，本轮不得改成 `http`。
- [ ] 新增 `AGENT_ENDPOINT = '/api/v1/agent/turn'`。
- [ ] 新增 `AGENT_TIMEOUT_MS = 12000`。
- [ ] 新增 `AGENT_CONTRACT_VERSION = 'agent-turn.v1'`。
- [ ] 常量集中在本文件，不读取环境变量、不读取任何凭据。

### 5.2 实现传输描述

- [ ] 实现 `describeAgentTransport()`，返回 `{ mode: 'mock', label: '本地 Mock（未接入真实模型）' }`。
- [ ] 文案固定，不得出现「已接入 ModelArts」「盘古」「真实模型」等误导性表述。

### 5.3 实现 `AgentTurnError`

- [ ] 定义错误结构：`name: 'AgentTurnError'`、`code`、`message`、`retryable`、`httpStatus`、`serverCode`、`requestId`、`details`。
- [ ] 实现 `createAgentTurnError(code, options)`、`isAgentTurnError(value)`、`normalizeAgentTurnError(error)`。
- [ ] 错误码覆盖设计 2.3.6 A：`AGENT_MOCK_FAILURE`、`AGENT_TIMEOUT`、`AGENT_NETWORK`、`AGENT_ABORTED`、`AGENT_HTTP_4XX`、`AGENT_RATE_LIMITED`、`AGENT_HTTP_5XX`、`AGENT_RESPONSE_INVALID`、`AGENT_CONTRACT_MISMATCH`、`AGENT_TRANSPORT_UNKNOWN`、`AGENT_REQUEST_INVALID`。
- [ ] `retryable` 默认值与设计表一致；错误对象不得包含堆栈、原始响应体、Token、密钥。
- [ ] `normalizeAgentTurnError` 对未知异常兜底为 `AGENT_NETWORK` 或 `AGENT_RESPONSE_INVALID`，并保留可展示的 `message`。

### 5.4 编写配置与错误断言

- [ ] 编写 T17：`describeAgentTransport()` 深等于 `{ mode:'mock', label:'本地 Mock（未接入真实模型）' }`。
- [ ] 断言 `AGENT_CONTRACT_VERSION === 'agent-turn.v1'`、`AGENT_TIMEOUT_MS === 12000`、`AGENT_TRANSPORT === 'mock'`。
- [ ] 断言错误对象含 `code/message/retryable`，且 `JSON.stringify(error)` 不含 `stack`、`token`、`secret`。
- [ ] 断言 `isAgentTurnError` 对普通 `Error` 返回 `false`。

### 5.5 运行并记录

- [ ] 运行 `node --test test/agent-turn.test.cjs`，记录通过数。
- [ ] 运行 `grep -nE "import\\.meta\\.env|localStorage|AK|SK|secret|password" src/services/agentTurn`，应无读取凭据的代码。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-turn.test.cjs` 通过。
- [ ] `node -e` 输出 `describeAgentTransport()` 为固定对象。
- [ ] `grep` 未发现任何凭据读取或硬编码密钥。
- [ ] 错误码字符串与设计 2.3.6 A 表一致。

---

## 6. Mock transport：本地规则解析

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 5、任务 3（营业时间归一化） |
| 涉及文件 | 新增 `src/services/agentTurn/mockAgentTransport.js`；修改 `test/agent-turn.test.cjs` |
| 对应测试 | T1–T5（T6/T7 的失败注入在任务 8 完成） |
| 明确不做 | 不调用真实模型、不联网、不伪造模型名、不写业务状态、不修改 `agentService.js` |
| 风险与回退 | 规则误判（把时间当价格、把描述当菜名）：固定解析顺序「店名 → 品类 → 营业时间 → 取餐方式 → 菜品」，只识别「菜名 + 价格」；回退为只保留店名/时间解析，菜品要求手动填写 |

### 6.1 输入归一化与解析入口

- [ ] 导出 `parseMockUtterance(utterance, currentDraft)`，供单测直接调用。
- [ ] 归一化：全角数字、全角冒号、全角逗号、`￥` 转半角；连续空白折叠为一个空格；首尾 trim。
- [ ] 超过 500 字的输入截断到 500 字，并在回复中说明；不抛异常。
- [ ] 固定解析顺序：店名 → 品类 → 营业时间 → 取餐方式 → 菜品。

### 6.2 解析店名、品类、营业时间与取餐方式

- [ ] 店名规则按设计 2.3.5 的 5 级优先级实现：显式「店名/名称/叫/是」→「叫做/叫」→ 已知餐饮后缀 → 首句兜底 → 不命中不改。
- [ ] 店名截断到 48 字；不覆盖已有店名，除非出现「改/换成/叫」；已知后缀列表与设计一致。
- [ ] 品类规则按关键词表归一化；显式「品类/类型/主营：X」优先；不命中不猜；截断 24 字。
- [ ] 营业时间支持「10 点到 21 点」「10 点半到 21 点」「10:00-21:00」；多段用中文逗号、顿号、`和` 分隔；最多 3 段；输出统一 `HH:MM-HH:MM`。
- [ ] 起止相同、倒置、跨午夜保留原文，不擅自修正，由领域校验报错。
- [ ] 取餐方式按「只/仅」限定优先，再识别普通关键词；两者都未出现时不修改，首次保持双 `false`。

### 6.3 解析菜品与生成回复

- [ ] 菜品先去掉「招牌是/菜品有/菜单：/还有」等前缀，再按 `、，,；;。\n` 分段。
- [ ] 每段必须同时识别「菜名 1–24 字 + 价格」，价格走 `parsePriceTextToCents`；只有菜名没有价格时不写入，不臆造价格。
- [ ] 纯时间句与纯店名句不进入菜品解析；同名菜去重，保留第一次出现的价格；最多 5 道，超过时忽略多余项并说明「本轮只保留前 5 道菜」。
- [ ] 已识别菜品与已有菜品按名称合并；已有价格不被空值覆盖；描述默认为空。
- [ ] `reply` 使用设计 2.3.5 的固定模板：部分识别、资料齐全、未识别、超 5 道、价格非法五种场景。
- [ ] `meta` 固定为 `{ transport:'mock', provider:'local-mock', mock:true, model:null, latencyMs:0 }`；`latencyMs` 使用固定 0，保证测试稳定。

### 6.4 实现 transport 工厂与一次性失败接口

- [ ] 实现 `createMockTransport(options?)`，返回 `{ name:'mock', send(request, context) }`。
- [ ] `send` 接收 `AgentTurnRequest`，返回 `AgentTurnResponse` 形状：`contractVersion`、`turnId`（`turn-mock-<n>`）、`status`、`reply`、`draft`、`missingFields`、`errors`、`nextQuestion`、`meta`。
- [ ] `status` 与 `nextQuestion` 由领域校验计算，transport 不自行决定 `readyForReview`。
- [ ] 支持 `context.failOnce === true` 时抛 `AGENT_MOCK_FAILURE`，消息固定为「本地 Mock 模拟失败（仅用于验证失败态）」、`retryable=true`；失败只发生一次，由 service 控制开关复位。
- [ ] 不保存跨请求状态；transport 内部不记录 token、不写日志。

### 6.5 编写 Mock 断言

- [ ] 编写 T1：一段完整描述解析出店名/品类/时间/履约/菜品，字段值符合规则表。
- [ ] 编写 T2：只有菜名没有价格时不新增菜品。
- [ ] 编写 T3：纯时间句只更新营业时间，不产生菜品。
- [ ] 编写 T4：6 道菜与重复菜名时最多 5 道、同名合并。
- [ ] 编写 T5：`meta.mock=true`、`provider='local-mock'`、`model=null`。

### 6.6 运行并记录

- [ ] 运行 `node --test test/agent-turn.test.cjs`，T1–T5 通过。
- [ ] 运行 `grep -nE "fetch\\(|https?://|pangu|modelarts|盘古" src/services/agentTurn/mockAgentTransport.js`，应无输出。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-turn.test.cjs` 通过。
- [ ] `parseMockUtterance` 为纯函数：同一输入两次调用深相等，不修改 `currentDraft`。
- [ ] Mock 响应 JSON 中 `meta.model === null`、`meta.mock === true`。
- [ ] 文件内无网络调用、无真实模型名、无凭据读取。

---

## 7. HTTP transport：契约实现但默认不启用

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 5、任务 6 |
| 涉及文件 | 新增 `src/services/agentTurn/httpAgentTransport.js`；修改 `test/agent-turn.test.cjs` |
| 对应测试 | T8–T16 |
| 明确不做 | 不默认启用（`AGENT_TRANSPORT` 仍为 `mock`）；不读取全局 Token；不自动重试；不修改 `server/`；不访问真实网络 |
| 风险与回退 | 契约漂移：以 `agent-turn.v1` 与契约文档为准，响应校验失败抛 `AGENT_RESPONSE_INVALID`；回退时保留 Mock，删除或停用 HTTP transport |

### 7.1 实现 transport 工厂与请求构造

- [ ] 实现 `createHttpTransport({ fetchImpl, endpoint, timeoutMs, getAuthorization })`，返回 `{ name:'http', send(request, context) }`。
- [ ] `fetchImpl` 必须由调用方注入；模块顶层不直接调用 `fetch`；测试注入 stub。
- [ ] 请求：`POST` 到 `endpoint`（默认 `/api/v1/agent/turn`），`Content-Type: application/json; charset=utf-8`、`Accept: application/json`、`X-Agent-Contract: agent-turn.v1`。
- [ ] `Authorization` 仅在 `getAuthorization()` 返回非空时注入；默认返回 `null`；不读取 `localStorage`/环境变量。
- [ ] 请求体包含 `contractVersion`、`utterance`、`draft`（`ContractDraft`）、`client:{surface:'desktop',phase:'store-info'}`、`projectId:null`。

### 7.2 实现超时与错误归一化

- [ ] 使用 `AbortController` + timer 实现超时；超过 `timeoutMs` → `AGENT_TIMEOUT`、`retryable=true`。
- [ ] `fetch` 抛网络错误 → `AGENT_NETWORK`、`retryable=true`；外部取消 → `AGENT_ABORTED`、`retryable=false`。
- [ ] 400/401/403/404/409/422 → `AGENT_HTTP_4XX`、`retryable=false`，保留 `httpStatus/serverCode/requestId`；401/403 的展示文案提示重新登录。
- [ ] 429 → `AGENT_RATE_LIMITED`、`retryable=true`；500/502/503 → `AGENT_HTTP_5XX`、`retryable=true`。
- [ ] 非 JSON → `AGENT_RESPONSE_INVALID`；错误体不进入日志、不拼接进用户可见消息。

### 7.3 实现响应校验与版本校验

- [ ] 校验响应必须含 `contractVersion/turnId/status/reply/draft/meta`；`status` 只允许 `collecting|reviewing`；`missingFields/errors/nextQuestion` 类型正确。
- [ ] `contractVersion !== 'agent-turn.v1'` → `AGENT_CONTRACT_MISMATCH`、`retryable=false`。
- [ ] 响应越界（菜品超过 5 道、价格非整数、字符串超长）→ `AGENT_RESPONSE_INVALID`，不把非法数据交给 UI。
- [ ] transport 不计算 `readyForReview`、不覆盖服务端 `status`；最终状态由 service 本地校验决定。

### 7.4 编写 HTTP 断言

- [ ] 编写 T8：stub 断言 URL、method、headers、body 与 `contractVersion`。
- [ ] 编写 T9：stub 返回合法 JSON，返回归一化响应。
- [ ] 编写 T10：stub 永久 pending + `timeoutMs:10`，抛 `AGENT_TIMEOUT`、`retryable=true`。
- [ ] 编写 T11：422 错误体 → `AGENT_HTTP_4XX`、`retryable=false`，保留 `serverCode/requestId`。
- [ ] 编写 T12：429 → `AGENT_RATE_LIMITED`、`retryable=true`。
- [ ] 编写 T13：503 → `AGENT_HTTP_5XX`、`retryable=true`。
- [ ] 编写 T14：stub 返回 HTML → `AGENT_RESPONSE_INVALID`。
- [ ] 编写 T15：缺 `draft` 或 `meta` → `AGENT_RESPONSE_INVALID`。
- [ ] 编写 T16：响应 `agent-turn.v0` → `AGENT_CONTRACT_MISMATCH`。

### 7.5 运行并记录

- [ ] 运行 `node --test test/agent-turn.test.cjs`，T8–T16 通过。
- [ ] 确认测试中 stub 调用次数与预期一致，没有真实网络请求。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-turn.test.cjs` 通过。
- [ ] `grep -n "fetch(" src/services/agentTurn/httpAgentTransport.js` 仅有注入调用，无模块顶层真实 `fetch`。
- [ ] `grep -nE "localStorage|import\\.meta\\.env|AK|SK" src/services/agentTurn/httpAgentTransport.js` 无输出。
- [ ] 测试运行时不出现 `ECONNREFUSED`、`ETIMEDOUT` 等真实网络错误。

---

## 8. Turn service：React 唯一调用入口

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 6、任务 7、任务 4 |
| 涉及文件 | 新增 `src/services/agentTurn/agentTurnService.js`；修改 `test/agent-turn.test.cjs` |
| 对应测试 | T6、T7、T18、T19 |
| 明确不做 | 不操作 React state、不调用 `dispatch`、不写库、不吞错、不自动重试、不改 `agentService.js` |
| 风险与回退 | 一次性失败状态跨请求泄漏：每次请求结束在 `finally` 复位；回退为「由 App 每次显式传参」并记录。服务端返回 `reviewing` 但草稿缺项：以本地校验覆盖，测试 T18 守住 |

### 8.1 实现服务工厂与 transport 选择

- [ ] 实现 `createAgentTurnService(options?)`，返回 `{ requestAgentTurn, describeAgentTransport }`。
- [ ] 默认 transport 为 Mock；仅当显式注入 `transport` 时使用注入实现；未知 transport 抛 `AGENT_TRANSPORT_UNKNOWN`。
- [ ] `describeAgentTransport` 转出配置模块的实现，保证 UI 与服务文案一致。
- [ ] 不读取环境变量、不读取凭据、不创建全局单例以外的状态。

### 8.2 实现 `requestAgentTurn`

- [ ] 入参 `{ utterance, draft, simulateFailureOnce = false }`；`utterance` trim 后为空或超过 500 字 → `AGENT_REQUEST_INVALID`、`retryable=false`。
- [ ] 流程：`toContractDraft(draft)` → 组装 `AgentTurnRequest` → `transport.send` → 校验 `contractVersion` → `fromContractDraft` → `validateAgentDraft` → `buildNextQuestion`。
- [ ] 返回 `{ draft, validation, nextQuestion, reply, meta, status, turnId }`；`status` 只可能是 `collecting|reviewing`，由 `validation.readyForReview` 决定，**不信任服务端 `status`**。
- [ ] 响应草稿经 `normalizeAgentDraft` 规范化后再返回；不修改入参。
- [ ] 异常统一为 `AgentTurnError`；service 捕获后重新抛出，不吞错、不返回半成品。

### 8.3 实现一次性模拟失败

- [ ] `simulateFailureOnce=true` 时，本次 `send` 使用失败上下文；transport 抛 `AGENT_MOCK_FAILURE`。
- [ ] 失败标记在本次请求结束（成功或失败）后复位；同一实例连续第二次请求正常成功。
- [ ] 开关只在 `describeAgentTransport().mode === 'mock'` 时可生效；HTTP 模式下忽略该参数或明确拒绝。

### 8.4 编写 service 断言

- [ ] 编写 T6：同一实例 `simulateFailureOnce:true` → 抛 `AGENT_MOCK_FAILURE`、`retryable=true`。
- [ ] 编写 T7：连续两次请求，首次失败、第二次成功，开关自动复位。
- [ ] 编写 T18：stub transport 返回 `status:'reviewing'` 但草稿缺营业时间 → service 返回 `collecting`。
- [ ] 编写 T19：空 utterance → `AGENT_REQUEST_INVALID`。

### 8.5 运行并记录

- [ ] 运行 `node --test test/agent-turn.test.cjs`，T6/T7/T18/T19 通过。
- [ ] 检查 service 文件无 React、DOM、存储依赖。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-turn.test.cjs` 通过。
- [ ] `grep -nE "React|dispatch\\(|localStorage|document|window" src/services/agentTurn/agentTurnService.js` 无输出。
- [ ] `node -e` 用 stub transport 验证「服务端说 reviewing、本地缺项 → collecting」。
- [ ] service 抛出的错误均为 `AgentTurnError` 且不含堆栈外泄。

---

## 9. 服务层测试矩阵补齐（T1–T19）

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 8 |
| 涉及文件 | 修改 `test/agent-turn.test.cjs` |
| 对应测试 | T1–T19 |
| 明确不做 | 不引入测试框架、不测 React 渲染、不访问真实网络、不读取真实凭据 |
| 风险与回退 | 超时测试不稳定：使用可控 Promise + `timeoutMs:10`，不使用真实长等待；回退为 fake timer 或直接断言错误构造，不删除覆盖 |

### 9.1 核对测试编号覆盖

- [ ] 逐一核对 T1–T19 是否都有对应 `test(...)` 或明确的子断言；缺失项补齐。
- [ ] 每个测试用中文标题或注释标注编号，便于与设计 2.7.2 对照。
- [ ] Mock 与 HTTP 测试使用独立实例，避免一次性失败开关串扰。

### 9.2 补齐边界与脱敏断言

- [ ] 断言所有错误对象不含 `stack`、`token`、`secret`、`password`。
- [ ] 断言响应缺字段、类型错误、版本不匹配时不把原始响应体透传给 UI。
- [ ] 断言请求体 `projectId === null`，不生成假 ID。
- [ ] 断言 HTTP transport 不自动重试：stub 调用次数为 1。

### 9.3 运行并记录

- [ ] 运行 `node --test test/agent-turn.test.cjs`，T1–T19 全部通过。
- [ ] 运行 `npm test`，确认没有引入真实网络错误。
- [ ] 统计测试文件中的 `test(` 数量并与 T1–T19 对照。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-turn.test.cjs` 通过，覆盖 T1–T19。
- [ ] `grep -c "^test(" test/agent-turn.test.cjs` 不少于 19（或按子断言合并时，T 编号全部可见）。
- [ ] 运行测试期间无 `ECONNREFUSED`/`ETIMEDOUT`/DNS 错误。
- [ ] `npm test` 中原有 20 项仍通过。

---

# 阶段 C：状态层

## 10. `constants` 增量与 Agent 状态切片初始化

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 3、任务 4 |
| 涉及文件 | 修改 `src/state/constants.mjs`；修改 `src/state/sessionMachine.mjs`；修改 `test/agent-intake-flow.test.cjs`（新建，先写初始化断言） |
| 对应测试 | 初始化断言、旧 20 项回归 |
| 明确不做 | 不新增顶层 phase；不改 `sessions/store/features/build/visual/deploy` 形状；不改既有消息 id 规则；不改 `PHASES` 枚举 |
| 风险与回退 | 新增切片可能破坏旧测试的严格深比较：不改旧断言，只追加新断言；回退时删除 `agentDraft/agent` 初始化与常量，恢复原 state |

### 10.1 增加 STORE_INFO 的 Composer 文案与状态常量

- [ ] 在 `COMPOSER_PLACEHOLDER` 增加 `[PHASES.STORE_INFO]`：`用一句话说店名、品类、营业时间、取餐方式和 3–5 道菜…`。
- [ ] 在 `COMPOSER_SUBMIT_LABEL` 增加 `[PHASES.STORE_INFO]`：`整理资料`。
- [ ] 新增 `AGENT_STATUS` 冻结常量：`IDLE/REQUESTING/COLLECTING/REVIEWING/CONFIRMED/FAILED`；不改 `PHASES` 与既有键。
- [ ] 不修改 `composerEnabled` 的既有语义；STORE_INFO 是否显示由 App 的 `COMPOSER_PHASES` 与选择器共同决定。

### 10.2 初始化 `agentDraft` 与 `agent` 切片

- [ ] 在 `sessionMachine.mjs` 引入 `agentDraft` 领域函数（只 import 纯函数）。
- [ ] `createInitialState()` 返回值追加 `agentDraft: createEmptyAgentDraft()` 与 `agent: createInitialAgentSlice()`。
- [ ] `agent` 初始值：`status:'idle'`、`lastUtterance:''`、`lastError:null`、`attempts:0`、`missingFields:[]`、`errors:[]`、`nextQuestion:null`、`reply:''`、`meta:null`、`simulateFailure:false`、`turnId:null`、`confirmedAtSeq:null`。
- [ ] `createInitialAgentSlice` 作为模块内辅助函数；如为测试导出，必须在契约文档记录，且不改变公共语义。
- [ ] `RESET` 继续调用 `createInitialState()`，自动清空 Agent 切片；不额外写 reset 逻辑。

### 10.3 编写初始化断言

- [ ] 新建 `test/agent-intake-flow.test.cjs`，沿用 `node:test` + 动态 `import()` 风格。
- [ ] 断言初始 state 含 `agentDraft` 与 `agent`，且 `agent.status === 'idle'`。
- [ ] 断言 `agentDraft` 深等于空草稿；`fulfillment` 双 `false`、`dishes` 空数组。
- [ ] 断言 `RESET` 后 Agent 切片恢复初始值。

### 10.4 运行旧测试

- [ ] 运行 `npm test`，确认原有 20 项全部通过。
- [ ] 若旧测试因深比较失败，只调整新增断言，不修改旧测试预期。

**验收标准（可执行检查）**

- [ ] `npm test` 原有 20 项通过。
- [ ] `node -e "import('./src/state/sessionMachine.mjs').then(m=>{const s=m.createInitialState(); console.log(s.agent.status, s.agentDraft.dishes.length)})"` 输出 `idle 0`。
- [ ] `grep -n "STORE_INFO" src/state/constants.mjs` 命中 placeholder 与 submit label。
- [ ] `git diff -- src/state/constants.mjs` 仅新增键，未改既有键。

---

## 11. 请求生命周期 actions

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 10、任务 9（service 返回形状） |
| 涉及文件 | 修改 `src/state/sessionMachine.mjs`；修改 `test/agent-intake-flow.test.cjs` |
| 对应测试 | F1、F2、F6、F14（预写） |
| 明确不做 | 不在 reducer 内发请求、读时间/随机数；不追加失败文本气泡；不在重复 `REQUEST` 时追加消息；不改既有消息 id 规则 |
| 风险与回退 | 重复请求导致重复消息：`requesting` 时直接返回原 state；回退保留 `SUCCESS/FAILURE`，暂时移除 `REQUEST/RETRY` 的并发保护并记录 |

### 11.1 实现 `AGENT_TURN_REQUEST`

- [ ] 前置：`agent.status !== 'requesting'` 且 `utterance` trim 非空；否则返回原 state。
- [ ] 置 `status='requesting'`、`attempts+1`、`lastUtterance=utterance`、`lastError=null`。
- [ ] 向当前会话追加 user 消息，`instant:true`，文本为 utterance 原文；消息 id 走 `appendMessages` 的 `seq` 递增。
- [ ] 保留现有草稿、缺项与错误展示（错误清空，草稿不动）。

### 11.2 实现 `AGENT_TURN_RETRY`

- [ ] 前置：`status === 'failed'` 且 `lastUtterance` 非空；否则返回原 state。
- [ ] 置 `status='requesting'`、`attempts+1`；**不追加 user 消息**。
- [ ] 草稿与 `lastError` 保留到本次结果返回；不重复提交气泡。

### 11.3 实现 `AGENT_TURN_SUCCESS`

- [ ] 前置：`status === 'requesting'`；否则忽略。
- [ ] 用 `normalizeAgentDraft(action.draft)` 更新草稿；用本地 `validateAgentDraft` 重算校验（不直接信任 `action.validation`，只以其为参考）。
- [ ] 用本地校验结果决定 `status`：`readyForReview ? 'reviewing' : 'collecting'`；写入 `missingFields/errors/nextQuestion/reply/meta/turnId`。
- [ ] 追加 agent 消息：`staged:true`、`meta:{ kind:'agent-turn' }`，文本为 `reply`；缺项追问也通过 `reply` 呈现。
- [ ] 复位 `simulateFailure=false`，清空 `lastError`；保留 `lastUtterance` 与 `attempts`。

### 11.4 实现 `AGENT_TURN_FAILURE`

- [ ] 前置：`status === 'requesting'`；写入 `status='failed'`、`lastError=action.error`。
- [ ] **不追加**任何文本消息；保留草稿、`lastUtterance`、`attempts`。
- [ ] 错误对象只保留展示字段（`code/message/retryable/httpStatus/serverCode/requestId`），不保存堆栈。
- [ ] 复位 `simulateFailure=false`，保证请求结束后面板开关自动关闭；请求期间输入内容与草稿不被清空。
- [ ] 实现 `AGENT_SIMULATE_FAILURE { value }`：只设置 `agent.simulateFailure`，不改变 `status`、草稿与消息；该开关只在 mock 模式展示。

### 11.5 预写流程断言

- [ ] F1：`CONFIRM_TEMPLATE` 后 `AGENT_TURN_REQUEST/SUCCESS`（缺营业时间）→ `status='collecting'`，`nextQuestion.field='businessHours'`，消息含 agent 追问。
- [ ] F2：完整 Mock 响应 → `status='reviewing'`、`readyForReview=true`、确认条件满足。
- [ ] F6：模拟失败 → `failed` → `RETRY` → 成功；`attempts=2`，user 消息数量不增加。
- [ ] F14：`AGENT_TURN_FAILURE` 不追加错误气泡，消息数量不变，`lastError` 存在。

### 11.6 运行并记录

- [ ] 运行 `node --test test/agent-intake-flow.test.cjs`，F1/F2/F6/F14 通过。
- [ ] 运行 `npm test`，旧 20 项不回归。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-intake-flow.test.cjs` 通过。
- [ ] `node -e` 连续两次派发 `AGENT_TURN_REQUEST`，消息只增加 1 条，`attempts` 只增加 1。
- [ ] 失败后 `agent.status === 'failed'`，会话消息数量与失败前相同。
- [ ] `grep -nE "AGENT_TURN_|AGENT_SIMULATE_FAILURE" src/state/sessionMachine.mjs` 命中五个 action（`REQUEST/RETRY/SUCCESS/FAILURE` 与 `AGENT_SIMULATE_FAILURE`）。

---

## 12. 草稿编辑 actions

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 11 |
| 涉及文件 | 修改 `src/state/sessionMachine.mjs`；修改 `test/agent-intake-flow.test.cjs` |
| 对应测试 | F3、F4、F5（编辑回退部分） |
| 明确不做 | 不加拖拽排序、规格、库存字段；不在编辑时调用 service；不追加编辑消息；不绕过领域校验 |
| 风险与回退 | 价格文本与 `priceCents` 不一致：以领域 `applyDraftPatch` 为唯一入口；回退为只允许整数元输入并记录 |

### 12.1 实现字段编辑

- [ ] `EDIT_AGENT_DRAFT_FIELD`：支持 `storeName/category/businessHours`；调用 `applyDraftPatch` 后立即 `normalize + validate`。
- [ ] `EDIT_AGENT_FULFILLMENT`：支持 `dineIn/takeaway` 布尔；重算校验。
- [ ] 编辑后状态：`confirmed` → `reviewing`；`idle` → 按校验结果进入 `collecting/reviewing`；`failed` 保持 `failed`，但同时更新缺项/错误。
- [ ] 编辑不追加会话消息；不改变 `lastUtterance/attempts/meta`。

### 12.2 实现菜品编辑与增删

- [ ] `EDIT_AGENT_DISH`：支持 `name/priceText/description`；`priceText` 变化时同步 `priceCents`（合法）或 `null`（非法）；重算校验。
- [ ] `ADD_AGENT_DISH`：菜品 < 5 时用 `createDishId` 生成 id，字段为空；达到 5 道时返回原 state。
- [ ] `REMOVE_AGENT_DISH`：菜品 > 0 时按 id 删除；重算；`confirmed` 下删除先回到 `reviewing`，再按校验结果落到 `collecting/reviewing`。
- [ ] 菜单顺序保持数组顺序，不支持拖拽。

### 12.3 编写编辑断言

- [ ] F3：`EDIT_AGENT_DISH priceText='abc'` → `priceCents=null`、`errors` 含 `PRICE_INVALID`、状态回 `collecting`。
- [ ] F4：删除至 2 道 → 缺项；增加到第 6 道 → 被拒绝，仍为 5 道。
- [ ] F5 的编辑部分：`confirmed` 后编辑店名 → `status='reviewing'`，草稿已更新，等待再次确认。
- [ ] 断言价格 `28.5` → `priceCents=2850`，`formatCents` 展示 `28.50`。

### 12.4 运行并记录

- [ ] 运行 `node --test test/agent-intake-flow.test.cjs`，F3/F4/F5 通过。
- [ ] 运行 `npm test`，旧 20 项通过。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-intake-flow.test.cjs` 通过。
- [ ] `node -e` 断言非法价格后 `status === 'collecting'` 且 `errors` 含 `PRICE_INVALID`。
- [ ] `node -e` 断言第 6 道菜被拒绝，`dishes.length === 5`。
- [ ] `grep -n "EDIT_AGENT\\|ADD_AGENT\\|REMOVE_AGENT" src/state/sessionMachine.mjs` 命中全部 action。

---

## 13. 确认、重开与阶段兼容

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 12 |
| 涉及文件 | 修改 `src/state/sessionMachine.mjs`；修改 `test/agent-intake-flow.test.cjs` |
| 对应测试 | F5、F8、F9、F10、F11、F12、F13 |
| 明确不做 | 不写库、不发布、不持久化；不把营业时间/履约/菜品塞进 `store.notes`；不修改 `StoreInfoStep` 内部；不新增 phase |
| 风险与回退 | `SUBMIT_STORE_INFO` 防御过严会打断旧测试：必须允许 `idle` 与 `confirmed`，拒绝 `requesting/collecting/reviewing/failed`；回退时恢复无防御版本但记录 UI 风险 |

### 13.1 实现 `CONFIRM_AGENT_DRAFT`

- [ ] 前置：`status === 'reviewing'` 且本地 `readyForReview === true`；否则返回原 state。
- [ ] 在追加消息前取 `state.seq` 作为 `confirmedAtSeq`（避免受新消息影响）。
- [ ] 映射：`store.name = agentDraft.storeName`、`store.type = agentDraft.category`；`address/phone/notes` 保持原值。
- [ ] 追加 user 消息「资料已确认」+ agent 摘要（店名/品类/营业时间/履约/菜品数）；`status='confirmed'`；不写库、不发布。
- [ ] `agentDraft` 原样保留，作为营业时间、履约方式、菜品的唯一事实来源。

### 13.2 实现 `REOPEN_AGENT_DRAFT`

- [ ] 前置：`status === 'confirmed'`；置 `status='reviewing'`。
- [ ] 追加 agent 消息「已返回资料编辑」；不修改草稿、不重复交接。
- [ ] 保留 `confirmedAtSeq` 或按设计清空（以测试断言为准，建议保留用于展示历史）。

### 13.3 实现模板确认预填

- [ ] `CONFIRM_TEMPLATE` 在 `createStepSession` 结果上预填 `agentDraft.storeName = base.store.name`（店名来自 `SUBMIT_NAME`）。
- [ ] 预填后立即重算缺项/错误，使面板能显示「还差品类/营业时间/取餐方式/菜品」。
- [ ] 旧会话数量、标题、交接文本不变。

### 13.4 实现原表单同步

- [ ] `SET_STORE_FIELD`：`agent.status === 'confirmed'` 且 `field === 'name'` → 同步 `agentDraft.storeName`；`field === 'type'` → 同步 `agentDraft.category`。
- [ ] 同步后重算校验；若新值非法，保留 `confirmed`，摘要显示警告，不阻断原表单提交。
- [ ] 其他字段（`address/phone/notes/intro`）不进入草稿，避免两个事实来源。

### 13.5 实现提交防御与交接 payload

- [ ] `SUBMIT_STORE_INFO` 增加防御：`agent.status` 为 `idle` 或 `confirmed` 时允许；为 `requesting/collecting/reviewing/failed` 时返回原 state。
- [ ] 交接 payload 在 `{ styleId, store }` 之外追加 `agentDraft: toContractDraft(state.agentDraft)`；不写库、不发布。
- [ ] 确认 `idle` 路径仍走原逻辑，保证旧测试通过。

### 13.6 编写确认与兼容断言

- [ ] F5：确认后编辑 → `status='reviewing'`；`store.name` 与草稿同步。
- [ ] F8：`collecting` 下派发 `SUBMIT_STORE_INFO` → 返回原 state（被拒绝）。
- [ ] F9：`idle` 下派发 `SUBMIT_STORE_INFO` → 仍进入 `PROMPT_STUDIO`。
- [ ] F10：`CONFIRM_TEMPLATE` 后 `agentDraft.storeName === state.store.name`。
- [ ] F11：任意状态 `RESET` → `agent.status='idle'`、空草稿、无错误。
- [ ] F12：确认映射 `store.name/type` 正确；`store.notes` 不被覆盖；`agentDraft.businessHours/fulfillment/dishes` 保留；交接 payload 含契约草稿。
- [ ] F13：`category='社区家常菜'` 时 `store.type` 为该自由文本；`storeTypesForForm` 的注入在任务 20/21 验证。

### 13.7 运行并记录

- [ ] 运行 `node --test test/agent-intake-flow.test.cjs`，F5/F8–F13 通过。
- [ ] 运行 `npm test`，尤其确认 8 处旧 `SUBMIT_STORE_INFO` 用例全部通过。

**验收标准（可执行检查）**

- [ ] `npm test` 旧 20 项通过。
- [ ] `node -e` 断言 `collecting` 下 `SUBMIT_STORE_INFO` 返回同一 state 引用。
- [ ] `node -e` 断言确认后 `store.notes` 与确认前一致。
- [ ] 交接消息文本包含 `agentDraft` 字段且不含 `priceText`。

---

## 14. `selectAgentComposerState` 选择器

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 13 |
| 涉及文件 | 修改 `src/state/sessionMachine.mjs`；修改 `test/agent-intake-flow.test.cjs` |
| 对应测试 | F7 |
| 明确不做 | 不替代其他阶段的 Composer 逻辑；不读取 DOM；不新增全局状态；不处理输入文本本身 |
| 风险与回退 | 失败后 Composer 被误禁用：F7 守住；回退为 App 直接按状态计算 `submitDisabled`，但保留选择器测试 |

### 14.1 实现选择器返回形状

- [ ] 导出 `selectAgentComposerState(state)`，返回 `{ visible, placeholder, submitLabel, hint, submitDisabled, editable }`。
- [ ] 文案从 `constants.mjs` 读取，不在选择器内硬编码；`hint` 使用设计 2.4.1 的示例文案。
- [ ] 非 `STORE_INFO` 阶段返回 `visible:false` 与原逻辑占位，App 继续使用既有 `COMPOSER_PHASES`/`COMPOSER_HINTS`。

### 14.2 实现状态规则

- [ ] STORE_INFO 且 `confirmed` → `visible:false`、`editable:false`。
- [ ] STORE_INFO 且 `requesting` → `visible:true`、`editable:true`、`submitDisabled:true`。
- [ ] STORE_INFO 且 `failed` → `visible:true`、`editable:true`、`submitDisabled:false`。
- [ ] STORE_INFO 且 `idle/collecting/reviewing` → `visible:true`、`editable:true`、`submitDisabled:false`。
- [ ] `placeholder/submitLabel/hint` 在所有 STORE_INFO 状态下有值。

### 14.3 编写选择器断言

- [ ] F7：`failed` 下 `editable=true`、`submitDisabled=false`。
- [ ] 断言 `requesting` 下 `submitDisabled=true`、`editable=true`。
- [ ] 断言 `confirmed` 下 `visible=false`。
- [ ] 断言非 STORE_INFO 阶段 `visible=false`，不影响 App 原逻辑。

### 14.4 运行并记录

- [ ] 运行 `node --test test/agent-intake-flow.test.cjs`，F7 通过。
- [ ] 运行 `npm test`，旧 20 项通过。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-intake-flow.test.cjs` 通过。
- [ ] `node -e` 断言 `failed` 状态返回 `editable === true && submitDisabled === false`。
- [ ] `grep -n "selectAgentComposerState" src/state/sessionMachine.mjs` 命中导出。

---

## 15. 流程测试矩阵 F1–F15

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 14、任务 9 |
| 涉及文件 | 修改 `test/agent-intake-flow.test.cjs` |
| 对应测试 | F1–F15 |
| 明确不做 | 不渲染 React、不引入 Testing Library、不访问真实网络、不依赖真实时间 |
| 风险与回退 | 用例间状态串扰：每个用例新建 state 与 service 实例；回退时拆分为独立测试文件，不删除覆盖 |

### 15.1 建立测试辅助

- [ ] 提供 `seededStoreInfo()` 辅助：`START_ONBOARDING → SUBMIT_NAME → SKIP_INTRO → SUBMIT_CUSTOMIZE → BUILD_READY → CONFIRM_TEMPLATE`，返回进入 STORE_INFO 的 state。
- [ ] 提供 `runTurn(state, service, utterance, options)` 辅助：派发 REQUEST → 调 service → 派发 SUCCESS/FAILURE，返回新 state。
- [ ] 所有辅助只使用公开 reducer 与 service API，不直接改 state 内部字段。

### 15.2 覆盖四条必需交互

- [ ] F1 资料不完整追问：缺营业时间 → `collecting`、`nextQuestion.field='businessHours'`、消息含追问。
- [ ] F2 资料完整进入可编辑确认：完整响应 → `reviewing`、`readyForReview=true`。
- [ ] F3 修改价格后重新校验：非法价格 → `PRICE_INVALID`、`collecting`。
- [ ] F4 修改菜品后重新校验：删除至 2 道 → 缺项；第 6 道被拒绝。
- [ ] F6 Mock 失败后可重试：失败 → `failed` → RETRY → 成功；`attempts=2`、不重复 user 消息。
- [ ] F7 失败后 Composer 可用：`editable=true`、`submitDisabled=false`。

### 15.3 覆盖确认、兼容与重置

- [ ] F5 确认后编辑回退。
- [ ] F8 确认前不可提交原表单。
- [ ] F9 旧测试兼容（`idle` 直接提交）。
- [ ] F10 模板确认预填店名。
- [ ] F11 RESET 清空。
- [ ] F12 确认映射 `store` 与交接 payload。
- [ ] F13 自由品类兼容。
- [ ] F14 失败不追加错误气泡。
- [ ] F15 重试复用最新草稿：失败后编辑、再重试，断言请求体使用编辑后的草稿（通过 stub transport 捕获请求）。

### 15.4 运行并记录

- [ ] 运行 `node --test test/agent-intake-flow.test.cjs`，F1–F15 全部通过。
- [ ] 运行 `npm test`，确认新增与旧测试同时通过。
- [ ] 统计 F 编号覆盖，缺失项补齐。

**验收标准（可执行检查）**

- [ ] `node --test test/agent-intake-flow.test.cjs` 通过，F1–F15 均有对应断言。
- [ ] 测试文件中四条交互有明确的中文标题或注释。
- [ ] `npm test` 全量通过，旧 20 项不回归。
- [ ] 测试不渲染 React、不产生真实网络请求。

---

# 阶段 D：组件与 App 接线

## 16. `AgentIntakePanel` 状态面板

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 15；同时完成 `Composer` 的 `submitDisabled` 小改动 |
| 涉及文件 | 新增 `src/components/agent/AgentIntakePanel.jsx`；修改 `src/components/chat/Composer.jsx` |
| 对应测试 | T20 静态约束；人工走查任务 21 |
| 明确不做 | 组件内不 `fetch`、不 import service、不读取全局 state、不判断字段合法性；组件内不放第二个 textarea；不新增 reducer action |
| 风险与回退 | 组件被 App 引用前不参与构建：先做静态检查，构建在任务 20；回退删除新增组件，`Composer` 改动可单独回退 |

### 16.1 扩展 `Composer` 的提交禁用

- [ ] 给 `Composer` 增加可选 `submitDisabled`，默认值等于 `disabled`。
- [ ] textarea 的 `disabled` 仍只由 `disabled` 控制；提交按钮与 Enter 由 `submitDisabled` 控制。
- [ ] 旧调用方不传该属性时行为完全不变；不修改既有类名与布局。

### 16.2 实现面板 props 与状态条

- [ ] 按设计 2.4.2 定义 props：`status`、`transportLabel`、`transportMode`、`reply`、`missingFields`、`errors`、`nextQuestion`、`lastError`、`attempts`、`canConfirm`、`simulateFailure`、`onRetry`、`onToggleSimulateFailure`、`onConfirm`、`onReopen`。
- [ ] 顶部状态条：左侧状态徽标（等待输入 / 正在整理 / 还差 N 项 / 可以确认 / 请求失败 / 已确认）；右侧 Mock 徽标。
- [ ] Mock 徽标文本固定来自 `transportLabel`；同时输出 `data-transport={transportMode}` 与 `title="当前为本地规则解析，未调用任何真实模型"`。
- [ ] 回复区展示 `reply` 或 `nextQuestion.text`，使用 `aria-live="polite"`；请求中不频繁播报。

### 16.3 实现缺项、错误与失败条

- [ ] 缺项 chips：每个 `missingFields` 一个 chip，展示 `label` 与 `detail`，使用 `href="#agent-field-<field>"` 锚点。
- [ ] 字段错误摘要：按 `field` 去重，最多展示 3 条，其余折叠；不展示堆栈或原始响应。
- [ ] 失败条：`lastError` 存在时展示图标、`message`、`attempts`（第 N 次尝试）；`retryable === true` 时才显示重试按钮。
- [ ] 失败条下方固定提示「本次不会保存或发布任何资料」；若存在 `nextQuestion`，继续展示「可以继续补充：…」。
- [ ] 请求中展示进度三点与「正在整理资料」，不展示确认按钮。

### 16.4 实现 Mock 开关与确认区

- [ ] 仅 `transportMode === 'mock'` 时显示「下一次请求模拟失败」开关；开启后显示「已武装」；请求结束由父组件传入的 `simulateFailure` 自动关闭。
- [ ] `status === 'reviewing' && canConfirm` 时显示「资料无误，继续」；不满足时禁用并说明「还有 N 项需要处理」。
- [ ] `status === 'confirmed'` 时显示「已确认，请补充风格与地址」与「返回修改资料」。
- [ ] `status === 'failed'` 时确认按钮禁用，必须先重试或重新提交。

### 16.5 组件边界自查

- [ ] 组件只通过 props 接收数据、只通过回调发事件；不直接 `dispatch`。
- [ ] 不 import `agentDraft`、`agentTurnService`、`agentService`；不调用 `fetch`；不做价格换算。
- [ ] 不新增 reducer action、不写 `localStorage`、不读取全局业务状态。

**验收标准（可执行检查）**

- [ ] `grep -nE "fetch\\(|agentTurnService|requestAgentTurn|validateAgentDraft|parsePriceTextToCents" src/components/agent/AgentIntakePanel.jsx` 无输出。
- [ ] `grep -n "data-transport" src/components/agent/AgentIntakePanel.jsx` 命中。
- [ ] `grep -n "aria-live" src/components/agent/AgentIntakePanel.jsx` 命中。
- [ ] 组件 props 与设计 2.4.2 表逐项一致（人工对照）。
- [ ] `npm run build` 通过（`Composer` 是既有文件，必须验证旧调用方未破坏）。
- [ ] `Composer` 旧调用方不传 `submitDisabled` 时行为不变（构建与任务 20 人工走查验证）。

---

## 17. `DraftEditor` 草稿编辑器

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 16 |
| 涉及文件 | 新增 `src/components/agent/DraftEditor.jsx` |
| 对应测试 | 静态约束；人工走查任务 21 |
| 明确不做 | 组件内不做金额换算、不做校验、不调用 service；不支持拖拽排序、规格、加料、库存、分类管理；不新增 reducer action |
| 风险与回退 | 价格输入被组件擅自改写：输入框只展示 `priceText`，失焦不改写，投影时使用 `priceCents`；回退为只允许整数元输入并记录 |

### 17.1 实现受控字段

- [ ] 按设计 2.4.3 定义 props：`draft`、`validation`、`disabled`、`maxDishes`（5）、`minDishes`（3）、`onChangeField`、`onToggleFulfillment`、`onChangeDish`、`onAddDish`、`onRemoveDish`。
- [ ] 基础资料：店名 input、品类 input、营业时间 input（placeholder `例如 10:00-21:00`）；多时段提示使用英文逗号。
- [ ] 所有输入为受控组件，值来自 `draft`；不维护内部业务副本。

### 17.2 实现取餐方式与菜品

- [ ] 取餐方式：两个 checkbox 或开关；双 `false` 时显示提示；至少选一个。
- [ ] 菜品卡片列表：每行菜名 input、价格 input（`inputMode="decimal"`）、描述 textarea、删除按钮。
- [ ] 价格输入展示 `priceText`，不展示 `priceCents`；不擅自格式化或改写店主文本。
- [ ] 底部「添加菜品（N/5）」：达到 5 道禁用；少于 3 道显示「至少 3 道」。
- [ ] 新增菜品后焦点移到新菜名输入框（纯 UI 行为，可由父组件或 ref 实现）。

### 17.3 实现字段错误可访问性

- [ ] 每个字段错误在对应输入框下方展示；输入框设置 `aria-invalid="true"` 与 `aria-describedby="agent-error-<field>"`。
- [ ] 错误文案来自 `validation.errors`，组件不自行生成规则文案。
- [ ] 缺项提示使用 `validation.missingFields` 的 `label/detail`，不自行判断。
- [ ] 为每个字段提供 `id="agent-field-<field>"` 锚点，供缺项 chip 跳转。

### 17.4 组件边界自查

- [ ] 不 import `agentDraft`、`agentTurnService`；不调用 `fetch`。
- [ ] 不调用 `formatCents`、`parsePriceTextToCents`、`validateAgentDraft`。
- [ ] `disabled=true` 时所有输入只读，但仍展示数据；请求期间是否只读按决策点 D-1 的方案执行。

**验收标准（可执行检查）**

- [ ] `grep -nE "fetch\\(|formatCents|parsePriceTextToCents|validateAgentDraft|agentTurnService" src/components/agent/DraftEditor.jsx` 无输出。
- [ ] `grep -n "aria-invalid" src/components/agent/DraftEditor.jsx` 命中。
- [ ] `grep -n "inputMode" src/components/agent/DraftEditor.jsx` 命中价格输入。
- [ ] 组件 props 与设计 2.4.3 表逐项一致（人工对照）。
- [ ] 菜品数量边界在 UI 上可见（5 道禁用添加、少于 3 道提示）。

---

## 18. `AgentDraftSummary` 已确认摘要

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 17 |
| 涉及文件 | 新增 `src/components/agent/AgentDraftSummary.jsx` |
| 对应测试 | 静态约束；人工走查任务 21 |
| 明确不做 | 组件内不做金额换算、不执行确认逻辑、不提供发布按钮、不写库 |
| 风险与回退 | 摘要展示与草稿不一致：只接收已格式化的展示模型；回退为只展示店名/品类/时间/菜品数，不展示价格明细 |

### 18.1 实现展示模型

- [ ] 按设计 2.4.4 定义 props：`storeName`、`category`、`businessHours`、`fulfillmentText`、`dishes`（`[{ id, name, priceDisplay, description }]`）、`onReopen`。
- [ ] 菜品价格展示 `priceDisplay`（由外部 `formatCents` 生成，形如 `¥28.00`）；组件不自行换算。
- [ ] 有描述时展示；无描述不占位。
- [ ] 展示营业时间、履约方式、菜品数量。

### 18.2 实现边界提示与返回修改

- [ ] 固定提示「以下资料已在本地确认，尚未保存到云端，也未发布」。
- [ ] 提供「返回修改资料」按钮，触发 `onReopen`。
- [ ] 不提供「发布」「保存到云端」「上传」按钮。
- [ ] 摘要为只读，不包含可编辑输入框。

### 18.3 组件边界自查

- [ ] 不 import `agentDraft`、`agentTurnService`；不调用 `fetch`；不调用 `formatCents`。
- [ ] 不执行确认逻辑；确认动作只由父组件派发。
- [ ] 不读取全局 state。

**验收标准（可执行检查）**

- [ ] `grep -nE "fetch\\(|formatCents|agentTurnService|localStorage" src/components/agent/AgentDraftSummary.jsx` 无输出。
- [ ] `grep -n "尚未保存到云端" src/components/agent/AgentDraftSummary.jsx` 命中。
- [ ] `grep -nE "发布|上传" src/components/agent/AgentDraftSummary.jsx` 只出现在「未发布」说明中，不存在发布按钮。
- [ ] 组件 props 与设计 2.4.4 表逐项一致（人工对照）。

---

## 19. `agent.css` 与样式接入

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 16–18（类名已确定） |
| 涉及文件 | 新增 `src/styles/agent.css`；修改 `src/styles/index.css` |
| 对应测试 | `npm run build` 样式解析；人工视觉走查 |
| 明确不做 | 不修改 `tokens.css`、不改既有 `.store-*`/`.composer-*`/`.chat-*` 类；不引入布局库；不做媒体查询以外的响应式方案 |
| 风险与回退 | 样式污染既有页面：所有类名统一 `.agent-` 前缀；回退删除 `index.css` 的 import 即恢复 |

### 19.1 建立样式命名空间

- [ ] 新建 `src/styles/agent.css`，所有选择器以 `.agent-` 开头，不覆盖既有类。
- [ ] 覆盖设计 2.4.7 建议类名：面板、状态条、Mock 徽标、回复、缺项 chips、错误列表、失败条、模拟开关、确认栏、编辑器、字段、字段错误、菜品列表/卡片/价格、摘要、摘要提示。
- [ ] 沿用现有暖白背景 + 紫色主 CTA 的视觉语言；错误色满足 4.5:1 对比度。
- [ ] 允许在 `agent.css` 内大胆设计，但不改 `tokens.css` 与既有组件类。

### 19.2 实现布局与响应式

- [ ] 桌面宽屏两列：基础资料 + 菜品；窄窗口单列。
- [ ] 面板、编辑器、摘要的间距、圆角、边框与现有卡片风格一致。
- [ ] 缺项 chip、失败条、确认栏在视觉上可区分；请求中与失败态有明确视觉反馈。
- [ ] 按钮、输入框的焦点态可辨识，满足键盘操作。

### 19.3 接入样式入口

- [ ] 在 `src/styles/index.css` 末尾追加一行 `@import './agent.css';`；不改其他 import 顺序。
- [ ] 确认 Vite 能解析新增 CSS；无未解析路径。

### 19.4 运行构建

- [ ] 运行 `npm run build`，确认样式被包含且构建成功。
- [ ] 记录 CSS 产物大小变化，作为构建说明的依据。

**验收标准（可执行检查）**

- [ ] `npm run build` 退出码 0。
- [ ] `grep -c "^\\.agent-" src/styles/agent.css` 不少于 20。
- [ ] `grep -n "agent.css" src/styles/index.css` 仅 1 行新增。
- [ ] `git diff -- src/styles/tokens.css` 无改动；`git diff -- src/styles/build.css src/styles/chat.css` 无改动。

---

## 20. `App.jsx` 接线

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 15、任务 19；决策点 D-1 |
| 涉及文件 | 修改 `src/App.jsx` |
| 对应测试 | `npm run build`；人工走查四条交互；静态检查 |
| 明确不做 | 不把 Agent 请求放进无条件 `useEffect`；不改模板匹配/生图/部署占位逻辑；不直接 `fetch`；不改 `StoreInfoStep` 内部；不新增 phase |
| 风险与回退 | React StrictMode 或阶段切换导致重复请求：请求只由用户事件触发，并用 `useRef` 防连点；回退时 `STORE_INFO` 分支恢复原 `StoreInfoStep`，`COMPOSER_PHASES` 移除 `STORE_INFO` |

### 20.1 接入文案与输入框可见性

- [ ] 在 `COMPOSER_PHASES` 增加 `PHASES.STORE_INFO`。
- [ ] 在 `COMPOSER_HINTS` 增加 STORE_INFO 示例：`示例：店名是松月食堂，做社区家常菜，10:00-21:00，堂食和自取，宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。`。
- [ ] Composer 的 `placeholder/submitLabel` 从 `constants.mjs` 读取 STORE_INFO 文案。
- [ ] 传入 `submitDisabled` 与 `disabled` 时，遵循 `selectAgentComposerState` 的 `submitDisabled/editable` 结果。

### 20.2 实现请求 handler

- [ ] 新增 `handleAgentTurn(utterance, { retry = false } = {})`：先派发 `AGENT_TURN_REQUEST`（重试时派发 `AGENT_TURN_RETRY`），再调用 `requestAgentTurn`。
- [ ] 使用 `useRef` 记录进行中的请求，防止快速双击/StrictMode 造成重复发起；`requesting` 状态下忽略新提交。
- [ ] 成功：派发 `AGENT_TURN_SUCCESS`，携带 `draft/validation/nextQuestion/reply/meta/turnId`；成功后清空 Composer 输入，避免重复提交同一句。
- [ ] 失败：捕获 `AgentTurnError`，派发 `AGENT_TURN_FAILURE`；**保留**输入框内容与草稿；不把错误写入消息流。
- [ ] 请求期间 Composer textarea 保持可编辑，提交按钮按 `selectAgentComposerState().submitDisabled` 禁用；失败后提交按钮恢复可用。
- [ ] 请求只由用户提交或重试触发，不放入 `useEffect`。

### 20.3 实现编辑、确认、重开与重试回调

- [ ] `handleAgentFieldChange(field, value)` → `EDIT_AGENT_DRAFT_FIELD`。
- [ ] `handleAgentFulfillment(field, value)` → `EDIT_AGENT_FULFILLMENT`。
- [ ] `handleAgentDishChange(id, field, value)` → `EDIT_AGENT_DISH`。
- [ ] `handleAgentAddDish()` → `ADD_AGENT_DISH`；`handleAgentRemoveDish(id)` → `REMOVE_AGENT_DISH`。
- [ ] `handleAgentConfirm()` → `CONFIRM_AGENT_DRAFT`；`handleAgentReopen()` → `REOPEN_AGENT_DRAFT`。
- [ ] `handleAgentRetry()` → 使用 `state.agent.lastUtterance` 与当前草稿发起重试；不追加 user 消息。
- [ ] `handleSimulateFailure(value)` → `AGENT_SIMULATE_FAILURE`。

### 20.4 实现 `STORE_INFO` 渲染分支

- [ ] `renderStage()` 的 `STORE_INFO` 分支根据 `state.agent.status` 渲染：
  - `confirmed`：`AgentDraftSummary` + 原 `StoreInfoStep`；
  - 其他状态：`AgentIntakePanel` + `DraftEditor`（`idle` 默认折叠，`collecting/reviewing/failed` 自动展开）。
- [ ] `AgentDraftSummary` 的 `priceDisplay` 由 `formatCents` 在 App 层生成；组件不换算。
- [ ] `StoreInfoStep` 保持原 props，仅 `storeTypes` 使用兼容后的 `storeTypesForForm`。
- [ ] 不在 Agent 面板内放第二个 textarea；自然语言只走全局 Composer。

### 20.5 实现右栏 Agent 状态卡

- [ ] `buildPanelCards` 的 `STORE_INFO` 分支追加 Agent 状态卡：传输模式、已完成字段数、缺项数量、下一步提示。
- [ ] 卡片使用 `describeAgentTransport().label`，明确 Mock 未接入真实模型。
- [ ] `confirmed` 后展示「已确认，等待补充风格与地址」；不展示发布按钮。
- [ ] 不改其他阶段的卡片。

### 20.6 实现自由品类兼容

- [ ] 计算 `storeTypesForForm`：`STORE_TYPES.includes(draft.category)` 时用原数组；否则追加 `{ value: draft.category, label: draft.category }`；`category` 为空时用原数组。
- [ ] 不修改 `StoreInfoStep` 内部；只通过 props 注入。
- [ ] 确认后 `store.type` 为自由文本时，`select` 能显示该项。

### 20.7 构建与自查

- [ ] 运行 `npm run build`，确认 JSX/import/CSS 全部解析。
- [ ] 运行 `grep -nE "fetch\\(" src/App.jsx`，应无直接 `fetch`。
- [ ] 运行 `git diff -- src/App.jsx`，确认只新增 STORE_INFO 分支、文案、handler 与右栏卡片，未改模板/生图/部署逻辑。
- [ ] 按设计 2.7.4 做一次开发模式人工走查（任务 21 统一记录）。

**验收标准（可执行检查）**

- [ ] `npm run build` 退出码 0。
- [ ] `grep -n "STORE_INFO" src/App.jsx` 命中 `COMPOSER_PHASES` 与 `renderStage` 分支。
- [ ] `grep -nE "fetch\\(|axios" src/App.jsx` 无输出。
- [ ] `grep -n "AgentIntakePanel\\|DraftEditor\\|AgentDraftSummary" src/App.jsx` 均有引用。
- [ ] 旧阶段（`BUILDING/PROMPT_STUDIO/IMAGE_REVIEW/DEPLOY`）的 effect 与 handler 未被改写（人工 diff 核对）。

---

## 21. 组件约束检查与人工走查

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 20 |
| 涉及文件 | 不新增；如发现越界，按最小改动修正 |
| 对应测试 | T20 静态约束；人工走查清单 2.7.4 |
| 明确不做 | 不引入 React 测试库、不新增自动化框架、不改业务逻辑来“适配”走查 |
| 风险与回退 | 人工走查发现问题：记录并只做局部修正；回退按任务 20 的回退方案恢复原表单 |

### 21.1 静态约束检查

- [ ] `grep -R -nE "fetch\\(|XMLHttpRequest|agentTurnService|requestAgentTurn|validateAgentDraft|parsePriceTextToCents|formatCents" src/components/agent` 无输出。
- [ ] `grep -R -nE "localStorage|sessionStorage|document\\.cookie" src/components/agent` 无输出。
- [ ] `grep -R -n "dispatch(" src/components/agent` 无输出（组件只发事件，不直接 dispatch）。
- [ ] 确认 `src/components/agent` 下每个组件只 import React 与现有图标库（如需要），不 import 服务层/领域层。

### 21.2 人工走查清单

- [ ] 第 1 步：`npm run dev` 走到 `STORE_INFO`，看到 Mock 徽标、输入框、可选手动编辑。
- [ ] 第 2 步：输入只含店名，出现营业时间/履约/菜品追问。
- [ ] 第 3 步：补一句完整资料，进入 `reviewing`，草稿可编辑。
- [ ] 第 4 步：修改价格为非法文本，字段标红，确认按钮禁用。
- [ ] 第 5 步：打开「下一次模拟失败」并提交，失败条出现；输入框仍可输入。
- [ ] 第 6 步：点击重试，成功；不重复用户气泡。
- [ ] 第 7 步：确认资料，展示摘要；原 `StoreInfoStep` 出现；店名/品类已回填。
- [ ] 第 8 步：走完原流程 `PROMPT_STUDIO → IMAGE_REVIEW → DEPLOY`，与既有行为一致。

### 21.3 记录与判定

- [ ] 记录 `npm run dev` 是否可启动；若端口占用或无法人工操作，明确写出原因并标记为「待人工复验」。
- [ ] 记录每条走查的通过/失败；失败项附截图路径或复现步骤。
- [ ] 若第 8 步回归，停止收口，回到任务 20 修正并重跑。

**验收标准（可执行检查）**

- [ ] 静态检查四条命令均无越界输出。
- [ ] 人工走查 8 步有逐项记录，未通过项有跟进措施。
- [ ] 走查发现的修正只涉及 `src/components/agent`、`src/App.jsx`、`src/styles/agent.css`，不扩散到禁止文件。
- [ ] `npm run build` 再次通过。

---

# 阶段 E：文档

## 22. 新增 `docs/agent-turn-contract.md`

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 21 |
| 涉及文件 | 新增 `docs/agent-turn-contract.md` |
| 对应测试 | 文档自查（字段逐项对照设计 2.2.2） |
| 明确不做 | 不写真实 Endpoint、密钥、AK/SK、区域 ID、账号 ID；不声称已接入 ModelArts；不修改 `docs/api.md` |
| 风险与回退 | 契约漂移：以 `agent-turn.v1` 冻结字段为准；回退删除该文档，不影响代码 |

### 22.1 写契约头与边界

- [ ] 标题、版本、状态（冻结/本轮不实现后端）、适用阶段。
- [ ] 明确「本轮只冻结契约，`POST /api/v1/agent/turn` 后端尚未实现；前端只使用本地 Mock」。
- [ ] 明确「真实 ModelArts 尚未接入，未配置任何华为云凭据」。
- [ ] 明确与 B1 `sessions` 的区别：不复用、不落库、不持久化。

### 22.2 冻结请求与响应 schema

- [ ] 请求头：`Content-Type`、`Accept`、`X-Agent-Contract`、可选 `Authorization`。
- [ ] 请求体：`contractVersion`、`utterance`（1–500 字）、`draft`、`client.surface='desktop'`、`client.phase='store-info'`、`projectId=null`。
- [ ] `ContractDraft` 字段：`storeName/category/businessHours/fulfillment/dishes[{id,name,priceCents,description}]`；`priceCents` 为整数或 `null`，禁止浮点与字符串。
- [ ] 响应体：`contractVersion/turnId/status/reply/draft/missingFields/errors/nextQuestion/meta`；`status` 只允许 `collecting|reviewing`。
- [ ] `meta`：`transport/provider/mock/model/latencyMs`；Mock 固定 `mock=true、provider='local-mock'、model=null`。
- [ ] 提供请求/响应示例（首次空草稿、缺营业时间、资料齐全）。

### 22.3 写校验责任、错误码与重试语义

- [ ] 校验责任：前端领域层做最终门槛；后端接入后必须二次校验；店主确认前不落库。
- [ ] 错误码表：传输/服务错误（A 表）与字段错误（B 表）逐项列出，含 `retryable` 与 UI 建议。
- [ ] 重试语义：超时/网络/5xx/429/Mock 失败可手动重试；4xx/契约不匹配/响应非法不自动重试；重试不追加 user 消息。
- [ ] 错误体不返回堆栈、SQL、密钥、OpenID、模型原始输出。

### 22.4 写 Mock ↔ HTTP 替换步骤

- [ ] 说明 `AGENT_TRANSPORT` 从 `mock` 改为 `http` 的步骤：注入 `fetchImpl`、设置 `endpoint`、注入 `getAuthorization`。
- [ ] 说明 UI、reducer、领域层不需要改代码；只替换 transport。
- [ ] 说明 HTTP transport 已实现但本轮不启用；启用前必须完成后端契约联调。
- [ ] 说明超时 12s、手动重试、无自动重试。

### 22.5 写 ModelArts 接入前待确认项 Q1–Q10

- [ ] 逐项写入设计 2.10.2 的 Q1–Q10：调用方式、鉴权方式、模型名称/版本、超时/配额/限流、是否流式、内容审核/脱敏、日志与可观测性、会话归属/多租户、幂等、价格与营业时间最终校验责任。
- [ ] 每项写明「本轮处理」与「接入前需确认的账号/API/鉴权/区域信息」。
- [ ] 明确 AK/SK 永不下发前端；前端只注入短期 Token。
- [ ] 明确「真实 ModelArts 尚未接入」的固定表述，避免答辩误导。

### 22.6 文档自查

- [ ] 与设计 2.2.2 字段表逐项对照，确认无遗漏、无改义。
- [ ] 确认所有金额示例均为整数分，展示层才用 `¥28.00`。
- [ ] 确认没有真实凭据、真实 Endpoint、真实区域 ID。

**验收标准（可执行检查）**

- [ ] `grep -nE "agent-turn\\.v1|POST /api/v1/agent/turn|ModelArts|尚未接入|Q1|Q10|鉴权|区域" docs/agent-turn-contract.md` 均有命中。
- [ ] `grep -nE "AK|SK|secret|password|token=" docs/agent-turn-contract.md` 不含真实值（只允许说明性文字）。
- [ ] 契约字段与设计 2.2.2 人工对照无差异。
- [ ] 文档明确「后端未实现、本轮只使用 Mock」。

---

## 23. 更新项目状态文档与新增接入前交接

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 22 |
| 涉及文件 | 修改 `docs/后端待实现接口清单.md`；修改 `docs/待完成目标.md`；新增 `docs/本轮Agent接入前准备交接.md` |
| 对应测试 | 文档自查、章节完整性检查 |
| 明确不做 | 不删除历史条目；不把 M6 的 ModelArts 勾选为完成；不写真实账号/密钥；不修改 `docs/api.md` 的 B1 契约 |
| 风险与回退 | 文档夸大接入：固定写「真实 ModelArts 尚未接入」；回退只删除新增章节/文件，历史内容保留 |

### 23.1 更新 `docs/后端待实现接口清单.md`

- [ ] 在 §0 能力缺口总览追加一行「资料收集 turn（Mock）」，前端位置 `agentTurnService`，当前占位「本地规则解析」，优先级 P0。
- [ ] 保留原有 §0–§14 编号与内容；在文末追加 §15「Agent 资料收集（`agent/turn`）」。
- [ ] §15 写清：路径 `POST /api/v1/agent/turn`、请求/响应字段、与 `store-projects`/`generation/*` 的区别、实现建议。
- [ ] 实现建议包含：NestJS 模块、DTO 校验（class-validator）、服务端二次校验字段与价格、确认前不落库、`Idempotency-Key`/turnId 去重、限流、日志脱敏、模型密钥只在服务端。
- [ ] 明确 `agent/turn` 是「资料收集」能力，不是点餐业务接口，不复用 B1 `sessions`。

### 23.2 更新 `docs/待完成目标.md`

- [ ] 保留 §0–§6 历史内容，不删除任何已完成/未完成条目。
- [ ] 追加 §7「2026-10-31 桌面端 Agent 资料收集（Mock）完成记录」。
- [ ] 勾选本轮已完成项：领域层、Mock/HTTP transport、service、reducer 增量、三组件、文档、测试与构建。
- [ ] 明确未完成项：真实 ModelArts 未接入、后端 `agent/turn` 未实现、会话持久化未做、认证未做。
- [ ] 写入真实验证证据：`npm test` 通过数、`npm run build` 输出、新增测试文件与编号范围。
- [ ] 不勾选 M6 的 ModelArts 条目；不把本轮 Mock 描述为「已接入模型」。

### 23.3 新增 `docs/本轮Agent接入前准备交接.md`

- [ ] 写当前实现清单：新增/修改文件、每个文件职责、依赖方向。
- [ ] 写验证命令与已知输出：`node --test test/agent-draft.test.cjs`、`node --test test/agent-turn.test.cjs`、`node --test test/agent-intake-flow.test.cjs` 的结果；`npm test` 与 `npm run build` 的全量结果先标注「待任务 25 回填」，不得提前编造。
- [ ] 写未决项：决策点 D-1/D-2 的最终选择、人工走查结果、未覆盖的边界。
- [ ] 写接入前待确认信息：华为云账号归属、ModelArts Studio 工作流/API 形式、鉴权方式（IAM Token/AK-SK/API Key）、区域与 Endpoint、模型名称与版本、配额/限流、内容审核与脱敏、日志保留策略、幂等策略、租户隔离。
- [ ] 写禁止项：AK/SK 不下发前端、确认前不落库、不调用真实模型、不修改 B1/`server/`、不新增依赖。
- [ ] 写回退方案：`AGENT_TRANSPORT` 保持 `mock`；删除 `src/services/agentTurn` 与组件即可回到无 Agent 状态；文档保留。

### 23.4 文档自查

- [ ] 确认 `docs/后端待实现接口清单.md` 原章节 0–14 仍存在。
- [ ] 确认 `docs/待完成目标.md` 原 M0–M8 条目未被删除。
- [ ] 确认三份文档均出现「真实 ModelArts 尚未接入」或等价表述。
- [ ] 确认没有真实账号、密钥、Endpoint、区域 ID。

**验收标准（可执行检查）**

- [ ] `grep -n "Agent 资料收集" docs/后端待实现接口清单.md` 命中。
- [ ] `grep -n "agent/turn" docs/后端待实现接口清单.md` 命中。
- [ ] `grep -n "真实 ModelArts 尚未接入" docs/本轮Agent接入前准备交接.md` 命中。
- [ ] `grep -n "尚未接入" docs/待完成目标.md` 命中。
- [ ] `grep -nE "Q1|Q10|鉴权|区域|Endpoint" docs/本轮Agent接入前准备交接.md` 命中。
- [ ] 原章节编号与历史条目仍在（人工核对）。

---

## 24. 更新 `docs/本轮构建介绍.md`

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 23 |
| 涉及文件 | 修改 `docs/本轮构建介绍.md` |
| 对应测试 | 文档自查；与任务 25 真实输出一致 |
| 明确不做 | 不写「已接入 ModelArts」；不写未经验证的测试数量；不删除既有构建记录 |
| 风险与回退 | 数字与真实输出不一致：以任务 25 的命令输出为准；回退删除新增段落 |

### 24.1 追加本轮构建段落

- [ ] 在文末追加「## 2026-10-31 Agent 资料收集 Mock 接入」。
- [ ] 写目标：在 `STORE_INFO` 阶段接入自然语言资料收集、结构化草稿确认、失败态与重试。
- [ ] 写已完成：领域层、Mock/HTTP transport、service、reducer 增量、三组件、样式、App 接线、文档。
- [ ] 写测试：新增 D/T/F 测试文件与数量，旧 20 项保持通过。
- [ ] 写构建：`npm run build` 真实模块数与产物大小。
- [ ] 写边界：真实 ModelArts 未接入、后端 `agent/turn` 未实现、不持久化、不发布、不写库。
- [ ] 写回退：`AGENT_TRANSPORT` 保持 `mock`；删除 Agent 分支即回到原表单流程。

### 24.2 数字核对

- [ ] 测试数量、构建模块数、产物大小必须与任务 25 的真实输出一致。
- [ ] 若任务 25 尚未执行，先留占位并标注「待任务 25 回填」，不得编造数字。

**验收标准（可执行检查）**

- [ ] `grep -n "2026-10-31 Agent 资料收集" docs/本轮构建介绍.md` 命中。
- [ ] `grep -n "未接入" docs/本轮构建介绍.md` 命中。
- [ ] `grep -nE "npm test|npm run build" docs/本轮构建介绍.md` 命中。
- [ ] 文档中的测试数量与任务 25 输出一致（人工核对）。
- [ ] 既有构建记录未被删除。

---

# 阶段 F：全量验证

## 25. 全量测试与构建验证

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 24 |
| 涉及文件 | 不新增；把真实输出回填到 `docs/本轮构建介绍.md` 与 `docs/本轮Agent接入前准备交接.md` |
| 对应测试 | `npm test`、`npm run build` |
| 明确不做 | 不运行 `server/` 命令、不运行 `npm run build:win`、不执行 git 写操作、不修改测试来“凑通过” |
| 风险与回退 | 测试失败：定位到对应阶段任务修正，不回退全量；构建失败：检查 import/JSX/CSS，必要时临时关闭 STORE_INFO Agent 分支定位；回退按任务 20 方案恢复原表单 |

### 25.1 运行全量测试

- [ ] 运行 `npm test`，记录退出码、通过数、失败数、失败用例名。
- [ ] 确认原有 20 项与新 D/T/F 测试全部通过。
- [ ] 确认运行中没有真实网络请求、没有访问 `server/`。

### 25.2 运行生产构建

- [ ] 运行 `npm run build`，记录退出码、模块数、CSS/JS 产物大小。
- [ ] 确认无未解析 import、无缺失 CSS、无 Vite 警告中的阻断项。

### 25.3 核对禁止文件

- [ ] 对比任务 1 的 `git diff --name-only` 快照，确认 `server/`、`templates/`、`miniprogram/`、`package.json`、`src/services/agentService.js` 无新增差异。
- [ ] 运行 `git status --porcelain`，列出本轮实际新增/修改文件，与任务 0.7 清单核对。
- [ ] 确认没有新增依赖（`package.json` 与 lockfile 未改）。

### 25.4 回填文档

- [ ] 把真实测试数量与构建输出回填到 `docs/本轮构建介绍.md` 的对应段落。
- [ ] 把真实命令输出回填到 `docs/本轮Agent接入前准备交接.md` 的「验证证据」章节。
- [ ] 若存在失败或未执行项，明确写出原因与后续措施，不用「基本通过」等模糊表述。

**验收标准（可执行检查）**

- [ ] `npm test` 退出码 0，通过数不少于「旧 20 + 新增 D/T/F 用例数」。
- [ ] `npm run build` 退出码 0。
- [ ] 禁止文件无新增差异。
- [ ] 文档中的数字与真实输出一致。
- [ ] 没有运行 `server/` 与 `build:win` 命令。

---

## 26. 交付核对与最终确认

| 项目 | 内容 |
| --- | --- |
| 依赖 | 任务 25 |
| 涉及文件 | 如有文档错漏，只做局部修正 |
| 对应测试 | 设计附录 B 自检清单、四条交互、红线清单 |
| 明确不做 | 不开始 ModelArts 接入、不做下一轮功能、不写业务代码 |
| 风险与回退 | 发现越界改动：按任务级回退方案最小化撤销；不整仓回退，避免影响用户未提交改动 |

### 26.1 对照设计附录 B 自检

- [ ] 组件不直接 `fetch`，HTTP 只在 `httpAgentTransport.js`。
- [ ] Mock 与 HTTP 返回同一契约，`meta` 可辨识，`model=null`。
- [ ] 店主确认前不保存、不发布、不写 `localStorage`、不调用后端。
- [ ] 草稿状态与顶层 phase 解耦，不新增 phase。
- [ ] 所有校验集中在 `agentDraft.mjs`，reducer 不重复实现规则。
- [ ] 价格只用整数分传输，`priceText` 不进入契约。
- [ ] 失败后 Composer 保持可用，重试不重复用户消息。
- [ ] 现有 20 项测试兼容（`SUBMIT_STORE_INFO` 允许 `idle`）。
- [ ] 未修改 `server/`、`templates/`、`miniprogram/`、`agentService.js`。
- [ ] 无新增依赖。
- [ ] 文档明确 ModelArts 未接入、凭据未配置。

### 26.2 对照四条交互

- [ ] 资料不完整追问：F1 通过，人工走查第 2 步通过。
- [ ] 资料完整进入可编辑确认：F2/F12 通过，人工走查第 3/7 步通过。
- [ ] 修改价格或菜品后重新校验：F3/F4/F5 通过，人工走查第 4 步通过。
- [ ] Mock 请求失败后可重试：T6/T7/F6/F7/F14/F15 通过，人工走查第 5/6 步通过。

### 26.3 对照红线

- [ ] 无自主规划、多 Agent、Skill 注册、工具编排、动态代码执行。
- [ ] 无真实模型调用、无云凭据、无真实联网。
- [ ] 无认证、无持久化、无写库、无发布。
- [ ] 未触碰 B1、`server/`、Electron 打包、菜单系统、`templates/`。

### 26.4 输出最终报告

- [ ] 列出本轮所有新增/修改文件及职责。
- [ ] 列出执行过的命令与真实结果（测试通过数、构建输出）。
- [ ] 列出未解决问题与人工确认项（至少包含 D-1/D-2 的最终选择、人工走查结果）。
- [ ] 明确下一步是「ModelArts 接入前准备」，不是直接接模型。

**验收标准（可执行检查）**

- [ ] 附录 B 11 项全部有记录。
- [ ] 四条交互均有自动化与人工证据。
- [ ] 红线清单无违反。
- [ ] 最终报告包含文件、命令、真实结果、未解决问题，不含笼统总结。
- [ ] 未开始任何业务代码编写或下一阶段接入。

---

## 附录：任务级回退速查

| 任务 | 回退动作 | 影响范围 |
| --- | --- | --- |
| 2–4 | 删除 `src/domain/agentDraft.mjs` 与 `test/agent-draft.test.cjs` | 无其他模块依赖前可完全回退 |
| 5–9 | 删除 `src/services/agentTurn/` 与 `test/agent-turn.test.cjs` | `AGENT_TRANSPORT` 保持 `mock` 时无运行时影响 |
| 10–15 | 移除 `sessionMachine.mjs` 的 `AGENT_*` case、切片与选择器；`constants.mjs` 删除 STORE_INFO 键 | 旧 20 项测试应恢复通过 |
| 16–18 | 删除 `src/components/agent/` | App 未引用时无影响 |
| 19 | 删除 `src/styles/index.css` 中的 `@import './agent.css';` | 样式立即恢复 |
| 20 | `STORE_INFO` 分支恢复原 `StoreInfoStep`；`COMPOSER_PHASES` 移除 `STORE_INFO` | 原流程完全恢复 |
| 22–24 | 删除新增文档/章节；保留历史记录 | 代码不受影响 |
| 25–26 | 无需回退；按失败项回到对应任务修正 | 不影响已完成模块 |

> 回退纪律：任何回退都只针对本清单新增内容，禁止 `git reset/checkout/clean`，禁止影响用户既有未提交改动。