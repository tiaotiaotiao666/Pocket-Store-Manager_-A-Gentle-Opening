# M5–M7 构建说明（面向下一位 AI / 开发者）

日期：2026-10-31（验收轮更新）
状态：**M5–M7 代码与 L1 自动化验收已闭环；微信编译、点击导出、安装包等 W/L2/L3/L4 证据仍未执行。**

> 阅读顺序：本文件 → `docs/evidence/s7-checklist.md` → `docs/M5-M7-本地Composer与模板资产扩展-实现方案.md` → 需求规格 → 编码任务清单。

---

## 0. 一句话现状

- **M5**：Composer（契约 → 解析 → Lock → 确定性生成 → 产物校验 → 原子提交）、Base 提炼、桌面 IPC/服务层、打包资源断言全部落地并通过验收。
- **M6**：后端受控导入与桌面导入服务/UI 落地；服务端 164 项测试、根目录 246 项测试（245 pass / 1 todo）全绿。
- **M7**：1 Base + 3 UI Block + 1 Feature Pack + 3 Recipe 已全部登记并冻结（`base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）`）；`order-classic` 与 `order-poster` 双工程 CLI 生成成功、静态校验 0 错 0 警，poster 插槽替换断言通过。
- **验收轮修复 11 类问题**（事件名契约、样式导入越界、`priceText` 违规、校验顺序、导入文案、5 处测试断言等），明细见 `docs/evidence/s7-checklist.md` §2。

---

## 1. 目录结构（本轮新增/改动）

```text
scripts/
  registry-check.cjs              # 注册表门禁；--write 重新冻结
  check-packaging.cjs             # electron-builder files 覆盖断言
  mini-dup-check.cjs              # Base 与 miniprogram 双份一致性
  validate-miniprogram.cjs        # 已参数化：--root / runChecks(root)
  composer/
    version.cjs digest.cjs schema.cjs safety.cjs
    registry.cjs manifest-impl-check.cjs
    resolve.cjs lock.cjs emit.cjs verify.cjs atomic.cjs report.cjs
    index.cjs cli.cjs verify-cli.cjs
templates/
  registry/                       # registry.v1.json / lock / schema / fixtures / 迁移与顺序
  base/ordering-base/1.0.0/       # 唯一 Base（src + manifest + slots + theme）
  components/{store-header,product-card,cart-bar}/1.0.0/
  features/poster-carousel/1.0.0/
  recipes/{order-classic,order-poster,order-classic-candidate}/
desktop/
  composer-ipc.cjs                # composer:* handlers（可单测）
  main.cjs preload.cjs            # 已接入；删除旧 generator:export 与旧脚本 require
src/
  composition/{planFromSession.mjs,themePresets.mjs}
  services/{exportService.js,importService.js}
  components/build/{DeployStep.jsx,ExportResultCard.jsx,ImportDiffCard.jsx}
  state/{constants.mjs,sessionMachine.mjs}  # DEPLOY/IMPORT 状态与 action
  App.jsx                         # 删除假进度；真实导出 + 导入区块
server/
  prisma/schema.prisma            # category/configVersion + StoreImport
  prisma/migrations/20261101090000_add_imports_and_config_version/
  src/imports/                    # diff/canonical/dto/service/controller/module
  src/common/auth/store-owner.guard.ts
  src/stores/{stores.service,stores.controller}.ts  # 版本字段 + tables
```

---

## 2. 五类契约与生成口径

| 契约 | 文件 | 要点 |
| --- | --- | --- |
| `base.manifest.v1` | `templates/base/.../manifest.json` | 7 页、7 Token、3 插槽、`excludedCapabilities` 三项 |
| `manifest.v1` | 各资产 `manifest.json` | props/events 必须与实现双向一致；UI Block boundary 四项 false |
| `slots.v1` | `templates/base/.../slots.json` | 锚点三段式：`@slot` / `@slot-fallback` / `@slot-fallback:end` / `@slot:end` |
| `composition.v1` | Plan | 只允许白名单字段、精确版本；插槽分配来自 `features[].slots[]`（可带 `pageId`） |
| `lock.v1` | 生成产物 `composition.lock.json` | 14 必填项；`lockDigest` 排除 `generatedAt` |

确定性：
- canonical JSON（键排序、无空格、LF），只允许整数；
- 产物 `store.generated.js` 的 `meta.generatedAt` 固定 `1970-01-01T00:00:00Z`；
- `generation-report.json` / `生成报告.md` / `composition.lock.json` 不参与 `outputDigest.tree`；
- 两次生成逐文件 `sha256` 一致，由 `test/composer-determinism.test.cjs` 断言。

---

## 3. 关键命令与真实结果

### 3.1 已验证（2026-10-31 验收轮真实执行）

```text
npm test                       → 246 项，245 pass / 0 fail / 1 todo
npm run test:desktop           → 7 / 7
npm run mini:check             → 0 错 0 警
npm run mini:dup-check         → 镜像一致性通过（status=migrating）
node scripts/registry-check.cjs → base 1 / ui-block 3 / feature-pack 1 / recipe 3（direct 0）
node scripts/check-packaging.cjs → 224 必需文件，0 缺失
npm run build                  → Vite 构建成功（含 M6/M7 前端接线）
cd server && npm test          → 164 / 164（B3 修复后回归通过）
```

双工程生成（输出到 `C:\Users\leiji\AppData\Local\Temp\m5acc`）：

```text
order-classic → 120 文件，静态校验 0 错 0 警
order-poster  → 124 文件，静态校验 0 错 0 警；
                首页 home-hero 替换为 <poster-carousel>，
                usingComponents 含 poster-carousel，
                slots.generated.js 的 homeHero = 1 项分配 / 3 张海报 items
```

注意：CLI `--out` 语义是**父目录**，工程名用 `--project-name` 指定：
`node scripts/composer/cli.cjs --plan <plan.json> --out <父目录> --project-name <名称>`。

### 3.2 未验证（仍需人工/环境）

```text
微信开发者工具导入编译（W）      # CLI 端口关闭，需人工 GUI
npm run desktop 点击导出（L2）   # 无人工点击证据
npm run build:win（L3）          # electron-builder 缓存为空
干净机安装（L4）/ 真机（R）      # 无验收机与真机
```

环境受限（非代码缺陷）：验收时 `E:\智能开店app` 工作区内新建多文件目录 rename 持续 EPERM（对照实验证实该目录被本机环境锁定；`E:\tmp-m5` 与 C 盘临时目录正常）。**生成验收请输出到工作区外目录**。`commitStaging` 已加 EPERM/EBUSY/EACCES 退避重试作为常规增强。

---

## 4. 错误码速查

Composer：
`REGISTRY_DRIFT`、`ASSET_NOT_REGISTERED`、`ASSET_VERSION_NOT_FOUND`、`DEPENDENCY_MISSING`、`DEPENDENCY_CYCLE`、`ASSET_CONFLICT`、`VERSION_CONFLICT`、`SLOT_UNKNOWN`、`SLOT_TYPE_REJECTED`、`SLOT_CAPACITY_EXCEEDED`、`SLOT_DUPLICATED`、`SLOT_REQUIRED_MISSING`、`PROP_TYPE_MISMATCH`、`THEME_CONTRAST_LOW`、`PREVIEW_ONLY_*`、`TARGET_EXISTS`、`TARGET_NOT_WRITABLE`、`PATH_TOO_LONG`、`EXPORT_CANCELLED`、`REPRODUCIBILITY_FAILED`。

导入：
`STORE_NOT_FOUND`、`FORBIDDEN`、`IDEMPOTENCY_CONFLICT`、`CONFIRMATION_REQUIRED`、`PREVIEW_STALE`、`DELIVERY_NOT_SUPPORTED`、`DUPLICATE_CATEGORY/PRODUCT/TABLE`、`PRICE_RANGE`、`HOURS_*`、`IMPORT_NOT_FOUND`。

---

## 5. 已知限制与红线

1. **没有 direct Recipe**：微信编译/回归/审核未产生，三份 Recipe 全部 candidate，不得进入店主可选列表。
2. **微信编译、真机、NSIS、干净机均未执行**；`M5-7-02` 保持未勾选。
3. **Electron 点击级导出未执行**：代码与契约测试完成，但无人工点击证据。
4. **海报无 PNG 素材**：使用主题渐变色块，`knownLimits` 已声明；若产品要求摄影图，需补素材并重新冻结。
5. **桌面导入身份**：demo 登录仅开发环境；`ALLOW_DEMO_LOGIN=false` 时入口禁用并提示到小程序端导入。
6. **miniprogram/ 镜像**：`pages/home` 未同步版本守卫（`domain/versionGuard.js` 仅 Base 有），迁移状态仍 `migrating`。
7. **旧模板**：`templates/mini-program` 与 `scripts/generate-mini-program.cjs` 仅历史追溯，不得作为导出源，不得进入安装包。
8. **工作区中文路径导出受限**：本机 `E:\智能开店app` 下多文件目录 rename 持续 EPERM（环境问题），生成验收输出到工作区外。
9. **事件名契约**：组件事件必须 camelCase（如 `openDetail`），与 `manifest.v1` Schema 一致；改资产内容后必须 `node scripts/registry-check.cjs --write` 重新冻结。

**不要做**：
- 不要绕过注册表直接复制资产到产物；
- 不要让 Agent 输出源码/命令并执行；
- 不要把 Token、AppSecret、OpenID、绝对路径写入导出工程或报告；
- 不要把静态校验当作微信编译，把 `desktop:dev` 当作安装包验收；
- 不要在 `production` 下使用 demo 登录、HTTP API 或缺失后端版本。

---

## 6. 下一位执行者的最小闭环

1. 微信开发者工具人工导入 `order-classic` 与 `order-poster` 产物并编译，记录截图；通过后才可把 Recipe 改 `direct`（需四类证据）。
2. 补 L2 点击导出、L3/L4 安装包证据，再更新 `docs/待完成目标.md`。
3. 同步 `domain/versionGuard.js` 到 miniprogram 镜像（或按迁移声明推进镜像退出）。
4. 任何资产内容变更后：`node scripts/registry-check.cjs --write` 重新冻结，再跑 `npm test`。
5. 持续更新 `docs/evidence/s7-checklist.md`、`docs/handoff/当前工作区交接.md`、`docs/bugs/README.md`。