# E0-U1 → E3 的 UIA 断言清单（不执行 GUI，不伪造截图）

> 任务：`t3` / **E0-U1**（product-ui），attempt 2，attempt_id `6d23cc4e-8eae-4b21-8254-80de7bf110c6`。
> 用途：E3 把 `src/components/agent/e0/**` 接进真实右栏后，用它做**无障碍树（UIA）**断言。
> 依据：`AGENTS.md`「界面调试：优先用无障碍树，不要靠截图」+ `docs/agent-accessibility-debugging.md`；
> 口径：`PASS / FAIL / BLOCKED / NOT_RUN`，`partial` ≠ 通过。
>
> **本轮状态：全部 `NOT_RUN`。**
> 原因有两条，且都是事实：①本轮 E0-U1 **不接 App 主链**（`src/App.jsx` / `RightPanel.jsx` 属 Captain 派单），
> 这些控件此刻**不在**任何真实窗口里；②按冻结 §14.11 / 计划 §6，E0 阶段不做 GUI 走查与截图。
> 所以本文件是**待执行的断言清单**，不是走查结论；本轮**没有**产出任何快照、截图或“已验证”声明。

---

## 0. 怎么用这份清单（E3）

1. 接线完成后先 `npm run agent:app`（**不要**用 `npm run desktop:dev`：从 Electron 宿主派生的 shell 会带
   `ELECTRON_RUN_AS_NODE=1`，`electron .` 会退化成纯 Node 并在 `desktop/main.cjs:17` 抛
   `TypeError: Cannot read properties of undefined (reading 'getPath')`）。
2. 每条断言按「快照 → 定位 → 动作 → 重新快照」四步走；**ref 只属于当次快照**，`STALE_REF` /
   `AMBIGUOUS_TARGET` 时重新快照，禁止复用旧 ref。
3. 断言命令用 `agent:find` / `agent:verify`（退出码 1 = 文本缺失），语义点击用 `agent:click`，
   输入用 `agent:type`。命令模板见 §6。
4. 每条断言结果只填 `PASS / FAIL / BLOCKED / NOT_RUN`；**不可用**就写 `BLOCKED` 并给原因，
   **没跑**就写 `NOT_RUN`，不许先写 PASS 再补证据。
5. 截图只能作为**辅助**证据（同一 route / 同一尺寸 / 同一门店与身份）；**禁止**把 React 预览截图或
   DevTools 模拟器截图当作微信运行时截图。

---

## 1. 组件与 UIA 名称对照表（名称来自源码，E3 按此断言）

> 「可读名称」= Chromium→UIA 暴露的 `Name`；纯图标控件必须 `aria-label`，这里已全部满足。
> 「稳定 id」= 元素的 `id`，会映射成 UIA 的 `automation_id`，用于避开同名歧义。

### 1.1 目标页选择 `TargetPageSelect.jsx`

| 断言 | role | 可读名称 | 稳定 id | 期望 |
|---|---|---|---|---|
| U-01 区域存在 | `Group`（`role="group"`） | `目标页面选择` | `e0-target-page-field` | 存在且可见 |
| U-02 单选组存在 | `List`/`RadioGroup`（`role="radiogroup"`） | `目标页面（单选）` | —（由 `aria-labelledby="e0-target-page-label"` 命名） | 存在；子项正好 **8** 个 |
| U-03 选项数 | — | — | — | `role="radio"` 元素数 == 8（8 页枚举，不多不少） |
| U-04 选项名称 | `RadioButton`（`role="radio"`） | `<页面中文名>（<pageId>）`，不可选时追加 `，不可选` | `e0-target-page-<pageId>` | 8 个 id 与 §14.5 枚举一一对应：`home / menu / product-detail / checkout / orders / order-detail / mine / merchant-orders` |
| U-05 选中态 | `RadioButton` | 同上 | 同上 | 选中项 `aria-checked=true` / UIA `SelectionItem.IsSelected=true`，其余为 false |
| U-06 不可选页不可点 | `RadioButton` | 同上（含 `，不可选`） | 同上 | `aria-disabled=true`；点击后**不出现**新的选中项，且无新 run |
| U-07 不可选页有原因 | `Text`（`role="note"`） | `<页面中文名>不可选原因` | — | 文本非空（例如「当前项目没有该页面的能力事实（page-contract 未派生），不能选择」） |
| U-08 可选数量提示 | `Text`（`role="note"`） | `可选页面数量` | — | 文本形如 `可选 1 / 8 页`；若全不可选则为「当前没有可选页面」 |
| U-09 枚举外页面被忽略 | `Text`（`role="note"`） | `被忽略的页面` | — | 平台多给 id 时才出现；出现即说明平台侧 8 页派生有偏差，记 `FAIL` |

### 1.2 参考图 + consent `ReferenceImageUploader.jsx`

| 断言 | role | 可读名称 | 稳定 id | 期望 |
|---|---|---|---|---|
| U-10 区域存在 | `Group` | `参考图与同意提示` | `e0-reference-image-field` | 存在且可见 |
| U-11 图片状态词 | `Text`/`Status`（`role="status"`） | `参考图状态：MISSING` / `：READY` / `：BLOCKED` | — | 文本就是状态词本身；缺图必须是 `MISSING` |
| U-12 缺图提示 | `Text`（`role="note"`） | `参考图缺失提示` | — | 文本同时含 `MISSING` 与 `BLOCKED`（如「未选择参考图（MISSING）：参考图缺失导致视觉分析 BLOCKED…」） |
| U-13 已选图摘要 | `Text`（`role="note"`） | `已选参考图` | — | 有图时出现，含文件名/大小/MIME/assetId；**不出现**本地绝对路径 |
| U-14 选图入口 | `Button` | `选择一张参考图` | — | 可聚焦可点击；点击只发起选图请求（**不**在渲染层读文件） |
| U-15 移除按钮 | `Button` | `移除已选参考图` | — | 有图时才存在；点击后回到 `MISSING` |
| U-16 同意勾选 | `CheckBox`（`role="checkbox"`） | `同意把参考图发给模型` | `e0-consent-checkbox` | `aria-checked` 随点击翻转（UIA `TogglePattern.ToggleState`）；默认未勾选 |
| U-17 同意文案 | `Text` | 可见文本 | — | 必须读得出「我同意把这张参考图发给模型，仅用于识别页面结构与视觉风格」 |
| U-18 同意状态说明 | `Text`（`role="note"`） | `同意状态说明` | — | 未勾选含 `BLOCKED`；勾选后为「已记录用户同意…」 |
| U-19 阻断提示 | `Text`（`role="note"`） | `视觉分析阻断提示` | — | 缺图或未同意时出现，明确「视觉分析 BLOCKED」 |
| U-20 图片错误 | `Text`（`role="alert"`） | `参考图错误` | — | 只有平台回 `AGENT_IMAGE_INVALID` / 超限时出现；文案不得含 base64 或路径 |

### 1.3 utterance `UtteranceInput.jsx`

| 断言 | role | 可读名称 | 稳定 id | 期望 |
|---|---|---|---|---|
| U-21 区域存在 | `Group` | `改造要求输入` | `e0-utterance-field` | 存在且可见 |
| U-22 输入框 | `Edit`（`<textarea>`） | `用一句话说明想怎么改` | `e0-utterance-input` | 可聚焦、可输入；`ValuePattern` 可读回输入内容 |
| U-23 关联说明 | — | — | `e0-utterance-hint` | `aria-describedby` 指向的 id 必须真实存在（否则 UIA 描述为空） |
| U-24 字数提示 | `Text`（`role="note"`） | `字数统计` | — | 形如 `已写 12 / 500 字，还可写 488 字` |
| U-25 空输入提示 | `Text`（`role="note"`） | `需求缺失提示` | — | 空值时出现且含 `MISSING`；输入后消失 |
| U-26 上限 | `Edit` | 同上 | 同上 | 输入超过 500 字被截断（`maxLength` 生效），UIA 读回的 Value 长度 ≤ 500 |
| U-27 错误 | `Text`（`role="alert"`） | `改造要求错误` | — | 仅在有错误时出现 |

### 1.4 进度条 `RunProgressBar.jsx`

| 断言 | role | 可读名称 | 稳定 id | 期望 |
|---|---|---|---|---|
| U-28 区域存在 | `Group`（`role="region"`） | `执行进度` | `e0-progress` | 存在 |
| U-29 步数提示 | `Text`（`role="note"`） | `进度步数` | — | 形如 `共 5 步，最新：完成（已完成）` |
| U-30 阶段列表 | `List`（`role="list"`） | `阶段列表` | — | `aria-live="polite"`（UIA 侧为 `LiveSetting=Polite`） |
| U-31 每一步 | `ListItem`（`role="listitem"`） | `<阶段中文名>：<事件状态中文>` | — | 数量与真实事件数一致；**顺序**与事件顺序一致 |
| U-32 未知阶段保留 | `ListItem` | `未知阶段（<stage>）：…` | — | 收到白名单外 stage 时**必须**出现该行，且后续阶段仍在其后（不丢步） |
| U-33 未知阶段可辨识 | `ListItem` | 同上 | — | 存在 `data-known-stage="false"` 与说明文本「白名单外阶段，按原样保留（不丢步）」 |
| U-34 空进度 | `Text`（`role="note"`） | `尚无进度` | — | 未开工时出现且含 `NOT_RUN`；**不得**出现假阶段 |
| U-35 折叠提示 | `Text`（`role="note"`） | `进度折叠提示` | — | 超过 200 步才出现；文案说明折叠了多少步且未知阶段仍保留 |
| U-36 四态词表 | `Text`（`role="note"`） | `状态词说明` + 4 个 `状态词 <TOKEN>（中文）` | — | 恰好 4 个 token：`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`，无第五种 |

### 1.5 候选摘要卡 `CandidateSummaryCard.jsx`

| 断言 | role | 可读名称 | 稳定 id | 期望 |
|---|---|---|---|---|
| U-37 区域存在 | `Group`（`role="region"`） | `候选摘要` | `e0-candidate-summary` | 存在 |
| U-38 无候选 | `Text`/`Status` | `候选状态：NOT_RUN` + `无候选提示` | — | 没有候选时如实写 `NOT_RUN`，不出现「通过」字样 |
| U-39 静态门禁 | `Text`/`Status`（`role="status"`） | `静态门禁：<四态>` | — | 与静态汇总一致；`FAIL` 时提交按钮必须不可用（E3 接线时校验） |
| U-40 修改文件数 | `Text` | `修改文件数 <n>` | — | 数字来自平台字段（见 interface-gap R7）；缺字段时如实为 0/未知，不得编造 |
| U-41 treeDigest | `Text` | `treeDigest <完整值或“未知”>` | — | 短摘要可见、`title`/名称里是完整 `sha256:…` |
| U-42 attempt | `Text` | `attempt <attemptId>` | — | 与本次 run 的 attemptId 一致；revision 一并显示 |
| U-43 目标页面 | `Text` | `目标页面 <pageId>` | — | 与提交时的 targetPage 一致 |
| U-44 静态汇总 | `Text`/`Status` | `静态检查汇总：<四态>` | — | 四态之一；明细行名称形如 `source.check：PASS` |
| U-45 运行时汇总 | `Text`/`Status` | `运行时检查汇总：<四态>` | — | 微信未跑必须是 `NOT_RUN` / `BLOCKED`，**不得**显示 PASS |
| U-46 运行时明细 | `ListItem` | `wechat.verify：BLOCKED` 等 | — | 每行有 `data-status`；名称可读 |
| U-47 BLOCKED 原因 | `Group`/`List` | `BLOCKED 原因` | — | 每条形如 `BLOCKED wechat.verify <原因>`；**没有原因也要如实写**「平台未给出原因（不得据此视为通过）」 |
| U-48 NOT_RUN 原因 | `Group`/`List` | `NOT_RUN 原因` | — | 同上 |
| U-49 partial 提示 | `Text`（`role="note"`） | `partial 说明` | — | 存在 BLOCKED/NOT_RUN 时出现，文案含「partial ≠ 通过」 |
| U-50 门禁口径 | `Text`（`role="note"`） | `门禁口径说明` | — | 文案明确「只表示能不能提交，不等于已采用/已导出」 |

---

## 2. 走查顺序（E3 脚本按此顺序执行）

```text
S1 打开应用 → 右栏切换到「Agent 对话」          断言 U-01（进入单页输入区）
S2 读 get-context.targetPages                    断言 U-03/U-04/U-07（8 页 + 不可选原因）
S3 选一个 enabled 页                             断言 U-05；再点一个 disabled 页断言 U-06 无变化
S4 不选图直接看提示                              断言 U-11=U-12=U-19（MISSING + BLOCKED）
S5 选 1 张参考图（真实 PNG/JPEG/WebP，≤2 MiB）    断言 U-13/U-15；再移除断言回到 U-12
S6 勾选同意                                      断言 U-16 翻转 → U-18 转「已记录用户同意」
S7 输入 utterance（含超长用例）                   断言 U-22/U-24/U-26
S8 清空 utterance                                 断言 U-25（MISSING 提示回来）
S9 触发一次真实 run，观察 agent:progress          断言 U-29/U-31 顺序正确
S10 注入一个白名单外 stage（测试桩或真实事件）      断言 U-32/U-33（未知阶段保留，后续步不丢）
S11 等 run 结束看候选摘要                         断言 U-37…U-50；微信未跑必须是 NOT_RUN/BLOCKED
S12 取消一次运行                                  `too-late` 只显示「已完成，无法取消」，**不得**显示为失败
```

> S10 是**必须**的一条：旧链 `src/domain/frontendReconstruct.mjs:703` 的 `return sameState` 会把未知阶段静默吞掉
> （冻结 §10 D-UI-1），E0 新链如果也丢步，这条断言必须红。

---

## 3. 负例与状态记法（E3 必须逐条覆盖）

| 负例 | 触发方式 | 期望 UIA 表现 | 状态记法 |
|---|---|---|---|
| 缺参考图 | 不选图直接开始 | U-12 出现 `MISSING`，U-19 出现 `BLOCKED` | 若被允许继续：`FAIL` |
| 未勾同意 | 选图但不勾 | U-18 含 `BLOCKED` | 若被允许继续：`FAIL` |
| 非 enabled 页 | 点灰页 | U-06 无选中变化 + U-07 原因可见 | 若被选中：`FAIL` |
| 白名单外 stage | 注入未知 stage | U-32/U-33 出现且不丢步 | 若被丢弃：`FAIL` |
| 检查 FAIL | 造一次 source.check 失败 | U-39/U-44 显示 `FAIL`，提交不可用 | 若可提交：`FAIL` |
| 微信不可用 | 无 DevTools / 超时 | U-45/U-46 为 `BLOCKED` 或 `NOT_RUN`，U-47/U-48 给原因 | 若显示 PASS：`FAIL` |
| 证据陈旧 | treeDigest 与记录不一致 | 平台应回 `AGENT_EVIDENCE_STALE`；UI 不得显示「已采用」 | 若显示已采用：`FAIL` |
| 环境跑不起来 | `agent:app` 失败 / 快照超时 | 记 `BLOCKED` + 真实错误行（不截断、不改写） | `BLOCKED` |
| 本轮未接线 | e0 组件不在真实树里 | `agent:find -- 目标页面选择` 退出码 1 | `NOT_RUN` |

---

## 4. 证据归档口径（E3 产出物）

- 目录：`docs/evidence/workspace-agent/e3-uia/`（E3 自己的证据目录，不在本轮范围）。
- 每条断言一行：`断言ID | 结果 | 名称/ref | 快照文件 | 备注`；`BLOCKED`/`NOT_RUN` 必须写原因。
- 快照落盘用 `npm run agent:snapshot -- --out <file>`（**不要** `Set-Content -Encoding UTF8`，会带 BOM 破坏 JSON）。
- 截图：只允许 `agent:snapshot` 同屏辅助；文件名标 `uia`；**禁止**用 React 预览/DevTools 模拟器截图冒充微信截图
  （冻结 `AGENTS.md` 边界 + §14.11 口径：等价门禁 ≠ 官方门禁 ≠ 微信/UIA 验收）。
- 任何一条 FAIL 都不能用「其它条都过了」抵消；E0/E3 的通过与否由 verifier 独立复核。

---

## 5. 序号自检（填表用）

| 断言段 | 条数 | 覆盖要求 |
|---|---|---|
| U-01…U-09 目标页 | 9 | 8 页枚举 + 不可选原因 + 数量提示 |
| U-10…U-20 参考图/同意 | 11 | MISSING/BLOCKED + consent 翻转 + 无路径泄漏 |
| U-21…U-27 utterance | 7 | 可读名称 + 上限 + MISSING |
| U-28…U-36 进度 | 9 | 顺序 + 未知阶段不丢步 + 四态词表 |
| U-37…U-50 候选摘要 | 14 | 修改文件数 + treeDigest + 两套四态 + BLOCKED/NOT_RUN 原因 |
| **合计** | **50** | 每条都能用 `agent:find` / `agent:verify` 判真假 |

---

## 6. 命令模板（E3 直接复制）

```powershell
# 启动（agent shell 里用这个，避免 ELECTRON_RUN_AS_NODE=1）
npm run agent:app

# 找元素（失败退出码非 0）
npm run agent:find -- "目标页面选择"
npm run agent:find -- "同意把参考图发给模型"

# 只断言文本存在（缺失则退出码 1）
npm run agent:verify -- "未知阶段"
npm run agent:verify -- "MISSING"
npm run agent:verify -- "NOT_RUN"

# 语义点击 / 输入（ref 必须来自当次快照，PowerShell 里加单引号）
npm run agent:snapshot
npm run agent:click -- "菜单页（menu）"
npm run agent:click -- "同意把参考图发给模型"
npm run agent:type -- "用一句话说明想怎么改" "菜单页按分类横滑，卡片更像实拍"

# 快照落盘（不要用 Set-Content -Encoding UTF8）
npm run agent:snapshot -- --out docs/evidence/workspace-agent/e3-uia/snap-s1.json

# 快照慢的时候加超时（Chromium 首次构建无障碍树较慢）
npm run agent:snapshot -- --timeout-ms 25000
```

---

## 7. 与 E0-U1 的边界（本轮明确不做的事）

1. **不执行** §2 的 S1–S12，也不产出快照/截图：e0 组件尚未接线，`src/App.jsx` / `RightPanel.jsx` 属 Captain 派单。
2. **不伪造**：本文件里没有任何 `PASS`，也没有“已走查”的表述；全部 `NOT_RUN`。
3. 不新增 UIA 专用入口（不加 `data-testid` 之外的桥接、不加 IPC 通道）；组件侧已给足 `role` + `aria-label` + `id`，
   E3 只需要按名字断言。
4. 组件级的“源码可断言”部分（角色/名称/未知阶段/MISSING/四态）已由
   `test/e0-ui-components.test.cjs` 与 `test/e0-ui-contract.test.cjs` 覆盖（22/22 pass），
   但**源码断言 ≠ UIA 验收**，两者不得互相替代。
