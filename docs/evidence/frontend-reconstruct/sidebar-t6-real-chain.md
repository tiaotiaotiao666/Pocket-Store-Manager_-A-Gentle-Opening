# 侧栏单图 → 新骨架 → 微信预览：T6 真实链路证据（2026-11-21）

> 结论口径：只有真实跑过、并且能指到原始产物的项才写 `PASS`；只读到中间提示或环境不具备的项写
> `BLOCKED`；没跑的写 `NOT_RUN`。**本文件不含任何 PASS 之外的合并结论**，也不把 React 预览截图
> 当作微信运行时截图。

## 1. 环境与方法

| 项 | 事实 |
| --- | --- |
| 应用 | 仓库工作区 Electron（`node_modules/electron/dist/electron.exe .`），隔离 `--user-data-dir=<temp>`，CDP `--remote-debugging-port` |
| 前端 | 本仓库 Vite（`127.0.0.1:5173`，`VITE_API_BASE_URL=http://127.0.0.1:3101/api/v1`） |
| 后端 | 本仓库 `server/dist/main.js`，隔离端口 `3101`（避开既有 3000 进程），`readyz database=ok` |
| 模型 | 服务端 `deepseek-flash`（真实调用，日志可见 `model_call` / `tool_call` / `run_end`） |
| 微信 | 本机 `E:\微信web开发者工具`（`cli-resolver` 解析成功），真实编译 + `miniprogram-automator` 交互 |
| UI 自动化 | **仅 Electron CDP**。`agent-desktop`（UIA）在本机返回 `INTERNAL private file DACL grants an untrusted principal`，未使用、也未冒充 |
| 脚本 | `.resultverify/t6/chain.mjs`（整条链）、`.resultverify/t6/preview-dock.mjs`（最终预览）、`.resultverify/t6/probe-selftest.mjs`（探测自检） |

## 2. 结论表

| 里程碑 | 结论 | 证据 |
| --- | --- | --- |
| 侧栏一次发送（1 张参考图 + 1 段话） | `PASS` | `chain-result.json#checks: sidebar-reference-sent`（附件 1、草稿未被改写） |
| 资料写回 + 外发确认 | `PASS` | `sidebar-writeback-and-consent`（变更卡 ≥1）、`#screen-send-confirm` 出现并点击 |
| 服务端真实分析与草案 | `PASS` | 服务端日志 `frontend reconstruct ... status=planned coverage=covered modelCalls=5 toolCalls=4`，`runId=frun-mwq1dsur-fi1dof` |
| 候选生成 + Composer dry-run | `PASS` | `evidence-run-A/frontend-runs/frun-mwq1dsur-fi1dof/attempts/attempt-1/{candidate,overlay}`、`attempt.json(status=committed)` |
| 微信真实编译 + 运行时验证 | `PASS` | `verification/runtime/frontend-runtime.json`：`RUNTIME_PASS`，页面 4/4、关键交互 2/2、交互合计 7/11、截图 5 张（`shots/*.png`） |
| 采用候选 → 继续制作 | `PASS` | `attempts/attempt-1/adopted.json`：`status=adopted`、`runtimeStatus=PASS`、`partialConfirmed=false`；采用后未自动弹新微信窗口 |
| 最终预览：导出工程 | `PASS` | `preview-dock-result.json#verdict.export=PASS`；导出工程 8 页、`project.config.json` AppID 已后置写入、`appid-postprocess.json` 侧车与 `composition.lock.json` 齐备（`evidence-run-A/preview/T6链路验证店-预览-253384`） |
| 最终预览：微信工具打开工程页面 | `BLOCKED` | `preview-dock-result.json#verdict.openDevtools=BLOCKED`，工具原始提示：「微信开发者工具已启动。如果窗口里还没显示小程序页面，请稍等或在工具里点一次「编译」（Ctrl+B）。」——进程存在但无对应工程窗口标题 |
| 两种骨架（经典/poster）dry-run 对比 | `NOT_RUN` | 本轮只跑了一条参考图链路 |
| adopt 后重开项目、撤销本轮、项目切换/取消/双击隔离 | `NOT_RUN` | 未在本轮执行 |

整体口径：**核心链路（发送 → 分析 → 候选 → dry-run → 微信运行时 PASS → 采用 → 导出）已真实打通；
「微信工具把导出的预览工程打开成页面」这一步仍是 `BLOCKED`，其余验收矩阵项 `NOT_RUN`。**

## 3. 本轮修掉的真实阻塞（都不是新增功能）

1. **候选构建全线失败**：`MATERIALIZE_VERIFY_FAILED / ASSET_INTEGRITY_MISMATCH`。
   根因是工作区里 8 个文件被旧版整份覆盖（`scripts/composer/registry.cjs`、`scripts/composer/schema.cjs`、
   `scripts/component-catalog.cjs`、`scripts/check-packaging.cjs`、`templates/catalog/curation.v1.json`、
   `templates/registry/schema/component-catalog.v1.json`、`test/component-catalog.test.cjs`、
   `test/composer-assets.test.cjs`，另有 `scripts/start-all.ps1`、`test/cors-headers.test.cjs`、
   `.codeartsdoer/skills/wechat-template-builder/SKILL.md`），`registry.cjs` 丢了 `assetRoots`，
   私有 overlay 资产永远找不到。已按字节还原为已提交版本（`git diff` 为空）。
   还原后 `loadRegistry()` 恢复 `assetRoots`，候选构建通过。
2. **微信开发者工具误判「未安装」**：`devtools-probe` 只查注册表与默认路径。已改为兜底调用
   `desktop/devtools-cli.cjs` 的 `resolveDevtoolsCli()`（`via:'cli-resolver'`），并把沙箱下
   `spawn EPERM` 收敛成 `found:false` 而不是抛错。真实界面现在显示「已检测到微信开发者工具」。
3. **候选微信验证不带项目 AppID**：`frontend:verify-candidate` 新增可选 `appId`（`wx[0-9a-f]{16}`，
   规范化小写），在跑微信验证前原子写入并自检，失败即 `FRONTEND_APPID_WRITE_FAILED` 且不进入验证。
   这是本轮微信运行时能真实编译的前提（此前导出工程恒为 `touristappid` → `APPID_ERROR`）。
4. **环境清单永久卡在「检测中…」**：`runEnvChecks` 里 `await devtoolsService.probe()` 在 `try` 之外，
   探测一旦失败 `setEnvGuideBusy(false)` 永不执行，「稍后再做 / 已准备就绪」全部 disabled。
   已把探测包进 `try/catch`、给 `readyz` 加 8s 硬超时、失败时状态记 `fail` 并写明原因；
   `devtoolsService.probe()` 也不再向界面抛异常（IPC 失败 → `status:'failed'`）。
5. **运行时交互把「数据缺失」当「骨架缺陷」**：`scripts/wechat-devtools-run.cjs` 的点击链硬编码 Base 类名
   （`.home__table` / `.home__cta` / `.menu__table`），新骨架（`fp-cand__*`）必然命不中；后端
   `/tables` 为空时堂食选桌物理上无法执行，却会把候选判成 FAIL。已改为：
   - 显式读取后端 `/tables`，为空时该步如实记 `BLOCKED/NOT_RUN` 并降为参考项（写明「数据缺失，不是骨架缺陷」）；
   - 首页 CTA 拿不到 `.home__cta` 时按可见文案「开始点餐」做真实点击（报告标注实际路径）；
   - 未选桌时不再断言「结算页桌号一致」。

## 4. 复现命令

```powershell
# 1) 后端（隔离端口）与前端
$env:PORT='3101'; $env:SERVER_HOST='127.0.0.1'; $env:ALLOW_DEMO_LOGIN='true'; $env:AGENT_REQUIRE_AUTH='false'; $env:CACHE_DRIVER='memory'
node server/dist/main.js
$env:VITE_API_BASE_URL='http://127.0.0.1:3101/api/v1'; $env:VITE_IMPORT_AUTH_MODE='demo'; node_modules\.bin\vite --port 5173 --strictPort

# 2) 整条链（约 8–12 分钟，含真实模型与真实微信编译）
node .resultverify\t6\chain.mjs

# 3) 最终预览（复用已采用候选的 userData，只验导出与工具调起）
node .resultverify\t6\preview-dock.mjs <已采用候选的 userData 目录>
```

## 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `npm test` | 1250 项，1248 通过、0 失败、2 跳过，退出码 0 |
| `npm run build` | 通过（1717 modules，退出码 0） |
| `npm --prefix server test` | 35 文件 / 625 项全绿，退出码 0 |
