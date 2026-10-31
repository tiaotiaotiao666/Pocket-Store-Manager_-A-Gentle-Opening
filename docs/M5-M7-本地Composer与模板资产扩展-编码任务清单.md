# M5–M7 本地 Composer 与模板资产扩展 · 编码任务清单

> 状态：**编码任务规划（tasks）**，编制日期 2026-10-31。
> 上游依据：`docs/M5-M7-本地Composer与模板资产扩展-需求规格.md`（95 条可追踪规则）、`docs/M5-M7-本地Composer与模板资产扩展-实现方案.md`（S0–S7、D1–D8、A1–A17）。
> 本轮边界：**只产出本任务清单**。未修改 `src/`、`server/`、`miniprogram/`、`templates/`、`desktop/`、`scripts/`、`package.json` 等任何实现文件；未安装依赖；未执行 git 写操作；未触碰工作区既有内容。
> 执行前提：D1–D8 均按默认推荐执行（批准 B3 写接口、新增 `storeConfigVersion`、海报素材随包、会话 UI 增量修改、demo 登录、不兼容 v1、保留候选 Recipe、接受 L1+L2 阶段性证据但 M5-7-02 不勾选）。

---

## 0. 阅读方式与执行约定

### 0.1 任务来源与编号口径

- 需求规则编号严格按正文 95 条：`M5-1×8`、`M5-2×8`、`M5-4×9`、`M5-5×10`、`M5-6×9`、`M5-7×7`、`M6-1×10`、`M6-2×8`、`M6-3×7`、`M7-1×4`、`M7-2×2`、`M7-3×5`、`M7-4×4`、`M7-5×4`，合计 **95**。
- 需求文档第 7 章把 `M5-4-01…09` 误写为 `M5-3-01…09`；本清单统一使用 **`M5-4-xx`**，不创建 `M5-3` 章节。
- 任务 ID 规则：`T-M5-xx`、`T-M6-xx`、`T-M7-xx`、`T-CL-xx`（收尾）。ID 一次性分配，不复用、不重排。

### 0.2 环境与证据等级（每个任务必须标注）

| 标记 | 含义 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| `L1` | 本机 Node 单元/静态/契约测试，无 Electron、无微信工具 | 契约、解析、生成、原子性、后端逻辑 | 真实渲染、真实安装 |
| `L2` | 本机 Electron 运行（`npm run desktop`）+ Vite 构建 + 资源包含静态断言 | 本机真实导出、IPC 形状、打包资源覆盖 | 安装包可用、干净机器可用 |
| `L3` | `npm run build:win` 产出 NSIS 安装包 | 安装包已生成、解包文件清单 | 安装后可导出 |
| `L4` | 干净 Windows 10/11 x64 安装 → 导出 → 微信导入 | M5-7-02 的完整验收 | — |
| `W` | 微信开发者工具人工 GUI 导入与编译（CLI 端口当前关闭） | 微信编译与页面渲染 | 真机 HTTPS/安全区 |
| `R` | 真机扫码与点击走查 | 运行时真实行为 | 安装包验收 |

> 禁止：用 `L1` 静态校验冒充 `W` 微信编译；用 `npm run desktop:dev` 截图冒充 `L4`；用 React 预览截图冒充微信运行时。

### 0.3 任务字段说明

每个任务固定包含 8 个字段：**前置依赖、并行关系、环境/证据等级、新建文件、修改文件、实现要点、验证方式、规则追踪**。文件路径均为仓库相对路径；「新建」与「修改」严格区分，避免实现阶段误判。

### 0.4 工作区保护

1. 现有未提交内容（`miniprogram/services/{session,auth,request}.js`、`miniprogram/pages/merchant-orders/index.js`、`miniprogram/components/cart-panel/index.js`、相关测试与文档）是用户资产，**不得回滚、不得覆盖**。
2. `src/` 只做方案 2.5.4 列出的最小增量编辑，不改写 `revealFlush`、`SKIP_INTRO`、阶段会话交接。
3. `templates/mini-program/` 只读保留为历史归档，不删除、不再作为导出源。
4. `docs/后端待实现接口清单.md` 默认不修改（A14），合并动作留到 `T-CL-08` 由用户确认。

---

## 1. 执行顺序总览

### 1.1 阶段依赖图

```text
S0 契约冻结（T-M5-01…06）
  → S1 Base 提炼（T-M5-07…13）
    → S2 Composer 核心（T-M5-14…25）
      → S3 桌面接线与打包（T-M5-26…35）
        → M5 验收（T-M5-36…40）
  ↘ S4 后端 M6（T-M6-01…07）  ← 可与 S2/S3 并行（只依赖 T-M5-02/03 契约口径）
        ↘ S5 桌面 M6 客户端（T-M6-08…14）
              ↘ S6 M7 资产（T-M7-01…12）
                    ↘ S7 收尾（T-CL-01…09）
```

### 1.2 关键路径（必须串行，任何一环失败后续不可宣称完成）

```text
T-M5-01 → T-M5-02/03/04 → T-M5-06 → T-M5-08 → T-M5-09/10/11
→ T-M5-14/15 → T-M5-16 → T-M5-17/18 → T-M5-19 → T-M5-20
→ T-M5-22 → T-M5-23 → T-M5-24 → T-M5-25
→ T-M5-26/27/28/29/30/31/32 → T-M5-33 → T-M5-34
→ T-M5-36 → T-M5-38 →（T-M5-39 → T-M5-40 受网络/机器约束）
→ T-M6-01 → T-M6-02 → T-M6-05 → T-M6-07
→ T-M6-08 → T-M6-09 → T-M6-14
→ T-M7-01…04 → T-M7-05 → T-M7-06 → T-M7-07
→ T-M7-08 → T-M7-09 → T-M7-10 → T-M7-11 → T-CL-01…09
```

### 1.3 可并行批次

| 批次 | 可并行任务 | 前提 |
| --- | --- | --- |
| P0 | `T-M5-02`、`T-M5-03`、`T-M5-05` | `T-M5-01` 完成 |
| P1 | `T-M5-04`、`T-M5-06` | `T-M5-02/03` 完成 |
| P2 | `T-M5-09`、`T-M5-10`、`T-M5-11` | `T-M5-08` 完成 |
| P3 | `T-M5-14`、`T-M5-15`、`T-M5-17`、`T-M5-20`、`T-M5-21` | `T-M5-16` 前序契约与 Base 完成 |
| P4 | `T-M5-26`、`T-M5-27`、`T-M5-28`、`T-M5-29`、`T-M5-30`、`T-M5-31`、`T-M5-34` | `T-M5-25` 完成 |
| P5 | `T-M6-03`、`T-M6-04`、`T-M6-06`、`T-M6-08` | `T-M6-02` 与 `T-M6-01` 完成 |
| P6 | `T-M7-01`、`T-M7-02`、`T-M7-03`、`T-M7-04` | `T-M5-07` 与 `T-M6-11` 完成 |
| P7 | `T-CL-02` 准备、`T-CL-05` 撰写 | 各阶段证据开始产出后即可起草 |

> 并行禁止项：`T-M5-16` 之前不得开始 `T-M5-19/24`；`T-M6-14` 之前不得宣称 M6 完成；`T-M7-07` 之前不得把任何 Recipe 放入店主可选列表。

### 1.4 任务总表

#### M5（40 项）

| ID | 任务 | 前置 | 环境 | 规则 |
| --- | --- | --- | --- | --- |
| T-M5-01 | 注册表骨架、版本冻结与摘要工具 | 无 | L1 | M5-1-04/07 |
| T-M5-02 | 五类契约与导出配置 Schema 文档冻结 | T-M5-01 | L1 | M5-1-01/02/08、M5-4-01 |
| T-M5-03 | 合法/非法样例与期望结果表 | T-M5-02 | L1 | M5-1-01/05/06、M5-4-02/03/04/09 |
| T-M5-04 | 内置 Schema 校验器 | T-M5-02/03 | L1 | M5-1-02/08、M5-4-01 |
| T-M5-05 | 资产安全扫描模块 | T-M5-01 | L1 | M5-1-08、M5-5-05、4.3.1/4.3.3 |
| T-M5-06 | 注册表加载、冻结校验与声明实现一致性 | T-M5-03/04/05 | L1 | M5-1-03…07、M5-2-04 |
| T-M5-07 | 静态校验脚本参数化 | T-M5-01 | L1 | M5-2-06、M7-3-04 |
| T-M5-08 | Base 源码目录提炼与复制 | T-M5-07 | L1 | M5-2-01/03 |
| T-M5-09 | Base 插槽锚点与扩展占位改造 | T-M5-08 | L1 | M5-2-03/07、M5-5-03 |
| T-M5-10 | Base 主题 Token 化与公开配置最小 v2 | T-M5-08 | L1 | M5-2-03、M5-5-09/10、M6-3-03 |
| T-M5-11 | Base Manifest、插槽与 Token 声明 | T-M5-09/10 | L1 | M5-1-03、M5-2-03/04/07 |
| T-M5-12 | 双份维护门禁与迁移声明 | T-M5-11 | L1 | M5-2-01/02 |
| T-M5-13 | Base 可删除性与边界断言 | T-M5-12 | L1 | M5-2-03/05/06、M7-3-01…04 |
| T-M5-14 | 解析器：白名单、版本、依赖、冲突、循环 | T-M5-06/13 | L1 | M5-1-04、M5-4-02/03/07、M5-5-07 |
| T-M5-15 | 解析器：插槽、页面、props、兼容性、对比度 | T-M5-14 | L1 | M5-2-07、M5-4-04/09、M5-5-10 |
| T-M5-16 | Lock 生成与完整性校验 | T-M5-14/15 | L1 | M5-4-05/08、6.3 |
| T-M5-17 | 生成器：应用级文件 | T-M5-16 | L1 | M5-5-02/09/10 |
| T-M5-18 | 生成器：页面、组件与插槽替换 | T-M5-17 | L1 | M5-5-02/03、M5-2-05 |
| T-M5-19 | 产物校验器 | T-M5-18 | L1 | M5-5-02/06、4.3.3 |
| T-M5-20 | 原子写盘与目录保护 | T-M5-16 | L1 | M5-5-04、4.2.2/3/5、M5-7-03/05 |
| T-M5-21 | 生成报告 | T-M5-19 | L1 | M5-5-08、6.6、4.4.3 |
| T-M5-22 | Composer 编排入口与 CLI | T-M5-20/21 | L1 | M5-5-01/02 |
| T-M5-23 | 固定 Plan 与 order-classic Recipe 资产 | T-M5-22 | L1 | M5-5-01 |
| T-M5-24 | Composer 测试套件与旧测试改写 | T-M5-23 | L1 | M5-5-02/03/05/06、M5-4-06 |
| T-M5-25 | 确定性复现验证 | T-M5-24 | L1 | M5-4-06、4.2.1 |
| T-M5-26 | Electron 主进程 Composer IPC | T-M5-25 | L2 | M5-6-01/02/04、M5-7-04 |
| T-M5-27 | preload 桥接扩展 | T-M5-26 | L2 | M5-6-01/03/09 |
| T-M5-28 | exportService 服务层 | T-M5-25 | L1 | M5-6-04/09 |
| T-M5-29 | planFromSession 与主题预设 | T-M5-25 | L1 | M5-6-06、M5-5-09 |
| T-M5-30 | 会话状态机增量改造 | T-M5-28/29 | L1 | M5-6-01/02/05/07/08 |
| T-M5-31 | DeployStep 与 ExportResultCard | T-M5-28 | L1 | M5-6-02/03/04/05/07 |
| T-M5-32 | App.jsx 导出接线 | T-M5-26…31 | L2 | M5-6-01…09 |
| T-M5-33 | 桌面契约与服务层测试 | T-M5-32 | L1 | M5-6-01…09、M5-7-04 |
| T-M5-34 | 打包资源契约检查与 build.files 修复 | T-M5-26 | L1/L2 | M5-7-01/04、M5-2-08 |
| T-M5-35 | 旧导出脚本退出主链 | T-M5-34 | L1 | M5-5-09、M5-2-08、M5-7-06 |
| T-M5-36 | 桌面真实导出验收 | T-M5-33/34 | L2 | M5-6-01/03 |
| T-M5-37 | 路径鲁棒性验收 | T-M5-36 | L2 | M5-7-03/05 |
| T-M5-38 | Vite 构建与打包资源静态验收 | T-M5-36 | L2 | M5-7-01/04 |
| T-M5-39 | NSIS 安装包构建 | T-M5-38 | L3 | M5-7-01/02/07 |
| T-M5-40 | 干净机安装与微信编译 | T-M5-39 | L4 + W | M5-7-02、M5-5-01 |

#### M6（15 项）

| ID | 任务 | 前置 | 环境 | 规则 |
| --- | --- | --- | --- | --- |
| T-M6-01 | B3 契约文档先行 | T-M5-02 | L1 | M6-1-01/05/06/08、4.5.4、6.5 |
| T-M6-02 | 数据模型与迁移 | T-M6-01 | L1 | M6-1-02/09、6.5.2 |
| T-M6-03 | OWNER 守卫与差异纯函数 | T-M6-02 | L1 | M6-1-03/04/05/07、M6-2-07 |
| T-M6-04 | 导入 DTO、Controller 与模块注册 | T-M6-02 | L1 | M6-1-01/06、6.5.1/3/4 |
| T-M6-05 | 导入事务、幂等、映射与缓存 | T-M6-03/04 | L1 | M6-1-01…10 |
| T-M6-06 | 公开门店字段与桌号接口 | T-M6-01 | L1 | M6-1-09、M6-3-04、A3 |
| T-M6-07 | 服务端导入测试与构建 | T-M6-05/06 | L1 | M6-1-01…10 |
| T-M6-08 | 桌面 importService | T-M6-01 | L1/L2 | M6-1-05、A15、M6-2-01…08 |
| T-M6-09 | 导入差异确认 UI 与状态 | T-M6-07/08 | L2 | M6-1-04、M6-2-05/07 |
| T-M6-10 | 前端导入服务测试 | T-M6-08 | L1 | M6-2-01…08 |
| T-M6-11 | store.generated v2 生成器与白名单 | T-M5-18 | L1 | M6-3-01…07、6.4 |
| T-M6-12 | 小程序版本守卫与桌号读取 | T-M6-11 | L1 | M6-3-06、M6-2-01…04/06 |
| T-M6-13 | 配置 v2 与版本守卫测试 | T-M6-11/12 | L1 | M6-3-01…07 |
| T-M6-14 | 前后端真实联调 | T-M6-07/09/13 | L1/L2 | M6-1-01…10、M6-3-04 |
| T-M6-15 | M6 门禁汇总 | T-M6-14 | L1/L2 | M6 全部 |

#### M7（12 项）

| ID | 任务 | 前置 | 环境 | 规则 |
| --- | --- | --- | --- | --- |
| T-M7-01 | store-header 资产 | T-M5-07、T-M6-11 | L1 | M7-1-01/02、M7-3-01/02 |
| T-M7-02 | product-card 资产 | T-M5-07、T-M6-11 | L1 | M7-1-01/02、M7-3-01/02 |
| T-M7-03 | cart-bar 资产 | T-M5-07、T-M6-11 | L1 | M7-1-01/02、M7-3-01/02 |
| T-M7-04 | poster-carousel Feature Pack | T-M5-07、T-M5-09 | L1 | M7-1-03、M7-3-01/02 |
| T-M7-05 | 资产全量校验 | T-M7-01…04 | L1 | M7-3-01…04 |
| T-M7-06 | 三份 Recipe 与发布/候选元数据 | T-M7-05 | L1 | M7-1-04、M7-5-01/04 |
| T-M7-07 | 注册表登记、preview 登记与扩展顺序门禁 | T-M7-06 | L1 | M7-2-01、M7-4-01/03 |
| T-M7-08 | Recipe 晋升与 preview-only 门禁测试 | T-M7-07 | L1 | M7-3-05、M7-4-04、M7-5-01/02/03 |
| T-M7-09 | preview-only 四处呈现 | T-M7-08 | L1/L2 | M7-4-02 |
| T-M7-10 | 三份 Recipe 生成与可删除性验收 | T-M7-09 | W | M5-2-05、M7-1-04、M7-5-01 |
| T-M7-11 | 逐资产证据与发布记录 | T-M7-10 | W + R | M7-2-02、M7-5-04 |
| T-M7-12 | M7 门禁汇总 | T-M7-11 | L1 + W | M7 全部 |

#### 收尾（9 项）

| ID | 任务 | 前置 | 环境 | 规则/文档 |
| --- | --- | --- | --- | --- |
| T-CL-01 | 全量测试矩阵 | T-M7-12 | L1/L2 | 4.1–4.5 |
| T-CL-02 | 证据归档与清单 | T-CL-01 | L1 | 2.8.5 |
| T-CL-03 | 更新 `docs/待完成目标.md` | T-CL-02 | L1 | 里程碑 |
| T-CL-04 | 更新 `docs/bugs/` 台账 | T-CL-02 | L1 | BUG-006/008/009 |
| T-CL-05 | 构建说明 md | T-CL-01 | L1 | 偏好 3 |
| T-CL-06 | 更新 `docs/handoff/` | T-CL-03…05 | L1 | 交接规范 |
| T-CL-07 | 更新概览与契约索引 | T-CL-06 | L1 | 文档治理 |
| T-CL-08 | 后端待实现清单与决策确认 | T-CL-07 | L1 | A14 |
| T-CL-09 | 交付边界与未执行项声明 | T-CL-08 | L1 | 红线 |

---

## 2. M5 阶段任务（本地 Composer 与导出升级）

### 2.1 S0 契约冻结与注册表

#### T-M5-01 注册表骨架、版本冻结与摘要工具

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | 无 |
| 并行关系 | 可与 `T-M5-02`、`T-M5-05` 并行；`T-M5-03/04/06` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/registry/registry.v1.json`、`templates/registry/registry.lock.json`、`scripts/composer/version.cjs`、`scripts/composer/digest.cjs`、`scripts/registry-check.cjs` |
| 修改文件 | `package.json`（仅 `scripts` 增加 `registry:check`、`composer:build`、`composer:verify`） |
| 实现要点 | 1) `registry.v1.json` 冻结 `registryVersion="2026.11.0"` 与 `assets[]` 索引（`id/version/kind/path/integrity`），初始允许空资产集但结构完整；2) `registry.lock.json` 只存 `{registryVersion, contentDigest}`，与索引分离，避免“同一状态两处维护”；3) `digest.cjs` 实现 canonical JSON（键 Unicode 排序、无空格、LF、禁止浮点/`-0`/NaN）、`sha256:` 前缀、`planDigest/assetDigest/treeSha256/fileSha256/lockDigest`；4) `version.cjs` 固定 `COMPOSER_VERSION="0.1.0"`；5) `registry-check.cjs` 重算索引摘要并与 lock 比较，不一致且版本未变 → 退出码 1 并打印 `REGISTRY_DRIFT`。 |
| 验证方式 | `node scripts/registry-check.cjs` 退出码 0；手改任一资产文件但不改版本 → 退出码 1 且输出 `REGISTRY_DRIFT{registryVersion,expectedDigest,actualDigest}`；`node -e "const d=require('./scripts/composer/digest.cjs');console.log(d.canonical({b:1,a:[2,1]}))"` 输出键有序且无空格。 |
| 规则追踪 | `M5-1-04`、`M5-1-07`、`4.4.4` |

#### T-M5-02 五类契约与导出配置 Schema 文档冻结

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-01` |
| 并行关系 | 与 `T-M5-03`、`T-M5-05` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/registry/schema/base.manifest.v1.json`、`manifest.v1.json`、`slots.v1.json`、`composition.v1.json`、`lock.v1.json`、`store.generated.v2.json` |
| 修改文件 | 无 |
| 实现要点 | 1) 六份 Schema 必须是“机器可读规则 + 人类可读说明”的 JSON 文档，字段、必填、取值范围、拒绝条件逐条对应方案 2.2.2–2.2.6 与 2.4.3；2) 固化通用约定：ID `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`（3–48）、版本 `MAJOR.MINOR.PATCH`、路径包内相对 POSIX、颜色 `^#[0-9A-F]{6}$`、金额整数分、禁止字段表（`source/code/script/command/url/token/secret/password/apiKey/priceText/totalCents`）；3) `slots` 插槽 ID 统一 kebab-case（`home-hero`），不采用需求文档示意写法 `home.hero`；4) `lock.v1` 必填 12 项，`store.generated.v2` 字段白名单逐项固定。 |
| 验证方式 | `node -e "['base.manifest.v1','manifest.v1','slots.v1','composition.v1','lock.v1','store.generated.v2'].forEach(f=>JSON.parse(require('fs').readFileSync('templates/registry/schema/'+f+'.json','utf8')))"` 全部可解析；人工对照方案 2.2 字段表逐项核对（记录在 `docs/evidence/m5/s0.md`）。 |
| 规则追踪 | `M5-1-01`、`M5-1-02`、`M5-1-08`、`M5-4-01`、`6.1–6.4` |

#### T-M5-03 合法/非法样例与期望结果表

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-02` |
| 并行关系 | 与 `T-M5-04` 交替推进；`T-M5-06` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/registry/schema/fixtures/valid/{base-manifest,ui-block-manifest,feature-pack-manifest,recipe,slots,composition,lock}.json`、`fixtures/valid/store-generated-v2.js.txt`、`fixtures/invalid/*.json`、`fixtures/expectations.json` |
| 修改文件 | 无 |
| 实现要点 | 1) 每个契约至少 1 份合法样例；2) 非法样例按错误码命名（`plan-schema-unsupported.json`、`version-not-exact.json`、`entry-path-invalid.json`、`entry-missing.json`、`interface-mismatch.json`、`dependency-missing.json`、`dependency-cycle.json`、`asset-conflict.json`、`slot-type-rejected.json`、`slot-capacity-exceeded.json`、`theme-contrast-low.json`、`api-contract-incompatible.json`、`plan-field-forbidden.json` 等），每份只制造一个错误；3) `expectations.json` 记录 `{file, code, path}`，测试逐条比对错误码与定位，禁止只断言“抛错”；4) 本任务先覆盖契约级错误码，解析/生成级样例在 `T-M5-14/15/19/20` 补齐。 |
| 验证方式 | `node --test test/composer-schema.test.cjs`（该文件在 `T-M5-06` 创建）逐份断言 `code` 与 `path`；`fixtures/invalid/` 文件数量 ≥ `expectations.json` 条目数。 |
| 规则追踪 | `M5-1-01`、`M5-1-05`、`M5-1-06`、`M5-4-02`、`M5-4-03`、`M5-4-04`、`M5-4-09` |

#### T-M5-04 内置 Schema 校验器

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-02`、`T-M5-03` |
| 并行关系 | 与 `T-M5-06` 交替推进 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/schema.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 不引入 `ajv` 等新依赖（A17），用 Node 内置能力实现类型/必填/正则/枚举/白名单校验；2) 暴露 `validatePlan/validateManifest/validateBaseManifest/validateSlots/validateLock/validateStoreConfig/detectForbiddenKeys/validatePath`；3) 每个失败返回 `{ok:false,code,path,message,details}`，`path` 精确到 JSON 路径（如 `features[0].source`）；4) 实现 `allowedKeys` 白名单机械校验，供 `T-M6-11` 直接复用；5) 实现 64 KB 体积上限与禁止浮点金额检查。 |
| 验证方式 | `node --test test/composer-schema.test.cjs`：合法样例全通过；非法样例逐条返回指定 `code` 与 `path`；注入 `features[0].source` → `PLAN_FIELD_FORBIDDEN`；`version:"latest"` → `VERSION_NOT_EXACT`。 |
| 规则追踪 | `M5-1-01`、`M5-1-02`、`M5-1-08`、`M5-4-01`、`6.1.10/11` |

#### T-M5-05 资产安全扫描模块

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-01` |
| 并行关系 | 与 `T-M5-02/03` 并行；`T-M5-06/19` 复用本模块 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/safety.cjs`、`test/composer-safety.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) `scanSources(files,{mode})` 扫描资产内容，`scanOutput(dir,{mode})` 扫描产物文本；2) 规则覆盖：私钥/API Key（`sk-`、`-----BEGIN … PRIVATE KEY-----`、`AKIA…`）、数据库连接串、微信 AppSecret、内网地址（`10./192.168./172.16-31.`）、绝对路径/UNC/`file://`、外部 URL、越权路由 API；3) `127.0.0.1`/`localhost` 仅在 `mode=development` 白名单，`production` 命中即拒绝；4) 返回 `{file,line,pattern,code}`，支持限定行号范围；5) 产物额外禁止 `src/domain/catalog.mjs`、`node_modules`、`process.env`。 |
| 验证方式 | `node --test test/composer-safety.test.cjs`：注入 `sk-` 前缀字符串 → `SECRET_DETECTED` 且命中文件+行；注入 `D:\` 路径 → `PATH_ESCAPE`；development 下 `http://127.0.0.1` 通过、production 下拒绝；产物含 `process.env` → 失败。 |
| 规则追踪 | `M5-1-08`、`M5-5-05`、`4.3.1`、`4.3.3`、`6.4.10` |

#### T-M5-06 注册表加载、冻结校验与声明实现一致性

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-03`、`T-M5-04`、`T-M5-05` |
| 并行关系 | S0 收口任务，后续全部依赖 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/registry.cjs`、`scripts/composer/manifest-impl-check.cjs`、`test/composer-schema.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) `loadRegistry(registryRoot)` 读取索引、lock、每个资产 `manifest.json`，校验必填字段、`identity.version` 与目录名一致、入口存在、入口路径合法、`registryVersion` 等于冻结值；2) 冻结校验：重算 `registryDigest` 与 lock 比对，不一致 → `REGISTRY_DRIFT`；3) `manifest-impl-check` 用 `node:vm` 桩执行组件 JS（注入 `Component/Page/require`），双向比对 `interface.props` 与实际 `properties`，静态扫描 `triggerEvent('<name>'` 与 `interface.events` 比对，顶层副作用 → `COMPONENT_SIDE_EFFECT`；4) 未登记 ID → `ASSET_NOT_REGISTERED`，版本不存在 → `ASSET_VERSION_NOT_FOUND` 并列出可用版本。 |
| 验证方式 | `node --test test/composer-schema.test.cjs` 全绿；删除某 Manifest 的 `release` → `MANIFEST_FIELD_MISSING` 且列出字段；目录版本与 `identity.version` 不一致 → `MANIFEST_VERSION_MISMATCH`；入口 `../../outside/index.js` → `ENTRY_PATH_INVALID`；组件多声明一个 prop → `INTERFACE_MISMATCH{extra}`。 |
| 规则追踪 | `M5-1-03`、`M5-1-04`、`M5-1-05`、`M5-1-06`、`M5-1-07`、`M5-2-04`、`4.4.4` |

### 2.2 S1 Base 提炼

#### T-M5-07 静态校验脚本参数化

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-01` |
| 并行关系 | 可与 S0 并行；`T-M5-08/13` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `scripts/validate-miniprogram.cjs`（抽出 `runChecks(root)`，新增 `--root` 参数，默认仍为 `miniprogram`）、`package.json`（`mini:check` 透传 `--root`） |
| 实现要点 | 1) 保留现有全部规则与输出格式，默认行为不变；2) 输出路径改为相对 `root`，便于 Base 与产物复用；3) 缺失 `app.js/app.wxss` 的提示改为相对路径；4) 非法 root → 非零退出并给出明确文案。 |
| 验证方式 | `npm run mini:check` 仍为 0 错误 0 警告；`node scripts/validate-miniprogram.cjs --root templates/base/ordering-base/1.0.0/src`（Base 建好后）可运行；`node scripts/validate-miniprogram.cjs --root does-not-exist` 退出码非 0。 |
| 规则追踪 | `M5-2-06`、`M7-3-04`、`C2/C3` |

#### T-M5-08 Base 源码目录提炼与复制

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-07` |
| 并行关系 | 后续 `T-M5-09/10/11` 可在本任务后并行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/base/ordering-base/1.0.0/src/{app.js,app.json,app.wxss,sitemap.json,project.config.json}`、`src/pages/**`、`src/components/**`、`src/services/**`、`src/domain/**`、`src/state/**`、`src/styles/**`、`src/config/env.js`、`wechat/{project.config.json,sitemap.json}` |
| 修改文件 | 无（`miniprogram/` 本任务不动） |
| 实现要点 | 1) 从 `miniprogram/` 复制 7 页面、13 组件、9 服务、7 领域、`state/`、`styles/`；2) **不复制** `project.private.config.json`；3) 保持字节一致，为后续“双份一致性断言”建立基线；4) `wechat/` 只放与机器无关的工程模板；5) 记录复制清单与文件数到 `docs/evidence/m5/s1.md` 草稿。 |
| 验证方式 | `node scripts/validate-miniprogram.cjs --root templates/base/ordering-base/1.0.0/src` 为 0 错 0 警；`node -e "const a=require('fs').readdirSync('miniprogram/pages');console.log(a.length)"` 为 7，Base 页面数一致；`project.private.config.json` 不存在于 Base。 |
| 规则追踪 | `M5-2-01`、`M5-2-03`、`4.4.1` |

#### T-M5-09 Base 插槽锚点与扩展占位改造

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-08` |
| 并行关系 | 与 `T-M5-10`、`T-M5-11` 并行（涉及同一目录，建议同一人串行合并提交） |
| 环境/证据 | `L1` |
| 新建文件 | `templates/base/ordering-base/1.0.0/src/config/slots.generated.js`、`src/pages/{home,menu,orders,mine,checkout,order-detail,merchant-orders}/extensions.generated.js`、`src/fragments/{home-hero,home-marketing,menu-aside}.fallback.wxml` |
| 修改文件 | `src/pages/home/index.wxml`、`src/pages/home/index.js`、`src/pages/menu/index.wxml`、`src/pages/menu/index.js`（仅加锚点、`slotProps` 与 `extensions` require） |
| 实现要点 | 1) 三段式锚点：`<!-- @slot:home-hero -->`、`<!-- @slot-fallback:home-hero -->`、`<!-- @slot-fallback:home-hero:end -->`、`<!-- @slot:home-hero:end -->`；2) fallback 内容必须等于改造前的真实标签（`store-header` 等），保证未分配插槽时渲染结果不变；3) 页面 JS 固定 `const slotProps = require('../../config/slots.generated.js');` 与 `data:{slotProps}`；4) 每个页面固定 `require('./extensions.generated.js')` 并在 `onLoad` 调用 `extensions.onLoad`；5) 锚点恰好出现一次，顺序固定。 |
| 验证方式 | `node scripts/validate-miniprogram.cjs --root templates/base/ordering-base/1.0.0/src` 0 错 0 警；人工比对改造前后首页/菜单 WXML 渲染结构（记录截图）；`grep` 确认每个锚点恰好 1 次。 |
| 规则追踪 | `M5-2-03`、`M5-2-07`、`M5-5-03`、`2.2.4` |

#### T-M5-10 Base 主题 Token 化与公开配置最小 v2

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-08` |
| 并行关系 | 与 `T-M5-09/11` 并行（同目录，注意合并冲突） |
| 环境/证据 | `L1` |
| 新建文件 | `templates/base/ordering-base/1.0.0/src/theme.generated.wxss`（占位）、`src/config/store.generated.js`（v2 最小示例） |
| 修改文件 | `src/app.wxss`（顶部 `@import "theme.generated.wxss";`，删除全部 `--store-*` 硬编码锚点）、`src/config/env.js`（生产/开发模式说明与空值约定） |
| 实现要点 | 1) 彻底移除“字符串锚点替换”路径，Token 只由 `theme.generated.wxss` 提供；缺失 `@import` → 后续 `THEME_REPLACE_ANCHOR_MISSING`；2) v2 最小示例必须含 `schemaVersion:2`、`meta`（含六类版本字段占位）、`store/api/catalog/fulfillmentOptions/theme/capabilities/demoPaymentDisclaimer`，且不含 `priceText/template/icons`；3) `env.js` 明确“`store.generated.api.baseUrl` 优先”，生产模式下本地默认值置空；4) 文件头写“由 Composer 生成，勿手改”。 |
| 验证方式 | `node -e "const p='templates/base/ordering-base/1.0.0/src/config/store.generated.js';const m=require('./'+p);console.log(m.schemaVersion,Object.keys(m))"` 输出 2 与白名单键；`grep -R "--store-" templates/base/ordering-base/1.0.0/src/app.wxss` 无硬编码定义；`node scripts/validate-miniprogram.cjs --root ...` 0 错。 |
| 规则追踪 | `M5-2-03`、`M5-5-09`、`M5-5-10`、`M5-7-06`、`M6-3-03` |

#### T-M5-11 Base Manifest、插槽与 Token 声明

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-09`、`T-M5-10` |
| 并行关系 | 与 `T-M5-12` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/base/ordering-base/1.0.0/manifest.json`、`slots.json`、`theme.tokens.json` |
| 修改文件 | `templates/registry/registry.v1.json`（登记 `ordering-base@1.0.0`）、`templates/registry/registry.lock.json`（重新冻结摘要） |
| 实现要点 | 1) `manifest.json` 按 `base.manifest.v1` 填全：`identity/entry/pages/themeTokens/layouts/services/builtinComponents/excludedCapabilities/storeConfigSchema/slots`；2) 7 个 PageDecl（`home/menu/orders/mine/checkout/order-detail/merchant-orders`），`required` 与 `audience` 正确，`merchant-orders` 标 `audience:"merchant"`；3) `excludedCapabilities` 必须含 `ad-slot`、`coupon`、`poster-carousel`；4) `theme.tokens.json` 至少 4 个 Token（背景/主色/强调/文字）+ `presets[]`，`contrastWith` 指向背景；5) `slots.json` 声明 `home-hero`（max 1）、`home-marketing`（max 2，仅 feature-pack）、`menu-aside`（max 1，仅 ui-block）；6) 入口 `entry.root="src"` 四件套存在。 |
| 验证方式 | `node scripts/registry-check.cjs` 退出码 0；`node --test test/composer-assets.test.cjs`（`T-M5-13` 创建）断言 7 页、Token ≥4、`@import` 存在、插槽锚点存在、`excludedCapabilities` 命中；缺失 `release` 字段 → 校验失败。 |
| 规则追踪 | `M5-1-03`、`M5-2-03`、`M5-2-04`、`M5-2-07`、`6.2` |

#### T-M5-12 双份维护门禁与迁移声明

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-11` |
| 并行关系 | 与 `T-M5-13` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/registry/migration.json`、`scripts/mini-dup-check.cjs` |
| 修改文件 | `package.json`（新增 `mini:dup-check`） |
| 实现要点 | 1) `migration.json` 声明 `sourceOfTruth=templates/base/ordering-base/1.0.0/src`、`mirror=miniprogram`、`status=migrating`、`allowedDiffs`（`config/env.js`、`project.config.json`、`project.private.config.json`、`config/store.generated.js`）、`exitCondition`；2) 对 `components/pages/services/domain/state/styles` 同名文件做 `sha256` 比对；内容不同且不在白名单 → 失败并列出差异文件；3) 仅 Base 有 → 正常；仅 `miniprogram/` 有 → 警告；4) 通过时也必须打印 `status:"migrating"` 与退出条件。 |
| 验证方式 | `npm run mini:dup-check` 通过并打印迁移状态；手改 `miniprogram/components/cart-bar/index.wxss` 一个字符 → 失败并指出该文件；还原后再次通过。 |
| 规则追踪 | `M5-2-01`、`M5-2-02`、`4.4.1` |

#### T-M5-13 Base 可删除性与边界断言

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-12` |
| 并行关系 | S1 收口任务 |
| 环境/证据 | `L1` |
| 新建文件 | `test/composer-assets.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 断言 Base 必备能力：`entry` 四件套、`app.json.pages` 与磁盘一致、`themeTokens≥4`、`app.wxss` 含 `@import`、`config/store.generated.js` 被 4 个 tab 页 require、`services/request.js`+`platform.js`、`state-view/loading-block/error-banner`、7 页面、`home-hero/home-marketing` 锚点、`merchant-orders` 存在；2) 断言 `excludedCapabilities` 不含营销能力实现；3) 断言 UI Block 边界：`wx.request`、路由 API、`globalData`、`services/` require 零命中；4) 断言可删除性：构造不含可选 Block 的 Plan，产物 `usingComponents` 不出现该组件且静态检查通过（依赖 `T-M5-18`，可先写跳过分支并在 `T-M5-24` 打开）。 |
| 验证方式 | `node --test test/composer-assets.test.cjs` 全绿；人为向 `components/store-header/index.js` 注入 `wx.request` → 边界断言失败。 |
| 规则追踪 | `M5-2-03`、`M5-2-05`、`M5-2-06`、`M7-3-01`、`M7-3-02`、`M7-3-03`、`M7-3-04` |

### 2.3 S2 Composer 核心

#### T-M5-14 解析器：白名单、版本、依赖、冲突、循环

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-06`、`T-M5-13` |
| 并行关系 | 与 `T-M5-15` 可并行（同文件 `resolve.cjs`，建议同一人串行） |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/resolve.cjs`、`test/composer-resolve.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 收集引用集合 `R = features ∪ {slot.component} ∪ Base`，逐个查注册表，缺失 → `ASSET_NOT_REGISTERED`/`ASSET_VERSION_NOT_FOUND{available}`；2) DFS 依赖闭包，不做自动补依赖；缺失 → `DEPENDENCY_MISSING{requiredBy}`；3) 三色标记环检测 → `DEPENDENCY_CYCLE{cycle}`；4) 两两冲突检测 → `ASSET_CONFLICT{a,b,reason}`；5) 同一 ID 多版本 → `VERSION_CONFLICT{versions}`；6) 只按 Plan 精确版本取资产，不查“最新”；存在更高版本写入 `updatesAvailable[]` 但不替换；7) 仅 Plan 显式 `degradations[]` 允许移除资产，报告 `degraded[]` 必须非空。 |
| 验证方式 | `node --test test/composer-resolve.test.cjs`：缺依赖、冲突、循环、版本冲突各自返回可区分 code；注册表新增高版本后旧 Plan 仍生成旧版本且报告含 `updatesAvailable`；移除依赖资产且未声明降级 → 失败。 |
| 规则追踪 | `M5-1-04`、`M5-4-02`、`M5-4-03`、`M5-4-07`、`M5-5-07` |

#### T-M5-15 解析器：插槽、页面、props、兼容性、对比度

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-14` |
| 并行关系 | 与 `T-M5-17` 无冲突可并行 |
| 环境/证据 | `L1` |
| 新建文件 | 无（继续在 `resolve.cjs` 内实现） |
| 修改文件 | `scripts/composer/resolve.cjs` |
| 实现要点 | 1) 插槽：`slotId` 属于该页（`SLOT_UNKNOWN`）、类型 ∈ `accepts`（`SLOT_TYPE_REJECTED`）、数量 ≤ `maxItems`（`SLOT_CAPACITY_EXCEEDED`）、同页同插槽重复（`SLOT_DUPLICATED`）、`requiresSlots` 已分配（`SLOT_REQUIRED_MISSING`）；2) props：键已声明（`PROP_UNKNOWN`）、类型匹配（`PROP_TYPE_MISMATCH`）、必填有值（`PROP_REQUIRED_MISSING`）、字符串 ≤200；3) `asset:<id>/<key>` 资源引用必须存在（`ASSET_SOURCE_MISSING`）；4) 页面：`pageId` 唯一（`PAGE_DUPLICATED`）、Base required 页必选、扩展页排序合并；5) 兼容：`baseRange` 满足 Base 版本（`BASE_VERSION_INCOMPATIBLE`）、`apiContract` 在 Base `apiContracts`（`API_CONTRACT_INCOMPATIBLE`）、`minWechatLib` 取最大值；6) 主题：Token 键白名单（`THEME_TOKEN_UNKNOWN`）、缺失（`THEME_TOKEN_MISSING`）、WCAG 对比度 `textColor/pageBackground ≥4.5`、`primaryColor/pageBackground ≥3.0`（`THEME_CONTRAST_LOW`）。 |
| 验证方式 | `node --test test/composer-resolve.test.cjs` 覆盖 2.8.3 负例矩阵 12 项：容量超限、类型不符、重复插槽、未登记插槽、契约不兼容、低对比度等全部拒绝且无输出文件；正常 Plan 通过。 |
| 规则追踪 | `M5-2-07`、`M5-4-03`、`M5-4-04`、`M5-4-09`、`M5-5-10` |

#### T-M5-16 Lock 生成与完整性校验

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-14`、`T-M5-15` |
| 并行关系 | 后续 `T-M5-17/20` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/lock.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) `buildLock(graph, planDigest)` 输出 `lock.v1` 全部必填项：`lockVersion/planDigest/base/registryVersion/registryDigest/features/resolvedDependencies/composerVersion/apiContract/capabilitySet/sourceDigests/outputDigest/backendVersions/generatedAt`；2) `features/resolvedDependencies/capabilitySet/outputDigest.files/sourceDigests` 强制排序；3) `outputDigest` 在 P3 为空占位，P6 回填；4) `lockDigest = sha256(canonical(lock 去掉 generatedAt))`；5) Lock 禁止业务数据/Token/完整菜单，生成后立即跑 `scanSources`。 |
| 验证方式 | 缺任一必填项 → 构建失败并指出字段；`node --test test/composer-schema.test.cjs` 的 `lock` 合法/非法样例通过；锁文件扫描零秘密命中。 |
| 规则追踪 | `M5-4-05`、`M5-4-08`、`6.3`、`4.4.2` |

#### T-M5-17 生成器：应用级文件

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-16` |
| 并行关系 | 与 `T-M5-18` 串行；`T-M5-20` 可并行 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/emit.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 按 2.4.1 生成 `app.json`（pages Base 顺序 + 扩展页 id 排序、window、tabBar 颜色由 Token 确定性整数运算）、`theme.generated.wxss`（Token 全量）、`config/store.generated.js`（v2 白名单）、`config/slots.generated.js`、`config/env.js`（按 mode）、`project.config.json`（`touristappid`）、`sitemap.json`、`README.md`、`composition.lock.json`、`generation-report.json` 占位；2) 复制 `app.js/app.wxss`；3) 统一格式：JSON `2 空格 + LF`，配置 `module.exports = <JSON>;\n`，文本 `\r\n→\n`；4) 产物禁止时间戳/主机名/随机数/绝对路径；5) tabBar 提亮用 `min(255,c+20)` 整数运算。 |
| 验证方式 | `node --test test/composer-emit.test.cjs`：`app.json.pages` 与磁盘一一对应；`store.generated.js` 只含白名单键且无 `priceText`；`theme.generated.wxss` 四个 Token 齐全；同一输入两次 emit 文本字节一致。 |
| 规则追踪 | `M5-5-02`、`M5-5-09`、`M5-5-10`、`6.4` |

#### T-M5-18 生成器：页面、组件与插槽替换

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-17` |
| 并行关系 | `T-M5-19` 紧随本任务 |
| 环境/证据 | `L1` |
| 新建文件 | 无（继续在 `emit.cjs` 内实现） |
| 修改文件 | `scripts/composer/emit.cjs` |
| 实现要点 | 1) 页面四件套复制；2) WXML 按 SlotsDecl 顺序处理锚点：未分配保留 fallback，已分配用 `<tag prop-one="{{slotProps.<dataKey>[i].propOne}}" />` 序列替换 fallback，锚点保留；3) 页面 `usingComponents` 只包含实际使用的 Base 内置 + 插槽分配 + 扩展所需组件，未使用不得出现；4) 组件目录名 = 资产 ID；5) `extensions.generated.js` 始终生成（未扩展为 `module.exports = {}`）；6) 资源按 `entry.assets` 复制；7) 产物中不得出现“按名称动态 require 组件”的代码。 |
| 验证方式 | `node --test test/composer-emit.test.cjs`：未分配插槽时 fallback 原样保留；分配后组件标签与 `slotProps` 键一致；删除可选 Block 后 `usingComponents` 无残留；`app.json` 页面路径与磁盘一一对应；产物无动态组件加载。 |
| 规则追踪 | `M5-5-02`、`M5-5-03`、`M5-2-05`、`M5-2-07` |

#### T-M5-19 产物校验器

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-18` |
| 并行关系 | 与 `T-M5-21` 可并行（`T-M5-21` 读取本任务结果） |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/verify.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 在 staging 上执行：文件清单完整性、`app.json` 与磁盘一致、`usingComponents` 路径存在、页面四件套、`wx:for` 带 `wx:key`；2) 复用参数化后的 `runChecks(root)`；3) `scanOutput` 秘密/路径/宿主依赖扫描；4) 两次内存 emit 复算 `treeSha256` 与 Lock 比对，不一致 → `REPRODUCIBILITY_FAILED{diffFiles}`；5) 组件边界：UI Block 零网络/路由/全局状态/服务层，`wx.request` 只在 `services/platform.js`。 |
| 验证方式 | `node --test test/composer-safety.test.cjs` + `test/composer-emit.test.cjs`：人为放入违规组件 → 校验失败且不进入交付；产物含 `sk-` → `SECRET_DETECTED`；篡改一个产物文件 → `REPRODUCIBILITY_FAILED`。 |
| 规则追踪 | `M5-5-02`、`M5-5-06`、`M5-5-05`、`4.3.3`、`M5-2-06` |

#### T-M5-20 原子写盘与目录保护

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-16` |
| 并行关系 | 与 `T-M5-17/18` 可并行 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/atomic.cjs`、`test/composer-atomic.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) P4 预检：父目录存在且可写（创建并删除探测文件）、最终目录必须 `ENOENT`、`fs.statfs` 空间 ≥ 估算×1.2、`final.length + maxRelPath.length ≤240`；2) staging 命名 `<parent>/.smartstore-tmp-<8位随机>`（同卷）；3) P5 每写一个文件检查 `signal.cancelled`，命中 → `EXPORT_CANCELLED` 并回滚；4) 导出开始清理 `mtime >1h` 的自家 staging；5) P7 唯一跨目录操作 `fs.rename`，失败回滚；6) 只删自己命名模式的目录。 |
| 验证方式 | `node --test test/composer-atomic.test.cjs`：中途注入失败 → 最终目录不存在；同名目录 → `TARGET_EXISTS` + `suggestedName` 且原目录逐字节不变；只读目录 → `TARGET_NOT_WRITABLE`；取消 → 无残留；两次重试后目录唯一。 |
| 规则追踪 | `M5-5-04`、`4.2.2`、`4.2.3`、`4.2.5`、`M5-7-03`、`M5-7-05` |

#### T-M5-21 生成报告

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-19` |
| 并行关系 | 与 `T-M5-22` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/report.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) `generation-report.json` 按 2.4.6 字段：`reportVersion/generatedAt/recipe/lock/registry/composer/plan/checks/wechatCompile/output/previewOnly/degraded/updatesAvailable/versionGaps/unresolved/durations`；2) 每条规则一个 `checks.id`，`result` 为 `pass/fail/skip`；3) `生成报告.md` 渲染章节，必须含 preview-only 清单、微信编译结果（含未执行）、未解决问题；4) 报告禁止 Token/密钥/完整菜单/订单/OpenID；5) 报告失败只写 `warnings`，不回滚工程。 |
| 验证方式 | 生成一次后 `node -e "const r=require('<out>/generation-report.json');console.log(Object.keys(r))"` 字段齐全；`grep -E "sk-|AppSecret|BEGIN PRIVATE"` 零命中；未执行微信编译时 `wechatCompile.result="not-run"`。 |
| 规则追踪 | `M5-5-08`、`6.6`、`4.4.3`、`4.3.1` |

#### T-M5-22 Composer 编排入口与 CLI

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-20`、`T-M5-21` |
| 并行关系 | `T-M5-23` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `scripts/composer/index.cjs`、`scripts/composer/cli.cjs` |
| 修改文件 | `package.json`（`composer:build` 指向 CLI、`composer:verify` 指向校验入口） |
| 实现要点 | 1) `compose(options)` 编排 P0–P8，签名与 `ComposeOptions/ComposeResult` 一致；2) `onProgress` 发 `{stage,step,total,message}`，emit 按文件数真实计数；3) `signal.cancelled` 仅 P0–P5 生效，P6/P7 显示不可取消；4) P8 报告写最终目录；5) CLI 支持 `--plan <file> --out <dir> --mode production|development --store-profile <file> --json`，退出码 0/1/2 区分成功/业务失败/参数错误。 |
| 验证方式 | `node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <系统临时目录>/m5-check` 成功；`--plan bad.json` 返回退出码 1 且打印错误码；两次运行进度事件总数等于文件数。 |
| 规则追踪 | `M5-5-01`、`M5-5-02`、`M5-6-01`（进度真实性）、`2.3.1` |

#### T-M5-23 固定 Plan 与 order-classic Recipe 资产

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-22` |
| 并行关系 | `T-M5-24` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/recipes/order-classic/1.0.0/recipe.json`、`plan.json`、`release.json`（M5 阶段 `stage:"candidate"`，M7 晋升） |
| 修改文件 | `templates/registry/registry.v1.json`（登记 `order-classic@1.0.0`）、`registry.lock.json`（重新冻结） |
| 实现要点 | 1) Plan 含 7 页面，至少 4 页必选；插槽可先不分配，验证 fallback；2) `baseTemplate={ordering-base,1.0.0}`、`registryVersion=2026.11.0`、`apiBinding={storefront.v1}`、`themeTokens` 四色且对比度达标；3) `recipe.json` 记录 `planRef/displayName/description/knownLimits`；4) 不引入 `poster-carousel`；5) 这份 Plan 是 M5 的固定基线，后续不得随意改。 |
| 验证方式 | `node --test test/composer-schema.test.cjs` 校验 recipe/plan；`node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <tmp>` 生成成功；`node scripts/validate-miniprogram.cjs --root <tmp>/<project>` 0 错。 |
| 规则追踪 | `M5-5-01`、`M5-5-02`、`6.1` |

#### T-M5-24 Composer 测试套件与旧测试改写

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-23` |
| 并行关系 | 与 `T-M5-25` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | `test/composer-schema.test.cjs`（如未建）、`test/composer-resolve.test.cjs`、`test/composer-emit.test.cjs`、`test/composer-determinism.test.cjs`、`test/composer-atomic.test.cjs`、`test/composer-safety.test.cjs` |
| 修改文件 | `test/generator.test.cjs`（改写为产物契约用例，不再断言旧复制脚本的 4 页/`priceText`） |
| 实现要点 | 1) 每个测试文件只覆盖对应层，使用 `node:test`；2) 使用临时目录（`node:os.tmpdir()`）避免污染仓库；3) `composer-emit` 增加“端到端产物契约”用例替代旧 `generator.test.cjs`；4) 负例矩阵 12 项逐条落地；5) 所有测试必须能在无 Electron、无 MySQL、无微信工具下运行。 |
| 验证方式 | `npm test` 全绿；单独运行 `node --test test/composer-*.test.cjs` 全绿；故意修改一个断言 → 失败（证明测试有效）。 |
| 规则追踪 | `M5-5-02`、`M5-5-03`、`M5-5-05`、`M5-5-06`、`M5-4-03`、`M5-4-06` |

#### T-M5-25 确定性复现验证

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-24` |
| 并行关系 | S2 收口任务 |
| 环境/证据 | `L1` |
| 新建文件 | 无（`test/composer-determinism.test.cjs` 已在 `T-M5-24` 建） |
| 修改文件 | 无（若发现差异则修 `emit.cjs/digest.cjs`） |
| 实现要点 | 1) 固定 `now=2026-11-20T00:00:00Z` 生成 A、`now=2026-11-21T00:00:00Z` 生成 B；2) 断言 `canonical(lockA 去 generatedAt) === canonical(lockB 去 generatedAt)`、`treeSha256` 相同、逐文件 `sha256` 相同；3) 换父目录再生成一次，断言与目标路径无关；4) 篡改一个资产文件但版本不变 → `REGISTRY_DRIFT` 且拒绝生成。 |
| 验证方式 | `node --test test/composer-determinism.test.cjs` 全绿；报告记录两个 `treeSha256` 值到 `docs/evidence/m5/s2.md`。 |
| 规则追踪 | `M5-4-06`、`4.2.1`、`M5-1-07` |

### 2.4 S3 桌面接线与打包修复

#### T-M5-26 Electron 主进程 Composer IPC

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-25` |
| 并行关系 | 与 `T-M5-27/28/29/30/31/34` 可并行 |
| 环境/证据 | `L2` |
| 新建文件 | 无 |
| 修改文件 | `desktop/main.cjs`（旧 `generator:export` 改为转发 `composerExport`，新增 `composer:*` handlers；保留 `generator:open-path/pick-materials/save-image`；彻底移除旧入口在 `T-M5-35`） |
| 实现要点 | 1) 新增 `composer:validate/export/cancel/read-report/choose-directory`；2) 每个 handler 首行校验 `event.senderFrame.url` 以 `file://` 或 `http://127.0.0.1:5173/` 开头；3) `approvedParents:Set` 只接受 `chooseExportDirectory` 返回路径；4) 入参 `JSON.stringify ≤256 KB`、`plan ≤64 KB` → `PAYLOAD_TOO_LARGE`；5) 主进程再次执行 P0–P2，不信任渲染进程；6) `activeTask` 单例，第二次 → `EXPORT_BUSY`；7) 进度每 50 文件或 200ms 先到者发送；8) 打包态 `app.getAppPath()` 定位 `templates/registry`。 |
| 验证方式 | `node --test test/desktop-contract.test.cjs`（`T-M5-33` 创建）：未获白名单的 `parentDir` → `TARGET_NOT_WRITABLE`；超体积 → `PAYLOAD_TOO_LARGE`；并发 → `EXPORT_BUSY`；非桌面来源 → 拒绝。 |
| 规则追踪 | `M5-6-01`、`M5-6-02`、`M5-6-04`、`M5-7-04`、`2.5.1` |

#### T-M5-27 preload 桥接扩展

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-26` |
| 并行关系 | 与 `T-M5-28` 并行 |
| 环境/证据 | `L2` |
| 新建文件 | 无 |
| 修改文件 | `desktop/preload.cjs`（新增 `composerValidate/composerExport/composerCancel/composerReadReport/onComposerProgress/chooseExportDirectory`，保留 `isDesktop/exportProject/openPath/pickMaterials/saveImage`） |
| 实现要点 | 1) `onComposerProgress(listener)` 注册 `ipcRenderer.on` 并返回退订函数；2) `exportProject` 标 `@deprecated` 并内部转发 `composerExport`（S3 后移除）；3) 只暴露白名单方法，不暴露 `ipcRenderer` 本身；4) 参数与返回值可直接结构化克隆。 |
| 验证方式 | `node --test test/desktop-contract.test.cjs` 断言桥接对象键集合与函数形状；`onComposerProgress` 返回函数可用；旧 `exportProject` 仍存在。 |
| 规则追踪 | `M5-6-01`、`M5-6-03`、`M5-6-09`、`2.5.1` |

#### T-M5-28 exportService 服务层

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-25` |
| 并行关系 | 与 `T-M5-27/29` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `src/services/exportService.js` |
| 修改文件 | 无 |
| 实现要点 | 1) 暴露 `isDesktopExportAvailable/subscribeProgress/chooseDirectory/validatePlan/exportProject/cancelExport/openProjectDirectory/readReport`；2) 非桌面 → `{status:'desktop-required'}`，不发请求、不写文件；3) `EXPORT_ERROR_TEXT` 错误码→中文文案映射，UI 只展示 `message`；4) `openProjectDirectory` 目录被删 → `{ok:false,message:'目录不存在，可重新导出'}`；5) 不把 Token/路径写日志。 |
| 验证方式 | `node --test test/export-service.test.cjs`（`T-M5-33` 创建）：无 `window.smartStore` → `desktop-required`；`TARGET_EXISTS` → 中文建议；`openProjectDirectory` 失败文案正确。 |
| 规则追踪 | `M5-6-04`、`M5-6-09`、`2.5.3` |

#### T-M5-29 planFromSession 与主题预设

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-25` |
| 并行关系 | 与 `T-M5-28/30` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `src/composition/planFromSession.mjs`、`src/composition/themePresets.mjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 纯函数：不读时间、不读文件、不做 IO；2) 映射 `build.selectedId→baseTemplate/recipe`、`features.selected→features[]`、`visual.styleId→themeTokens`、`agentDraft→storeProfile`；3) 固定 7 页面与插槽预设；4) 未映射能力 → `unmappedCapabilities[]` 警告；5) `themePresets` 只从 Base `theme.tokens.json.presets[]` 派生，不重复定义颜色。 |
| 验证方式 | `node --test test/compose-plan-from-session.test.cjs`（`T-M5-33` 创建）：同一 state 两次调用深相等；未知模板 → 回落 `order-classic` + 警告；未映射能力进入清单。 |
| 规则追踪 | `M5-6-06`、`M5-5-09`、`2.5.7` |

#### T-M5-30 会话状态机增量改造

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-28`、`T-M5-29` |
| 并行关系 | 与 `T-M5-31` 可并行（不同文件） |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `src/state/constants.mjs`（末尾新增 `DEPLOY_STATUS`，不动 `PHASES/CLOSED_PHASES`）、`src/state/sessionMachine.mjs`（`deploy` 初始字段扩展 + 8 个新 case，保留 `DEPLOY_PROGRESS/DEPLOY_DONE`）、`src/domain/onboardingScript.mjs`（替换 `DEPLOY_STEPS` 与 `DEPLOY_INTRO`） |
| 实现要点 | 1) `DEPLOY_STEPS=['校验配置','生成工程','检查产物','导入微信开发者工具（外部）']`；2) `DEPLOY_INTRO` 去掉“上线/演示环境”表述；3) 新增 `DEPLOY_START/DEPLOY_DIRECTORY_CHOSEN/DEPLOY_STAGE/DEPLOY_SUCCESS/DEPLOY_FAILURE/DEPLOY_CONFLICT/DEPLOY_CANCELLED/DEPLOY_RESET`；4) `deploy` 增加 `stage/taskId/directory/projectName/result/error/previewOnly/versionGaps`；5) 不改 `createStepSession`、`APPROVE_IMAGE`、`revealFlush`、`SKIP_INTRO`。 |
| 验证方式 | `node --test test/session-machine.test.cjs` 原断言全绿；`node --test test/reveal-transition.test.cjs` 全绿；新增 DEPLOY action 用例通过；`grep` 确认 `PHASES` 数量与 `CLOSED_PHASES` 未变。 |
| 规则追踪 | `M5-6-01`、`M5-6-02`、`M5-6-05`、`M5-6-07`、`M5-6-08` |

#### T-M5-31 DeployStep 与 ExportResultCard

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-28` |
| 并行关系 | 与 `T-M5-30` 可并行 |
| 环境/证据 | `L1`（组件渲染）+ `L2`（实际交互） |
| 新建文件 | `src/components/build/ExportResultCard.jsx` |
| 修改文件 | `src/components/build/DeployStep.jsx`（保留文件与导出名，新增 props；六态渲染） |
| 实现要点 | 1) 六态：`idle/choosing/validating|generating|verifying/done/failed/conflict/cancelled`；2) 真实四步列表 + 真实进度，取消仅前两阶段可用；3) 成功卡片展示路径（可复制）、打开目录、Recipe/Lock 版本、preview-only 徽标、版本缺口；4) 失败显示中文原因 + 弱化错误码 + 重试/更换目录；5) 文案红线：不出现“上传/已发布/已提交审核/部署成功”，成功标题为“工程已生成”；6) 组件只收 props、只发事件。 |
| 验证方式 | `node --test test/desktop-contract.test.cjs` 或组件测试断言文案词表零命中；人工在 `npm run desktop` 中逐态截图（`docs/evidence/m5/s3.md`）。 |
| 规则追踪 | `M5-6-02`、`M5-6-03`、`M5-6-04`、`M5-6-05`、`M5-6-07` |

#### T-M5-32 App.jsx 导出接线

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-26`…`T-M5-31` |
| 并行关系 | S3 关键串行点 |
| 环境/证据 | `L2` |
| 新建文件 | 无 |
| 修改文件 | `src/App.jsx`（仅替换 DEPLOY effect 381–403 + 新增 handlers + DEPLOY 渲染 props；不改其它阶段） |
| 实现要点 | 1) 删除 `setInterval` 假进度；2) 进入 DEPLOY 且 `status==='idle'` → 置 `choosing` 等用户点击；3) 新增 `handleDeployChooseDirectory/Start/Retry/Cancel/OpenPath/CopyPath`；4) 导出前调用 `planFromSession` 得到唯一 Plan；5) 订阅进度并 dispatch `DEPLOY_STAGE`；6) 失败/取消回到可重试状态，2 秒内恢复；7) 重复点击由主进程 `EXPORT_BUSY` + 本地忙碌态双重拦截。 |
| 验证方式 | `npm test` 全绿；`npm run desktop` 人工：取消无文件、成功后打开目录、重复点击忙碌态（截图/日志到 `docs/evidence/m5/s3.md`）；`grep -n "setInterval" src/App.jsx` 在 DEPLOY effect 中零命中。 |
| 规则追踪 | `M5-6-01`、`M5-6-02`、`M5-6-03`、`M5-6-04`、`M5-6-08`、`M5-6-09` |

#### T-M5-33 桌面契约与服务层测试

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-32` |
| 并行关系 | `T-M5-36` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `test/desktop-contract.test.cjs`、`test/export-service.test.cjs`、`test/compose-plan-from-session.test.cjs` |
| 修改文件 | `test/session-machine.test.cjs`（仅新增 DEPLOY 用例，不改原断言）、`test/reveal-transition.test.cjs`（不改，确认全绿） |
| 实现要点 | 1) `desktop-contract` 用桩 `ipcMain/ipcRenderer` 测 handler 形状、来源校验、体积上限、`TARGET_EXISTS` 建议名、`desktop-required`；2) `export-service` 测环境判定与错误码中文映射；3) `compose-plan-from-session` 测纯函数与 `unmappedCapabilities`；4) 所有测试不启动 Electron。 |
| 验证方式 | `npm test` 全绿；`npm run test:desktop` 可执行且全绿（补齐 BUG-009）；`node --test test/reveal-transition.test.cjs` 全绿。 |
| 规则追踪 | `M5-6-01`…`M5-6-09`、`M5-7-04`、`BUG-009` |

#### T-M5-34 打包资源契约检查与 build.files 修复

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-26` |
| 并行关系 | 与 `T-M5-35` 串行 |
| 环境/证据 | `L1`/`L2` |
| 新建文件 | `scripts/check-packaging.cjs` |
| 修改文件 | `package.json`（`build.files` 增加 `templates/registry/**`、`templates/base/**`、`templates/components/**`、`templates/features/**`、`templates/recipes/**`、`scripts/composer/**`；新增 `check:packaging`） |
| 实现要点 | 1) 内置 glob 匹配器（`**`、`*`、目录后缀），不引新依赖；2) 必需路径清单 = 注册表索引/lock/schema、所有资产 `manifest.json` + `entry.files`、`scripts/composer/**`、`dist/index.html`、`desktop/**`、`package.json`；3) 缺任一 → 退出码 1 并打印缺失路径；4) 同时断言 `scripts/generate-mini-program.cjs` 不在 `files` 中（M5-2-08）。 |
| 验证方式 | `node scripts/check-packaging.cjs` 退出码 0；从清单移除 `templates/base/ordering-base/1.0.0/manifest.json` → 退出码 1 且指出缺失项；`npm run build` 后再次运行仍 0。 |
| 规则追踪 | `M5-7-01`、`M5-7-04`、`M5-2-08`、`BUG-006` |

#### T-M5-35 旧导出脚本退出主链

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-34` |
| 并行关系 | S3 收口任务之一 |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `scripts/generate-mini-program.cjs`（文件头标 `@deprecated`，说明仅历史追溯）、`desktop/main.cjs`（不再 `require` 该脚本）、`package.json`（移除 `mini:example` 或标注 deprecated；`files` 已移除该脚本） |
| 实现要点 | 1) 旧脚本不再被任何运行时路径引用；2) 保留文件供追溯，但不得出现在安装包；3) 报告中不得出现“复制模板”路径；4) 旧主题锚点替换路径彻底关闭（`THEME_REPLACE_ANCHOR_MISSING` 由新链路负责）。 |
| 验证方式 | `grep -R "generate-mini-program" desktop scripts src test --include=*.cjs --include=*.js --include=*.jsx --include=*.mjs` 仅命中脚本自身注释；`node scripts/check-packaging.cjs` 通过；生成报告 `grep "复制模板"` 零命中。 |
| 规则追踪 | `M5-5-09`、`M5-2-08`、`M5-7-06`、`BUG-008` |

### 2.5 M5 人工与环境验收

#### T-M5-36 桌面真实导出验收

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-33`、`T-M5-34` |
| 并行关系 | `T-M5-37/38` 依赖本任务 |
| 环境/证据 | `L2`（本机 Electron 运行） |
| 新建文件 | `docs/evidence/m5/s3.md` |
| 修改文件 | 无 |
| 实现要点 | 1) `npm run desktop` 启动；2) 走完会话到 DEPLOY，选择目录并导出；3) 记录真实路径、Recipe/Lock 版本、取消路径、失败路径、重复点击路径；4) 截图/日志必须含时间戳与工程路径；5) 明确“本机运行 ≠ 安装包验收”。 |
| 验证方式 | 导出目录存在 `app.json/config/store.generated.js/composition.lock.json/generation-report.json`；点击“打开目录”能打开；取消后目录不存在；证据写入 `docs/evidence/m5/s3.md`。 |
| 规则追踪 | `M5-6-01`、`M5-6-03`、`M5-6-02`、`M5-6-04` |

#### T-M5-37 路径鲁棒性验收

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-36` |
| 并行关系 | 与 `T-M5-38` 并行 |
| 环境/证据 | `L2` |
| 新建文件 | `docs/evidence/m5/paths.md` + 截图 |
| 修改文件 | 无 |
| 实现要点 | 1) 中文路径、含空格路径、长路径各导出一次；2) 只读目录 → 明确拒绝且原目录不变；3) 同名工程目录 → `TARGET_EXISTS` + 建议名；4) 路径长度预算 240 字符；5) 记录三类路径的完整路径与结果。 |
| 验证方式 | 三次导出均成功且工程可被静态校验；只读目录失败文案正确；同名目录原内容逐字节不变（`sha256` 对比）。 |
| 规则追踪 | `M5-7-03`、`M5-7-05`、`4.2.5` |

#### T-M5-38 Vite 构建与打包资源静态验收

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-36` |
| 并行关系 | `T-M5-39` 依赖本任务 |
| 环境/证据 | `L2` |
| 新建文件 | `docs/evidence/m5/s3-packaging.md` |
| 修改文件 | 无 |
| 实现要点 | 1) `npm run build` 通过；2) `node scripts/check-packaging.cjs` 通过；3) 记录 `dist/` 产物清单与 `build.files` 覆盖结果；4) 明确 L2 只能证明“资源包含静态正确”，不能证明“安装后可导出”。 |
| 验证方式 | 两条命令均退出码 0；证据文档记录命令、时间、退出码、缺失项（应为 0）。 |
| 规则追踪 | `M5-7-01`、`M5-7-04` |

#### T-M5-39 NSIS 安装包构建

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-38` |
| 并行关系 | `T-M5-40` 依赖本任务 |
| 环境/证据 | `L3`（需网络或 builder 缓存/镜像） |
| 新建文件 | `docs/evidence/m5/installer.md` |
| 修改文件 | 无 |
| 实现要点 | 1) 先探测 `%LOCALAPPDATA%\electron-builder\Cache` 是否存在；2) 网络可用 → `npm run build:win`；3) 网络不可用 → 记录失败日志与阻塞原因，**不得**用 `desktop:dev` 冒充；4) 解包 `release/*.exe` 或 `win-unpacked` 列出必需资源；5) 验证 NSIS 不写用户导出目录（安装/卸载脚本只动安装目录）。 |
| 验证方式 | `release/*.exe` 存在；解包清单含 `templates/registry/registry.v1.json`、`scripts/composer/**`；缺失 → 阻断缺陷。网络失败时只交付“L3 未完成 + 原因”。 |
| 规则追踪 | `M5-7-01`、`M5-7-02`、`M5-7-07`、`A8`、`D8` |

#### T-M5-40 干净机安装与微信编译

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-39` |
| 并行关系 | M5 最终验收，`T-CL-01` 前必须明确状态 |
| 环境/证据 | `L4` + `W` |
| 新建文件 | `docs/evidence/m5/installer/`、`docs/evidence/m5/wechat/` |
| 修改文件 | 无 |
| 实现要点 | 1) 干净 Windows 10/11 x64 安装 → 启动 → 导出；2) 微信开发者工具人工导入工程并编译，截图含项目路径与编译成功提示；3) 若 CLI 端口可用，补 `cli.bat` 日志；4) 核心闭环点击走查（扫码→菜单→加购→结算→下单→演示付款→接单→完成）；5) 未执行项必须显式写“未执行 + 原因”，不得勾选 M5-7-02。 |
| 验证方式 | 安装截图 + 导出截图 + 微信编译截图 + 回归截图序列；`docs/待完成目标.md` 的 M5-7-02 仅在 L4 完成时勾选。 |
| 规则追踪 | `M5-7-02`、`M5-5-01`、`A7`、`A8`、`D8` |
---

## 3. M6 阶段任务（生成器与后端联通 B3）

> 本阶段可自 `T-M5-02/03` 契约口径冻结后启动，与 M5 的 S2/S3 **并行**；但 `T-M6-14` 真实联调必须等 `T-M6-07` 与 `T-M6-09` 都完成。
> 后端默认按 D1 批准新增受控导入写接口；若用户否决，按 `T-M6-15` 的降级口径把 M6-1 标记为未完成，不得以 `PATCH` 拼凑。

#### T-M6-01 B3 契约文档先行

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-02`（契约写法口径） |
| 并行关系 | 与 M5 S2/S3 并行；`T-M6-02` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `docs/evidence/m6/s4.md`（草稿） |
| 修改文件 | `docs/api.md`（新增第 10 节“B3 受控导入增补”，原章节不改）、`docs/backend-data-model.md`（增补 `stores.config_version` 与 `store_imports`）、`docs/README.md`（索引补一行，可选） |
| 实现要点 | 1) 冻结三个接口：`POST /merchant/stores/:storeId/imports`、`GET .../imports/:importId`、`GET /stores/:storeId/tables`；2) 冻结 `GET /stores/:storeId` 增补 `configVersion/catalogVersion`；3) 写全请求/响应字段、`Idempotency-Key`、`mode=preview|apply`、`previewToken`、`confirmations`、`conflicts/notImported/cacheRefreshed`；4) 写全错误码表（403/404/409/422）与用户文案；5) 明确“先改文档再改实现”（C7）。 |
| 验证方式 | 人工逐项对照方案 2.6.1/2.6.7；`grep -n "B3 受控导入" docs/api.md` 命中；Markdown 相对链接检查通过；`docs/evidence/m6/s4.md` 记录契约冻结结论。 |
| 规则追踪 | `M6-1-01`、`M6-1-05`、`M6-1-06`、`M6-1-08`、`4.5.4`、`C7` |

#### T-M6-02 数据模型与迁移

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-01` |
| 并行关系 | `T-M6-03/04/06` 可在本任务后并行 |
| 环境/证据 | `L1`（需本地 MySQL，按 `docs/backend-local-dev.md`） |
| 新建文件 | `server/prisma/migrations/<timestamp>_add_imports_and_config_version/migration.sql` |
| 修改文件 | `server/prisma/schema.prisma`（`Store.configVersion Int @default(0)`、`Store.imports`、`User.imports`、`model StoreImport`）、`server/prisma/seed.ts`（create 分支 `configVersion:1`，更新分支不覆盖） |
| 实现要点 | 1) 字段与方案 2.6.2 一致，含 `@@unique([storeId,userId,idempotencyKey])`、`@@index([storeId,createdAt])`；2) 迁移 SQL 显式写 `config_version INT NOT NULL DEFAULT 0` 与 `store_imports` 全字段、外键；3) 不在 `StoreTable` 加数据库唯一约束（现有数据风险），桌号唯一由应用层校验；4) 迁移可重复执行于已有数据。 |
| 验证方式 | `cd server && npm run db:migrate` 成功；`npm run db:seed` 可重复执行；`mysql` 查询 `SHOW COLUMNS FROM stores LIKE 'config_version'` 与 `SHOW TABLES LIKE 'store_imports'` 均存在；`npx prisma validate` 通过。 |
| 规则追踪 | `M6-1-02`、`M6-1-09`、`6.5.2`、`A2` |

#### T-M6-03 OWNER 守卫与差异纯函数

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-02` |
| 并行关系 | 与 `T-M6-04/06` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `server/src/common/auth/store-owner.guard.ts`、`server/src/imports/import-diff.ts`、`server/test/b3-import-diff.test.ts`（可与 `T-M6-07` 合并） |
| 修改文件 | 无 |
| 实现要点 | 1) `StoreOwnerGuard`：无 `storeId` → 400；无用户 → 401；无 membership → 403；`role!=='OWNER'` → 403（STAFF 明确拒绝）；通过后写 `request.storeMembership`；2) `import-diff.ts` 纯函数：`profile/category/product/table` 四类匹配键与差异字段按 2.6.4；3) 默认动作 `skip`，不静默改价、不静默上架、不删除未声明项；4) 请求内唯一性校验（重复 `draftKey/draftId`、分类重名、同分类商品重名、桌号重名）。 |
| 验证方式 | `cd server && npx vitest run test/b3-import-diff.test.ts`（或 `npm test`）：价格不同 → 冲突且默认 skip；`available=false` 未声明 → 冲突；STAFF 调用 → 403；重复桌号 → `DUPLICATE_TABLE`。 |
| 规则追踪 | `M6-1-03`、`M6-1-04`、`M6-1-05`、`M6-1-07`、`M6-2-07` |

#### T-M6-04 导入 DTO、Controller 与模块注册

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-02` |
| 并行关系 | 与 `T-M6-03/06` 并行；`T-M6-05` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `server/src/imports/imports.dto.ts`、`server/src/imports/imports.controller.ts`、`server/src/imports/imports.module.ts` |
| 修改文件 | `server/src/app.module.ts`（注册 `ImportsModule`） |
| 实现要点 | 1) 路由与方案 2.6.1 一致，`@UseGuards(SessionAuthGuard, StoreOwnerGuard)`；2) `Idempotency-Key` 在 `mode=apply` 必填，8–128 可见 ASCII；3) DTO 校验：分类 ≤3、商品 3–5、桌号 ≤20、`priceCents` 1–999999、营业时间正则/1–3 段/不重叠/拼接 ≤64、`delivery` 出现必须 `false`、图片/加价/规格字段拒绝；4) 错误码映射到 403/404/409/422；5) 请求体大小上限与 `sourceDraftDigest` 64 hex 校验。 |
| 验证方式 | `cd server && npm run build` 通过；`npx vitest run test/b3-imports.test.ts`（`T-M6-07`）：非法价格 → `422 PRICE_RANGE`；2 道菜 → `422 VALIDATION_ERROR`；重复分类 → `DUPLICATE_CATEGORY`；`delivery:true` → 422。 |
| 规则追踪 | `M6-1-01`、`M6-1-06`、`6.5.1`、`6.5.3`、`6.5.4` |

#### T-M6-05 导入事务、幂等、映射与缓存

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-03`、`T-M6-04` |
| 并行关系 | `T-M6-07` 依赖本任务 |
| 环境/证据 | `L1`（需真实 MySQL 测试库） |
| 新建文件 | `server/src/imports/imports.service.ts` |
| 修改文件 | 无 |
| 实现要点 | 1) `preview`：OWNER/门店校验 → DTO → 读既有数据 → `diff` → `previewToken=sha256(canonical(...))` → 预分配 mapping，不写库、不消耗幂等键；2) `apply`：`requestHash` 查 `(storeId,userId,key)`，同 hash 返回原 `resultJson`，不同 → 409 `IDEMPOTENCY_CONFLICT`；校验 `previewToken` 未过期（`PREVIEW_STALE`）；`confirmations` 覆盖全部冲突（`CONFIRMATION_REQUIRED`）；3) 单 `$transaction`：upsert 分类/商品/桌号 → 更新门店 profile → `configVersion+1`、`catalogVersion+1` → 写 `store_imports(status='APPLIED')`；4) 任一步失败整体回滚，不留 PENDING；5) 事务外 `cache.invalidate('catalog:'+storeId)`，失败写 `cacheRefreshed:false` 不回滚；6) 捕获 `P2002` 重查返回幂等重放；7) `mapping` 覆盖全部导入项，缺项即失败；8) `notImported` 列出图片/加料/规格。 |
| 验证方式 | `cd server && npm run build && npm test`：双击 apply 只产生一份；同键不同内容 → 409；未确认冲突 → 422；注入事务中途失败 → 数据与导入前一致；导入后 `GET /catalog` 返回新 `version`；`cacheRefreshed` 语义正确。 |
| 规则追踪 | `M6-1-01`…`M6-1-10`、`M6-2-08`、`6.5` |

#### T-M6-06 公开门店字段与桌号接口

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-01` |
| 并行关系 | 与 `T-M6-03/04` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `server/src/stores/tables.dto.ts`（如现有风格需要） |
| 修改文件 | `server/src/stores/stores.service.ts`（`PublicStoreView` 增 `configVersion/catalogVersion`；新增 `listTables(storeId)`）、`server/src/stores/stores.controller.ts`（`GET :storeId/tables`）、`server/src/stores/stores.module.ts`（如需要） |
| 实现要点 | 1) `GET /stores/:storeId` 同时返回 `configVersion` 与 `catalogVersion`，一次取全减少请求；2) `GET /stores/:storeId/tables` 公开只读，只返回 `{id,name,sortOrder}`，不返回订单/占用；3) 门店不存在 → 404 `STORE_NOT_FOUND`；4) 不改变既有 `GET /stores/:storeId` 其它字段与错误语义。 |
| 验证方式 | `cd server && npm run build`；`npx vitest run test/b3-config-version.test.ts test/b3-tables.test.ts`：返回字段齐全、排序稳定、404 正确、跨店桌号下单仍 `TABLE_NOT_FOUND`。 |
| 规则追踪 | `M6-1-09`、`M6-3-04`、`A3`、`17.1` |

#### T-M6-07 服务端导入测试与构建

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-05`、`T-M6-06` |
| 并行关系 | `T-M6-14` 依赖本任务 |
| 环境/证据 | `L1`（真实 MySQL 测试库，不用 mock Prisma） |
| 新建文件 | `server/test/b3-imports.test.ts`、`server/test/b3-config-version.test.ts`、`server/test/b3-tables.test.ts` |
| 修改文件 | `server/test/setup.ts`（如需清理 `store_imports`）、`server/test/helpers/**`（如需登录/建店夹具） |
| 实现要点 | 1) `b3-imports` 覆盖：preview 不写库、apply 幂等重放、同键异内容 409、冲突默认 skip、逐项确认、STAFF/跨店 403、分类/商品/桌号唯一性、价格/营业时间边界、整体回滚、映射完整性、`notImported`、`cacheRefreshed`；2) `b3-config-version` 覆盖：导入后两版本递增、公开接口返回字段；3) `b3-tables` 覆盖：公开只读、排序、404、无订单字段；4) 计时断言宽松 ≤5s（4.1.4）。 |
| 验证方式 | `cd server && npm run build && npm test`：新增文件全绿，既有 139 项无回归；测试使用独立测试库并在结束后清理。 |
| 规则追踪 | `M6-1-01`…`M6-1-10`、`6.4`、`4.1.4`、`4.2.4` |

#### T-M6-08 桌面 importService

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-01` |
| 并行关系 | 与后端 `T-M6-03/04/05` 并行开发，联调在 `T-M6-14` |
| 环境/证据 | `L1`/`L2` |
| 新建文件 | `src/services/importService.js` |
| 修改文件 | `.env.example`（仅新增 `VITE_IMPORT_AUTH_MODE=demo` 说明，若团队批准） |
| 实现要点 | 1) A15：`VITE_IMPORT_AUTH_MODE=demo` 时调 `POST /auth/wechat/login`（`demoOpenId=demo-owner-001`）取 Token，只存内存，不进 `localStorage`/日志/导出工程；2) 暴露 `previewImport/applyImport/getImport/refreshCatalog`；3) `403 DEMO_LOGIN_DISABLED` → `{status:'auth-unavailable'}` 并禁用入口；4) 错误码→中文文案；5) 不把 Token/映射写入 `store.generated.js`；6) 幂等键由桌面端生成（`crypto.randomUUID`）。 |
| 验证方式 | `node --test test/import-service.test.cjs`（`T-M6-10`）：无 Token → `auth-unavailable`；错误码映射正确；Token 不落盘断言；`sourceDraftDigest` 稳定。 |
| 规则追踪 | `M6-1-05`、`M6-2-01`…`M6-2-08`、`A15`、`D5` |

#### T-M6-09 导入差异确认 UI 与状态

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-07`、`T-M6-08` |
| 并行关系 | `T-M6-14` 依赖本任务 |
| 环境/证据 | `L2` |
| 新建文件 | `src/components/build/ImportDiffCard.jsx` |
| 修改文件 | `src/App.jsx`（DEPLOY 面板内嵌导入区块，**不新增 phase**）、`src/state/sessionMachine.mjs`（`deploy.import` 子状态 + 4 个 action） |
| 实现要点 | 1) 展示逐项差异：实体、键、后端值、草稿值、可选动作（跳过/更新/新建）；2) 未确认全部冲突不得提交；3) `notImported` 明确展示“图片/加料/规格未导入”；4) 导入失败/缓存未刷新可重试；5) 不出现“已上线/已发布”；6) 组件只 props/events。 |
| 验证方式 | `npm test` 全绿；`npm run desktop` 人工：预检 → 差异 → 逐项选择 → apply → 版本递增（截图/日志到 `docs/evidence/m6/s5.md`）。 |
| 规则追踪 | `M6-1-04`、`M6-2-05`、`M6-2-07`、`M6-1-09` |

#### T-M6-10 前端导入服务测试

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-08` |
| 并行关系 | 与 `T-M6-09` 可并行 |
| 环境/证据 | `L1` |
| 新建文件 | `test/import-service.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) 用桩 `fetch` 测请求形状、幂等键、错误码映射；2) 断言 Token 不出现在返回值/日志桩；3) 断言 `AgentDraft` 映射：3–5 菜、整数分、营业时间数组、履约开关、店名/品类；4) 断言未支持字段进入 `notImported`。 |
| 验证方式 | `node --test test/import-service.test.cjs` 全绿；`npm test` 全绿。 |
| 规则追踪 | `M6-2-01`…`M6-2-08` |

#### T-M6-11 store.generated v2 生成器与白名单

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-18`、`T-M6-01` |
| 并行关系 | `T-M6-12/13` 依赖本任务；M7 资产依赖本任务的 v2 契约 |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `scripts/composer/emit.cjs`（v2 组装：`meta` 九项、`store/api/catalog/fulfillmentOptions/theme/capabilities/demoPaymentDisclaimer`）、`scripts/composer/schema.cjs`（复用 `allowedKeys` 白名单） |
| 实现要点 | 1) 字段白名单机械校验在**生成前**执行，任何未知键 → `PLAN_FIELD_FORBIDDEN`；2) `meta` 必含 `configSchemaVersion/storeConfigVersion/catalogVersion/apiContractVersion/recipeId/recipeVersion/lockDigest/generatedAt/generatorVersion/planDigest/mode/versionGaps`；3) `production` 下 `api.baseUrl` 非 HTTPS → 拒绝；`development` 允许本地地址并在 README 标注“仅本地演示”；4) `delivery` 固定 `false`；5) `capabilities.onlineReady` 与 `previewOnly` 交集必须为空；6) 旧 v1 配置 → `STORE_CONFIG_SCHEMA_UNSUPPORTED`，不静默读取；7) 无后端版本 → `null` + `versionGaps`，`production` 拒绝（A2 降级）。 |
| 验证方式 | `node --test test/store-config-v2.test.cjs`（`T-M6-13`）：六类版本齐全；多余键失败；`priceText` 出现失败；`delivery:true` 失败；v1 拒绝；非 HTTPS + production 拒绝。 |
| 规则追踪 | `M6-3-01`…`M6-3-07`、`6.4`、`4.3.2` |

#### T-M6-12 小程序版本守卫与桌号读取

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-11` |
| 并行关系 | 与 `T-M6-13` 交替推进 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/base/ordering-base/1.0.0/src/domain/versionGuard.js` |
| 修改文件 | `templates/base/ordering-base/1.0.0/src/services/store.js`（新增 `getTables(storeId)`）、`src/pages/home/index.js`（onLoad 比对 `meta.catalogVersion` 与在线 `version`，落后时提示刷新）、`src/pages/home/index.wxml`（提示条）、`src/services/store.js` 对应 `miniprogram/` 同步（若 `mini:dup-check` 要求） |
| 实现要点 | 1) `compareVersions(local, online)` 纯函数返回 `{stale,shouldRefresh,message}`；2) 在线数据为准，不把导出快照当事实；3) 桌号优先真实接口，`TABLES_API_UNAVAILABLE` 时保留演示兜底并在界面标注；4) 不把版本比较放到组件内（组件不触网）。 |
| 验证方式 | `node --test test/version-guard.test.cjs`：本地版本 < 在线 → 提示；相等 → 不提示；服务层 `getTables` 形状正确；`node scripts/validate-miniprogram.cjs --root templates/base/ordering-base/1.0.0/src` 0 错。 |
| 规则追踪 | `M6-3-06`、`M6-2-01`…`M6-2-04`、`M6-2-06`、`A3` |

#### T-M6-13 配置 v2 与版本守卫测试

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-11`、`T-M6-12` |
| 并行关系 | `T-M6-14` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `test/store-config-v2.test.cjs`、`test/version-guard.test.cjs` |
| 修改文件 | 无 |
| 实现要点 | 1) `store-config-v2` 断言白名单、`meta` 六类版本、`delivery`、`demoPaymentDisclaimer`、v1 拒绝、production HTTPS；2) `version-guard` 断言落后/相等/在线更新三种分支；3) 断言 `priceCents` 是唯一金额事实（无 `priceText`）。 |
| 验证方式 | `node --test test/store-config-v2.test.cjs test/version-guard.test.cjs` 全绿；`npm test` 全绿。 |
| 规则追踪 | `M6-3-01`…`M6-3-07`、`6.4` |

#### T-M6-14 前后端真实联调

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-07`、`T-M6-09`、`T-M6-13` |
| 并行关系 | `T-M6-15` 依赖本任务 |
| 环境/证据 | `L1`/`L2`（需 MySQL；Redis 可选，memory 降级需标注） |
| 新建文件 | `docs/evidence/m6/s4.md`、`docs/evidence/m6/s5.md`（最终版） |
| 修改文件 | 无（联调发现缺陷时按 `docs/bugs/` 新建条目） |
| 实现要点 | 1) 启动后端（`CACHE_DRIVER=memory` 或真实 Redis）；2) 桌面 demo 登录取 Token；3) `GET /stores/:storeId`、`/catalog`、`/tables` 读数；4) `POST preview` → 逐项确认 → `POST apply`；5) 校验 `storeConfigVersion/catalogVersion` 递增、`mapping` 数量、`cacheRefreshed`；6) 重复 apply 返回同一结果；7) 记录脱敏请求/响应摘要，不记录 Token。 |
| 验证方式 | 证据文档含命令、时间、版本号、mapping 条数、幂等重放结果；`cd server && npm test` 全绿作为前置；桌面截图/日志齐全。 |
| 规则追踪 | `M6-1-01`…`M6-1-10`、`M6-3-04`、`4.1.4` |

#### T-M6-15 M6 门禁汇总

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M6-14` |
| 并行关系 | M7 可在本任务前启动资产开发，但 M7 的“生成 + 导入闭环”证据依赖本任务 |
| 环境/证据 | `L1`/`L2` |
| 新建文件 | `docs/evidence/m6/s4.md`、`docs/evidence/m6/s5.md`（定稿） |
| 修改文件 | `docs/待完成目标.md`（M6 勾选草案，最终在 `T-CL-03`） |
| 实现要点 | 1) 汇总 `cd server && npm run build && npm test`、`npm test`、真实联调结果；2) 逐条列出 M6-1/2/3 的通过/未通过；3) 若 D1 被否决，明确写“M6-1 未完成，降级为只读导出 + 快照”，不得勾选；4) 列出遗留项（图片/加料/规格不导入、demo 登录仅开发）。 |
| 验证方式 | 门禁表逐项有命令与结果；未通过项有原因与后续动作。 |
| 规则追踪 | `M6-1`、`M6-2`、`M6-3` 全部 |

---

## 4. M7 阶段任务（模板资产扩展）

> 上限纪律：1 Base、3 UI Block、1 Feature Pack、3 Recipe。广告位与优惠券本轮**只登记门禁与 schema**，不实现资产。
> 每个资产必须有独立验收记录，禁止“整包通过”替代单项证据。

#### T-M7-01 store-header 资产

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-07`、`T-M6-11`（v2 配置口径） |
| 并行关系 | 与 `T-M7-02/03/04` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/components/store-header/1.0.0/manifest.json`、`src/index.{js,json,wxml,wxss}`、`preview/{normal,empty,error,long}.json` |
| 修改文件 | 无（源组件从 `miniprogram/components/store-header` 迁出，`miniprogram/` 保留为镜像） |
| 实现要点 | 1) Manifest 按 `manifest.v1` 填全，`kind:"ui-block"`、`baseRange:"^1.0.0"`、`boundary` 四项全 `false`；2) props 与实现双向一致（`storeName/tableName/businessHours/mode`）；3) 四类预览数据可解析且不超 64 KB；4) 组件不触网/不路由/不读 `globalData`/不依赖服务层；5) 与 Base 镜像内容一致（`mini:dup-check`）。 |
| 验证方式 | `node --test test/composer-assets.test.cjs`（`T-M7-05`）：Manifest 完整、四类预览存在、interface 一致、boundary 全 false；`npm run mini:dup-check` 通过。 |
| 规则追踪 | `M7-1-01`、`M7-1-02`、`M7-3-01`、`M7-3-02`、`M7-3-04` |

#### T-M7-02 product-card 资产

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-07`、`T-M6-11` |
| 并行关系 | 与 `T-M7-01/03/04` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/components/product-card/1.0.0/manifest.json`、`src/index.{js,json,wxml,wxss}`、`preview/{normal,empty,error,long}.json` |
| 修改文件 | 无 |
| 实现要点 | 1) Manifest 字段齐全，`requiredPages:["menu"]`；2) props 与实现一致，`disabled` 只由页面传入；3) 金额只展示 `priceCents` 派生文本，不引入第二份金额事实；4) 四类预览（空菜单、超长菜名、缺价异常等）；5) boundary 全 false。 |
| 验证方式 | `node --test test/composer-assets.test.cjs` 通过；生成产物中 `product-card` 的 props 绑定与 `slotProps` 键一致。 |
| 规则追踪 | `M7-1-01`、`M7-1-02`、`M7-3-01`、`M7-3-02`、`M6-2-06` |

#### T-M7-03 cart-bar 资产

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-07`、`T-M6-11` |
| 并行关系 | 与 `T-M7-01/02/04` 并行 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/components/cart-bar/1.0.0/manifest.json`、`src/index.{js,json,wxml,wxss}`、`preview/{normal,empty,error,long}.json` |
| 修改文件 | 无 |
| 实现要点 | 1) Manifest 字段齐全；2) props 与实现一致（`totalCents/quantity/disabled`），事件 `select`/`submit` 属于动词集；3) 金额只展示 `totalCents`，无 `priceText`；4) 四类预览含空购物车、超长数量；5) boundary 全 false。 |
| 验证方式 | `node --test test/composer-assets.test.cjs` 通过；产物 `usingComponents` 与 WXML 标签一致。 |
| 规则追踪 | `M7-1-01`、`M7-1-02`、`M7-3-01`、`M7-3-02`、`M6-2-06` |

#### T-M7-04 poster-carousel Feature Pack

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M5-07`、`T-M5-09` |
| 并行关系 | 与 `T-M7-01/02/03` 并行 |
| 环境/证据 | `L1`（静态）+ `W`（编译在 `T-M7-10`） |
| 新建文件 | `templates/features/poster-carousel/1.0.0/manifest.json`、`src/components/hero-carousel/index.{js,json,wxml,wxss}`、`src/pages/home.extend.json`、`preview/{normal,empty,error,long}.json`、`assets/{poster-01.png,poster-02.png,poster-03.png}` |
| 修改文件 | 无 |
| 实现要点 | 1) Manifest `kind:"feature-pack"`、`dependencies:[{id:"hero-carousel",version:"1.0.0"}]`、`requiresSlots:["home-hero"]`、`visual.assets` 约束 PNG/750×360/单张 ≤200KB/总量 ≤600KB；2) `hero-carousel` props：`items/autoplay/interval/showIndicator`，`interval` 越界取默认；事件 `select{index}`；3) 图片 `binderror` → 占位“海报加载失败”，空 items → 高度降为 120rpx；4) 关闭时首页回落 `store-header` fallback；5) `home.extend.json` 只声明插槽与钩子名；6) `release.status` 按 A5 标 `online-ready`，`knownLimits` 标注“演示素材，店主可替换”；7) 素材为仓库自制，不含第三方版权内容。 |
| 验证方式 | `node --test test/composer-assets.test.cjs` 通过；`node scripts/composer/cli.cjs --plan templates/recipes/order-poster/1.0.0/plan.json --out <tmp>` 产物含 `hero-carousel`；`W` 编译后开关两态截图（`T-M7-10`）。 |
| 规则追踪 | `M7-1-01`、`M7-1-03`、`M7-3-01`、`M7-3-02`、`M7-4-01`、`A5`、`D3` |

#### T-M7-05 资产全量校验

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-01`…`T-M7-04` |
| 并行关系 | `T-M7-06` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `test/composer-assets.test.cjs`（追加资产用例）、`scripts/composer/registry.cjs`（资产校验聚合入口） |
| 实现要点 | 1) 遍历注册表所有资产：Manifest 必填字段、`identity.version` 与目录一致、入口存在且路径合法；2) 四类预览数据可解析、字段完整、体积 ≤64 KB；3) `interface` 与实现一致；4) `boundary` 断言（UI Block 四项 false，Feature Pack 仅 pages/services 可触网）；5) 兼容声明可执行（`baseRange/minWechatLib/apiContract`）；6) 任一失败阻断后续 Recipe。 |
| 验证方式 | `node --test test/composer-assets.test.cjs` 全绿；人为删除一份 `preview/empty.json` → 失败并指出资产与缺失键；把 `boundary.allowNetwork` 改为 true → 失败。 |
| 规则追踪 | `M7-3-01`、`M7-3-02`、`M7-3-03`、`M7-3-04` |

#### T-M7-06 三份 Recipe 与发布/候选元数据

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-05` |
| 并行关系 | `T-M7-07` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/recipes/order-poster/1.0.0/{recipe.json,plan.json,release.json}`、`templates/recipes/order-classic-candidate/0.1.0/{recipe.json,plan.json,candidate.json}` |
| 修改文件 | `templates/recipes/order-classic/1.0.0/release.json`（由 candidate 改为 direct 的字段先留空，晋升在 `T-M7-08/11` 填证据） |
| 实现要点 | 1) `order-classic` 不含海报；`order-poster` 在 `home-hero` 分配 `hero-carousel`（props `asset:poster-carousel/posters`）；2) `order-classic-candidate@0.1.0` 只作候选机制样本，`stage:"candidate"`，不进店主可选；3) `recipe.json` 含 `planRef/displayName/description/recipe{stage,verifiedAt,wechatCompile,regression,secretScan,approvals,knownLimits}`；4) `release.json` 记录版本、验证时间、编译结果、审核结论、已知限制；5) `direct` 四类证据缺一 → 注册表校验失败。 |
| 验证方式 | `node --test test/composer-schema.test.cjs` 校验 Recipe；`node scripts/composer/cli.cjs --plan templates/recipes/order-poster/1.0.0/plan.json --out <tmp>` 成功；`node --test test/composer-recipe-stage.test.cjs`（`T-M7-08`）断言缺证据不能 direct。 |
| 规则追踪 | `M7-1-04`、`M7-5-01`、`M7-5-04`、`D7` |

#### T-M7-07 注册表登记、preview 登记与扩展顺序门禁

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-06` |
| 并行关系 | `T-M7-08` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `templates/registry/preview-registry.json`、`templates/registry/expansion-order.json` |
| 修改文件 | `templates/registry/registry.v1.json`（登记 3 Block/1 Pack/3 Recipe）、`registry.lock.json`（重新冻结 `2026.11.0`）、`scripts/registry-check.cjs`（扩展断言） |
| 实现要点 | 1) 资产索引与目录一一对应，版本精确；2) `preview-registry.json` 结构为 `{assetId,capability,businessPurpose,minimalContract,priority,acceptance}`，本轮无 preview-only 资产时保持空数组但仍校验一一对应逻辑；3) `expansion-order.json` = `["poster-carousel","home-marketing","ad-slot","coupon"]`、`requirePreviousDirect:true`；本轮只登记 `poster-carousel`，登记 `ad-slot`/`coupon` → 门禁失败；4) `registry-check` 校验：登记资产必须有 Manifest、`direct` Recipe 必须四证据、顺序不得跳步、preview-only 必须有登记。 |
| 验证方式 | `npm run registry:check` 退出码 0；人为登记 `ad-slot` → 失败并提示“需先完成 poster-carousel 验收”；删除 `preview-registry` 中一条但资产标 preview-only → `PREVIEW_REGISTRY_MISSING`。 |
| 规则追踪 | `M7-2-01`、`M7-4-01`、`M7-4-03`、`4.4.1` |

#### T-M7-08 Recipe 晋升与 preview-only 门禁测试

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-07` |
| 并行关系 | `T-M7-09` 依赖本任务 |
| 环境/证据 | `L1` |
| 新建文件 | `test/composer-recipe-stage.test.cjs` |
| 修改文件 | `scripts/composer/registry.cjs`（`recipe.stage` 校验）、`scripts/composer/resolve.cjs`（`PREVIEW_ONLY_NOT_ACKNOWLEDGED`、`PREVIEW_ONLY_IN_ONLINE_RECIPE`） |
| 实现要点 | 1) `direct` 必须 `wechatCompile/regression/secretScan/approvals` 四类证据齐全；2) 店主可选列表 = `direct` 且未 `expired`；`candidate`/`expired` 只在内部预览；3) Base 主版本升级 → 扫描引用 Recipe，`stage` 改 `expired` 并写 `expiredReason`；4) `preview-only` 进入 `direct` → 拒绝；Plan 含 preview-only 且 `previewOnlyAck=false` → 拒绝；5) 组合负例矩阵（缺依赖/冲突/循环/重复页面/路径逃逸/容量/类型/重复插槽/未登记插槽/契约不兼容/低对比/preview 未确认）全部覆盖。 |
| 验证方式 | `node --test test/composer-recipe-stage.test.cjs test/composer-resolve.test.cjs` 全绿；人为把候选 Recipe 放入可选列表 → 失败；Base 版本升级 → 受影响 Recipe 变 `expired` 且不出现在可选。 |
| 规则追踪 | `M7-3-05`、`M7-4-04`、`M7-5-01`、`M7-5-02`、`M7-5-03` |

#### T-M7-09 preview-only 四处呈现

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-08` |
| 并行关系 | `T-M7-10` 依赖本任务 |
| 环境/证据 | `L1`/`L2` |
| 新建文件 | 无 |
| 修改文件 | `src/components/build/{DeployStep,ExportResultCard}.jsx`（preview-only 徽标 + 限制说明）、`src/services/exportService.js`（warnings 透传）、`scripts/composer/emit.cjs`（README“仅预览资产”小节、`capabilities.previewOnly[]`）、`scripts/composer/index.cjs`（`composerValidate` warnings） |
| 实现要点 | 1) 四处缺一不可：桌面组合确认、导出前校验 warnings、导出工程 README、`store.generated.js` 的 `capabilities.previewOnly`；2) `onlineReady` 与 `previewOnly` 交集为空；3) 限制说明取 `knownLimits` 前 2 条；4) 禁止出现“可上线”；5) 本轮资产均为 online-ready，但机制必须用测试构造 preview-only 资产验证（不登记正式资产）。 |
| 验证方式 | `node --test test/store-config-v2.test.cjs`：交集为空、README 含“仅预览资产”小节（测试构造 preview-only）；桌面截图与校验 warnings 截图存 `docs/evidence/m7/`。 |
| 规则追踪 | `M7-4-02`、`6.4.7` |

#### T-M7-10 三份 Recipe 生成与可删除性验收

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-09` |
| 并行关系 | `T-M7-11` 依赖本任务 |
| 环境/证据 | `W`（微信开发者工具人工编译） |
| 新建文件 | `docs/evidence/m7/s6.md`、`docs/evidence/m7/wechat/**` |
| 修改文件 | 无 |
| 实现要点 | 1) 三份 Recipe 各生成一个完整工程；2) 微信开发者工具导入并编译，截图含项目路径与“编译成功”；3) 删除可选 UI Block 后再次生成并编译，验证 `M5-2-05`；4) 关闭 `poster-carousel`（Plan 不分配 `home-hero`）后首页完整可用；5) 记录每份工程的 `treeSha256`、页面数、组件数；6) CLI 端口可用时补 `cli.bat` 日志。 |
| 验证方式 | 三份工程均 `node scripts/validate-miniprogram.cjs --root <out>` 0 错；微信编译截图齐全；删除组件后 `usingComponents` 无残留且编译通过；关闭海报后首页截图正常。 |
| 规则追踪 | `M5-2-05`、`M7-1-04`、`M7-5-01`、`A7` |

#### T-M7-11 逐资产证据与发布记录

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-10` |
| 并行关系 | `T-M7-12` 依赖本任务 |
| 环境/证据 | `W` + `R`（真机可选，未执行需标注） |
| 新建文件 | `docs/evidence/m7/{store-header,product-card,cart-bar,poster-carousel,recipes}.md` |
| 修改文件 | 各 `templates/recipes/*/release.json`（写入真实编译/回归/审核记录）、各资产 `manifest.json` 的 `release.verifiedRecipes`（如需要） |
| 实现要点 | 1) 逐资产记录：Manifest、四类预览、兼容声明、边界检查、编译记录、已知限制；2) 每份 Recipe 记录四类证据与审核人/时间；3) `order-classic`/`order-poster` 晋升 direct，`order-classic-candidate` 保持 candidate；4) 真机走查（扫码、安全区）未执行时明确写“未执行 + 原因”；5) 不以“整包通过”替代单项证据。 |
| 验证方式 | 证据文档逐项可追溯到资产 ID；`npm run registry:check` 通过；`node --test test/composer-recipe-stage.test.cjs` 通过；审核记录字段齐全。 |
| 规则追踪 | `M7-2-02`、`M7-5-04`、`4.3.4`、`A11` |

#### T-M7-12 M7 门禁汇总

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-11` |
| 并行关系 | 收尾阶段入口 |
| 环境/证据 | `L1` + `W` |
| 新建文件 | `docs/evidence/m7/s6-final.md` |
| 修改文件 | `docs/待完成目标.md`（M7 勾选草案，最终在 `T-CL-03`）、`docs/模板库与组合生成规划.md`（状态更新） |
| 实现要点 | 1) 汇总资产数量（1 Base/3 Block/1 Pack/3 Recipe）；2) 汇总 `composer-assets`、`registry:check`、`composer-recipe-stage`、三份工程生成与微信编译；3) 明确广告位/优惠券未实现（仅 schema 与门禁）；4) 列出 preview-only 机制验证结果；5) 列出未执行项（真机/安全区）。 |
| 验证方式 | 门禁表逐项有命令/证据/结果；未通过项有原因与后续动作；资产计数与上限一致。 |
| 规则追踪 | `M7-1`、`M7-2`、`M7-3`、`M7-4`、`M7-5` 全部 |
---

## 5. 收尾验证与文档（9 项）

#### T-CL-01 全量测试矩阵

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-M7-12` |
| 并行关系 | 收尾第一项，后续文档任务依赖真实结果 |
| 环境/证据 | `L1`/`L2` |
| 新建文件 | `docs/evidence/s7-checklist.md`（初稿） |
| 修改文件 | 无 |
| 实现要点 | 按 6.1 命令表逐条执行并记录：命令、时间、退出码、通过数/失败数、未执行原因；不得只写“已测试”。必须包含 `npm test`、`npm run test:desktop`、`npm run mini:check`、`npm run mini:dup-check`、`npm run registry:check`、`node scripts/check-packaging.cjs`、`npm run build`、`cd server && npm run build && npm test`、三份 Recipe CLI 生成、`npm run desktop` 人工导出。 |
| 验证方式 | `docs/evidence/s7-checklist.md` 每行有真实结果；任一失败项有原因、影响与后续动作；未执行项有明确阻塞说明。 |
| 规则追踪 | `4.1`–`4.5`、`M10` |

#### T-CL-02 证据归档与清单

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-01` |
| 并行关系 | 与 `T-CL-05` 可并行起草 |
| 环境/证据 | `L1` |
| 新建文件 | `docs/evidence/README.md`、`docs/evidence/m5/s0.md`、`s1.md`、`s2.md`、`s3.md`、`s3-packaging.md`、`paths.md`、`installer.md`、`docs/evidence/m6/s4.md`、`s5.md`、`docs/evidence/m7/s6.md`、`s6-final.md`、`docs/evidence/s7-checklist.md`（定稿） |
| 修改文件 | 无 |
| 实现要点 | 1) 统一证据目录结构（`m5/`、`m6/`、`m7/`、`installer/`、`wechat/`、`regression/`）；2) 每份证据写命令、时间、结果、截图路径；3) 明确 L1/L2/L3/L4/W/R 等级；4) 禁止用静态校验截图替代微信编译、用 `desktop:dev` 替代安装包；5) 证据文档中的本机绝对路径仅用于诊断，不进入发布材料。 |
| 验证方式 | `docs/evidence/README.md` 索引可跳到每份证据；`docs/evidence/s7-checklist.md` 与 2.8.5 清单一一对应。 |
| 规则追踪 | `2.8.5`、`4.3.1`、`4.4.2` |

#### T-CL-03 更新 `docs/待完成目标.md`

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-02` |
| 并行关系 | 与 `T-CL-04` 串行（统计口径一致） |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `docs/待完成目标.md` |
| 实现要点 | 1) M5：契约、Base、固定 Plan、静态产物、可复现、真实导出、安装包资源包含逐项按证据勾选；2) **M5-7-02 只有 L4 完成才勾**，仅 L1+L2 时保持 `[ ]` 并写“本机 builder 缓存缺失/网络阻塞”；3) M6：按 `T-M6-15` 结果勾选，D1 否决时 M6-1 全组不勾；4) M7：按 `T-M7-12` 勾选，广告位/优惠券保持 `[ ]`；5) M10 对应项（`test:desktop`、Manifest/可删除性/负例/Lock 可复现、微信编译）同步；6) 每条 `[x]` 必须附代码路径或证据路径；7) 更新“当前基线”和“当前已知工程风险”。 |
| 验证方式 | 每个 `[x]` 能在 `docs/evidence/` 找到对应证据；未完成项有原因；风险清单删除已解决项、保留未解决项。 |
| 规则追踪 | 里程碑追踪矩阵第 7 章、`docs/README.md` 第 4 节 |

#### T-CL-04 更新 `docs/bugs/` 台账

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-02` |
| 并行关系 | 与 `T-CL-03` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | 若联调发现新缺陷：`docs/bugs/open/BUG-013-主题.md`（编号按台账递增） |
| 修改文件 | `docs/bugs/README.md`（状态、统计、最近更新）、`docs/bugs/open/BUG-006-*.md`、`BUG-008-*.md`、`BUG-009-*.md`（补齐验证证据后迁到 `fixed/`） |
| 实现要点 | 1) **BUG-006**：Composer 断开 `src/` 运行时依赖 + `build.files` 修复 + `check-packaging` 通过 → 状态写“已修复 · 待 L4 安装包实测”，不得写“已修复”掩盖未做 L4；2) **BUG-008**：`theme.generated.wxss` + 锚点缺失失败已关闭静默替换 → 补 L1 证据后可“已修复”；3) **BUG-009**：`test/desktop-contract.test.cjs` 已建且 `npm run test:desktop` 可执行 → “已修复”；4) 修复文件从 `open/` 移到 `fixed/`，更新名录、统计与全仓链接；5) 未验证事项显式写“未验证”。 |
| 验证方式 | `docs/bugs/README.md` 名录状态与 `open/`/`fixed/` 文件位置一致；BUG-006 明确 L4 未执行；统计数字与条目数一致；旧路径检索无断链。 |
| 规则追踪 | `docs/bugs/README.md` 登记规则、`M5-7-06`、`BUG-006/008/009` |

#### T-CL-05 构建说明 md

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-01` |
| 并行关系 | 与 `T-CL-02` 可并行起草 |
| 环境/证据 | `L1` |
| 新建文件 | `docs/M5-M7-本地Composer与模板资产扩展-构建说明.md` |
| 修改文件 | 无 |
| 实现要点 | 1) 面向其他 AI 的阅读顺序：本清单 → 构建说明 → 契约/实现方案；2) 记录模块结构（`scripts/composer/`、`templates/registry/`、`templates/base|components|features|recipes/`、`server/src/imports/`、桌面 IPC/服务层）；3) 记录关键契约与错误码；4) 记录命令与真实结果；5) 记录已知限制、未执行项（微信编译/安装包/真机）；6) 明确“不要做什么”（不改资产绕过注册表、不写源码到产物、不把 Token 落盘）。 |
| 验证方式 | 新会话只读本文件即可复现构建与测试；命令可直接复制执行；与 `docs/evidence/s7-checklist.md` 结果一致。 |
| 规则追踪 | 用户偏好 3、`4.4.3` |

#### T-CL-06 更新 `docs/handoff/`

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-03`、`T-CL-04`、`T-CL-05` |
| 并行关系 | 与 `T-CL-07` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | `docs/handoff/archive/2026-11-M5-M7完成.md` |
| 修改文件 | `docs/handoff/当前工作区交接.md`（压缩为当前事实 + 未完成项 + 下一步）、`docs/handoff/README.md`（活动交接索引） |
| 实现要点 | 1) 写改动文件（按目录分组）、执行过的命令、真实结果、未解决问题、下一步；2) 保留用户未提交资产说明；3) 历史细节进 `archive/`，活动交接只留当前可执行事实；4) 更新“下一阶段”为 M8/B4 或答辩收尾。 |
| 验证方式 | 新会话只读 `docs/项目概览.md` + `docs/handoff/当前工作区交接.md` 能找到下一步；archive 文件含当时决策/验证/遗留；相对链接有效。 |
| 规则追踪 | `docs/README.md` 第 3 节、`docs/handoff/README.md` |

#### T-CL-07 更新概览与契约索引

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-06` |
| 并行关系 | 与 `T-CL-08` 串行 |
| 环境/证据 | `L1` |
| 新建文件 | 无 |
| 修改文件 | `docs/项目概览.md`、`docs/README.md`、`docs/template-schema.md`、`docs/面向AI的桌面端构建文档.md`、`docs/windows-deployment.md`、`docs/wechat-export-and-publish.md`、`docs/模板库与组合生成规划.md` |
| 实现要点 | 1) 状态从“规划/未实现”改为“已实现/部分实现”，并标注证据等级；2) `template-schema.md` 增补 `store.generated.v2` 与旧版本拒绝；3) 桌面文档增补 IPC 清单、`exportService` 边界、DEPLOY 四步；4) `windows-deployment.md` 增补 `check:packaging`、L1–L4 口径；5) 微信指引增补“导入生成工程”的步骤与证据要求；6) 模板规划更新“首批资产已落地/广告位与优惠券未实现”。 |
| 验证方式 | 文档间无矛盾（搜索“未实现”“规划”确认已更新项）；相对链接检查通过；不得把 L1/L2 写成安装包验收。 |
| 规则追踪 | `4.4.2`、`docs/README.md` 第 5 节 |

#### T-CL-08 后端待实现清单与决策确认

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-07` |
| 并行关系 | 需要用户答复（见第 10 章 U1） |
| 环境/证据 | `L1` |
| 新建文件 | `docs/evidence/s7-decisions.md`（记录用户答复） |
| 修改文件 | `docs/后端待实现接口清单.md`（**仅当用户批准**时合并第 18 节；默认不改） |
| 实现要点 | 1) 默认遵守 A14：不修改该清单，只把方案 3.5 建议与本次差异整理为待确认项；2) 若批准：新增“18. B3 受控导入与配置版本”，写接口、`store_imports`、`configVersion`、`tables`、错误码、验收；3) 同时确认 17.2–17.4 是否排期；4) 记录 BUG-007（Agent 鉴权）与本次无关，保持独立。 |
| 验证方式 | 用户答复写入 `s7-decisions.md`；若合并，`docs/README.md` 索引更新且 Markdown 链接有效；未合并时明确写“未修改”。 |
| 规则追踪 | `A14`、`M7-4-03`、`9.x` |

#### T-CL-09 交付边界与未执行项声明

| 字段 | 内容 |
| --- | --- |
| 前置依赖 | `T-CL-08` |
| 并行关系 | 收尾最后一项 |
| 环境/证据 | `L1` |
| 新建文件 | `docs/evidence/s7-boundaries.md` |
| 修改文件 | `docs/待完成目标.md`（风险清单最终同步） |
| 实现要点 | 1) 明确“已证明/未证明”：L1 契约与生成、L2 本机导出与资源包含、L3 安装包、L4 干净机、W 微信编译、R 真机；2) 明确不得宣称：已上传/已发布/已提交审核、真实微信支付、华为云模型接通、广告位/优惠券在线可用；3) 列出未执行项与阻塞原因；4) 给出答辩/交付时的建议表述。 |
| 验证方式 | 声明与 `s7-checklist.md` 逐项一致；无“已上线”类表述；未执行项有原因。 |
| 规则追踪 | 第 10 章红线、`M5-6-05`、`4.3.1` |

---

## 6. 测试策略

### 6.1 分层与命令（复用现有运行方式）

| 层 | 范围 | 命令 | 依赖 |
| --- | --- | --- | --- |
| 根 L1 全量 | 所有 `test/*.test.cjs` | `npm test` | 无 |
| 根 L1 单文件 | 单层契约/解析/生成 | `node --test test/composer-schema.test.cjs` | 无 |
| 桌面契约 L6 | preload/handler/体积/来源/冲突 | `npm run test:desktop` | 桩 `ipcMain`，无 Electron |
| 小程序静态 L12 | 参考工程与产物 | `npm run mini:check`；`node scripts/validate-miniprogram.cjs --root <path>` | 无 |
| 注册表 | 冻结/Manifest/顺序/发布状态 | `npm run registry:check` | 无 |
| 打包契约 | `build.files` 覆盖 | `node scripts/check-packaging.cjs`；`npm run check:packaging` | 无 |
| 构建 | Vite | `npm run build` | 无 |
| 端到端 CLI | 固定 Plan → 工程 | `node scripts/composer/cli.cjs --plan <plan> --out <tmp>` | 无 |
| 后端 L11 | 导入/版本/权限/回滚 | `cd server && npm run build && npm test` | 真实 MySQL 测试库 |
| 桌面 L2 | 真实导出 | `npm run desktop` 人工 | Electron 运行时 |
| 微信 W | 编译/走查 | 微信开发者工具人工 GUI | 工具已安装、端口可关 |
| 真机 R | 扫码/安全区 | 微信真机预览 | 可选 |

> 新增测试文件只要符合 `test/*.test.cjs` 就会自动进入 `npm test`；`test:desktop` 固定指向 `test/desktop-contract.test.cjs`，文件建成即恢复可用（关闭 BUG-009）。

### 6.2 新增/改写测试文件清单

**根目录（14 个新增 + 1 个改写）**

| 文件 | 覆盖任务 | 关键断言 |
| --- | --- | --- |
| `test/composer-schema.test.cjs` | T-M5-03/04/06/16 | 合法样例全过；非法样例逐条返回指定 `code+path`；Lock 必填项 |
| `test/composer-resolve.test.cjs` | T-M5-14/15 | 缺依赖/冲突/循环/版本/容量/类型/重复插槽/未登记插槽/契约不兼容/低对比全部拒绝 |
| `test/composer-emit.test.cjs` | T-M5-17/18/19 | `app.json` 与磁盘一致；白名单配置；Token 齐全；插槽三态 |
| `test/composer-determinism.test.cjs` | T-M5-25 | 两次生成 `treeSha256` 与逐文件摘要一致；`generatedAt` 不影响 |
| `test/composer-atomic.test.cjs` | T-M5-20 | 中途失败无半成品；同名目录不变；取消无残留；只读拒绝 |
| `test/composer-safety.test.cjs` | T-M5-05/19 | 伪密钥/绝对路径/内网地址命中定位；组件越界拦截 |
| `test/composer-assets.test.cjs` | T-M5-13、T-M7-01…05 | Base 必备能力；四类预览；interface 一致；boundary 全 false |
| `test/composer-recipe-stage.test.cjs` | T-M7-08 | 缺证据不能 direct；候选不进可选；Base 升级 → expired；preview-only 不进 direct |
| `test/desktop-contract.test.cjs` | T-M5-26/27/33 | handler 形状、来源校验、体积上限、`TARGET_EXISTS`、`EXPORT_BUSY`、`desktop-required` |
| `test/export-service.test.cjs` | T-M5-28/33 | 非桌面降级；错误码中文映射；目录不存在提示 |
| `test/compose-plan-from-session.test.cjs` | T-M5-29/33 | 同 state 同 Plan；未映射能力清单；模板回落 |
| `test/store-config-v2.test.cjs` | T-M6-11/13、T-M7-09 | 六类版本；白名单；`delivery:false`；v1 拒绝；HTTPS；preview-only 四处之一 |
| `test/version-guard.test.cjs` | T-M6-12/13 | 落后提示、相等不提示、在线优先 |
| `test/import-service.test.cjs` | T-M6-08/10 | 请求形状、幂等键、Token 不落盘、AgentDraft 映射、`notImported` |
| `test/generator.test.cjs`（改写） | T-M5-24 | 改为产物契约端到端，不再断言旧复制脚本 4 页/`priceText` |

**服务端（4 个新增）**

| 文件 | 覆盖任务 | 关键断言 |
| --- | --- | --- |
| `server/test/b3-imports.test.ts` | T-M6-05/07 | 幂等重放/冲突/403/回滚/上限/缓存语义/映射完整 |
| `server/test/b3-config-version.test.ts` | T-M6-06/07 | 导入后双版本递增；公开接口字段齐全 |
| `server/test/b3-tables.test.ts` | T-M6-06/07 | 公开只读、排序、404、无订单字段 |
| `server/test/b3-import-diff.test.ts`（可选） | T-M6-03 | 冲突默认 skip；不静默改价/上架；不删除未声明项 |

**命名规范**：根目录 `test/<领域>-<关注点>.test.cjs`（`node:test`）；服务端 `<阶段>-<模块>.test.ts`（Vitest）；测试使用 `node:os.tmpdir()` 或独立测试库，不污染仓库与演示数据；每个文件必须可单独运行。

### 6.3 组合负例矩阵（`test/composer-resolve.test.cjs` 必须覆盖）

| 负例 | 构造 | 期望 code | 期望无输出 |
| --- | --- | --- | --- |
| 缺依赖 | 移除 `hero-carousel` 且未声明 optional | `DEPENDENCY_MISSING` | 是 |
| 冲突 | 两资产互相 `conflicts` | `ASSET_CONFLICT` | 是 |
| 循环依赖 | A→B→A | `DEPENDENCY_CYCLE`（含环路径） | 是 |
| 重复页面 | `pages[]` 两次 `home` | `PAGE_DUPLICATED` | 是 |
| 路径逃逸 | 入口 `../../outside/index.js` | `ENTRY_PATH_INVALID` | 是 |
| 插槽超容量 | `home-hero` 放 2 个（max=1） | `SLOT_CAPACITY_EXCEEDED` | 是 |
| 插槽类型不符 | `menu-aside` 放 feature-pack | `SLOT_TYPE_REJECTED` | 是 |
| 插槽重复定义 | 同页同 slot 两次 | `SLOT_DUPLICATED` | 是 |
| 未登记插槽 | 使用 `home-footer` | `SLOT_UNKNOWN` | 是 |
| 契约不兼容 | `storefront.v2` 对 Base `v1` | `API_CONTRACT_INCOMPATIBLE` | 是 |
| 主题低对比 | 文字 `#FFFFFF` / 背景 `#FAF7F1` | `THEME_CONTRAST_LOW` | 是 |
| preview-only 未确认 | 含 preview-only 且 `previewOnlyAck=false` | `PREVIEW_ONLY_NOT_ACKNOWLEDGED` | 是 |

### 6.4 人工证据清单（W / R / L2 / L3 / L4）

| 验收项 | 证据形式 | 存放位置 | 未完成时的表述 |
| --- | --- | --- | --- |
| 本机真实导出 | 路径截图 + 日志 + Lock 摘要 | `docs/evidence/m5/s3.md` | “未执行” |
| 路径鲁棒性 | 中文/空格/长路径三次截图 | `docs/evidence/m5/paths.md` | “仅覆盖 X 类” |
| 微信编译 | 工具截图（含项目路径与编译成功）+ CLI 日志（若可用） | `docs/evidence/m5/wechat/`、`docs/evidence/m7/wechat/` | “未执行，工具服务端口关闭” |
| 核心闭环回归 | 扫码→菜单→加购→结算→下单→演示付款→接单→完成 | `docs/evidence/m5/regression/` | “未执行” |
| 安装包 | `release/*.exe` + 安装截图 + 导出截图 | `docs/evidence/m5/installer/` | “构建受 Electron 运行时下载阻塞” |
| preview-only 呈现 | 四处截图 | `docs/evidence/m7/` | “缺 X 处” |
| 真机 | 扫码/安全区截图 | `docs/evidence/m7/real-device/` | “未执行” |

---

## 7. 里程碑验收门禁

### 7.1 M5 门禁（全部通过才可勾 M5 对应条目）

**必须执行的命令**

```text
npm test
npm run test:desktop
npm run mini:check
node scripts/validate-miniprogram.cjs --root templates/base/ordering-base/1.0.0/src
npm run mini:dup-check
npm run registry:check
node scripts/check-packaging.cjs
npm run build
node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <系统临时目录>/m5-a
node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <系统临时目录>/m5-b
npm run desktop    # 人工导出一次
```

**必须全绿的文件**：`composer-schema`、`composer-resolve`、`composer-emit`、`composer-determinism`、`composer-atomic`、`composer-safety`、`composer-assets`、`desktop-contract`、`export-service`、`compose-plan-from-session`、`session-machine`、`reveal-transition`。

**必须更新的文档**：`docs/evidence/m5/s0.md`、`s1.md`、`s2.md`、`s3.md`、`s3-packaging.md`、`paths.md`、`installer.md`；`docs/待完成目标.md`（M5，L4 未完成时 M5-7-02 保持未勾）；`docs/bugs/README.md` 与 BUG-006/008/009；`docs/面向AI的桌面端构建文档.md`；`docs/template-schema.md`；`docs/windows-deployment.md`。

**不通过处置**：`T-M5-19/24/25/33` 任一失败 → 停止桌面接线与 M7 资产；`T-M5-34` 失败 → 阻断 M5 完成；`T-M5-39/40` 受环境阻塞 → 只交付 L1+L2，并明确 M5-7-02 未完成。

### 7.2 M6 门禁

**必须执行的命令**

```text
cd server && npm run db:migrate && npm run db:seed
cd server && npm run build && npm test
npm test
npm run mini:check
node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <tmp>
# 真实进程联调：GET 门店/目录/桌号 → POST preview → 确认 → POST apply → 重复 apply
```

**必须全绿的文件**：`b3-imports`、`b3-config-version`、`b3-tables`、`import-service`、`store-config-v2`、`version-guard`，且既有服务端 139 项无回归。

**必须更新的文档**：`docs/api.md` 第 10 节、`docs/backend-data-model.md`、`docs/evidence/m6/s4.md`、`s5.md`、`docs/待完成目标.md`（M6）。

**不通过处置**：M6-1 任一条失败 → M6 不得勾选；D1 被否决 → 明确写“只读导出 + 快照模式”，不得用 `PATCH` 拼凑；A15 不可用 → 导入入口禁用，M6 只能交付“小程序侧导入”说明。

### 7.3 M7 门禁

**必须执行的命令**

```text
npm test
npm run registry:check
node --test test/composer-assets.test.cjs test/composer-recipe-stage.test.cjs
node scripts/composer/cli.cjs --plan templates/recipes/order-classic/1.0.0/plan.json --out <tmp>/classic
node scripts/composer/cli.cjs --plan templates/recipes/order-poster/1.0.0/plan.json --out <tmp>/poster
node scripts/composer/cli.cjs --plan templates/recipes/order-classic-candidate/0.1.0/plan.json --out <tmp>/candidate
node scripts/validate-miniprogram.cjs --root <tmp>/classic
node scripts/validate-miniprogram.cjs --root <tmp>/poster
# 微信开发者工具人工导入三份工程并编译
```

**必须满足**：资产计数 = 1 Base / 3 UI Block / 1 Feature Pack / 3 Recipe；每个资产四类预览；`direct` 四类证据齐全；候选不进可选列表；扩展顺序门禁生效；广告位/优惠券未登记。

**必须更新的文档**：`docs/evidence/m7/s6.md`、`s6-final.md`、逐资产 `docs/evidence/m7/*.md`、各 `release.json`、`docs/待完成目标.md`（M7）、`docs/模板库与组合生成规划.md`。

**不通过处置**：任一资产缺 Manifest/预览/兼容声明 → 阻断进入 Recipe；任一 `direct` 缺证据 → 保持 candidate；顺序跳步 → 阻断该资产进入正式集合。

### 7.4 收尾门禁

**必须满足**：`T-CL-01` 全量矩阵有真实结果；`docs/evidence/s7-checklist.md` 与 2.8.5 一一对应；`docs/待完成目标.md` 每个 `[x]` 有证据；`docs/bugs/README.md` 状态与目录一致；构建说明可让新会话复现；`docs/handoff/` 活动交接可指导下一步；概览/契约/索引无矛盾；Markdown 相对链接全部有效。

**不通过处置**：任何一项未完成 → 不得宣称“M5–M7 完成”，只能写“部分完成 + 未完成清单”。

---

## 8. 环境阻塞与降级路径

| 阻塞项 | 检测方式 | 降级动作 | 可交付证据 | 不得宣称 | 对应任务 |
| --- | --- | --- | --- | --- | --- |
| electron-builder 缓存缺失/网络不可用 | `Test-Path "$env:LOCALAPPDATA\electron-builder\Cache"`；`npm run build:win` 报下载失败 | 交付 L1+L2：`npm run build` + `check-packaging` + `npm run desktop` 真实导出 | 资源包含断言、本机导出截图、失败日志 | “安装包验收通过”“干净机可导出” | T-M5-38/39/40 |
| 微信 CLI 服务端口关闭 | `cli.bat` 返回“服务端口已关闭” | 人工 GUI 导入 + 截图 + 编译成功提示；记录 CLI 不可用原因 | 工具截图、项目路径、编译日志 | “CLI 自动编译通过”“静态校验=微信编译” | T-M5-40、T-M7-10/11 |
| 无干净 Windows 验收机 | 环境清单确认 | 只交付 L1–L3；M5-7-02 保持未勾 | 安装包与解包清单 | “M5-7-02 完成” | T-M5-39/40 |
| MySQL 3306 被占用/实例未启动 | `mysqld` 进程与端口探测 | 改端口并同步 `server/.env`；按 `docs/backend-local-dev.md` 启动 | 迁移/种子/测试结果 | “数据库未验证”却勾选后端 | T-M6-02/07/14 |
| Redis 不可用/WSL 挂起 | `/readyz` 返回 `cache:"memory"` | `CACHE_DRIVER=memory` 降级；导入缓存语义仍可测 | memory 模式下的 `cacheRefreshed` 结果 | “Redis 链路已验收” | T-M6-14 |
| 无管理员权限 | 安装/服务/符号链接失败 | 用户目录缓存、ZIP MySQL、WSL Redis、复制 + 一致性断言（A16） | 用户空间复现步骤 | 需要提权才能运行 | 全程 |
| D1（后端写接口）被否决 | 用户书面答复 | M6 降级为“只读导出 + 门店配置快照”，导入卡片置灰并说明 | 只读导出 + `sourceMode="snapshot"` | M6-1 已满足、导入可用 | T-M6-01/15 |
| A15 demo 登录不可用（`ALLOW_DEMO_LOGIN=false`） | 后端返回 `DEMO_LOGIN_DISABLED` | 导入入口禁用，提示“请在微信小程序端完成配置导入” | 禁用态截图、错误码 | 桌面端可导入 | T-M6-08/09 |
| 真机/安全区不可用 | 无真机或网络限制 | 标注 `R` 未执行；只用 `W` 证据 | 工具截图 | “真机已验证” | T-M7-11 |
| 目标磁盘空间不足/只读/路径过长 | P4 预检 | 返回 `TARGET_NO_SPACE/TARGET_NOT_WRITABLE/PATH_TOO_LONG`，不写任何文件 | 错误码与提示截图 | “已降级成功” | T-M5-20/37 |
| 后端未批准合并待实现清单（A14） | 用户答复 | 只写 `docs/evidence/s7-decisions.md`，不改清单 | 决策记录 | 清单已更新 | T-CL-08 |

---

## 9. 需求规则覆盖核对（95 条）

> 说明：每条规则至少映射 1 个任务；任务内的“验证方式”必须能观察到对应断言。编号采用正文口径（`M5-4` 而非误写的 `M5-3`）。

### 9.1 M5-1 契约冻结与注册表（8 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-1-01 | 五类契约有版本与合法/非法样例，非法样例给出 code+path | T-M5-02/03/04 |
| M5-1-02 | 契约版本升级显式拒绝旧版本 | T-M5-02/04 |
| M5-1-03 | 每个资产 Manifest 字段齐全 | T-M5-06/11/13 |
| M5-1-04 | 注册表唯一白名单，未登记即拒绝 | T-M5-01/06/14 |
| M5-1-05 | 入口包内相对且存在 | T-M5-03/05/06 |
| M5-1-06 | 声明与实现一致 | T-M5-03/06/13 |
| M5-1-07 | 注册表版本显式冻结，漂移失败 | T-M5-01/06/25 |
| M5-1-08 | Manifest/Plan/Lock 禁止源码/秘密/URL | T-M5-02/04/05 |

### 9.2 M5-2 Base 统一与可删除性（8 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-2-01 | 唯一 Base 与唯一组件源 | T-M5-08/11/12 |
| M5-2-02 | 双份内容不同即失败 | T-M5-12 |
| M5-2-03 | Base 必备能力与 7 页闭环 | T-M5-08/09/10/11/13 |
| M5-2-04 | Base 不含营销能力 | T-M5-06/11/13 |
| M5-2-05 | 删除可选 Block 仍可编译 | T-M5-13/18/40、T-M7-10 |
| M5-2-06 | 组件铁律四项零命中 | T-M5-07/13/19 |
| M5-2-07 | 插槽协议与未分配可运行 | T-M5-09/11/15/18 |
| M5-2-08 | 旧静态模板退出导出源 | T-M5-34/35 |

### 9.3 M5-4 组合规划与 Lock（9 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-4-01 | Plan 只含白名单字段 | T-M5-02/04/14 |
| M5-4-02 | 精确版本，拒绝 latest/范围 | T-M5-03/14 |
| M5-4-03 | 缺依赖/冲突/循环/重复页面/未登记插槽前置拒绝 | T-M5-14/15 |
| M5-4-04 | 插槽容量与类型 | T-M5-15 |
| M5-4-05 | Lock 完整性 | T-M5-16 |
| M5-4-06 | 相同 Plan/Lock 可复现 | T-M5-24/25 |
| M5-4-07 | 禁止隐式升级 | T-M5-14 |
| M5-4-08 | Lock 不含业务数据/密钥 | T-M5-16 |
| M5-4-09 | 契约与基础库兼容校验 | T-M5-15 |

### 9.4 M5-5 确定性生成（10 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-5-01 | 固定 Plan 先跑通 2–3 Recipe | T-M5-22/23/40、T-M7-10 |
| M5-5-02 | 产物完整性（WXML/WXSS/JS/JSON/app.json/主题/配置） | T-M5-17/18/19/23 |
| M5-5-03 | 构建期确定，无运行时动态组件 | T-M5-09/18 |
| M5-5-04 | 原子输出，失败无半成品 | T-M5-20 |
| M5-5-05 | 生成前安全扫描 | T-M5-05/19 |
| M5-5-06 | 生成后边界扫描 | T-M5-13/19 |
| M5-5-07 | 不隐式降级 | T-M5-14 |
| M5-5-08 | 生成报告字段齐全 | T-M5-21 |
| M5-5-09 | 复制基线退出、主题变量化 | T-M5-10/17/29/35 |
| M5-5-10 | Token 只出现在声明位置 + 4.5:1 | T-M5-10/15/17 |

### 9.5 M5-6 桌面会话真实导出（9 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-6-01 | 真实导出替代动画，进度真实 | T-M5-26/30/32/36 |
| M5-6-02 | 取消不产生文件 | T-M5-26/30/31/32 |
| M5-6-03 | 成功展示真实路径/版本 | T-M5-27/31/32/36 |
| M5-6-04 | 失败可读 + 重试 | T-M5-26/28/31/36 |
| M5-6-05 | 能力诚实，不称上传/发布 | T-M5-30/31 |
| M5-6-06 | 预览与导出同一 Plan | T-M5-29/32 |
| M5-6-07 | 部署四步对齐真实能力 | T-M5-30/31 |
| M5-6-08 | 保留既有状态机 | T-M5-30/33 |
| M5-6-09 | 浏览器明确提示 | T-M5-27/28/32/33 |

### 9.6 M5-7 安装包与真实导出验收（7 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M5-7-01 | 安装包包含全部运行时资产 | T-M5-34/38/39 |
| M5-7-02 | 干净 Win10/11 真实安装导出 | T-M5-39/40 |
| M5-7-03 | 中文/空格/长路径 | T-M5-20/37 |
| M5-7-04 | 打包契约自动检查 | T-M5-33/34/38 |
| M5-7-05 | 不覆盖用户目录 | T-M5-20/37 |
| M5-7-06 | 旧产物/旧配置明确失败 | T-M5-10/35 |
| M5-7-07 | 卸载不删导出；升级可用 | T-M5-39/40 |

### 9.7 M6-1 受控导入（10 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M6-1-01 | 受控通道，禁止绕过 | T-M6-01/04/05 |
| M6-1-02 | 幂等防重 | T-M6-02/05/07 |
| M6-1-03 | 不覆盖运营数据 | T-M6-03/05 |
| M6-1-04 | 差异逐项确认 | T-M6-03/05/09 |
| M6-1-05 | 仅 OWNER | T-M6-01/03/07/08 |
| M6-1-06 | 分类/商品/价格约束 | T-M6-01/04/07 |
| M6-1-07 | 桌号约束与不删除 | T-M6-03/05/07 |
| M6-1-08 | 映射回传完整 | T-M6-01/05 |
| M6-1-09 | 版本递增与缓存失效 | T-M6-02/05/06/14 |
| M6-1-10 | 整体回滚 | T-M6-05/07 |

### 9.8 M6-2 AgentDraft 映射（8 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M6-2-01 | 营业时间完整映射 | T-M6-08/10/12/13 |
| M6-2-02 | 菜品全量映射、整数分 | T-M6-08/10/12/13 |
| M6-2-03 | 履约映射，外送关闭 | T-M6-08/10/11/13 |
| M6-2-04 | 店名/品类映射 | T-M6-08/10/12/13 |
| M6-2-05 | 未支持字段显式标注 | T-M6-05/09/10 |
| M6-2-06 | 唯一金额事实 | T-M6-10/11/13 |
| M6-2-07 | 冲突不自动覆盖 | T-M6-03/09/10 |
| M6-2-08 | 映射可追溯 | T-M6-05/08/10 |

### 9.9 M6-3 导出公开配置与版本映射（7 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M6-3-01 | 公开字段白名单 | T-M6-11/13 |
| M6-3-02 | 秘密禁止 | T-M6-11/13 |
| M6-3-03 | 生产必须 HTTPS | T-M6-10/11/13 |
| M6-3-04 | 六类版本齐全 | T-M6-06/11/13/14 |
| M6-3-05 | 不兼容明确拒绝 | T-M6-11/13 |
| M6-3-06 | 版本不一致提示刷新 | T-M6-12/13 |
| M6-3-07 | 旧版本识别 | T-M6-11/13 |

### 9.10 M7-1 / M7-2 首批资产与扩展顺序（6 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M7-1-01 | 首批 1/3/1/3 范围 | T-M7-01/02/03/04/07 |
| M7-1-02 | 核心 UI Block 来自稳定组件 | T-M7-01/02/03 |
| M7-1-03 | 海报轮播能力完整 | T-M7-04/10 |
| M7-1-04 | Recipe 覆盖基础与海报 | T-M7-06/10 |
| M7-2-01 | 严格扩展顺序 | T-M7-07/08 |
| M7-2-02 | 每资产独立验收 | T-M7-11 |

### 9.11 M7-3 / M7-4 / M7-5 验收、preview-only 与晋升（13 条）

| 规则 | 核心断言 | 任务 |
| --- | --- | --- |
| M7-3-01 | Manifest 完整（含测试入口） | T-M7-01/02/03/04/05 |
| M7-3-02 | 四类预览数据 | T-M7-01/02/03/04/05 |
| M7-3-03 | 兼容声明可执行 | T-M7-05 |
| M7-3-04 | 组件边界测试 | T-M7-05/07 |
| M7-3-05 | 五类负例覆盖 | T-M7-08 |
| M7-4-01 | preview-only 判定 | T-M7-04/07 |
| M7-4-02 | preview-only 四处呈现 | T-M7-09 |
| M7-4-03 | 后端待实现登记 | T-M7-07 |
| M7-4-04 | preview-only 不发布 | T-M7-08 |
| M7-5-01 | 晋升门槛四类证据 | T-M7-06/08/10 |
| M7-5-02 | 正式/候选严格分离 | T-M7-08 |
| M7-5-03 | 回归与失效 | T-M7-08 |
| M7-5-04 | 发布记录完整 | T-M7-06/11 |

### 9.12 覆盖统计

| 组 | 条数 | 已覆盖 | 未覆盖 |
| --- | --- | --- | --- |
| M5-1 | 8 | 8 | 0 |
| M5-2 | 8 | 8 | 0 |
| M5-4 | 9 | 9 | 0 |
| M5-5 | 10 | 10 | 0 |
| M5-6 | 9 | 9 | 0 |
| M5-7 | 7 | 7 | 0 |
| M6-1 | 10 | 10 | 0 |
| M6-2 | 8 | 8 | 0 |
| M6-3 | 7 | 7 | 0 |
| M7-1 | 4 | 4 | 0 |
| M7-2 | 2 | 2 | 0 |
| M7-3 | 5 | 5 | 0 |
| M7-4 | 4 | 4 | 0 |
| M7-5 | 4 | 4 | 0 |
| **合计** | **95** | **95** | **0** |

---

## 10. 需要用户决策的遗留项

> 以下项不阻塞任务清单成立，但会影响验收口径或能否勾选里程碑；默认值已按 D1–D8 记录，若需变更请在实现前答复。

| 编号 | 问题 | 默认处理 | 影响 | 需用户答复 |
| --- | --- | --- | --- | --- |
| U1 | 是否批准把本轮 B3 受控导入建议合并进 `docs/后端待实现接口清单.md`（A14） | **不合并**，只写 `docs/evidence/s7-decisions.md` | 后端团队能否直接排期 | 是/否 |
| U2 | 微信开发者工具 CLI 服务端口是否开启（A7） | 不开启，走人工 GUI 截图 + 日志 | 能否有自动化编译证据 | 开启/不开启/由验收人开启 |
| U3 | 构建环境是否可联网或提供 electron-builder 缓存/镜像；谁提供干净 Win10/11 验收机（A8） | 接受 L1+L2 阶段性证据，M5-7-02 不勾 | M5/M7 安装包验收能否闭环 | 网络/镜像/验收机归属 |
| U4 | 桌面端 demo 登录在生产关闭后，导入入口如何处理（A15） | 禁用并提示“请在微信小程序端完成导入” | M6 桌面导入能否演示 | 接受/需真实店主登录 |
| U5 | 候选 Recipe 发布审核人是谁，是否需双人复核（A11） | 单人 `release-review`，记录写入 `release.json` | `direct` 晋升证据 | 审核人/是否双人 |
| U6 | 是否保留第 3 份 `order-classic-candidate`（D7） | 保留，用于演示候选/正式分离 | M7 资产计数为 3 Recipe | 保留/删除 |
| U7 | 真机扫码、安全区与多分辨率走查是否纳入本轮 | 标注 `R` 未执行，仅交付 `W` 证据 | M7 验收完整度 | 纳入/不纳入 |
| U8 | BUG-006 的关闭口径：L2 资源断言通过但 L4 未做 | 状态写“已修复 · 待 L4 安装包实测”，不写“已修复” | bug 台账准确性 | 接受/要求 L4 后关闭 |
| U9 | 是否最终允许在现有会话式 UI 上做最小增量修改（D4/A9） | **允许**，仅改方案 2.5.4 列出的编辑点 | M5-6 能否满足 | 允许/改为独立导出窗口 |
| U10 | 首批 Recipe 名称与主题是否需固定（A12） | 由实现方自主决定（`order-classic`、`order-poster`、暖色/深绿主题） | 视觉与答辩观感 | 接受/指定名称与主题 |

**执行建议**：先答复 U1–U4 与 U9（它们直接决定 M6 与 M5-6 的验收口径），U5–U8、U10 可在对应阶段门禁前答复。

---

**文档状态**：编码任务清单已生成，等待用户确认后由实现 agent 按 `T-M5-01` 起执行。本文件不包含任何可运行代码，不代表任何能力已经实现。