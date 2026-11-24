# C3 独立复核（t25 / round 1）— source overlay 校验 / 覆盖语义 / usingComponents / 同源导出

- 复核对象：C3（t24）`scripts/composer/source-overlay.cjs`（新增）、`scripts/composer/emit.cjs`、`scripts/composer/index.cjs`、
  `test/composer-source-overlay.test.cjs`（新增）
- 冻结依据：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev11 §4.1、总计划 §6 C3
- 复核者：verifier（只读；除本文件外未写仓库文件；攻击脚本 `.tmp/a25/c3-attack.cjs`、`.tmp/a25/nested-junction.cjs`；
  未做 git 写操作；未启动 Electron/微信）
- 时间：2026-11-24 20:11–20:22（+08:00）；Node v24.14.0；DSH 沙箱 `workspace-write`
- 环境：verifier shell 仍 **spawn EPERM**；官方 npm 门禁 BLOCKED。Captain full-access 的 composer 133/133 仅记作外部证据。
- **Verdict：`needs_revision`（1 条 finding：overlay 未拒绝 junction/reparse 目录；修复后需 review r2）**

## 1. 门禁（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `node --test --experimental-test-isolation=none --test-force-exit test/composer-source-overlay.test.cjs` | **0** | **6/6** |
| 2 | `node --test --experimental-test-isolation=none --test-force-exit "test/composer*.test.cjs"`（13 文件） | **1** | `tests 133 / pass 132 / fail 1`；唯一失败 = `CLI 相对 media.json…`（`composer-media` 测试内 spawnSync EPERM，**环境 BLOCKED，非 C3 产品失败**；与 A0 基线一致） |
| 3 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（spawn EPERM，未伪装） |

## 2. 自写攻击用例（`%TEMP%` 临时 overlay/导出；不复用实现者测试）

脚本 `.tmp/a25/c3-attack.cjs`：**38 项 = 37 PASS / 1 FAIL**（FAIL 即 F1）。构造：复制 Base 为 overlay 根，
页面/组件最终文件直接覆盖、page-scoped product-card、shared store-header、新增 c3-badge 四件套、PNG 资产、删除 Base 资产；
`composer.compose({plan: order-classic, sourceOverlay: root})`。

| 类别 | 用例与结果 |
| --- | --- |
| 覆盖语义 | 页面 wxml/wxss/js **逐字节等于 overlay**；page-scoped 生成 `components/product-card--menu` 且 wxml 等于 overlay；menu `usingComponents['product-card']=/components/product-card--menu/index`、`c3-badge=/components/c3-badge/index`；home 仍用 Base 路径；shared `store-header` 影响面 `['home','menu']`；新增组件四件套齐；资产字节一致且 Base 资产已删除。PASS |
| 产物一致性 | `inspectOutput(out).ok===true`、`runChecks(out).ok===true`（mini:check 同实现）。PASS |
| templates 零写入 | compose 前后 `treeSha256(templates/**)` 相同。PASS |
| source-changes | 字段 `{schemaVersion,base,plan,lock,overlay,summary,files}` 齐全；无时间戳/绝对路径/tmpdir；自身不入 diff；modified/added/deleted 状态与 sha256 正确（deleted sha=null）。PASS |
| 确定性 | 两次 compose（固定 generatedAt）`result.treeSha256` 相同、`lockDigest` 相同；除 `generation-report.json`/`生成报告.md`/`composition.lock.json`（含时间/耗时，C3 测试同口径排除）外**全部文件逐字节一致**。PASS |
| buildProjectFiles 同源 | 用 compose 同参数（mode/projectName/theme/presentationTokens/planDigest/lockDigest/registryDigest/sourceOverlay）直接 `emit.buildProjectFiles`，除 lock/report 三个易变文件外**逐字节等于正式导出**（含 `source-changes.json`、`config/store.generated.js`、`project.config.json`）。PASS |
| 负例：Base | 坏 `base.treeSha256` → `SOURCE_BUNDLE_BASE_MISMATCH`。PASS |
| 负例：路径 | `../evil.wxml`、`C:/…`、`C:\…`、`pages\menu\…`、含 NUL → `SOURCE_BUNDLE_PATH_INVALID`；`src/evil.js` → `SOURCE_BUNDLE_PATH_FORBIDDEN`。PASS |
| 负例：sha/资产 | 声明 sha 不符 → `SOURCE_BUNDLE_FILE_HASH_MISMATCH`；假 PNG 魔数 → `SOURCE_BUNDLE_ASSET_TYPE_INVALID`；>2 MiB → `SOURCE_BUNDLE_ASSET_TOO_LARGE`；21 个资产 → `SOURCE_BUNDLE_ASSET_COUNT_EXCEEDED`。PASS |
| 负例：组件/页面 | 未知标签 `<evil-comp/>` → `SOURCE_OVERLAY_COMPONENT_UNKNOWN`；page scope 不在 Plan → `SOURCE_BUNDLE_COMPONENT_SCOPE_REQUIRED`；targetPage 不在 Plan → `SOURCE_BUNDLE_TARGET_PAGE_REQUIRED`；与 FrontendPack 同时出现 → `SOURCE_OVERLAY_CONFLICT`；Plan 插槽锚点被删 → `SLOT_REQUIRED_BY_PLAN`。PASS |
| **负例：reparse 目录** | overlay 根换成 **junction**（指向合法 overlay）→ `loadSourceOverlay` **返回 ok=true 并继续 compose 成功**；再把 `pages/menu` 换成指向外部目录的 junction、声明 `pages/menu/index.wxml` → compose **成功且导出内容来自 junction 外部目录**（`wroteOutsideContent:true`） | **FAIL → F1** |
| entry.assets | 子目录 `assets/sub/pic.png` → 落到 `assets/<id>/sub/pic.png`（保留相对子路径）；缺失 → `FEATURE_ASSET_MISSING`；旧 entry 内 `assets/legacy.png` 回退按 basename 落盘；空 assets 旧行为不变；`../evil.png` → `FEATURE_ASSET_PATH_INVALID`。PASS |

## 3. Finding（needs_revision）

### F1（severity: medium）overlay 未拒绝 junction/reparse 目录；嵌套 junction 可把外部内容读入导出

- 文件/行：`scripts/composer/source-overlay.cjs:126-140`（`loadSourceOverlay` 根校验）。代码只做
  `lstatSync(root)` + `!stats.isDirectory() || stats.isSymbolicLink()`；Windows junction 的 lstat 是普通目录，
  因此通过；随后 `realpathSync(root)` 只用于拼 manifest 路径，**从未与词法 root 比较**。
  同名问题在声明文件读取路径（`:192` 仅 lstat 文件本身）存在：中间路径段是 junction 时会跟随到外部。
- 实测（verifier 自写）：
  1) `overlayRoot` = junction → `loadSourceOverlay` 返回 `{ok:true}`，compose 成功；
  2) overlay 内 `pages/menu` = junction → 外部目录 `index.wxml` 被作为 `pages/menu/index.wxml` 写入导出，
     导出字节 = 外部文件字节（越出 overlay 根读取）。
- 风险：与验收“拒绝链接/非真实目录（reparse 目录）”不符；若用户数据目录被替换/junction 化，Composer 会把
  overlay 根之外的文件读入导出，破坏“私有 overlay 边界”。（overlay 根由主进程派生，B1 写入侧已拒绝链接，
  故不是 renderer 可直接触发的远程面；但属 C3 明确要求的安全校验缺口。）
- requiredFix：`loadSourceOverlay` 根部要求 `realpathSync(root)` 与规范化后的词法 root 相等（大小写/长路径按平台归一），
  否则 `SOURCE_OVERLAY_ROOT_INVALID`；对每个声明文件/资产的读取路径，逐段 `lstat` 拒绝 reparse（或 `realpath` 后必须
  `isInsideOrEqual(realRoot, realFile)`），并拒绝 `..` 之外的 reparse 穿越；补 junction 根 + 嵌套 junction 两条测试
  （Windows 用 `fs.symlinkSync(..., 'junction')`）。

## 4. 非 finding 观察

1. 两次 compose 的**完整树**因 `generation-report.json`/`生成报告.md`/`composition.lock.json` 内含时间/耗时不同而不同；
   `result.treeSha256` 与 `lockDigest` 相同，且其余文件逐字节一致（实现者测试同口径排除这三者）。建议 rev 明确
   “treeSha 指 result.treeSha256（项目文件），报告/锁文件为易变元数据”。
2. verifier 沙箱 create symlink 仍 EPERM（junction 可建）；symlink 根路径未能实测，以 junction 证据为准。
3. composer 全量在 verifier 沙箱为 `133/132/1`，唯一失败 `composer-media` 测试内 spawnSync EPERM（BLOCKED）；
   Captain full-access `133/133` 仅作外部证据，未写成 verifier PASS。

## 5. 越界与测试削弱

- C3 改动面：`source-overlay.cjs`（新增，20:05）、`emit.cjs`（19:56）、`index.cjs`（19:57）、
  `composer-source-overlay.test.cjs`（新增，20:06）；`scripts/composer` 其他文件 mtime 为 10/31–11/21 未动。
- `templates/**`/`miniprogram/**`/`src/**`/`server/**`/`desktop/**`/`contracts/**`/`package.json`：C3 未改；
  `git status` 中 templates/miniprogram/server 的 staged 改动属并发 C1/C2（非 C3），Composer 运行期间 templates treeSha
  前后一致（攻击用例 templates.zeroWrite PASS）。HEAD 仍 `437bf5f`（C3 未提交）；verifier 未做任何 git 写操作。
- 测试：`composer-source-overlay.test.cjs` 6 例真断言；`grep .skip/.todo/.only` 无；旧 composer 133 与 frontend 186 不回归。

## 6. 结论

- overlay 输入契约（Base 摘要/路径/sha/资产/组件/页面作用域）、覆盖语义（页面/组件/paged 变体/shared/新组件/资产）、
  usingComponents 重算、slot 阻断、FrontendPack 互斥、source-changes 形状与脱敏、同源确定性、buildProjectFiles 与导出
  逐字节一致、entry.assets 修复、人工切片一致性——**37/38 独立攻击通过**，templates 零写入，旧门禁不回归。
- 但 **F1（junction/reparse 未拒绝，嵌套 junction 可读入外部内容）** 是验收明确项 → **verdict=needs_revision**。
- repair 后需 **review r2**；C4 是否开放由 Captain 决定（C3 门禁未过）。
- 证据：本文件；攻击脚本 `.tmp/a25/c3-attack.cjs`、`.tmp/a25/nested-junction.cjs`；临时目录在 `%TEMP%`（不写仓库）。

---

# Review r2（t27，2026-11-24 20:33–20:42）— 复检 F1（junction/reparse）修复

- 复核对象：t26 repair-round-2（`scripts/composer/source-overlay.cjs` + `test/composer-source-overlay.test.cjs`）
- **Verdict：`pass`（0 findings；C3 满足 rev11 §4.1，可闭环）**
- 环境：verifier shell 仍 **spawn EPERM**（symlink 创建 EPERM、junction 可建）；官方 npm 门禁 BLOCKED；
  Captain full-access 的 composer 134/134 仅作外部证据，未写成 verifier PASS。

## R2-1 门禁复跑（真实退出码）

| # | 命令 | 退出码 | 结果 |
| ---: | --- | ---: | --- |
| 1 | `… test/composer-source-overlay.test.cjs` | **0** | **7/7** |
| 2 | `… "test/composer*.test.cjs"`（13 文件） | **1** | `tests 134 / pass 133 / fail 1`；唯一失败 = `CLI 相对 media.json…`（composer-media 测试内 spawnSync EPERM）→ **BLOCKED 环境、非 C3** |
| 3 | `… "test/frontend-reconstruct*.test.cjs" test/app-frontend-reconstruct.test.cjs`（13 文件） | **0** | **186/186** |
| 4 | `require` schema/resolve/emit/digest/source-overlay/index | **0** | composer modules ok |
| 5 | root 全量等价（130 文件 / 7 块 / 单进程 / `--test-force-exit --test-timeout=120000`） | **1** | `tests 1372 / pass 1363 / fail 7 / skip 2`；失败集 = **A0 的 7 项**（6 沙箱 spawn EPERM + 1 MIRROR），**无 NEW** |
| 6 | 官方 `npm test` / `npm run build` | — | **BLOCKED**（未伪装） |

## R2-2 F1 复验（junction/reparse 拒绝）

- 代码到位：`source-overlay.cjs:95-100` `resolveRealPath`（优先 `fs.realpathSync.native`）；
  `:108-135` `inspectOverlayPath`（逐段 lstat + 逐段 native realpath 与词法一致，最终 `isInsideOrEqual(realRoot)`）；
  `:194` 根 `realRoot` 与 `path.resolve(root)` 归一比较；`:202/207` manifest 路径检查；`:251-256` 每个声明文件/资产检查。
- 自写攻击（不采信实现者测试）：
  - `neg.junctionRootRejected`：overlay 根 = junction（指向合法 overlay）→ `loadSourceOverlay`/compose
    **被拒绝**（`SOURCE_OVERLAY_ROOT_INVALID`），无导出目录；**PASS**（t25 时该用例 FAIL）。
  - `.tmp/a25/nested-junction.cjs`：overlay 内 `pages/menu` = 指向外部目录的 junction、声明
    `pages/menu/index.wxml` → compose `ok:false, code:"SOURCE_OVERLAY_PATH_INVALID"`，
    **`wroteOutsideContent:false`**（外部内容未被写入）；PASS（t25 时为 ok:true + 外部内容入导出）。
  - symlink 创建在本沙箱仍 EPERM，未单独实测 symlink 根；以 junction 证据为准并如实记录。
- 自写攻击套件 `.tmp/a25/c3-attack.cjs` 重跑：**38 项 = 38 PASS / 0 FAIL**（t25 为 37/1）。

## R2-3 其余验收（与 t25 一致，无回归）

- 覆盖语义：menu wxml/wxss/js 逐字节=overlay；`product-card--menu` 变体且只改 menu usingComponents；
  shared `store-header` 影响 `['home','menu']`；新组件四件套；资产字节/删除；`inspectOutput`/`runChecks` ok；
  compose 前后 `templates` treeSha 不变。PASS
- `source-changes.v1`：字段齐全、无时间戳/绝对路径/tmpdir、自身不入 diff、状态与 sha 正确。PASS
- 确定性：两次 compose `result.treeSha256`+`lockDigest` 一致（除 lock/report 三个易变文件外逐字节一致）；
  `buildProjectFiles` 用 compose 同参数与导出逐字节一致（含 source-changes）。PASS
- 负例：Base 摘要、路径（`../`/绝对/盘符/反斜杠/NUL/仅 pages|components|assets）、sha、资产魔数/2MiB/20 个、
  未知组件、page scope/targetPage 不在 Plan、FrontendPack 冲突、slot 缺失 → 均返回预期 `SOURCE_*`/`SLOT_*` 码。PASS
- `entry.assets`：子目录 `assets/sub/pic.png → assets/<id>/sub/pic.png`；缺失 `FEATURE_ASSET_MISSING`；
  legacy entry 内回退 basename；空 assets 旧行为；`../` → `FEATURE_ASSET_PATH_INVALID`。PASS

## R2-4 测试削弱与越界

- `composer-source-overlay.test.cjs` 6→**7** 例（新增 junction 根/嵌套 junction 真断言），无 `.skip/.todo/.only`；
  既有 composer 134 与 frontend 186 不回归。
- t26 改动面：`source-overlay.cjs`（20:26）、`composer-source-overlay.test.cjs`（20:25）；
  `emit.cjs`(19:56)、`index.cjs`(19:57) 未再动；其他 composer 文件 mtime 10/31–11/21 未动。
- `templates/**`/`miniprogram/**`/`src/**`/`server/**`/`desktop/**`/`contracts/**`/`package.json` 未由 C3 改动
  （staged 改动属并发 C1/C2）；HEAD 仍 `437bf5f`（C3 未提交）；verifier 未做任何 git 写操作。
- **越界为零。**

## R2-5 结论

- F1（junction/reparse 未拒绝、嵌套 junction 可读入外部内容）已修复并有独立复验：
  junction 根被 `SOURCE_OVERLAY_ROOT_INVALID` 拒绝、嵌套 junction 被 `SOURCE_OVERLAY_PATH_INVALID` 拒绝且零写盘；
  正常 overlay 行为与其余 C3 验收无回归；测试 7/7、composer 134（本沙箱 133 + 1 环境 BLOCKED）、frontend 186。
- **verdict=pass（0 findings）**；C3 可闭环（C4 是否开由 Captain 决定）。
- 残余环境项：官方 npm 门禁 BLOCKED；symlink 根因沙箱 EPERM 未单独实测（junction 已实证）；
  真实 Composer CLI 的 spawn 路径需在 full-access 机器终验（Captain 134/134 为外部证据）。

