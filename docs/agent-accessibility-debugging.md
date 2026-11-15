# Agent 无障碍调试（agent-desktop）

> 日期：2026-11-12。状态：**已实现并真实跑通**本项目 Electron 窗口的 `snapshot → click → snapshot 验证` 闭环；微信开发者工具 GUI 与 MCP 通道**未验证**。

## 1. 这是什么

[`vercel-labs/agent-desktop`](https://github.com/vercel-labs/agent-desktop) 让 agent 通过操作系统的无障碍树操控桌面应用：

- Windows 走 **UI Automation**（macOS 走 AX API，Linux 走 AT-SPI）；
- `snapshot` 返回 JSON 树，每个可操作元素带 `@<snapshot_id>:eN` 形式的 ref；
- agent 按 ref 执行 `click` / `set-value` / `type`，再重新 `snapshot` 验证界面确实变化；
- 不截图、不做像素匹配；默认 **headless 语义投递**，不移动鼠标、不抢焦点（`--headed` 才物理输入）。

与既有手段的分工：

| 目标 | 工具 |
| --- | --- |
| Electron 桌面壳、设置页、工作台等 GUI | `agent-desktop`（本文） |
| 微信小程序页面内部 DOM / 路由 | `miniprogram-automator`（`npm run mini:smoke` 等） |
| 微信开发者工具的窗口级点击 | 尚未用 agent-desktop 验证，仍按 `docs/2026-11-03-全链路Agent打通-人工走查清单.md` 人工走查 |

依赖：`agent-desktop@^1.2.0` 已在 `devDependencies`。Windows 需要 10 1809+ x64/ARM64。

## 2. 项目内命令

```powershell
npm run agent:app          # 启动 vite + Electron（会清掉 ELECTRON_RUN_AS_NODE，见 §4）
npm run agent:status       # 无障碍权限、平台能力、状态目录
npm run agent:smoke        # 真实闭环走查：工作台 → 设置页 → 返回工作台
npm run agent:snapshot     # 打印交互元素树（role | name | ref）
npm run agent:find -- 设置  # 按名称搜索元素
npm run agent:click -- "设置与自检"
npm run agent:type -- "搜索项目" "源麦甜"
npm run agent:verify -- "我的项目" "新建项目：创建空白门店项目"
```

底层是 `scripts/agent-debug.cjs`（可 `require` 复用）与 `scripts/agent-smoke.cjs`。
二进制走 `node node_modules/agent-desktop/bin/agent-desktop`，不经过 shell，因此中文参数与 `@ref` 不需要额外转义。

退出码约定：`0` 成功；`1` 断言/用法失败；`2` 环境问题（未安装、找不到窗口、权限不可用）。

## 3. 一次真实闭环（2026-11-12 实测）

启动后窗口：`electron.exe | 智能开店 · 独立小程序生成器 | w-1576746`（UIA 可读，`accessible=true`）。
另用 `npm run agent:app` 从零启动过一次（窗口 `w-3607466`），随后 `npm run agent:smoke` 再次 PASS；
`agent:status` / `agent:snapshot` / `agent:find` / `agent:click` / `agent:type` / `agent:verify` 六个 npm 包装命令也已逐一验证，退出码均为 0。

1. 初始 `snapshot`：`refs=38`，可见 `group[region] 项目工作台`、`statictext 我的项目`（`native_id=automation_id:workbench-title`）、`button 新建项目：创建空白门店项目`、`textfield 搜索项目`、`button 打开项目：源麦甜`、`button 项目操作`。
2. `click "设置与自检"`：返回 `steps[0]=InvokePattern.Invoke:succeeded`、`disposition.delivery=delivered_unverified`（语义点击已投递，但客户端无法证明业务效果，必须复查）。
3. 复查 `snapshot`：`refs=105`，出现 `静态文本 运行环境与自检`、`button 返回项目`、`button 重新自检`、`button 复制诊断 JSON`、`button 保存快照`、`textfield 后端接口地址 默认 http://127.0.0.1:3000/api/v1` 等。
4. `click "返回项目"` → `refs=38`，重新出现 `我的项目` / `新建项目：创建空白门店项目`。

`npm run agent:smoke` 的实测输出（同一次运行）：

```text
[1/6] agent-desktop 1.2.0 | 平台 windows | 无障碍权限 granted
[2/6] 窗口 w-1576746 | electron.exe | 智能开店 · 独立小程序生成器 | accessible=true
[3/6] 初始快照 s3vrlr78zq4wzz | refs=38 | 341ms
  ✓ 项目工作台：我的项目、新建项目：创建空白门店项目、搜索项目
  · 项目卡片：打开项目：源麦甜
[4/6] 点击「设置与自检」→ @s3rhd5srv3woid:e12（语义 Click 已投递）
[5/6] 复查设置页 s2rzpo4dsbp8kx | refs=105 | 1590ms
  ✓ 设置页：运行环境与自检、返回项目、重新自检、保存设置
  ✓ 返回后的项目工作台：我的项目、新建项目：创建空白门店项目、搜索项目
[6/6] 最终快照 s1hdotymct9z9j | refs=38 | 923ms
PASS 无障碍调试闭环通过：snapshot → click → snapshot 验证 → 返回
```

文本输入同样验证过：`agent-debug.cjs type "搜索项目" "源麦甜"` 返回 `ValuePattern.SetValue:succeeded`、`delivered_verified`；省略文本即清空。

## 4. refs 生命周期与已知坑

- **ref 只属于生成它的 snapshot**。界面变化后旧 ref 会报 `STALE_REF`；同一次 snapshot 里名称重复会报 `AMBIGUOUS_TARGET`。两种情况都先重新 `snapshot`，或用更完整的名称。
- **PowerShell 中 `@ref` 必须加单引号**：`click '@s3rhd5srv3woid:e12'`。裸写 `@s...` 会被当成 splatting。
- **Chromium 首次构建无障碍树较慢**：默认 `--timeout-ms 3000` 会 `TIMEOUT`；本项目默认 25000（`AGENT_DESKTOP_TIMEOUT_MS` 可覆盖）。
- **`ELECTRON_RUN_AS_NODE=1` 是致命坑**：从 Electron 宿主（如 DeepSeek Harness）派生的 shell 会继承该变量，`electron .` 退化为纯 Node，`desktop/main.cjs:17` 的 `app.getPath('userData')` 直接抛
  `TypeError: Cannot read properties of undefined (reading 'getPath')`。`npm run agent:app` 会在子进程环境里删除该变量；手工启动前可执行 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
- **npm 未执行包的 postinstall**：`bin/agent-desktop` 是 Node 启动器，每次多约 125ms。可选优化：`npm install-scripts approve agent-desktop` 后 `npm rebuild agent-desktop`（本项目未做，不影响功能）。
- **没有 `--json` 参数**：CLI 默认输出 JSON envelope（`ok/command/data/error`），传 `--json` 会 `INVALID_ARGS`。
- **不要用 PowerShell `Set-Content -Encoding UTF8` 落盘 JSON**：Windows PowerShell 会写 BOM，`JSON.parse` 报 `Unexpected token '﻿'`。用 `agent:snapshot --out` 或 `utf8NoBOM`。

## 5. 给 UI 补可访问名称的约定

agent 能“看见”的前提是控件有无障碍名称。新增或改动界面时：

1. 所有可交互控件必须有**人类可读名称**：可见文本即可；纯图标按钮必须给 `aria-label`。
2. 关键容器给 `role` + `aria-label`（如 `role="region" aria-label="项目工作台"`、`role="navigation" aria-label="主导航"`）。
3. 列表/会话项用 `aria-current` 表达选中态。
4. 名称要**唯一且稳定**，避免同名按钮（同屏重复会导致 `AMBIGUOUS_TARGET`）；需要测试锚点时给 `id`（会映射为 UIA `automation_id`，如 `workbench-title`）。
5. 改完跑 `npm run agent:smoke`，必要时加一条 `agent:verify` 断言。

2026-11-12 已补齐的 4 个文件：

| 文件 | 改动 |
| --- | --- |
| `src/components/layout/Sidebar.jsx` | 导航 `role/aria-label`；按钮 `我的项目：打开工作台` / `设置与自检：打开设置面板` / `轻启：开始开店流程` / `待命名项目：开始命名` / `重置项目：清空当前会话`；会话项 `会话：<标题>` + `aria-current` |
| `src/components/chat/Composer.jsx` | 输入区 `role="group" aria-label="消息输入区"`；textarea 与发送按钮补 `aria-label` |
| `src/components/workbench/ProjectWorkbench.jsx` | 根节点 `role="region" aria-label="项目工作台"`；`h1 id="workbench-title"`；新建按钮 `aria-label="新建项目：创建空白门店项目"` |
| `src/components/workbench/ProjectCard.jsx` | 卡片主按钮 `aria-label="打开项目：<项目名>"` |

## 6. MCP 通道（未验证）

`agent-desktop mcp` 以 stdio 暴露全部命令为 MCP 工具（`desktop_snapshot`、`desktop_click` 等），可供支持 MCP 的客户端直接接入。**本项目尚未配置或验证 MCP 客户端**；当前交付以 npm scripts + 脚本库为准。

## 7. 未验证项与边界

- 微信开发者工具窗口的 agent-desktop 走查（窗口存在且 `accessible=true`，但未实际点击编译/预览）。
- 打包后的安装包：`build.files` 不含 `devDependencies`，agent-desktop **不会**随安装包分发，仅用于本机开发调试。
- macOS / Linux 分支、CI 环境（需要真实登录的桌面会话，UIA 不可在无头 CI 运行）。
- `agent-desktop` 的 `screenshot` 命令存在，但本项目刻意不使用像素截图做断言。

## 8. 排查表

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `WINDOW_NOT_FOUND`，只有 Harness/其他窗口 | 应用没起，或 `electron .` 因 `ELECTRON_RUN_AS_NODE` 崩了 | `npm run agent:app`，确认窗口标题含「智能开店」 |
| `TIMEOUT`（`elapsed_ms≈3052`） | Chromium 无障碍树首次构建慢 | `--timeout-ms 25000`；或 `AGENT_DESKTOP_TIMEOUT_MS=30000` |
| `STALE_REF` | 用了旧 snapshot 的 ref | 重新 `snapshot` 再操作 |
| `AMBIGUOUS_TARGET` | 同名元素多个 | 用更完整名称，或直接传 `@snapshot:eN` |
| `TARGET_NOT_FOUND` | 元素无名称/不可交互 | `agent:snapshot --all` 看完整树；给控件补 `aria-label` |
| `INVALID_ARGS` | 传了 `--json` 之类不存在的参数 | 去掉；CLI 默认输出 JSON |
| `app.getPath` 未定义 | `ELECTRON_RUN_AS_NODE=1` 继承 | 用 `npm run agent:app` |
| `Unexpected token '﻿'` | JSON 文件带 BOM | 用 `--out` 或 `utf8NoBOM` |
