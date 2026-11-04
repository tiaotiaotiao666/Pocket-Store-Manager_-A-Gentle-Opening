# T16 端到端全链路验收报告

- 验收人：team-result-verifier（独立验收工程师）
- 仓库：`E:\智能开店app`
- 验收时间：2026-11-03 18:50 – 19:00（本地时间）
- 场景分类文件：`.resultverify/verification_scenario.json` → `"verification_scenario": "new-feature"`（文件由前序 T10 生成，本任务只读取）
- 说明：本角色要求的 `scenario-recognition` / `new-feature-verification` skill 在本环境可用 skill 清单中**不存在**（`skills_list`/system prompt 均未列出），因此按任务书第 1–5 步手工执行同等流程，并逐条给出真实命令与退出码。**不伪造 skill 调用。**
- 只读约束：本轮未修改 `src/`、`server/src/`、`scripts/`、`templates/`、`test/`、`package.json` 与计划文件；本轮新增的仓库文件仅 `.resultverify/t16/` 下的证据文件（未跟踪）。仓库当前的 116 项未提交改动（含 `package.json` 的 `server:dev` 脚本与 `miniprogram-automator` 依赖、以及 T1–T14 的实现文件）均为**前序实现的既有改动**，不是本轮验收所写。

---

## VERDICT: INCOMPLETE

自动化第 1、2 步全部通过；第 3 步（后端真实启动）因本机 **MySQL 3306 未安装/未启动**而失败（Prisma `P1001` 原文见下），第 4、5 步（真实 HTTP 打 `agent/turn` v1/v2、`template-candidates`）随之 **NOT_RUN**。人工步骤（Electron 真实点击、微信开发者工具导入编译/真机预览、React 预览与真机视觉一致性）本轮未执行，无截图，因此**不能判 PASS**。

---

## 自动化步骤表

| # | 操作/命令 | 结果 | 关键输出/退出码 |
|---|---|---|---|
| 1 | 读取 `.resultverify/verification_scenario.json` | PASS | `{"verification_scenario":"new-feature","task_id":10}`；skill 不可用，手工执行 |
| 2 | `node C:\Users\leiji\AppData\Local\Temp\t16-verify\e2e.mjs`（纯逻辑全链路：reducer→Plan→预览→Composer 导出到临时目录） | PASS | **41/41 断言通过，EXIT=0**；`ok:true,total:41,passed:41,failed:[]` |
| 3 | `node C:\Users\leiji\AppData\Local\Temp\t16-verify\patch-e2e.mjs`（presentationPatch validate/merge/diff + 7 项对抗） | PASS | **20/20 通过，EXIT=0** |
| 4 | `node --test test/presentation-patch.test.cjs test/preview-presentation.test.cjs test/session-presentation.test.cjs test/composer-presentation.test.cjs test/composer-presentation-emit.test.cjs test/template-revise-service.test.cjs test/agent-turn-v2.test.cjs test/template-candidates-service.test.cjs test/image-prompt-spec.test.cjs test/app-presentation-wiring.test.cjs test/real-preview-channel.test.cjs` | PASS | `tests 161 / pass 161 / fail 0`，EXIT=0 |
| 5 | `npm test`（前端全量回归） | PASS | `tests 622 / pass 621 / fail 0 / todo 1`，EXIT=0（6.48s） |
| 6 | `npm run build` | PASS | `1660 modules transformed`，`built in 4.21s`，EXIT=0；仅有 chunk >500kB 的非阻塞警告 |
| 7 | `npm run mini:check -- --root "C:\Users\leiji\AppData\Local\Temp\t16-verify\composer-out\t16-e2e-store"`（对**新导出工程**做静态校验） | PASS | `7 个页面，15 个组件目录，53 个 JS 文件，25 个 WXSS 文件`；`静态校验通过：0 个错误，0 个警告`，EXIT=0 |
| 8 | `npm run test:desktop` | PASS | `tests 13 / pass 13 / fail 0`，EXIT=0 |
| 9 | `npm run registry:check` | PASS | `注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）`，EXIT=0 |
| 10 | `npx vitest run test/agent-turn-v2.test.ts test/deepseek-agent.provider.test.ts test/template-revise.test.ts test/template-candidates.test.ts test/presentation-patch.test.ts test/body-limit.test.ts test/env-validation.test.ts`（server 目录） | PASS | `Test Files 7 passed / Tests 127 passed`，EXIT=0 |
| 11 | `npx vitest run test/agent.controller.e2e.test.ts`（进程内 supertest，mock Prisma，**不是真实服务**） | PASS | `13 tests passed`，EXIT=0 |
| 12 | `CACHE_DRIVER=memory PORT=3000 npm run server:dev` + 5s/25s 后 `curl /api/v1/health`、`/api/v1/readyz`、`/api/v1/ready` | **FAIL（环境阻塞）** | health/readyz/ready 全部 `http_code=000`；进程因 Prisma `P1001` 退出，见“阻塞原因” |
| 13 | `POST /api/v1/agent/turn`（v1 纯文本）真实 HTTP | NOT_RUN | 依赖步骤 12 |
| 14 | `POST /api/v1/agent/template-candidates` 真实 HTTP | NOT_RUN | 依赖步骤 12 |
| 15 | `POST /api/v1/agent/turn`（v2 + 极小 base64 PNG，验证 `vision`） | NOT_RUN | 依赖步骤 12；且真实视觉调用需用户授权额度 |

### 步骤 2 关键断言（真实输出，节选）

```
PASS | 状态机：BUILD_READY 后候选就绪
PASS | 状态机：选择主厨推荐
PASS | 状态机：改模板请求进入 revising
PASS | 状态机：补丁状态回到 idle
PASS | 状态机：copy.tagline 写入 store.notes
PASS | 状态机：补丁保留 slotOrder
PASS | Plan：recipe 为 order-poster
PASS | Plan：themeTokens.primaryColor = 墨绿 #0E4D3A
PASS | Plan：presentationTokens = {md, sm}（仅商品卡变小）
PASS | Plan：slotOrder 把海报落到 menu#menu-hero
PASS | Plan：features[].slots[] 保持 Recipe 声明不变
PASS | 预览：海报块 pageId = menu / slotId = menu-hero / size = md
PASS | 预览：sizes px = {92, 52}
PASS | 预览：store.tagline 来自 Plan notes
PASS | Composer：导出 ok
PASS | 导出 theme.generated.wxss 含 --store-home-hero-min-height / --store-product-card-min-height
PASS | 导出 theme.generated.wxss 主色变量为墨绿 / homeHero md → 190rpx / productCard sm → 110rpx
PASS | 导出 slots.generated.js 含 menuHero 键且承载 poster-carousel；homeHero 为空数组
PASS | 导出 pages/menu/index.wxml 注入海报组件标签
PASS | 导出 pages/home/index.wxml 不再含海报组件（已移走）
PASS | 导出 store.generated.js 携带口号
PASS | 对抗：非法颜色回落预设、非法档位回落 md
PASS | 对抗：pageId 与 slotId 不匹配的 slotOrder 被忽略，海报留在 home
PASS | 附加场景：homeHero lg → 250rpx
PASS | 对抗：二次导出 theme.generated.wxss 字节一致（幂等）
```

导出产物落盘于系统临时目录（不在仓库）：
`C:\Users\leiji\AppData\Local\Temp\t16-verify\composer-out\t16-e2e-store`
`C:\Users\leiji\AppData\Local\Temp\t16-verify\composer-out-lg\t16-e2e-lg`

### 步骤 3 关键断言（真实输出，节选）

```
PASS | validate：合法补丁 ok / 小写墨绿归一为 #0E4D3A / productCard=sm / tagline 去空白
PASS | merge：保留上一轮主色与商品卡尺寸，新增落位 menu-hero，changes 只含本轮新增
PASS | diff：产出可读中文 label
PASS | 对抗：3 位颜色被拒（PATCH_THEME_COLOR_INVALID）
PASS | 对抗：非法尺寸档位被拒（PRESENTATION_PATCH_INVALID）
PASS | 对抗：无轮播模板改 carousel 被拒（PATCH_SIZE_UNSUPPORTED）
PASS | 对抗：pageId/slotId 错配被拒（PATCH_SLOT_TARGET_INVALID）
PASS | 对抗：未知顶层键 / __proto__ 原型污染被拒（PRESENTATION_PATCH_INVALID）
PASS | 对抗：口号 41 码点被拒 / 未知菜品被拒（PATCH_COPY_DISH_UNKNOWN）
PASS | 对抗：merge 中任一非法 → 整包失败且不返回部分补丁
```

---

## 阻塞原因

### B1（决定性）：本机 MySQL 3306 不可用，后端无法启动

- `Get-NetTCPConnection -State Listen -LocalPort 3306,6379,3000`：**无任何输出**（三个端口均未监听）。
- `Get-Service | Where Name/DisplayName -like '*mysql*'`：无 MySQL 服务；`Get-Command mysqld` 无结果；`C:\phpstudy_pro`、`D:\phpstudy_pro`、`C:\laragon`、`C:\wamp64` 均不存在；`Get-ChildItem C:\ -Filter mysqld.exe -Depth 3` 无结果。**本机未安装 MySQL 可执行文件。**
- `npm run server:dev`（`CACHE_DRIVER=memory PORT=3000`）日志原文（节选，已脱敏，未含 Key）：

```
> smart-store-server@0.1.0 start:dev
> nest start --watch
[server:dev] workspace : E:\智能开店app
[server:dev] CACHE_DRIVER=memory PORT=3000
[Nest] ... Mapped {/api/v1/agent/turn, POST} route
[Nest] ... Mapped {/api/v1/agent/template-revise, POST} route
[Nest] ... Mapped {/api/v1/agent/template-candidates, POST} route
PrismaClientInitializationError: Can't reach database server at `127.0.0.1:3306`

Please make sure your database server is running at `127.0.0.1:3306`.
    at async Proxy.onModuleInit (E:\智能开店app\server\src\database\prisma.service.ts:7:5)
    at async NestApplication.listen (E:\智能开店app\server\node_modules\@nestjs\core\nest-application.js:178:13)
    at async bootstrap (E:\智能开店app\server\src\main.ts:133:3) {
  clientVersion: '6.19.3',
  errorCode: 'P1001',
}
```

- 启动后 5 秒与 25 秒两次探测（首次编译在 3–4 秒内完成，路由已打印）：
  `health=000`、`readyz=000`、`ready=000`（连接失败，非 4xx/5xx）。
- 已按红线要求**未 mock 数据库**；启动的进程树已清理（`taskkill /PID 28044 /T /F`，随后 3000 端口复查无监听）。

### B2：真实生图通道关闭（已知且不改动）

`server/.env`：`IMAGE_PROVIDER_NAME=not-configured` → 前端返回 `local-demo` 占位图属预期。本轮未调用生图。

### B3：真实视觉模型调用需额度授权

`DEEPSEEK_API_KEY` 可用、`DEEPSEEK_MODEL=deepseek-chat`、`DEEPSEEK_VISION_MODEL` 默认 `deepseek-flash`；但步骤 5 被 B1 阻塞，且即便服务可起，真实视觉调用会消耗额度，需用户明确授权，本轮标注 `NOT_RUN`。

---

## 人工步骤（未执行，需用户操作）

1. 启动本机 MySQL（`127.0.0.1:3306`，库 `smart_store`）后重新执行 `npm run server:dev`，再由验收人复跑步骤 4、5（v1 纯文本、template-candidates、v2 带图）。
2. 打开 Electron 桌面端（`npm run desktop:dev`），在模板页真实点击：候选模板对比、对话修改（输入“主色改墨绿 / 商品卡小一点 / 海报挪到菜单页”），观察右侧实时预览是否即时变化。
3. 在资料页真实上传菜单照/环境照，触发 v2 填表，核对草稿字段与预览。
4. 走“预检 → 选择目录 → 导出”，在导出目录确认 `theme.generated.wxss`、`config/slots.generated.js`、`pages/menu/index.wxml` 与预览一致。
5. 用微信开发者工具导入导出工程 → 编译 → 真机预览，截图回传（**禁止**用 React 预览截图替代）。
6. 对比“React 预览渲染”与“微信真机截图”的视觉一致性（字号、间距、海报高度、配色逐项核对）。
7. 复核 T15 记录的 `composer:verify` `PATH_ESCAPE` 既有缺陷（`generation-report.json` / `生成报告.md` 含绝对路径）是否仍存在。

---

## 本轮能证明的结论

- **纯逻辑全链路已打通**：`sessionMachine`（对话→候选→选模板→改模板，含 requestId 守卫与 copy 落库）→ `planFromSession`（主题/尺寸/落位投影）→ `previewViewModel`（页面归属、px、tagline）→ Composer（wxss 变量、slots 配置、wxml 注入）**使用同一份 Plan 事实**，41 项断言全部通过。
- **补丁契约层严格**：validate/merge/diff 与 7 项对抗（非法颜色/尺寸/落位/原型污染/超长/未知菜品/整包回滚）全部按契约拒绝或归一，20 项通过。
- **导出工程真实消费新能力**：导出目录中 `--store-home-hero-min-height` 与 `--store-product-card-min-height` 被 `store-header/index.wxss`、`product-card/index.wxss` 以 `var()` 消费；海报组件真实出现在 `pages/menu/index.wxml` 并注册 `usingComponents`，首页锚点已空；两次导出字节一致（幂等）。
- **新导出工程通过静态门禁**：`mini:check` 0 错误 0 警告；`registry:check`、`test:desktop`、前端 621 通过 + 0 失败、服务端 agent 127 + 13 通过。
- **服务端路由层（进程内）语义正确**：`agent.controller.e2e`（supertest + mock Prisma）13/13 通过，说明 v1/v2 分派、鉴权、413 等逻辑本身无误 —— 但这不是“真实服务可用”的证据。

## 本轮不能证明的结论

- **真实后端服务可启动/可调用**：3306 缺失导致 `P1001`，HTTP v1/v2/template-candidates 均未发出，`vision` 字段未验证。
- **Electron 桌面端真实可点**：所有交互仅由静态接线测试与契约测试覆盖，未在真实窗口点击，无法排除“按钮存在但无响应”“状态刷新后丢失”等问题。
- **微信小程序真实运行**：未用微信开发者工具导入/编译/真机预览，`mini:check` 只是本机静态兜底。
- **React 预览与真机视觉一致**：无真机截图，无法比对。
- **生图通道**：provider 未配置，仅 local-demo 占位图。

---

## 未决问题清单

1. **后端不可启动（阻塞 PASS 判定）**：MySQL 3306 未安装，`server/src/database/prisma.service.ts:7` 的 `onModuleInit` 强制连接。建议：用户安装/启动 MySQL 并初始化 `smart_store`，或后端提供 `PRISMA_UNAVAILABLE` 降级开关（需产品决策，本轮不擅自改代码）。
2. **v2 视觉真实调用未验证**：即使服务可起，也需用户授权消耗 DeepSeek 额度；本轮 `NOT_RUN`。
3. **T15 的 `composer:verify` `PATH_ESCAPE` 既有缺陷**：本轮未复跑（任务未要求），判定不依赖它；报告文件含绝对路径的问题仍在 T15 记录中。
4. **生图通道 `IMAGE_PROVIDER_NAME=not-configured`**：前端 `local-demo` 占位图属预期，真实出图能力未验证。
5. **人工走查缺位**：桌面点击、微信工具导入编译、真机截图、视觉一致性核对均未执行，缺少截图路径，因此无法按“PASS 需人工步骤 5–9 完成”判定。

---

## 证据文件

| 文件 | 说明 |
|---|---|
| `.resultverify/t16/e2e-result.json` | 41/41 端到端断言明细（含 expected/actual） |
| `.resultverify/t16/patch-result.json` | 20/20 补丁契约断言明细 |
| `.resultverify/t16/server-start-error.log` | `npm run server:dev` 启动日志与 Prisma P1001 原文 |
| `.resultverify/t16/frontend-test.log` | 前端全量 `npm test` 日志（622 tests） |
| 临时脚本 | `C:\Users\leiji\AppData\Local\Temp\t16-verify\e2e.mjs`、`patch-e2e.mjs`（不在仓库） |
| 导出产物 | `C:\Users\leiji\AppData\Local\Temp\t16-verify\composer-out\t16-e2e-store`、`composer-out-lg\t16-e2e-lg` |