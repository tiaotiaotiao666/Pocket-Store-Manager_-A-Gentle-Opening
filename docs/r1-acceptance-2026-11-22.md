# R1 最终联合验收报告（70e0057）

生成时间：2026-11-22 10:55（Asia/Shanghai）
基线：`70e0057` + 本地同步提交 `53fe9d6`；本轮不新增功能、不改架构。

## 1. 验收判定

| # | 项目 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 后端/数据库/微信 CLI/生图服务就绪 | PASS | `GET http://127.0.0.1:3000/api/v1/readyz` → **200** `{"status":"ok","database":"ok","cache":"memory"}`；`/api/v1/health` → 200；`/api/v1/generation/posters/status` → `configured:true · imagelfk · gpt-image-2.6`（未输出密钥）；`/api/v1/stores/store-demo-001` 与 `/tables` 返回真实数据；CLI 解析到 `D:\Downloads\微信web开发者工具\cli.bat`（`WX_CLI_PATH`），`cli` 登录态 exit=0 |
| 2 | 新项目主线（AI 填资料 → 模板改+撤销 → AI 海报+采用 → 重开恢复 → 导出前确认 → 导出 → AppID 后处理） | PASS | 项目 `p_mwr88b5b509c5b`「云栖小馆」；AI 填资料 8.4s 写入店名/品类/时段/取餐/3 道菜；模板改 2 项（`theme.primaryColor=#F97316`、`sizes.homeHero=lg`）→ 撤销后 `presentation.patch` 归零；AI 海报 `a_af20e1e76faea438` 已保存；导出 143 文件到 `g1-appdata\exports\云栖小馆`（`assets/media/home-background.png` 1,257,111 B）；AppID 后处理 `touristappid` → `wx3b1c04f63cf6cfd0` |
| 3 | 新导出工程跑真实微信编译 + automator | PASS | `scripts/wechat-devtools-run.cjs`：compile(exit=0, 1219ms) · automation(exit=0) · 页面 4/4 · 关键交互 4/4；含真实点击选桌（A1/`table-a1-001`，三页一致）、加购、购物车、结算下单（真实后端订单 `ord_01M80JMC248GKBS1GQJG32`）、演示模拟支付 `UNPAID → DEMO_PAID` |
| 4 | 首页 AI 海报在真实渲染中可见 | PASS | `.arts/g1/shots2/pages-home-index.png`（230×495，顶部即 AI 生成海报） |
| 5 | 应用内「微信预览」 | 部分 PASS / 有缺陷 | 已由 BLOCKED 变为可发起：`已请求打开微信开发者工具：…\preview-projects\云栖小馆-预览-576042`（新鲜副本，非过期窗口、非 miniprogram 镜像）；但该预览副本 `assets/` 只有 tabbar 图标、**未包含 AI 海报**（导出工程有），见缺陷 D2 |
| 6 | 截图参考分支（上传→识别→候选→微信验证→采用→导出） | BLOCKED | 真实执行到「上传 → 外部确认（确认发送，接收方 `127.0.0.1:3000`）→ 识别」；连续 6 次运行均以 `FRONTEND_MODEL_CALL_LIMIT`（429，`modelCalls=8` 用尽，`stopReason=max_model_calls`）结束。提示修复已让 `mustKeep` 通过，失败点后移为 `$.pages[0].components|order|layout|targetSize`；候选、微信验证、采用、撤销采用均未发生，记 BLOCKED |
| 7 | 统一侧栏真实一轮 | 部分 PASS | 一轮真实模型调用 6.3s：提案"联系电话 → 010-88886666"写入 → 变更卡 → 「撤销本轮」后 `store.phone` 归零；用户消息无重复（1 条）；但 UI 残留互相矛盾的提示，见缺陷 D1 |
| 8 | 真实设备 / 发布 / 真实支付 | NOT_RUN | 仅有测试号，测试号不可上传发布；演示支付已明确标注不产生真实交易 |

## 2. 本轮真实修复（阻断项）

1. **后端 dist 滞后导致 `POST /api/v1/agent/app-assistant` 404**（表现为「请求未被接受」，连续 6 次失败）。重建 `server`（`npm run build`）后路由存在，AI 填资料恢复。属构建滞后，无源码改动。
2. **模型通道未配置**：应用处「直连 DeepSeek 但未保存 API Key」，致使 Agent 无法工作。改为「本机服务」（`modelChannel=server`，走已配置的后端），自检「模型通道 通过」。
3. **对话端点与基址重复**（`apiBaseUrl` 已含 `/api/v1`，`agentEndpoint` 又是 `/api/v1/agent/turn`，拼接成 `/api/v1/api/v1/...` → 404）。改为 `/agent/turn`，落到 `http://127.0.0.1:3000/api/v1/agent/turn`。
4. **演示数据缺失**：`stores` 0 行导致门店/菜单 404、`/stores/:id/tables` 为空导致选桌 BLOCKED。新增幂等脚本 `server/seed-demo-store.cjs`（1 店 / 3 分类 / 4 商品）与 `server/seed-demo-tables.cjs`（4 餐台），补齐后选桌链路 PASS。

## 3. 缺陷清单（非阻断，未改代码）

- **D1**：侧栏一轮成功后同时渲染「本轮已写入 + 变更卡 + 撤销本轮」与「项目在此期间已变化，这次结果没有写入，请重试。」；点「撤销本轮」后 `project.json` 已归零，但变更卡与冲突提示仍留在界面。
- **D2**：应用内预览工程（`preview-projects/*-预览-*`）不含导出工程里的 `assets/media/*` 海报素材，导致「应用内预览」看不到已在导出工程中生效的 AI 海报。
- **D3（阻断截图分支，本轮已做提示层修复但未解除）**：`POST /api/v1/agent/frontend-reconstruct` 中模型反复提交非法 `UiRequirement`（`FRONTEND_REQUIREMENT_INVALID`，非法点集中在 `$.mustKeep[0]` 与 requirement 顶层 `version`/`pageId`），8 次模型调用（`maxModelCalls=8`，`contract.generated.ts:72`）用尽后以 429 `FRONTEND_MODEL_CALL_LIMIT` 收尾。根因为契约常量上限与当前模型产出稳定性，非骨架缺陷。

### 3.3 本轮为截图分支所做的提示层修复（保留，未改契约）

1. `server/src/agent/frontend-reconstruct/prompt.ts`：把「不要给这些元素添加 … kind …」限定为列表元素，并补 `mustKeep` 只能是 `{kind, ref}` 的说明。
2. `server/src/agent/frontend-reconstruct/prompt.ts`：补 requirement 顶层 10 个允许键，明确 `version`/`pageId`/`draft` 属草稿字段。
3. `server/src/agent/frontend-reconstruct/schema.ts`：`assertExactKeys` 失败时把 `allowedKeys` 一并回传模型，避免逐个键试错耗尽调用次数。
4. `server/src/agent/frontend-reconstruct/tools.ts`：`check_frontend_coverage` 工具描述与 `requirement` 参数描述写明 `mustKeep` 必须是对象数组。
5. `server/src/agent/frontend-reconstruct/tools.ts`：`FRONTEND_REQUIREMENT_INVALID` 时把 `minimalRequirement`（合法最小示例）一并回传，避免逐字段试错。

效果：前 3 项把 `mustKeep` 与 requirement 顶层字段的失败清零，失败点后移到 `pages[0]` 结构；但 8 次模型调用上限仍在第 5–8 步耗尽，未能产出候选。

契约检查仍无漂移（`frontend-contract --check` = `sha256:eef3076d50392fe9…`），`npm test` 全绿。

## 3.1 重开恢复

在「我的项目」中重新打开「云栖小馆」（`p_mwr88b5b509c5b`）后：`phase=deploy`、`store.name=云栖小馆`、3 道菜、`presentation.templateId=warm-bistro`、`visual.styleId=warm`、`visual.imageAssetId=a_af20e1e76faea438`、`presentation.patch={}`（撤销后归零）、`deploy.directory=g1-appdata\exports`，与导出前一致。

## 3.2 回归与契约检查（全部 exit=0）

```text
npm test                                0  （duration 29.4s）
npm run build                           0
node scripts/frontend-contract.cjs --check   契约无漂移 sha256:eef3076d50392fe9…
npm run frontend:capabilities:check     0  （2 页 / 10 组件 / 25 动作 / 21 数据路径）
npm run app:capabilities:check          0  （digest=c6df6763）
npm run mini:check                      0  （0 错误 1 警告）
npm run mirror:check                    0  （149 文件 · sha256:30a411f3d34424e4…）
```

### 3.4 切换项目/会话隔离（实测）

在「我的项目」切到另一个项目（`新建项目`）再切回「云栖小馆」后，参考截图区回到「上传参考截图 / 还没生成候选前端」，上一轮上传的 `pages-home-index.png` 与失败状态都未串到另一个项目，符合「候选状态只保留在本次应用会话里」的约定；「撤销采用」因候选未产出而 NOT_RUN。

## 4. 复现命令

```powershell
# 后端
cd server; npm run build; node dist/main.js
# 演示数据
node server/seed-demo-store.cjs; node server/seed-demo-tables.cjs
# 真实编译 + automator
$env:WX_CLI_PATH='D:\Downloads\微信web开发者工具\cli.bat'
node scripts/wechat-devtools-run.cjs 'C:\Users\tiaotiao\Desktop\ICT\g1-appdata\exports\云栖小馆' --auto-port 9421 --json .arts/g1/r1-devtools-tables.json --shots .arts/g1/shots2
```

## 5. 演示入口

- 桌面端：`npm run dev`（Electron 33.4.11）→ 我的项目 → 「云栖小馆」
- 导出工程：`g1-appdata\exports\云栖小馆`（微信开发者工具「导入项目」即可编译）
- 后端：`http://127.0.0.1:3000/api/v1`（`store-demo-001`）
