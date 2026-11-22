# R2 验收报告：截图重构稳定性复核 + D1/D2 缺陷修复

基线：`21a4b0f`。本轮不新增能力、未提高 `FRONTEND_MAX_MODEL_CALLS`（仍为 8）、未放宽 DSL / 白名单 / 采用 / 导出门禁。

## 1. 结论

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 截图重构支线 | **BLOCKED**（未解除） | 3 次真实运行均在 8 次模型调用内无法产出合法候选；最后一次失败点收敛到 `$.pages[0].targetSize` |
| D1 同轮同显「已写入 + 项目已变化」 | **PASS**（真实界面实测） | 本轮真实写入一轮：出现「本轮已写入 联系电话（空）→ 010-88886666」且**未**出现「项目在此期间已变化」 |
| D1 撤销后清理卡片/冲突 + 提示已撤销 | **PASS**（真实界面实测） | 点「撤销本轮」后变更卡消失、无冲突提示、提示「已撤销本轮修改，门店资料已回到这一轮应用前的值。」 |
| D1 真实冲突保留 | **PASS**（单测 + 代码等价） | 未写入路径判据与修改前逐字等价，并有回归测试断言仍会报 stale（见 §4.3） |
| D2 预览副本含已采用海报 | **PASS**（真实预览工程实测） | 新预览副本 `assets/media/home-background.png` 与导出工程 sha256 完全一致 |
| 功能冻结 | 已冻结 | 本轮仅做提示词/工具契约与两处界面缺陷修复 |

## 2. 截图支线：成功链 vs 本轮失败链对比

| 维度 | 队友 T6 成功链（`2f99ae8`） | R2 本轮 |
| --- | --- | --- |
| 后端 | 隔离实例 `127.0.0.1:3101` | 本地 `127.0.0.1:3000`（`dist/main.js`） |
| 模型 / provider | `deepseek-flash` / `deepseek` | 同一通道（`modelChannel=server` → `/api/v1/agent/app-assistant`） |
| 直连/HTTP 配置 | `VITE_API_BASE_URL=http://127.0.0.1:3101/api/v1` | `http://127.0.0.1:3000/api/v1` |
| 模型调用 | 5 次（`modelCalls=5 toolCalls=4`） | 8 次耗尽（`stopReason=max_model_calls`） |
| 结束状态 | `status=planned coverage=covered` | `status=limit_reached` → `429 FRONTEND_MODEL_CALL_LIMIT` |
| 契约差异 | — | `contract.generated.ts` +132 / `types.ts` −182 / `schema.ts` ~107 / `tools.ts` +61 |

差异不在通道、模型或工具 schema，而在**运行时模型能否按 `UiRequirement` 结构一次写对**：T6 那次 5 轮收敛，本轮 8 轮不收敛。

## 3. 本轮四次真实运行（每轮都是 8 次调用上限内失败）

| 轮次 | 提示词改动 | 每次失败路径（`frontend_tool_rejected`） | 结束 |
| --- | --- | --- | --- |
| R2-a | 引入「最小 requirement 模板」+ 页字段硬约束 | `$.pages[0].regions[0].components` → `$.pages[0].regions[0].type` ×2 | `modelCalls=8` |
| R2-b | 增加 region 照抄模板 | `$.pages[0].targetSize` ×2 | 上游 `HTTP 502`，`modelCalls=6` |
| R2-c | `targetSize` 明示整数形状；`assertEnum/assertInteger` 回传 `expected` | `$.pages[0].targetSize` ×3 | `modelCalls=8` |
| R2-d | `assertObject` 回传 `expected/received`；第二阶段要求整页带回 `pageId/order/layout/targetSize` | 第一阶段通过；第二阶段 `regions[0].component` → `regions[0].type` → `regions[0].children` → `regions[0].rect.height` | `modelCalls=8` |

R2-d 说明 `targetSize` 缺陷（第一阶段失败）已被消除：本轮第一个拒绝点前移到第二阶段填 `regions`，随后每步换一个键出错（编造 `component` 键、`type` 枚举外值、`children` 形状、`rect.height` 非法），8 次内未收敛。

结论：模型在**空 `regions`** 的最小 requirement 上能一次写对，但**嵌套 `regions` 结构**在 8 次预算内无法稳定写对。失败点已从「顶层多余键」一路收敛到「region 子结构」，但 4 次真实运行均未在预算内收敛。按 R2 第 4 条，停止继续烧钱，支线保持 BLOCKED。

本轮**未**使用 Mock、未复用历史 PASS 作为本轮证据。参考图固定为 `.arts/g1/shots2/pages-home-index.png`（真实微信渲染首页截图，15 KB）。

## 4. D1：同一轮不再自相矛盾

### 4.1 根因

`AGENT_CHAT_SUCCESS` 用「请求发起时冻结的 `contentRevision`」对比当前值判断 stale；而本轮字段批次写入（`APP_ASSISTANT_CHANGES_APPLY`）先执行、必然把 `contentRevision` +1，于是**同一轮既写入又报冲突**。

### 4.2 修复

`src/state/sessionMachine.mjs`：stale 基线改为「本轮写入后版本优先」：

- 本轮有 `lastApplied`（且 `requestId` 匹配）→ 基线 = `appliedRevision`；
- 本轮没有写入 → 基线 = 请求快照（原行为不变）。

撤销清理：新增 `AGENT_CHAT_UNDO_APPLIED`（`src/state/sessionMachine.mjs`），由 `handleAgentChatUndoApplied`（`src/App.jsx:2830`）在 `UNDO_APPLY` 成功后派发，清 `lastApplied`/`lastStale` 并提示「已撤销本轮修改…」。

### 4.3 真实冲突仍保留

- 未写入路径：`baselineRevision = requestContextRevision`，与修改前逐字等价 → 迟到响应、请求期间手改内容照样报 stale。
- 写入后又有外部改动：基线为本轮写入后版本，`currentContentRevision !== appliedRevision` 时**仍会**报 stale。
- 「撤销本轮」在 `current !== appliedRevision` 时仍拒绝并提示改用全局撤销（未改动）。
- 自动化回归：`test/agent-sidebar.test.cjs` 新增一条覆盖三个分支——未写入路径遇到外部改动**仍报 stale**（`expectedRevision` 为请求快照）、本轮写入后 `lastStale === null`、撤销后 `lastApplied/lastStale` 皆清空且记录 `lastUndone`。

## 5. D2：应用内微信预览副本与正式导出同源

### 5.1 根因

正式导出传 `projectId` + `posterAssetId`（`src/App.jsx:4242`），预览导出（`runPreviewExport`）**没传**，所以预览副本缺 `assets/media/*`。

### 5.2 修复

`src/App.jsx` 预览导出补上同样两参数（受控引用，字节仍由主进程按资产权限与大小校验后读取；不复制无关缓存）。

### 5.3 实测（新预览工程 `云栖小馆-预览-878865`）

| 检查 | 结果 |
| --- | --- |
| `assets/media/home-background.png` | 存在，1,257,111 B |
| sha256 与导出工程对比 | `497476B13CD50FBA…` **完全一致** |
| `assets/media/manifest.json` | `9F64818E9B7E7EB9…` 一致；`source: ai-generated / imagelfk / gpt-image-2.6` |
| 页面引用 | `pages/home/index.wxml`：`src="/assets/media/home-background.png"` |
| 对照：修复前旧副本 `…-576042` | 只有 `assets/tabbar/*`，无 `assets/media/*` |

## 6. 检查结果

```
npm test                → 1251 tests / 1251 pass / 0 fail
npm run build           → vite build OK（exit 0）
server nest build       → exit 0
frontend-contract --check → 契约无漂移（sha256:eef3076d…）
frontend-capabilities     → 2 页、10 组件、25 动作、21 数据路径
app:capabilities:check    → 快照一致（digest=c6df6763）
mini:check                → 0 错误 1 警告
mirror:check              → 149 文件，摘要一致
```

## 7. 未运行 / 阻塞项

- 截图重构的候选 → 微信验证 → 采用 → 导出全链：**BLOCKED**（无合法候选）。
- 候选撤销采用、项目切换、关闭重开隔离：**NOT_RUN**（依赖上一条）。
- 真实设备、发布、真实支付：**NOT_RUN**（仅测试号 `wx39ff4eb9c62c0332`）。

## 8. 可演示范围（R2 后冻结）

主链：资料 → 能力 → 骨架 → 装修/视觉 → 导出 → 微信开发者工具编译与交互（4/4 页、4/4 交互）→ 统一会话字段批次写入 + 撤销（本轮 D1 实测）→ 应用内微信预览（本轮 D2 实测，含已采用海报）。截图重构支线仍不可演示。
