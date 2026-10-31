# F0 基线门禁复跑（P0 验收收口）

> 证据等级：L1（本机 Node 契约 / 静态测试 + Vite 生产构建）
> 执行时间：2026-10-31 21:18（本机时间）
> 执行环境：Windows，工作区根目录 `E:\智能开店app`，Node 运行时由 `node --test` 驱动
> 说明：以下全部为本轮**真实执行**结果，未引用任何历史通过结论；每条命令独立执行并单独记录退出码。

## 一、结果汇总

| 序号 | 命令 | 退出码 | 通过 / 失败 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `npm test` | 0 | 309 pass / 0 fail / 1 todo（共 310） | 存在既有 `MODULE_TYPELESS_PACKAGE_JSON` 警告，非失败 |
| 2 | `npm run build` | 0 | Vite 构建成功，1638 模块 | 产物 `dist/assets/index-DiDOyBJd.js` 386.71 kB |
| 3 | `npm run test:desktop` | 0 | 7 pass / 0 fail | 桌面契约专项 |
| 4 | `npm run mini:check` | 0 | 0 错误 / 0 警告 | 7 页 / 14 组件 / 42 JS / 24 WXSS |
| 5 | `npm run mini:dup-check` | 0 | 一致 106 文件 / 允许差异 5 / 警告 2 / 错误 0 | 迁移状态 `migrating`，允许差异不新增 |
| 6 | `npm run registry:check` | 0 | 校验通过 | 2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0） |
| 7 | `npm run check:packaging` | 0 | 校验通过 | 229 个必需文件 / 10 条 files 规则 |

七条硬门禁退出码均为 0，F0 通过，允许进入 F1。

## 二、逐条原始摘要

### 1. `npm test`

```text
ℹ tests 310
ℹ suites 0
ℹ pass 309
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 1
ℹ duration_ms 3887.7869
EXIT_CODE=0
```

- 警告（既有，非本批产生）：多个 `src/services/**/*.js` 在 `node` 下触发
  `[MODULE_TYPELESS_PACKAGE_JSON] ... Reparsing as ES module`。
  这是测试加载方式的既有告警，本批未改 `package.json`，不处理。
- todo 1 为既有用例，未计为 pass，也未删除。

### 2. `npm run build`

```text
vite v6.4.5 building for production...
✓ 1638 modules transformed.
dist/index.html                   0.60 kB │ gzip:   0.44 kB
dist/assets/index-DnjI7hAp.css   92.18 kB │ gzip:  14.28 kB
dist/assets/index-DiDOyBJd.js   386.71 kB │ gzip: 121.56 kB
✓ built in 3.40s
EXIT_CODE=0
```

### 3. `npm run test:desktop`

```text
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ todo 0
ℹ duration_ms 155.6454
EXIT_CODE=0
```

覆盖项：来源校验、不可信来源拒绝、父目录白名单、系统对话框确认后导出、超体积 payload 拒绝、
并发导出与取消、preload 白名单与进度订阅退订。

### 4. `npm run mini:check`

```text
小程序静态校验：7 个页面，14 个组件目录，42 个 JS 文件，24 个 WXSS 文件
  ✓ 标签配对、组件注册、事件处理函数、越界调用与 require 路径检查通过
静态校验通过：0 个错误，0 个警告
EXIT_CODE=0
```

### 5. `npm run mini:dup-check`

```text
双份维护门禁：source=templates/base/ordering-base/1.0.0/src · mirror=miniprogram
  一致 106 个文件，允许差异 5 个，警告 2 个，错误 0 个
  迁移状态：migrating
  ⚠ 仅 Base 存在（待同步）：domain/versionGuard.js
  ⚠ 仅镜像存在：project.private.config.json
  ✓ 镜像一致性检查通过
EXIT_CODE=0
```

- 两条警告为既有已允许差异，本批未新增 Base 差异。

### 6. `npm run registry:check`

```text
注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）
  ✓ 摘要冻结、Manifest、入口、预览、边界、晋升证据与扩展顺序均通过
EXIT_CODE=0
```

- 未执行 `--write`，未重冻结。

### 7. `npm run check:packaging`

```text
打包资源契约检查：229 个必需文件，10 条 files 规则
  ✓ 注册表、Base、Composer 运行时、desktop 与 dist 均在 files 覆盖内
  ✓ 旧复制模板脚本未进入安装包
EXIT_CODE=0
```

## 三、未执行的附加项

| 命令 | 状态 | 原因 |
| --- | --- | --- |
| `npm run mini:smoke` | NOT_RUN | 需要真实后端在 `127.0.0.1:3000` 运行，不属于 F0 七条硬门禁 |
| `npm run mini:pages` | NOT_RUN | 同上 |
| `npm run build:win` | NOT_RUN | 本批明确不执行安装包验收 |

## 四、结论

- F0 七条硬门禁本轮全部真实通过（退出码 0），无需要修复的 P0 回归。
- 本步骤未修改任何业务代码；新增文件仅本证据文档。
- 允许进入 F1（导出目标冲突预检）。