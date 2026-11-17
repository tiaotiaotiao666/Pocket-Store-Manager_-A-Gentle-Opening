# 基线失败判定（catalog 4 项漂移 / MIRROR 摘要不一致）

> 结论：两处失败均为 **pre-existing 基线问题**，不是 P0–P7 引入；本轮**没有**用
> `component-catalog --write`、`mirror:sync`、`registry-check --write` 或任何"重新冻结"手段掩盖。
> 执行时间 2026-11-17 02:52–03:00（+08:00）。

## 0. 共同前提：相关输入与 HEAD 完全一致

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 基线提交 | `git rev-parse HEAD` | `e2eb16ac2ce81f1975d8dccfc1a3c36ebda2d126` |
| 模板/镜像无改动 | `git diff --quiet -- templates miniprogram` | exit 0 |
| 模板/镜像无未跟踪候选资产 | `git status --porcelain -- templates miniprogram` | 空 |
| 生成器脚本未改 | `git status --porcelain -- scripts/component-catalog.cjs scripts/validate-miniprogram.cjs scripts/sync-miniprogram-mirror.cjs` | 空（三者均未出现在 `git status`） |
| 候选未写入全局资产 | `templates/frontend-packs` 仅有 `warm-home-menu`；`fr-5038d20dde55` 不存在 | 候选只在应用私有目录（本机 `%TEMP%`），见 `real-probe.md` |

即：`templates/catalog`、`miniprogram/`、对应生成器与清单内容都等于 HEAD；在 HEAD 字节上重跑同一
确定性检查会得到同样失败 → 判定为**基线既有**，与本次 P0–P7 改动无关（本功能唯一新增的
`scripts/frontend-capabilities.cjs` 只读取 Catalog/Base/页面，不写这些目录）。

## 1. `catalog:check`（4 项 product-detail 漂移）

```text
$ node scripts/component-catalog.cjs --check        # = npm run catalog:check（等价命令）
组件目录校验失败：4 项
  ✗ 内容漂移：sections/ordering-base@1.0.0/product-detail/product-body.json（运行 --write 重新生成）
  ✗ 内容漂移：sections/ordering-base@1.0.0/product-detail/product-cart-bar.json
  ✗ 内容漂移：sections/ordering-base@1.0.0/product-detail/product-cart-panel.json
  ✗ 内容漂移：sections/ordering-base@1.0.0/product-detail/product-hero.json
exit=1
```

- 对照：`test/component-catalog.test.cjs` 的 `组件目录必须与源码同源：--check 退出码为 0` 在 captain
  的 `npm test` 中同样失败（root `npm test` 的 2 个失败之一）。
- **未执行** `catalog:write`（会改写 `templates/catalog/**`，属 P0–P7 之外且会掩盖基线）；
  需要修复时应在独立任务里重生成并 review 差异后提交。

## 2. `mini:check` / `mirror:check`（镜像摘要不一致）

```text
$ node scripts/validate-miniprogram.cjs             # = npm run mini:check（等价命令）
小程序静态校验：8 个页面，15 个组件目录，55 个 JS 文件，26 个 WXSS 文件
  ✗ 镜像身份校验失败：镜像内容与清单摘要不一致（镜像已陈旧），请重新运行 node scripts/sync-miniprogram-mirror.cjs
exit=1

$ node scripts/sync-miniprogram-mirror.cjs --check  # = npm run mirror:check（等价命令）
镜像清单校验失败：镜像内容与清单摘要不一致（镜像已陈旧）
exit=1
```

用同一实现 `computeMirrorDigest()` 只读复算（未写盘）：

| 口径 | 摘要 | 文件数 |
| --- | --- | ---: |
| 工作区镜像现算（含 gitignored 的 DevTools 产物） | `b6c62d4ebcd38468d7850ada65cf5d7f8ae80c700ba03ebb45eb1fc49c0af082` | 150 |
| `miniprogram/MIRROR.json`（HEAD） | `30a411f3d34424e46fcf81848294a46fdd4a9373b1c40b0d9690c4da0f55ae13` | 149 |

根因（两条叠加，均与 HEAD 字节相关）：

1. `git config core.autocrlf=true`：工作区镜像为 CRLF，而清单按 LF 逐字节计算摘要；
   实测 `miniprogram/app.js` 有 8 处 CRLF、`pages/home/index.wxml` 有 114 处 CRLF。
2. `miniprogram/project.private.config.json`（微信开发者工具产物，gitignored，632B，2026-10-31）
   使实际文件数 149 → 150。

- 对照：`test/w5d-table-source.test.cjs` 的 `miniprogram/ 是受控镜像…摘要与内容一致` 在 captain 的
  `npm test` 中同样失败（root `npm test` 的另一个失败）。
- **未执行** `mirror:sync` / 任何强制改写，也没有删除/还原该 gitignored 文件。
- 修复需要仓库级决定（例如统一 `.gitattributes` + 在目标换行语义下重算并提交 `MIRROR.json`，或清理
  DevTools 本地产物后重同步）；属 P7 验证范围之外，交 captain 决策。

## 3. server `npm test` 的 6 个失败文件（环境）

captain 日志 `.tmp/captain-gates/server-npm-test.log`：`Test Files 6 failed | 24 passed (30)`、
`Tests 460 passed | 85 skipped (545)`。失败堆栈均为
`test/helpers/b1-fixtures.ts:prepareDatabase → ensureDatabaseExists → admin.$executeRawUnsafe(CREATE DATABASE …)`，
即本机没有可用 MySQL；与 `frontend-reconstruct` 无关。verifier 定向的 5 个 server 文件
（contract/service/runtime/capabilities/capabilities-script）**155/155 全绿**。

## 4. 本轮明确未执行的"掩盖型"命令

`npm run catalog:write`、`npm run mirror:sync`、`node scripts/registry-check.cjs --write`、
`node scripts/frontend-capabilities.cjs`（无 `--check` 的写快照模式）均未执行。
