# AGENTS.md

给在本仓库工作的编码 agent 的入口约定。项目背景、当前进度与阅读顺序见
[`docs/项目概览.md`](docs/项目概览.md) 与 [`docs/handoff/当前工作区交接.md`](docs/handoff/当前工作区交接.md)。

## 常用命令

```powershell
npm test                # node --test test/*.test.cjs
npm run build           # vite build
npm run desktop:dev     # vite + Electron（在普通终端里用）
npm run agent:app       # 同上，但适合 agent shell（见下方环境坑）
npm run agent:smoke     # 无障碍闭环走查：工作台 → 设置页 → 返回
npm run mini:check      # 小程序镜像结构校验
npm run mirror:check    # 校验 miniprogram/ 镜像是否与真源一致（MIRROR.json 摘要）
npm run mirror:sync     # 用 templates/base/ordering-base/1.0.0/src 覆盖同步 miniprogram/
npm run frontend:capabilities:check  # 校验图片驱动重构的能力快照与 Catalog/Base 同源
npm run frontend:verify -- --attempt <attemptDir> [--runtime]  # 候选 dry-run（可选真实微信验证）
node scripts/frontend-verify.cjs --attempt <attemptDir> [--runtime]  # 同上，直接入口
```

## 图片驱动前端重构：用户私有候选链

单张参考图 → 受控 `FrontendPack` 候选 → 私有 workspace/Registry overlay → Composer dry-run 与微信验证 → 用户采用/撤销。
契约见 [`docs/frontend-reconstruct-contract.md`](docs/frontend-reconstruct-contract.md)，本地执行侧见
[`desktop/frontend-reconstruct/README.md`](desktop/frontend-reconstruct/README.md)，操作规范见
[`.codeartsdoer/skills/README.md`](.codeartsdoer/skills/README.md)。

- 模型只产出有界 JSON DSL（`frontend-pack-draft.v1`）；不产出任意 WXML/WXSS/JS/WXS/命令，
  不接受外部 URL、绝对路径或模型提供的输出目录。
- 候选只写应用私有 `<userData>/projects/<projectId>/frontend-runs/<runId>/attempts/attempt-<n>/`，
  **不写正式 `templates/**`、不改 `miniprogram/`、不重冻结全局 Registry**；正式资产入库仍走
  [`wechat-template-builder`](.codeartsdoer/skills/wechat-template-builder/SKILL.md)。
- 缺必需能力即 `rejected`；`partial`（微信验证未完成）不等于验收通过；微信工具不可用时如实标
  `BLOCKED`/`NOT_RUN`，不得用 React 预览截图冒充微信运行时截图。
- 固定验证入口只有 `npm run frontend:verify`（脚本 `scripts/frontend-verify.cjs`，退出码 0/1/2/3），
  内部只调用 `scripts/wechat-devtools-run.cjs`；不新增任意命令执行入口。
- 过程卡/报告只展示真实 trace 的工具标签、`runId`/`attempt`/状态/耗时，不展示源码、base64、
  完整 prompt 或密钥；没有真实证据时写 `BLOCKED`/`NOT_RUN`。

## 小程序目录的身份：`miniprogram/` 是只读镜像，不是交付物

- 真源唯一：`templates/base/ordering-base/1.0.0/src`。`miniprogram/` 由
  `npm run mirror:sync` 从真源复制而来，根目录 `MIRROR.json` 记录真源路径、文件数与摘要。
- 不要手改 `miniprogram/`：手改会在下次同步被覆盖，也会让 `mini:check` 的摘要校验失败。
- 交付物只能由 Composer 导出（`node scripts/composer/cli.cjs --plan ... --out ...`），
  导出目录才是可以交给微信开发者工具的成果；`miniprogram/` 目录不得当作导出成果提交或汇报。
- `assets/tabbar/*.svg`、`components/poster-carousel/*` 是仅存在于镜像里的用户资产，
  同步脚本保留不删。

## 界面调试：优先用无障碍树，不要靠截图

本项目已接入 `agent-desktop`（devDependency），它读取 Windows UI Automation 树，
元素带 `@snapshot:eN` 形式的 ref，点击/输入后必须重新快照验证。完整说明见
[`docs/agent-accessibility-debugging.md`](docs/agent-accessibility-debugging.md)。

```powershell
npm run agent:snapshot                  # role | name | ref
npm run agent:find -- 设置与自检
npm run agent:click -- "设置与自检"      # 语义点击，默认不抢焦点
npm run agent:type -- "搜索项目" "源麦甜" # 省略文本表示清空
npm run agent:verify -- "运行环境与自检"  # 文本缺失则退出码 1
```

规则：

1. 改完界面先跑 `npm run agent:smoke`；新增关键控件时补一条 `agent:verify` 断言。
2. 新增可交互控件必须有可读名称：可见文本即可，纯图标按钮必须 `aria-label`；
   关键容器给 `role` + `aria-label`；需要稳定锚点时给 `id`（会映射为 UIA `automation_id`）。
3. 同一屏避免同名按钮；同名会导致 `AMBIGUOUS_TARGET`。
4. ref 只属于当次快照：`STALE_REF` / `AMBIGUOUS_TARGET` 时重新快照，不要复用旧 ref。
5. 截图只能作为辅助证据；不得把 React 预览截图当作微信运行时截图。

## 环境坑

- **`ELECTRON_RUN_AS_NODE=1`**：从 Electron 宿主派生的 shell 会继承它，使 `electron .`
  退化为纯 Node，在 `desktop/main.cjs:17` 抛 `TypeError: Cannot read properties of undefined (reading 'getPath')`。
  用 `npm run agent:app`，或先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
- PowerShell 里传 ref 必须加单引号：`click '@s3rhd5srv3woid:e12'`。
- Chromium 首次构建无障碍树慢，快照超时用 `--timeout-ms 25000`（脚本默认已是 25000）。
- 不要用 `Set-Content -Encoding UTF8` 落盘 JSON（带 BOM），用 `agent:snapshot --out`。

## 边界

- `build.files` 不含 devDependencies，agent-desktop 只用于本机开发，不随安装包分发。
- 微信小程序页面内部仍用 `miniprogram-automator`；微信开发者工具 GUI 尚未用 agent-desktop 验证。
- 不要 `git reset --hard` / `checkout -- .` / `clean -fd`：工作区有未提交改动。
- 不要把密钥写入前端、导出工程、日志或仓库。
