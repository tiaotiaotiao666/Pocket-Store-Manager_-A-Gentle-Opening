# Review-t7 round 2：E0-R2 修复复核（t20）与 X2 静态安全边界

> 任务：`t21 / Review-t7 round 2`（复核者：runtime-engineer2，attempt 2）
> 被复核：`t7 / E0-R2`（X2 静态部分）+ `t20 / repair-round-2`（F1/F2 修复）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.8 / §14.13；计划 §4 E0-R2；t21 验收
> 复核方式：**只读被复核源码**（未修改 `desktop/**`、`test/**`、`docs/evidence/workspace-agent/e0-r2/**`），
> 另在本目录新增独立探针 `t21-probe.cjs`（直接 require 实现 + fake 模型/Coordinator + 真实 Coordinator 临时工作区；
> 不引用 t7 测试断言；PNG 样本复用证据目录的确定性生成器）。
> 结论：**PASS**（round 1 的 F1/F2 均已关闭；t7 静态安全边界与 t21 验收在现行字节上全部成立）。
> 边界：**不是 X2 关闭结论**；真实 DeepSeek 多模态调用 0 次（本复核离线），真实模型证据仍归 t8；
> 微信/UIA/安装包 NOT_RUN。

## 0. 被测字节（本判定只对这些字节成立）

复核时（2026-11-25，Node v24.14.0 / npm 11.9.0）逐文件 `Get-FileHash -Algorithm SHA256` 复算：

| 文件 | 字节 | sha256 | 与 round 1 对比 |
|---|---:|---|---|
| `desktop/agent-runtime/images.cjs` | 21 298 | `66234e7e69f9e764df4f49ae81fcbf3f5157a44fc8ce76fb094696871d082c23` | 未变 |
| `desktop/agent-runtime/multimodal.cjs` | 5 192 | `939fb7670f1cd9605ffe571fb3816842e6546d7264bc970176eeea61e9836d95` | 未变 |
| `desktop/agent-runtime/workspace-runtime.cjs` | 35 710 | `8b52c22e663a38399d3766cfd993e5c9e1c4efe742d329c1639df6ee10ff55ec` | 未变 |
| `desktop/agent-runtime/model-chat.cjs` | 4 523 | `0ca728cb590d8b05997d6a654f1dbcea01eaf29260625b30f03bc5846bea1405` | 未变 |
| `desktop/model-credentials.cjs` | 32 677 | `70d15a78003a0a89f8aa7a8779f0de6e14990914c31f85fa5b375d37ab810a52` | 未变 |
| `docs/evidence/workspace-agent/e0-r2/run-real-call.cjs` | 16 324 | `40a4467d589569498fb98589cb1a19a5d71306b0dd150f1458bc8706bb9119a0` | **已改（F1）** |
| `test/runtime/images.test.cjs` | 32 896 | `8a178cda44e829bbb274b96314b03de81ee901a7212af271b3da1c446004c2db` | **已改（F1 回归）** |
| `test/runtime/multimodal-upstream.test.cjs` | 11 397 | `5d8df4c50c639afa3cd1b2a6bc0b9046c1a2ec54e0a92331f970b2f70c94f322` | **已改（F2）** |
| `test/runtime/workspace-runtime.test.cjs` | 28 896 | `63b092e516380bdf37642d88e2239693def1db33e96240e3f05157f63ddf594f` | 未变 |
| `docs/evidence/workspace-agent/e0-r2/probe.png` | 341 | `5dae3842d7bfe72cc97883cfdc6424a1774acd10fc958432d63125b4395eea34` | 未变 |
| `docs/evidence/workspace-agent/e0-r2/real-call.json` | 228 | `ef2e570a426c5760c3a9209b4b3a338c100f3c120fd2dc583c1de04d7c3623a5` | BLOCKED 记录 |
| 本复核探针 `t21-probe.cjs` | 23 657 | `afba4ee654234cba8d66392c94f7940c6326cf886c1c7c25b6595a19827fd7cd` | 新增 |

round 1 的 t7-probe 未改动（`7c42f255…ee604d`，29 674 B），本次作为独立回归复跑（§1）。

## 1. 命令与真实退出码（本次复核独立执行）

| # | 命令 | 真实退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"` | **0** | tests 87 / pass 86 / fail 0 / skipped 1 / duration_ms 707（skip = 文件 symlink EPERM，见 §5） |
| 2 | `node docs/evidence/workspace-agent/reviews/t7-probe.cjs`（round 1 独立探针回归） | **0** | 17 pass / 0 fail / 1 skip；observations 只剩 O3（round 1 的 O1/O2 已消失） |
| 3 | `node docs/evidence/workspace-agent/reviews/t21-probe.cjs`（本轮独立探针） | **0** | **14/14 pass**（F1a–c、F2a–b、Z、A1、V1、M1、R1、R2、Z2、E1、D1） |
| 4 | `Get-FileHash -Algorithm SHA256 docs/evidence/workspace-agent/e0-r2/probe.png` | 0 | 341 B / `5dae3842…ea34`（与脚本/报告/probe 一致） |

口径说明：

- 命令 1 为 t7/t20 的 verify 门禁；命令 2/3 是独立探针（不引用 t7 测试断言）。
- 真实模型调用 **0 次**；`D1` 用 fake `modelChat` + 真实 Coordinator 临时工作区，不联网。
- 官方 `npm test` / `npm run build` 本复核 **NOT_RUN**（不在 t21 验收内）。

## 2. t20 的两条修复（round 1 findings）

### F1（round 1 high）证据脚本把 `data:image/...` 前缀写进 `real-call.json` —— **已关闭**

- `run-real-call.cjs` 已删除 `sentParts.dataUrlPrefix` 与 `.slice(0, 24)`（`t21-probe` F1c 断言源码无 `dataUrlPrefix`/`data:image/`）；
  唯一报告出口 `buildRealCallReport`（`:170-196`）只记
  `hasImageUrl` / `imageUrlScheme:'inline-data-url'` / `dataUrlBytes` / `sentSha256MatchesProbe`，**不复制 URL 片段**。
- 独立探针 F1a：构造 PASS 形状报告 → `JSON.stringify(report)` **不含 `data:`、不含图片 base64**，且 `hasImageUrl=true`。
- 独立探针 F1b：对 `docs/evidence/workspace-agent/e0-r2/**` 全量扫描 `data:image/` 与 probe.png base64 前缀 → **0 命中**；
  当前 `real-call.json` 仍是 BLOCKED、228 B、无 `data:`。
- 回归用例 `test/runtime/images.test.cjs:617-648` 固化“PASS 报告构造不含任何 `data:` 字面量”；
  `test/runtime/images.test.cjs:578-608` 的证据目录扫描在门禁中真实执行（命令 1 exit 0）。
- t8 真实 PASS 后按当前 builder 落盘不会把图片 data URL/前缀写进证据（builder 只记布尔/摘要字段；
  若模型 reply 自身出现 `data:` 字样那是模型文本，不是内联图片，见 OBS-E）。本复核用 builder 输出 + 全量扫描证明，
  未临时改写 `e0-r2/real-call.json`。

### F2（round 1 medium）“400 KiB 通道上限”用例只有预检、没有 runtime —— **已关闭**

- `test/runtime/multimodal-upstream.test.cjs:172-221` 现在真的构造
  `createDirectWorkspaceRuntime({ coordinator, modelChat, userDataDir })`，用 ≈660 KiB 的 asset 调 `run.invoke`，
  断言 `AGENT_IMAGE_INVALID` / `issues[0].code==='channel_rejected'` / `data.status==='needs_input'` /
  `modelChat.calls.length===0`；未使用的 upstream/空 modelChat 已删除。
- 独立探针 F2a 静态复核该用例块包含真实 runtime 与 `calls.length, 0`、无 `upstream.bodies` 占位；
  F2b 独立重跑 660 KiB → `AGENT_IMAGE_INVALID/channel_rejected/needs_input`、上游 0 次。
- 门禁 1 中该用例真实执行并通过（exit 0）。

## 3. 验收逐条核对表（t21 合同）

| # | 验收项 | 结论 | 证据（文件:行 / 命令 / 探针） |
|---|---|---|---|
| 1 | 只接受 assetId，无路径/base64 入口 | PASS | `images.cjs:32,336-338`；`workspace-runtime.cjs:144-171`；探针 A1（路径/相对路径/data URL/裸 base64/简写全 `asset_id_invalid`）；t7-probe A1 |
| 2 | project.json→fileName→lstat 非链接→realpath == 资产根 realpath+fileName；资产根恰为 `<项目真实目录>/assets/images` 且在 userData 内 | PASS | `images.cjs:348-391`（`samePath(rootReal, projectReal/assets/images)`、`withinPath(projectReal,userDataReal)`、`lstat.isSymbolicLink`、`samePath(fileReal,expectedReal)`）；t7-probe P1/P2/P4；文件级 symlink 本机 EPERM skip（代码路径 `:381-383`）；残余见 OBS-B |
| 3 | 魔数与真实 MIME 一致并真实解码（PNG CRC/IDAT/扫描行；JPEG 段/SOF/SOS/EOI；WebP RIFF/VP8*） | PASS | `images.cjs:66-248`；探针 V1（正常样本通过；MIME 不符/截断 PNG 拒绝）；t7-probe V1/V2；`images.test.cjs:333-374` 的 JPEG/WebP 结构样本 |
| 4 | 登记字节数/sha256 不符即拒 | PASS | `images.cjs:409-417`；探针 V1（`asset_digest_mismatch`）；t7-probe V3 |
| 5 | 大小口径：平台 2 MiB、通道 400 KiB、生效值 min=400 KiB | PASS | `images.cjs:28,340-342`（2 MiB，只可调小）；`model-credentials.cjs:33,189-191`（409600 B）；探针 Z（409600 通过 / 409601 拒绝）与 F2b（660 KiB → `channel_rejected`、0 上游） |
| 6 | 超限/坏图 → `AGENT_IMAGE_INVALID`；E0 只接受 1 张 | PASS | `images.cjs:53-55,343-346,393-406,432-459`；探针 F2b/V1/Z2（2 张 → `too_many_images`）；t7-probe Z2/R2 |
| 7 | `buildMultimodalContent` 产出真实 `image_url` data URL、顺序稳定 | PASS | `multimodal.cjs:50-74`；探针 M1（两次构造逐字节一致、text→image_url、解码=probe.png）；t7-probe M1；`images.test.cjs:378-415` |
| 8 | data URL 只在内存；attempt/run/project/证据/trace 全量扫描不含 base64 或 data: | PASS | 产品侧 `workspace-runtime.cjs:758-760` + 探针 D1（真实 Coordinator 临时工作区：`attempt.json`/`run.json`/`project.json`/整棵 userData/结果/进度/trace 均无 `data:image/` 与 probe base64）；证据目录见 F1b；t7-probe R3 |
| 9 | 视觉 fail-closed；缺图/无视觉 → `AGENT_IMAGE_INVALID` / `AGENT_VISION_UNAVAILABLE(+needs_input)`，且 0 上游 | PASS | `multimodal.cjs:97-118`；`workspace-runtime.cjs:296-372`；探针 R1（VISION_UNAVAILABLE/needs_input/0 次）、R2（路径/data URL/未知 assetId → IMAGE_INVALID/0 次）；t7-probe R1/R2 |
| 10 | 独立复跑 runtime 门禁并记录退出码；probe.png sha256 与脚本断言一致 | PASS | §1 命令 1 exit 0（87/86/0/1）；命令 4：341 B / `5dae3842…ea34`；探针 E1（96×96、report.md 记录、无 data URL）；`images.test.cjs:650-676` |

**统计**：10/10 PASS。round 1 的两条 findings 已关闭；t7 测试文件现为 26 个 `test(`（新增 F1 回归），
`multimodal-upstream` 仍 3 个。

## 4. 关注点逐条结论

1. **是否有第二条“路径/base64 直入”绕道 —— 没有。**
   `normalizeImageRequest` 只把字符串/`{assetId}` 且匹配 `a_[0-9a-f]{16}` 的项放进 `assetIds`，
   其它一律 `AGENT_IMAGE_INVALID`（`workspace-runtime.cjs:144-171`）；解析器入口只认 assetId（`images.cjs:336-338`）。
   探针 A1/R2 分别覆盖解析器与 runtime 两个入口。
2. **realpath/junction 是否可绕过 —— 资产根/文件级都不能；项目目录换根到 userData 内另一项目属本地篡改残余（OBS-B）。**
   资产根 `realpath` 必须等于 `projectReal + /assets/images` 且在 `userDataReal` 内；资产根 junction 指向外部
   （t7-probe P1）与项目目录 junction 指向 userData 外（P2）都被拒；文件 symlink 由 lstat 拒（本机 EPERM skip）。
3. **data URL 是否漏进磁盘/日志 —— 产品侧与证据脚本都不漏。**
   runtime 结果只回 `{assetId,mime,bytes,sha256}` + `multimodal`；进度只带 assetId；trace 只含工具/步骤摘要；
   D1 用真实 Coordinator run 扫描 `attempt.json`/`run.json`/`project.json`/整棵 userData/结果/进度/trace；
   F1b 扫描证据目录；`buildRealCallReport` 无 `data:`/base64（F1a）。
4. **失败路径是否真 0 上游 —— 是。**
   视觉门、图片解析、400 KiB 通道预检都在 `modelChat.chat` 之前 return；探针 R1/R2/F2b 分别覆盖
   无视觉、坏输入、400 KiB 超限，均 `modelChat.calls.length===0`。
5. **大小口径是否 400 KiB 生效 —— 是（runtime 生效边界）。**
   平台解析 2 MiB；通道常量 409600 B；400 KiB 边界 409600 通过/409601 拒绝；660 KiB 在 runtime 被
   `channel_rejected` 且 0 上游。解析器单独调用仍可拿 2 MiB dataUrl（OBS-C，当前唯一消费方是 runtime）。
6. **测试是否仍有“看起来通过”的空断言 —— 已消除 F2 那条；未发现新的空断言。**
   通道用例现在真调 runtime 并断言 0 上游；F1 回归断言 PASS builder 输出无 `data:`；证据扫描在门禁中真实执行。
   t7-probe round 1 的 O1/O2 条件已不再成立（本次复跑 observations 只剩 O3）。

## 5. 观察（非阻塞，不影响 PASS）

| ID | 级别 | 事实 | 建议/去向 |
|---|---|---|---|
| OBS-A | low | `docs/evidence/workspace-agent/e0-r2/report.md` 仍是 t20 之前的描述：§5 写 `sentParts（类型/前缀/字节数/摘要…）`，§4 写 `images.test.cjs 25`（现为 26）。实际脚本已无前缀、测试已加回归 | 建议 t8 引用前更新报告（文档只读，未改） |
| OBS-B | low | 把 `projects/<A>` 做成指向 `projects/<B>`（同一 userData 内）的 junction 时，`resolveAssetImage(A, B 的 assetId)` **会成功**（实测 `assetId a_5dae3842…`、341 B）。原因：检查只要求 `rootReal === projectReal/assets/images` 且 `projectReal` 在 userData 内，未把 `projectReal` 绑定到 `userDataReal/projects/<projectId>`。需要本地建 junction，渲染进程无法直接制造；属防御纵深残余，未违反本轮“<项目真实目录>/assets/images”的字面判据 | E1 硬化时补 `samePath(projectReal, path.join(userDataReal,'projects',projectId))`；或证明项目目录 junction 只可能由本地用户制造 |
| OBS-C | info | 解析器上限 2 MiB、通道 400 KiB 分属两层；当前唯一消费方 runtime 会调 `assertChannelAccepts`，故“生效值 400 KiB”成立；若未来有调用方直接用 `resolveAssetImage().dataUrl` 会跳过 400 KiB（round 1 O3 同项） | 保持 runtime 唯一消费方或在 images.cjs 注释/describe 标明 |
| OBS-D | info | 文件级 symlink 用例本机 `EPERM`（Windows 开发者模式），门禁为 1 skipped；代码路径有 `lstat.isSymbolicLink()` 拒绝（`images.cjs:381-383`），junction 换根用例真实运行并通过 | 不构成 FAIL；换有权限环境可补跑 |
| OBS-E | info | 证据目录全量扫描的判据是 `data:image/` + 样本 base64 前缀，不是任意 `data:` 子串（`run-real-call.cjs` 注释本身含 `data:` 字样）；这与“不得内联图片”语义一致，避免把文档措辞误判为泄漏 | 若 t8 需要更严的“任意 data:”，应只针对 JSON 报告/证据镜像做白名单，而不是源码注释 |

## 6. 事实边界

- 本次复核 **真实 DeepSeek 调用 0 次**；D1 的“上游调用”是 fake `modelChat` 计数，不联网、不产生真实费用。
- **X2 未关闭**：t8 仍需用 `run-real-call.cjs` 产出真实多模态 PASS（本复核只确认脚本不会再写入图片 data URL/前缀）。
- 微信/UIA/安装包 = **NOT_RUN**；本复核不触及。
- 未修改任何被复核代码/测试/证据；本目录新增仅 `t21-probe.cjs` 与本文。

## 7. 复现方式

```powershell
# 1) t7/t20 verify 门禁（真实退出码见 §1）
node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"

# 2) round 1 独立探针回归（17 pass / 0 fail / 1 skip）
node docs/evidence/workspace-agent/reviews/t7-probe.cjs

# 3) round 2 独立探针（14/14）
node docs/evidence/workspace-agent/reviews/t21-probe.cjs

# 4) 归档样本摘要
Get-FileHash -Algorithm SHA256 docs/evidence/workspace-agent/e0-r2/probe.png
```

## 8. 总计划 §0.3 模板汇报

```text
任务 ID：t21 / Review-t7 round 2（E0-R2 修复复核 + X2 静态安全边界）
目标是否完成：YES（t20 的 F1/F2 均关闭；t21 的 10 条验收全部 PASS；无阻塞 finding）
实际修改文件：
  - docs/evidence/workspace-agent/reviews/t7-review-round2.md（本文）
  - docs/evidence/workspace-agent/reviews/t21-probe.cjs（独立探针，14/14）
  - 未改 desktop/**、test/**、docs/evidence/workspace-agent/e0-r2/** 等被复核内容
执行命令与真实退出码：
  node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" → exit 0（87 tests / 86 pass / 0 fail / 1 skipped）
  node docs/evidence/workspace-agent/reviews/t7-probe.cjs → exit 0（17 pass / 0 fail / 1 skip；observations 仅 O3）
  node docs/evidence/workspace-agent/reviews/t21-probe.cjs → exit 0（14/14）
  Get-FileHash probe.png → 341 B / 5dae3842…ea34
真实模型/微信/UIA/安装包：NOT_RUN（全部离线；fake 模型/Coordinator；X2 真实关闭仍待 t8）
关键结论：
  - F1：run-real-call 已删 dataUrlPrefix；buildRealCallReport 只记 hasImageUrl/imageUrlScheme/dataUrlBytes；
    PASS 报告 0 data:/0 base64；证据目录与 real-call.json 扫描干净；回归用例固化
  - F2：400 KiB 用例已真调 runtime；660 KiB → AGENT_IMAGE_INVALID/channel_rejected/needs_input/0 上游；
    独立探针 409600 通过、409601 拒绝，平台 2 MiB 不变
  - assetId 唯一入口/canonical/junction/魔数+真解码/摘要防篡改/单图/视觉 fail-closed/失败 0 上游/落盘无 data URL
    均独立复核成立；D1 用真实 Coordinator run 扫描 attempt.json/run.json/project.json/整棵 userData/结果/进度/trace
  - 观察（不阻塞）：报告文档仍写旧前缀/旧用例数（OBS-A）；项目目录 junction 到 userData 内另一项目可读（OBS-B，本地篡改残余）；
    解析器 2 MiB vs 通道 400 KiB 分层（OBS-C）
剩余问题：OBS-A/B/C/D/E 均非阻塞；X2 真实多模态证据与 P1–P2 的真实回答归 t8
下一任务是否可开始：就 t21 复核门禁 YES；E0/X2 整体仍由 t8 出具
```
