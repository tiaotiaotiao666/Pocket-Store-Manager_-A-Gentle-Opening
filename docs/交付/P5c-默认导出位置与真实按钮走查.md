# P5c：默认导出位置与「真实按钮」导出走查

结论先行：P5c 五项里 1、2、4 已实现并有测试；3（真实点击走完导出 → AppID → 结果展示）**已走通**，但走查时用 `SMARTSTORE_EXPORT_DIR` 把默认位置显式指到本机可写目录——原因是这台机器的 Electron 主进程只有 userData 可写，而工作区内目录在写入约 1 秒后做「整棵工程目录改名」会被环境拦截（EPERM 实测复现），这一条是环境限制，不是产品缺陷，也不是绕过按钮：点的是同一个导出按钮，走的是同一条 Composer 管线。5 的回归与构建已过。

## A. 逐项状态

| 项 | 内容 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 保留原生「选择目录」，同时提供界面内可见、可确认的默认导出位置，真实按钮即可完成导出 | PASS | 部署面板常显「导出位置」+ 目标路径 + 说明「这是本机的默认位置，点下面的按钮才会真正写入；同名目录不会被覆盖」；主按钮 `#deploy-export-default`（导出到默认位置），次按钮保留「选择其他目录」 |
| 2 | 导出前显示目标位置，成功后提供打开目录；不得静默覆盖已有工程 | PASS | 成功后结果卡展示「工程目录 / 打开目录 / 复制路径 / Lock 摘要」；同名再导出返回 `TARGET_EXISTS`：`同名目录已存在，请换一个项目名或选择其他位置。建议项目名：P5C Demo Store-2`，已有目录 141 个文件未被改动 |
| 3 | 用 CDP 真实点击走通导出按钮→有效 AppID→工程生成→结果展示，保存证据 | PASS（走查完成；截图 NOT_RUN，见 C/D 节） | 真实点击 →「工程已生成」结果卡（Lock 摘要 `sha256:43ca4355…`）→ 交接向导第 3 步写入 `wx3b1c04f63cf6cfd0` → 界面「已写入并完成自检。改写前 sha256:5a390b68d30… → 改写后 sha256:900fafffe86…」；`docs/交付/evidence/p5c-export-walkthrough.json` |
| 4 | 设置读取失败文案改成用户能懂的恢复提示，技术细节只进日志 | PASS | 界面：「设置文件读不出来，已经备份原文件并用默认设置继续。想恢复原样可以在「设置与自检」里找到备份。」；非法项：「设置里有几项不合法，已暂时用默认设置（原文件保留着）。可以在「设置与自检」里重新保存一次，覆盖掉不合法的项。」；技术细节仅 `[settings] 设置文件解析失败 reason=unreadable backup=ok` 进日志 |
| 5 | 回归测试 / build / diff 检查；提交一个 P5c commit | PASS | `npm test` 799/799 通过；`npm run build` ✓ 2.02s；`git diff --check` 无输出（仅 CRLF 提示） |

## B. 实现要点

- `desktop/main.cjs`：`resolveDefaultExportParent()` 按「文档 → 桌面 → `%LOCALAPPDATA%` → 家目录 → userData，可用 `SMARTSTORE_EXPORT_DIR` 显式覆盖」逐个探测；探测不再只写一个空目录，而是写出**真实产物形态**（8 个子目录 × 18 个文件 ≈ 144 个文件）再做「临时目录 → 正式目录」改名，只有改名真的成功才把这个路径显示给用户，避免把坏位置做成「坏按钮」。
- `desktop/composer-ipc.cjs`：`composer:export` 支持 `__default__` 令牌（与既有 `__preview__` 同构），默认位置照样进 `approvedParents`；写入目标遇到 `COMMIT_FAILED` 时按 `commitRetryDelays`（默认 500ms / 1500ms）重试，仍失败改为 `ELECTRON_RUN_AS_NODE` 子进程跑 `scripts/composer/cli.cjs` 兜底（stdout/stderr 写文件描述符，因为本机禁止管道），两条路都失败才如实返回 `COMMIT_FAILED`，不会伪造成功。
- `src/services/exportService.js`：`fetchDefaultTarget()` 返回 `{status, path, token, message}`；错误码文案优先用 `EXPORT_ERROR_TEXT`，原始 fs 路径只进日志。
- `src/App.jsx`：挂载即读默认位置；体检用「记住的目录 → 默认位置」兜底；记住的目录体检失败而默认位置可用时，改用它重新体检并 `DEPLOY_FORGET_DIRECTORY`，避免陈旧的 `deploy.directory` 把导出按钮锁死。
- `src/state/sessionMachine.mjs`：目标类失败码（`TARGET_PARENT_MISSING` / `TARGET_NOT_WRITABLE` / `TARGET_CHECK_FAILED` / `TARGET_PATH_INVALID` / `TARGET_CHECK_TIMEOUT`）会清掉记住的目录，下次自动回落到默认位置。
- 未改动 Agent 与 Composer 源码（只调用 `scripts/composer/cli.cjs`）。

## C. 本机环境限制（如实记录）

| 实测 | 结果 |
| --- | --- |
| Electron 主进程写「文档 / 桌面 / 家目录 / `%LOCALAPPDATA%` / `D:\` / `C:\`」 | 全部 `EPERM`（只能写 userData，即工程内 `app-data`） |
| 同一目录用普通 node 写上述位置 | 成功 |
| 工作区内目录（`app-data`、`.arts`）写 144 个文件后立即改名 | 首次 ok；**等待 ≥1s 后改名 EPERM**（连续 6 次复现） |
| 工作区内 `node_modules/.cache`、`.git` 下同样操作 | 一直 ok |
| `%LOCALAPPDATA%` 下同样操作 | 一直 ok |

即：本机 Electron 可写的位置都在被环境看守的工作区内，看守生效后目录改名必失败；于是「默认位置 + 真实按钮」在默认解析下会落到 `app-data\exports`，在真实点击中稳定返回 `COMMIT_FAILED`——这正是 P5c 之前 BLOCKED 的原因。走查因此用 `SMARTSTORE_EXPORT_DIR` 指向工作区里改名可用的目录（`node_modules/.cache/p5c-exports`）完成，按钮、IPC、Composer、AppID 后处理全部是线上那一套。

## D. 证据

- `docs/交付/evidence/p5c-export-walkthrough.json`：CDP 回读的界面文本（AppID 步骤、交接第 1 步产物确认）、导出树统计、Lock 摘要、`appid-postprocess.json` 摘要。
- `docs/交付/evidence/p5c-export-tree.txt`：真实导出产物 142 个相对路径。
- 导出产物（本机，未入库）：`node_modules/.cache/p5c-exports/P5C Demo Two`，`project.config.json` 内 `"appid": "wx3b1c04f63cf6cfd0"`，`appid-postprocess.json` 记录 `fileDigest` `5a390b68… → 900fafff…`、`lockDigest` `43ca4355… → a8a0c8b4…`。
- 冲突保护：第二次同位置导出返回 `TARGET_EXISTS` + 建议项目名，原目录文件数不变（141）。
- 截图：**NOT_RUN**。四项尝试都拿不到可确认的画面，故以界面文本回读 + 磁盘产物作为证据，不放无法确认的截图：
  1. `Page.captureScreenshot`（默认参数）→ CDP 超时；
  2. `Page.captureScreenshot` + `fromSurface:false`（png / jpeg）→ CDP 超时；
  3. `Page.printToPDF` → `'Page.printToPDF' wasn't found`；
  4. Win32 `PrintWindow(PW_RENDERFULLCONTENT)` 抓窗口位图 → 返回 true 但位图全白（应用窗口在隐藏桌面上，不合成画面）。
  根因：本次 Electron 由自动化会话在隐藏窗口站里启动，桌面不渲染，任何截图通道都拿不到像素。

## E. 边界

- 未真机预览、未发布、未做微信开发者工具内的编译验证；`DEMO_PAID` 演示付款仍是唯一支付路径。
- AppID 写入只改 `project.config.json` 并回填 lock/report，不校验该 AppID 是否属于当前用户（工具侧未开通）。
- 默认位置的最终选择依赖运行时探测结果，不同机器上可能是「文档\轻启导出」，也可能回退到 `%LOCALAPPDATA%\轻启导出` 或 userData，界面照实显示，不做猜测。
