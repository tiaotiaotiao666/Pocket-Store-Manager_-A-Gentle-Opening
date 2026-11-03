# 全量验证矩阵

日期：2026-10-31 · 最后更新：2026-11-03（M7 微信编译与晋升 direct）

> 每行必须是真实执行结果；未执行写“未执行 + 原因”，禁止只写“已测试”。

## 1. 验收轮已验证（2026-10-31 真实执行）

### 根目录（L1）

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `npm test` | **246 项：pass 245 / fail 0 / todo 1** | 验收前为 pass 218 / fail 27，修复后全绿 |
| `npm run test:desktop` | pass 7 / fail 0 | BUG-009 恢复可执行 |
| `npm run mini:check` | 0 错误 / 0 警告 | 7 页面 / 13 组件 |
| `npm run mini:dup-check` | 镜像一致性通过 | 迁移状态 `migrating`；`domain/versionGuard.js` 仅 Base 有（待同步）、`project.private.config.json` 仅镜像有（允许） |
| `node scripts/registry-check.cjs` | 通过 | **base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）**（2026-10-31 快照；2026-11-03 已为 `direct 2`） |
| `node scripts/check-packaging.cjs` | 通过 | 224 必需文件 / 10 条 files 规则 / 旧复制脚本未入包 |
| `npm run build` | 通过 | Vite 构建 2.48s，M6/M7 前端接线后已复验 |

### Composer 双工程生成（L1）

| 命令 | 结果 |
| --- | --- |
| CLI `order-classic` 生成（`C:\Users\leiji\AppData\Local\Temp\m5acc\classic`） | 成功，120 文件；产物树 `sha256:2ac808cd…`，Lock `sha256:8af0d642…` |
| CLI `order-poster` 生成（同目录 `poster`） | 成功，124 文件；产物树 `sha256:4d8ec74f…`，Lock `sha256:dad8a266…` |
| `validate-miniprogram.cjs --root <classic>` | 0 错误 / 0 警告 |
| `validate-miniprogram.cjs --root <poster>` | 0 错误 / 0 警告 |
| poster 首页插槽替换断言 | `home-hero` 已替换为 `<poster-carousel>`；`usingComponents` 含 `poster-carousel`；`slots.generated.js` 的 `homeHero` 为 1 项分配、携带 3 张海报 items，与 Plan 一致 |

### 服务端（L1）

| 命令 | 结果 |
| --- | --- |
| `cd server && npm test` | **164 / 164**（12 个测试文件全过，含 b3-import-diff / b3-imports / b3-tables 修复后回归） |

## 2. 验收轮发现并已修复的问题

| 问题 | 性质 | 修复 |
| --- | --- | --- |
| 注册表未登记 M7 资产且 Base 摘要漂移 | 收尾未完成 | 登记 6 条新资产（3 UI Block + 1 Feature Pack + 2 Recipe）并 `--write` 冻结；此后所有内容变更均重新冻结 |
| `product-card` 事件名 `open-detail` 不符合 Schema camelCase 约定 | 资产违反已冻结契约 | 改为 `openDetail`：资产 manifest/实现、Base 组件与 menu 页绑定、miniprogram 镜像、`miniprogram-components` 测试、三处文档同步 |
| `poster-carousel` 样式 `@import "../../../styles/component.wxss"` 越出产物根 | 资产路径错误 | 改为 `../../styles/component.wxss`（与 UI Block 一致），order-poster 产物静态校验通过 |
| Base `merchant-orders` 页面使用 `priceText` 展示字段 | 违反金额唯一事实契约 | 改名 `amountText`（Base 与镜像 js/wxml 共 4 文件）；`priceText` 仍只允许桌面端本地编辑态 |
| production 导出先报 `VERSION_GAP_REQUIRED` 再报 URL 非法 | 校验顺序不合理 | `emit.cjs` 调整为先 `validateStoreConfig`（URL/HTTPS）再要求后端版本号 |
| `importService` 演示登录被关闭时透传后端原文，缺少小程序端引导 | 实现缺陷 | `ensureToken` 与 preview/apply 的 `DEMO_LOGIN_DISABLED` 分支统一使用本地文案「请在微信小程序端完成配置导入」 |
| `import-service` apply 测试未重置模块级 Token 缓存 | 测试隔离缺失 | 测试开头补 `resetImportSession()` |
| `b3-import-diff` 价格冲突用例漏传 `profile.address/phone` 确认键 | 测试断言错误（实现行为正确） | 补全 4 键全确认通过，并保留「部分确认仍拒绝」断言 |
| `store-config-v2` 两处 `deepStrictEqual` 比较跨 vm realm 对象 | 测试写法问题 | `readConfig` 统一 JSON 规范化到当前 realm |
| `store-config-v2` 金额扫描对所有文件禁 `totalCents`，误伤领域层合计 | 测试范围过宽 | `totalCents` 禁止仅限 `config/store.generated.js`；`priceText`/密钥/`AppSecret` 仍全文件扫描 |
| 中文工作区大目录 rename EPERM | 见 §3，环境问题 | `commitStaging` 增加 EPERM/EBUSY/EACCES 退避重试（6 次，100–600ms），作为 Windows 桌面常规健壮性增强保留 |

## 3. 未验证 / 环境受限

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 微信开发者工具编译（W） | **已执行（2026-11-03）** | 5 份工程 `cli auto` 均成功（`order-classic`/`order-poster`/`poster-solo`/`classic-noblock`/候选），截图见 `m7/wechat/`；详见 `m7/s6.md` |
| `npm run desktop` 点击导出（L2） | 未执行 | 代码与契约测试完成，无人工点击证据 |
| `npm run build:win`（L3） | 未执行 | electron-builder 缓存为空，强制打包会失败 |
| 干净机安装（L4） | 未执行 | 无验收机；`M5-7-02` 保持未勾选 |
| 真机走查（R） | 未执行 | 无真机 |
| 工作区中文路径导出 | **本机环境受限** | 验收时 `E:\智能开店app` 下新建多文件目录 rename 持续 EPERM（小目录可改名；150 文件对照实验同样失败，重试 6 次无效）；同一代码在 `E:\tmp-m5` 与 C 盘临时目录大目录 rename 均成功。判定为本机对该目录的实时扫描/锁定，非 Composer 缺陷；M5 实施轮曾在中文路径成功，说明环境状态有变化 |

## 4. 结论

- M5 的 L1 门禁通过；M6 前后端测试全绿（根 245 pass + 服务端 164 pass）；M7 资产已冻结并完成双工程 L1 生成与静态校验。
- 2026-11-03 更新：微信编译（W）已执行，`registry:check` 实测 `direct 2`；根目录全量 623 项 623 pass / 0 fail / 0 todo。
- 仍未执行：L2 点击导出、L3/L4 安装包、真机 R、海报视觉人工目视。
- 可表述为「M5–M7 代码与 L1 + W 验收完成」；不得表述为「可发布 / 可直接上架」。