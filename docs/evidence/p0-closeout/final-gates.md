# F3 两项改动后的全量回归门禁

> 证据等级：L1（本机 Node 契约 / 静态测试 + Vite 生产构建）
> 执行时间：2026-10-31 21:26（本机时间）
> 执行环境：Windows，工作区根目录 `E:\智能开店app`
> 前提：F1（导出目标冲突预检）与 F2（工作台真实缩略图）已完成
> 说明：以下全部为本轮**真实执行**结果，未引用 F0 或任何历史通过结论。

## 一、结果汇总

| 序号 | 命令 | 退出码 | 通过 / 失败 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `npm test` | 0 | 330 pass / 0 fail / 1 todo（共 331） | 较 F0 的 310 项新增 21 项（F1 8 + F2 10 + 关联 3） |
| 2 | `npm run build` | 0 | Vite 构建成功，1639 模块 | 产物 `dist/assets/index-BApUZFh9.js` 392.36 kB |
| 3 | `npm run test:desktop` | 0 | 12 pass / 0 fail | 较 F0 的 7 项新增 5 项目标预检契约 |
| 4 | `npm run mini:check` | 0 | 0 错误 / 0 警告 | 7 页 / 14 组件 / 42 JS / 24 WXSS |
| 5 | `npm run mini:dup-check` | 0 | 一致 106 文件 / 允许差异 5 / 警告 2 / 错误 0 | 与 F0 完全一致，未新增 Base 差异 |
| 6 | `npm run registry:check` | 0 | 校验通过 | 2026.11.0，未执行 `--write` |
| 7 | `npm run check:packaging` | 0 | 校验通过 | 229 个必需文件 / 10 条 files 规则 |

七条硬门禁退出码均为 0，F3 通过。

## 二、逐条原始摘要

### 1. `npm test`

```text
ℹ tests 331
ℹ suites 0
ℹ pass 330
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 1
ℹ duration_ms 3771.5596
EXIT_CODE=0
```

- 新增覆盖：目标预检只读与清洗、服务层状态映射、规则合并去重、两种门禁区分、缩略图并发/缓存/LRU/clear。
- 既有 `MODULE_TYPELESS_PACKAGE_JSON` 警告仍在，属加载方式告警，非失败；本批未改 `package.json`。
- todo 1 为既有用例，未计为 pass，未删除。

### 2. `npm run build`

```text
vite v6.4.5 building for production...
✓ 1639 modules transformed.
dist/index.html                   0.60 kB │ gzip:   0.44 kB
dist/assets/index-DnjI7hAp.css   92.18 kB │ gzip:  14.28 kB
dist/assets/index-BApUZFh9.js   392.36 kB │ gzip: 123.22 kB
✓ built in 3.19s
EXIT_CODE=0
```

### 3. `npm run test:desktop`

```text
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ todo 0
ℹ duration_ms 149.6491
EXIT_CODE=0
```

新增覆盖：`composer:preflight-target` 只读、同名目录不变、名称清洗与越界防护、父目录缺失、不可信来源、preload 白名单方法。

### 4. `npm run mini:check`

```text
小程序静态校验：7 个页面，14 个组件目录，42 个 JS 文件，24 个 WXSS 文件
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

### 6. `npm run registry:check`

```text
注册表校验通过：2026.11.0 · base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）
EXIT_CODE=0
```

- 未执行 `--write`，未重冻结，无 drift。

### 7. `npm run check:packaging`

```text
打包资源契约检查：229 个必需文件，10 条 files 规则
  ✓ 注册表、Base、Composer 运行时、desktop 与 dist 均在 files 覆盖内
  ✓ 旧复制模板脚本未进入安装包
EXIT_CODE=0
```

## 三、与 F0 的差异

| 指标 | F0 | F3 | 变化 |
| --- | --- | --- | --- |
| `npm test` 总数 | 310 | 331 | +21 |
| `npm test` pass | 309 | 330 | +21 |
| `npm test` fail | 0 | 0 | 0 |
| `test:desktop` 总数 | 7 | 12 | +5 |
| build 模块数 | 1638 | 1639 | +1 |
| mini:check | 0/0 | 0/0 | 无变化 |
| mini:dup-check | 0 错误 | 0 错误 | 无变化 |
| registry:check | 通过 | 通过 | 无变化 |
| check:packaging | 229 文件 | 229 文件 | 无变化 |

## 四、未执行的附加项

| 命令 | 状态 | 原因 |
| --- | --- | --- |
| `npm run mini:smoke` | NOT_RUN | 需要真实后端在 `127.0.0.1:3000` 运行，不属于 F3 七条硬门禁 |
| `npm run mini:pages` | NOT_RUN | 同上 |
| `npm run build:win` | NOT_RUN | 本批明确不执行安装包验收 |

## 五、结论

- F3 七条硬门禁本轮全部真实通过（退出码 0），F1/F2 改动未引入 P0 回归。
- 本步骤只新增本证据文档，未修改业务代码。
- 主进程与 preload 已改动，后续 F4 桌面走查必须**完整关闭并重启桌面应用**，不能只依赖渲染层热更新。
- 允许进入 F4（桌面与浏览器人工走查，M1–M9、M13）。人工走查未执行前不得宣称“验收收口”。
## 六、F4 缺陷修复后的补充复跑（BUG-013）

> 执行时间：2026-10-31 21:35（本机时间）
> 背景：F4 人工走查发现新建项目后设置页永久停在“正在读取应用设置…”，根因为 `PROJECT_NEW_SUCCESS` 重置 settings 切片，详见 `docs/bugs/fixed/BUG-013-settings-slice-cleared-on-new-project.md`。

| 序号 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `npm test` | 0 | 332 项：331 pass / 0 fail / 1 todo（新增设置保留回归测试） |
| 2 | `npm run build` | 0 | 1639 模块，`index-4nuHmg8Q.js` 392.83 kB |
| 3 | `npm run test:desktop` | 0 | 12 pass / 0 fail |
| 4 | `npm run mini:check` | 0 | 0 错误 / 0 警告 |
| 5 | `npm run mini:dup-check` | 0 | 0 错误，允许差异 5、警告 2，与 F3 一致 |
| 6 | `npm run registry:check` | 0 | 2026.11.0 通过，未 `--write` |
| 7 | `npm run check:packaging` | 0 | 229 文件 / 10 条规则 |

七条复跑仍然全部退出码 0。BUG-013 修复未引入回归；该缺陷的用户界面复验仍需在设置页实际点击确认。
## 七、项目图片入口补充复跑

> 执行时间：2026-10-31 21:47（本机时间）
> 背景：F4 发现工作台缩略图缺少图片来源入口。按用户确认补最小入口：店铺装修页 `pickImages(6)` → `attachImages(projectId, tokens)` → `ADD_PROJECT_IMAGES` 写入 `assets.images` 并随自动保存落盘。

| 序号 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `npm test` | 0 | 333 项：332 pass / 0 fail / 1 todo（新增 `ADD_PROJECT_IMAGES` 回归测试） |
| 2 | `npm run build` | 0 | 1639 模块，`index-B_NDpn37.js` 396.23 kB |
| 3 | `npm run test:desktop` | 0 | 12 pass / 0 fail |
| 4 | `npm run mini:check` | 0 | 0 错误 / 0 警告 |
| 5 | `npm run mini:dup-check` | 0 | 0 错误，与 F3 一致 |
| 6 | `npm run registry:check` | 0 | 2026.11.0 通过，未 `--write` |
| 7 | `npm run check:packaging` | 0 | 229 文件 / 10 条规则 |

图片入口的界面验证仍未执行：需要在店铺信息页实际添加图片，确认工作台出现真实缩略图、删除资产文件后回退首字。自动化只覆盖 reducer 合并去重与 6 张上限，不覆盖 Electron 文件对话框。