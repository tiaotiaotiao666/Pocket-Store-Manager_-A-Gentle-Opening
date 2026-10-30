# 本轮交接：开店 Agent 接入前准备（本地 Mock）

> 日期：2026-10-31
> 状态：**前端实现完成，本地 Mock 可运行。** 后续同日的 DeepSeek 接入轮次已实现后端 `POST /api/v1/agent/turn`，真实 Provider 为 DeepSeek；ModelArts / 盘古仍未接入。
> 最新状态与验证证据见 [`本轮DeepSeek接入交接.md`](本轮DeepSeek接入交接.md)；本文保留为 Mock 轮次的历史交接。
> 上游文档：[`agent-turn-contract.md`](agent-turn-contract.md)、[`agent-turn-design.md`](agent-turn-design.md)、[`tasks-agent-turn.md`](tasks-agent-turn.md)。

---

## 1. 本轮实际完成的内容

在桌面端 `STORE_INFO`（店铺装修）阶段内增加“自然语言开店资料收集 → 结构化草稿 → 追问缺项 → 店主编辑 → 明确确认”的完整前端闭环，**不新增顶层 phase**，确认后仍进入原 `StoreInfoStep`，再走原有的生图提示词、效果审核与部署流程。

### 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/domain/agentDraft.mjs` | 草稿模型与全部纯函数：规范化、整数分价格、营业时间归一化、缺项/错误、追问、补丁合并、契约投影/反投影 |
| `src/services/agentTurn/agentServiceConfig.js` | `AGENT_TRANSPORT='mock'`、`AGENT_ENDPOINT`、12s 超时、契约版本、Mock 可辨识文案 |
| `src/services/agentTurn/agentTurnError.js` | `AgentTurnError` 构造、识别与归一化；错误体不含堆栈/密钥 |
| `src/services/agentTurn/mockAgentTransport.js` | 本地规则解析（店名/品类/营业时间/取餐方式/菜品）、固定回复、一次性失败注入；零网络 |
| `src/services/agentTurn/httpAgentTransport.js` | 完整 HTTP 契约、超时、错误归一化、响应结构校验；**默认不启用** |
| `src/services/agentTurn/agentTurnService.js` | React 唯一调用入口；不信任服务端 `status`，由本地校验决定 |
| `src/components/agent/AgentIntakePanel.jsx` | 状态条、Mock 徽标、回复、缺项 chips、错误摘要、失败条、重试、模拟失败开关、确认区 |
| `src/components/agent/DraftEditor.jsx` | 受控草稿编辑：店名、品类、营业时间、取餐方式、3–5 道菜品增删改、字段错误 |
| `src/components/agent/AgentDraftSummary.jsx` | 已确认只读摘要 + “尚未保存到云端，也未发布” + 返回修改 |
| `src/styles/agent.css` | `.agent-*` 命名空间样式，暖白 + 紫色，含请求中/失败/确认视觉 |
| `test/agent-draft.test.cjs` | 领域边界 D1–D31 |
| `test/agent-turn.test.cjs` | 配置、错误、Mock、HTTP、service T1–T20 |
| `test/agent-intake-flow.test.cjs` | reducer + service 流程 F0–F18 |
| `docs/agent-turn-contract.md` | 冻结 `agent-turn.v1` 契约与 ModelArts 待确认项 |
| `docs/本轮Agent接入前准备交接.md` | 本文件 |

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `src/state/constants.mjs` | `STORE_INFO` 输入框文案、`AGENT_STATUS`、示例 hint |
| `src/state/sessionMachine.mjs` | `agentDraft` / `agent` 切片、`AGENT_*` 与 `EDIT_*` action、`CONFIRM_TEMPLATE` 预填、`SET_STORE_FIELD` 同步、`SUBMIT_STORE_INFO` 防御与交接 payload、`selectAgentComposerState` |
| `src/components/chat/Composer.jsx` | 新增可选 `submitDisabled`，默认等于 `disabled`；旧调用方行为不变 |
| `src/App.jsx` | `STORE_INFO` 渲染分支、Composer 分流、Agent 请求 handler、右栏状态卡、自由品类兼容 |
| `src/styles/index.css` | 末尾追加 `@import './agent.css';` |
| `docs/后端待实现接口清单.md` | 新增 §15 Agent 资料收集章节 |
| `docs/待完成目标.md` | 追加本轮完成记录与验证证据 |
| `docs/本轮构建介绍.md` | 追加本轮构建说明 |

### 明确没有改

`server/**`、`templates/mini-program/**`、`miniprogram/**`、`package.json` 与 lockfile、`src/services/agentService.js`、B1 点餐模块、Electron 打包、菜单系统。未新增依赖，未执行任何 git 写操作。

---

## 2. 验证命令与真实结果

| 命令 | 真实结果 |
| --- | --- |
| `npm test`（基线，改动前） | 20/20 通过 |
| `npm run build`（基线，改动前） | 退出码 0，1604 modules，CSS 42.20 kB / JS 207.59 kB |
| `node --test test/agent-draft.test.cjs` | 31/31 通过 |
| `node --test test/agent-turn.test.cjs` | 21/21 通过 |
| `node --test test/agent-intake-flow.test.cjs` | 19/19 通过（含 F0、F1–F18） |
| `npm test`（最终） | **91/91 通过**，旧 20 项无回归 |
| `npm run build`（最终） | **退出码 0**，1612 modules，CSS 56.12 kB（gzip 9.21 kB）/ JS 250.07 kB（gzip 80.29 kB） |

静态检查（真实执行）：

- `src/components/agent`：无 `fetch(`、`XMLHttpRequest`、`agentTurnService`、`requestAgentTurn`、`validateAgentDraft`、`parsePriceTextToCents`、`formatCents`、`localStorage`、`sessionStorage`、`document.cookie`、`dispatch(`。
- `src/App.jsx`：无 `fetch(` / `axios`。
- `src/domain/agentDraft.mjs`：无网络、DOM、存储、`Date.now`、`Math.random`。
- `src/services/agentTurn/mockAgentTransport.js`：无 `fetch(`、URL、`modelarts` / `pangu` / `盘古`。
- `src/services/agentTurn/agentTurnService.js`：无 React、DOM、存储、`dispatch(`。
- `src/styles/agent.css`：121 个 `.agent-*` 顶层选择器；未修改 `tokens.css` 与既有组件类。

未执行：

- 未运行 `server/` 下任何命令（本轮不改后端）。
- 未运行 `npm run build:win`（Electron 打包属于独立事项，且上一轮已知下载阻塞）。
- 未做浏览器人工视觉走查：当前环境未驱动桌面窗口/截图流程，需在 `npm run dev` 或 `npm run desktop:dev` 中复验。自动化流程测试已覆盖四条交互的状态与消息流。

---

## 3. 四条必需交互的证据

| 交互 | 自动化证据 | 说明 |
| --- | --- | --- |
| 资料不完整时追问 | `F1`、`T1`、`T3` | 缺营业时间时 `status=collecting`，`nextQuestion.field=businessHours`，会话流出现追问 |
| 资料完整时进入可编辑确认 | `F2`、`F12` | `status=reviewing`、`readyForReview=true`、确认后映射 `store` |
| 修改价格或菜品后重新校验 | `F3`、`F4`、`F5`、`F13` | 非法价格产生 `PRICE_INVALID` 并回到 `collecting`；2 道菜缺项；第 6 道被拒绝；确认后编辑回到 `reviewing` |
| Mock 请求失败后可重试 | `F6`、`F7`、`F14`、`F15`、`T6`、`T7` | 失败不追加错误气泡；Composer 可编辑；重试不重复 user 消息；复用最新草稿 |

---

## 4. 未决项与人工确认

1. **D-1（已按方案 A 实施）**：`requesting` 期间 `DraftEditor` 只读，Composer 仍可输入；响应直接覆盖草稿。若未来要求“请求期间编辑不丢失”，需引入 `draftRevision` 合并逻辑。
2. **D-2（已按方案 A 实施）**：`AgentTurnError` 独立在 `src/services/agentTurn/agentTurnError.js`，由 mock/http/service 共用。
3. **人工视觉走查未执行**：需要在真实窗口确认窄窗口单列布局、缺项 chip 锚点跳转、焦点态与失败条视觉。自动化测试不渲染 React。
4. **Mock 解析是规则而非 NLU**：只识别“菜名 + 价格”同时出现的菜品；不识别中文数字时间；不解析菜品描述。后续接真实模型后由模型负责抽取，前端契约不变。
5. **营业时间不支持跨午夜**：`22:00-02:00` 会报 `HOURS_RANGE`，需拆成 `22:00-23:59,00:00-02:00`（本轮不引入跨天字段）。

---

## 5. 接入真实 ModelArts 前仍需确认的信息

> **真实 ModelArts 尚未接入。** 以下均为未确认项，本轮没有配置、没有伪造、也没有写入仓库。

以下均为**未确认项**，本轮没有配置、没有伪造、也没有写入仓库：

1. **账号归属**：使用哪个华为云账号/企业项目？是否有 ModelArts Studio 工作区权限？
2. **API 形式**：ModelArts Studio 工作流调用、托管推理 API，还是盘古 API？同步还是异步任务？是否流式？
3. **鉴权方式**：IAM Token、AK/SK 签名、API Key 或临时 STS？短期 Token 由谁签发、有效期多久？
4. **区域与 Endpoint**：Region、服务 Endpoint、网关地址；是否经过企业代理或统一网关？
5. **模型名称与版本**：具体模型、版本、上下文长度、结构化输出能力。
6. **配额与限流**：QPS、并发、日配额、超时上限；429 的重试策略。
7. **内容审核与脱敏**：输入输出审核责任方、敏感经营信息脱敏规则。
8. **日志与可观测性**：请求 ID、模型调用日志、保留周期、脱敏字段。
9. **会话归属与多租户**：Agent 回合如何归属店主；是否需要 `agent_sessions` / `agent_turns` 独立表。
10. **幂等**：重试是否重复扣费；是否支持 `Idempotency-Key` 与 `turnId` 去重。
11. **最终校验责任**：价格、营业时间、菜品数量的服务端二次校验与确认后落库时机。

**安全红线**：AK/SK 永不下发前端；前端只接收短期 Token；密钥不写日志、不进错误体、不进仓库。店主确认前不落库、不发布。

---

## 6. 回退方案

| 场景 | 回退动作 |
| --- | --- |
| 想完全回到无 Agent 的原表单 | `App.jsx` 的 `STORE_INFO` 分支恢复为单个 `StoreInfoStep`；`COMPOSER_PHASES` 移除 `STORE_INFO` |
| 想停用 Agent 服务 | 删除 `src/services/agentTurn/`；`AGENT_TRANSPORT` 保持 `mock` 时无运行时影响 |
| 想回退领域层 | 删除 `src/domain/agentDraft.mjs` 与对应测试 |
| 想回退状态层 | 移除 `sessionMachine.mjs` 的 `AGENT_*` / `EDIT_*` case、两个切片与选择器；`constants.mjs` 删除 STORE_INFO 键 |
| 想回退 UI | 删除 `src/components/agent/` 与 `agent.css` 的 import |

回退只针对本轮新增内容，**禁止 `git reset` / `git checkout` / `git clean`**，不得影响工作区既有未提交改动。

---

## 7. 下一步建议

1. 先在桌面窗口做一次人工走查（8 步清单见 `docs/tasks-agent-turn.md` 任务 21.2）。
2. 后端按 `docs/agent-turn-contract.md` 实现 `POST /api/v1/agent/turn`，并完成服务端二次校验与幂等。
3. 确认第 5 节账号/API/鉴权/区域信息后，再把 `AGENT_TRANSPORT` 切到 `http` 并做契约联调。
4. 仍然不要在本轮范围内接入多 Agent、自主规划、Skill 注册或模型直接写库。
---

## 8. 后续更新：DeepSeek 真实接入（同日）

上一轮遗留的两项已被后续轮次处理：

| 原遗留项 | 后续状态 |
| --- | --- |
| 后端 `POST /api/v1/agent/turn` 尚未实现 | ✅ 已实现 `server/src/agent/**`，契约仍为 `agent-turn.v1` |
| 真实 ModelArts 尚未接入 | ⚠️ 改为先接 **DeepSeek**；ModelArts / 盘古仍未接入 |

本轮变化摘要：

- 后端新增 `AgentModule`：严格请求校验 → DeepSeek `/chat/completions` → 白名单合并 → 服务端独立校验 → 统一 `agent-turn.v1`。
- 缺少 `DEEPSEEK_API_KEY` 返回 `503 DEEPSEEK_NOT_CONFIGURED`，**不回退本地 Mock**。
- 前端新增 `VITE_AGENT_TRANSPORT=mock|http`；默认仍为 `mock`，不破坏原有启动与交互。
- 鉴权临时边界：development/test + `AGENT_REQUIRE_AUTH=false` 允许联调；production 必须 `AGENT_REQUIRE_AUTH=true` 且无 Authorization 返回 401。
- Agent 仍然**不写业务数据库**；确认前不落库、不发布。
- 当前没有 Skill、工具调用、多 Agent、自主规划和自动发布。

完整文件清单、配置变量、API 示例与测试结果见 [`本轮DeepSeek接入交接.md`](本轮DeepSeek接入交接.md)。