# Review-t7：E0-R2 图片解析与多模态消息独立复核

> 任务：`t17 / Review-t7`（复核者：workspace-lead2，attempt 2）
> 被复核任务：`t7 / E0-R2`（runtime-engineer）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.8 / §14.13；计划 §4 E0-R2
> 复核方式：**只读被复核源码**（未修改 `desktop/**`、`test/**`、`templates/**`、`miniprogram/**`），
> 另在本目录新增独立探针 `docs/evidence/workspace-agent/reviews/t7-probe.cjs`（直接 require 实现，
> 不引用 t7 测试断言；PNG 样本用证据目录里的确定性生成器）。
> 结论：**NEEDS_REVISION**（产品实现本身正确，但有 1 个 high + 1 个 medium 的交付缺陷需要修：
> 证据脚本会把 `data:image/...` 前缀写进 `real-call.json`，t8 真实调用后会让 t7 自己的证据扫描用例失败；
> 另有一条 400 KiB 用例声称 runtime 行为却从未创建 runtime）。
> 边界：真实 DeepSeek 调用 0 次（本机无 Key / 本复核不执行真实调用）；本复核**不是** E0/X2 关闭结论。

## 0. 被测字节（本判定只对这些字节成立）

复核时（2026-11-25）逐文件复算 sha256（`Get-FileHash -Algorithm SHA256`），未采用 t7 报告自述：

| 文件 | 字节 | sha256 |
|---|---:|---|
| `desktop/agent-runtime/images.cjs` | 21 298 | `66234e7e69f9e764df4f49ae81fcbf3f5157a44fc8ce76fb094696871d082c23` |
| `desktop/agent-runtime/multimodal.cjs` | 5 192 | `939fb7670f1cd9605ffe571fb3816842e6546d7264bc970176eeea61e9836d95` |
| `desktop/agent-runtime/workspace-runtime.cjs`（图片分支） | 35 710 | `8b52c22e663a38399d3766cfd993e5c9e1c4efe742d329c1639df6ee10ff55ec` |
| `desktop/agent-runtime/model-chat.cjs`（supportsVision） | 4 523 | `0ca728cb590d8b05997d6a654f1dbcea01eaf29260625b30f03bc5846bea1405` |
| `desktop/model-credentials.cjs`（400 KiB 通道上限） | 32 677 | `70d15a78003a0a89f8aa7a8779f0de6e14990914c31f85fa5b375d37ab810a52` |
| `docs/evidence/workspace-agent/e0-r2/probe.png` | 341 | `5dae3842d7bfe72cc97883cfdc6424a1774acd10fc958432d63125b4395eea34` |
| `docs/evidence/workspace-agent/e0-r2/run-real-call.cjs` | 14 094 | `72ba61cd8867dd8809fc7e9ebaedc85a29adbc200041895fd17c94b43ad452e8` |
| `test/runtime/images.test.cjs` | 31 302 | `9bc1cc1925cdf70e55a0ed1b048e319d4d5ff4afcd25f90b120141b08925b13d` |
| `test/runtime/multimodal-upstream.test.cjs` | 10 676 | `7c039cb3ef7de36455948e9d48e2a1e61977e95e9ba383311e02806ddbaf09e8` |
| `test/runtime/workspace-runtime.test.cjs` | 28 896 | `63b092e516380bdf37642d88e2239693def1db33e96240e3f05157f63ddf594f` |

## 1. 命令与真实退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"` | **0** | tests 86 / pass 85 / fail 0 / skipped 1（skip = 文件 symlink EPERM，见 §5） |
| `node docs/evidence/workspace-agent/reviews/t7-probe.cjs` | **0** | 独立探针 17 pass / 0 fail / 1 skip + 3 条 observations（产品侧断言全成立） |
| `Get-FileHash docs/evidence/workspace-agent/e0-r2/probe.png` | 0 | `5dae3842…ea34`、341 B，与脚本/报告一致 |

探针覆盖：`S1` 无写盘/子进程；`A1` 只认 assetId；`A2` 5 键冻结形状；`P1` 资产根 junction 换根拒绝；
`P2` 项目目录 junction 到 userData 外拒绝；`P3` 文件 symlink（本机 EPERM 跳过）；`P4` fileName 越界拒绝；
`V1` 魔数/MIME 不符拒绝；`V2` 截断 PNG 真解码拒绝；`V3` 登记 sha256/bytes 不符拒绝；
`Z1` 平台 2 MiB 边界；`Z2` E0 单图；`Z3` 400 KiB 通道口径在 **runtime** 层生效且上游 0 次；
`M1` parts 顺序稳定 + 解码一致；`R1` 视觉 fail-closed + 0 上游；`R2` 缺图/坏图/路径/base64 0 上游；
`R3` 结果/进度/userData 无 data URL；`E1` 归档样本 96×96 真解码。

## 2. Findings（需要修复，故本复核判 NEEDS_REVISION）

### F1（high）证据脚本会把 `data:image/...` 前缀写进 `real-call.json`，t8 真实调用后 t7 自己的证据扫描用例必失败

- **位置**：`docs/evidence/workspace-agent/e0-r2/run-real-call.cjs:296-305`（`report.sentParts`）；
  `test/runtime/images.test.cjs:578-608`（`scan(EVIDENCE_DIR)`，命中 `data:image/` 即失败）。
- **问题**：`run-real-call.cjs` 在 PASS 时写
  `sentParts.dataUrlPrefix = parts[1].image_url.url.slice(0, 24)`，
  实际值是 `"data:image/png;base64,iV"`（已复核，24 字符）。t8 按契约执行该脚本后，
  `docs/evidence/workspace-agent/e0-r2/real-call.json` 里就会出现 `data:image/` 字面量：
  1) 与 §14.8-4「data URL 只在调用内存」的口径相冲突（虽只是 24 字符前缀，不含完整图片），
  2) 会让 `test/runtime/images.test.cjs` 的「证据目录全量扫描」用例在下一次运行直接失败——
     而 t8 的 verify 里包含这条测试命令，属于**会把 E0 门禁卡红**的交付缺陷。
- **证据**：探针 `O1-real-call-evidence-prefix`；`node -e "'data:image/png;base64,iVBORw0KGgo'.slice(0,24)"`
  → `"data:image/png;base64,iV"`；当前 `real-call.json` 仍是 BLOCKED 记录（228 B）所以暂未暴露。
- **requiredFix**：`run-real-call.cjs` 的落盘报告不得包含任何 `data:` 字面量。把
  `sentParts.dataUrlPrefix` 换成 `hasImageUrl: true` / `imageUrlScheme: 'inline-data-url'`
  （mime/bytes/sha256 已在 `cases[].images` 与 `probe` 里），并在有 PASS 报告存在的前提下复跑
  `node --test --experimental-test-isolation=none test/runtime/images.test.cjs` 证明扫描仍为绿。
  **不得**用「把 real-call.json 从扫描里排除」的方式放宽断言。

### F2（medium）“通道上限 400 KiB”用例声称 runtime 层 0 上游，但从未创建 runtime（证据虚化）

- **位置**：`test/runtime/multimodal-upstream.test.cjs:172-207`，注释在 `:191`
  「同一个超限图在 runtime 层也不会发出任何上游调用」。
- **问题**：该用例只做了 `assertChannelAccepts` 预检，随后用 `createModelChat` 造了一个从未被调用的
  modelChat，并断言 `calls.length === 0` / `upstream.bodies.length === 0` —— 这两条无论如何都为真，
  因为根本没有 `createDirectWorkspaceRuntime(...)` 调用。也就是说“超 400 KiB 的图在 runtime 层 0 上游”
  这条验收**没有测试覆盖**，报告的“runtime 0 上游”证据被放大。
- **证据**：探针 `O2-test-claims-runtime-but-only-preflight`；代码块见 `:190-203`（无 runtime 构造）。
- **产品行为本身是对的**：探针 `Z3-effective-channel-400KiB-in-runtime` 用 660 KiB 真实样本 + 真 runtime
  证实 `AGENT_IMAGE_INVALID / channel_rejected`、上游 0 次、Coordinator 0 次。所以这是**用例质量问题**，
  不是产品缺陷；但评审要求证据可复核，必须补真断言。
- **requiredFix**：在该用例里构造 `createDirectWorkspaceRuntime({ coordinator, modelChat（计数）, userDataDir })`，
  用超 400 KiB 的 asset 调 `run.invoke`，断言 `result.code === 'AGENT_IMAGE_INVALID'`、
  `result.issues[0].code === 'channel_rejected'`、`modelChat.calls.length === 0`；
  删除未被使用的 `upstream`/空 `modelChat` 占位，避免制造虚假覆盖。

## 3. 验收逐条核对表

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `resolveAssetImage` 只接受 assetId（无路径/base64 入口） | PASS | `images.cjs:326-338`；探针 A1（6 类输入全 `asset_id_invalid`，含真实路径也不读取） |
| 2 | 路径经 project.json→fileName→lstat 非链接→realpath 等于“资产根 realpath+fileName”；资产根恰为 `<项目真实目录>/assets/images` 且在 userData 内 | PASS | `images.cjs:348-391`；探针 P1（资产根 junction 换根 → `asset_root_outside_project`）、P2（项目目录 junction → 外部 → 拒绝）、P4（`../` → `asset_file_invalid`）；P3 文件 symlink 本机 EPERM 跳过（代码也有 `lstat.isSymbolicLink` 拒绝，:381-383） |
| 3 | 魔数与真实 MIME 一致并做真实解码（PNG CRC/IDAT/扫描行；JPEG 段/SOF/SOS/EOI；WebP RIFF/VP8*） | PASS | `images.cjs:66-248`；探针 V1/V2；`images.test.cjs:249-374`（含 JPEG/WebP 结构样本）；报告 §7-2 如实声明 JPEG/WebP 为段结构级 |
| 4 | 登记字节数/sha256 不符即拒 | PASS | `images.cjs:409-417`；探针 V3（`asset_digest_mismatch` / `asset_size_mismatch`） |
| 5 | 大小口径：平台 2 MiB、通道 400 KiB、生效值 min=400 KiB | PASS（附 O1 口径说明） | 平台 2 MiB：`images.cjs:28,340-342` + 探针 Z1（1.4 MiB 通过 / 2.3 MiB 拒绝 / limits 不能抬高）；通道 400 KiB：`model-credentials.cjs:33`；**runtime 生效值**由 `assertChannelAccepts` 预检 + 探针 Z3（660 KiB → `channel_rejected`、0 上游）证实 |
| 6 | 超限/坏图 → `AGENT_IMAGE_INVALID`；E0 只接受 1 张 | PASS | `images.cjs:53-55,393-406,432-459`；探针 Z2（2 张 `too_many_images`）、R2（坏图/超 2 MiB 0 上游） |
| 7 | `buildMultimodalContent` 产出真实 `image_url` data URL、顺序稳定 | PASS | `multimodal.cjs:50-74`；探针 M1（两次构造逐字节一致、text→image_url、解码=样本、裸 base64/SVG 拒绝）；`images.test.cjs:378-415` |
| 8 | data URL 只在内存：attempt/run/project/证据/trace 全量扫描不含 base64 或 data: | **FAIL（F1）** | 产品 runtime 侧 PASS：探针 R3（结果/进度/userData 扫描干净）、`images.test.cjs:578-608` 当前通过；但 `run-real-call.cjs` 在 t8 PASS 时会写 `data:image/` 前缀进证据，随后该扫描用例必失败 → 见 F1 |
| 9 | 视觉能力 fail-closed；缺图/无视觉 → `AGENT_IMAGE_INVALID` / `AGENT_VISION_UNAVAILABLE(+needs_input)`，均 0 上游 | PASS | `multimodal.cjs:97-118`；`workspace-runtime.cjs:296-374`；探针 R1（两种声明 + 0 上游）、R2（缺图/路径/base64/坏图 + 0 上游）、`images.test.cjs:466-530` |
| 10 | 独立复跑 verify 并记录退出码；probe.png sha256 一致 | PASS | §1：exit 0（86/85/0/1）；probe.png 341 B、`5dae3842…ea34`、96×96（探针 E1） |

**通过/未通过统计**：9 条 PASS、1 条 FAIL（第 8 条因 F1）。产品实现 17/17 探针成立；交付缺陷集中在
“证据脚本落盘”和“一条用例的虚假 runtime 覆盖”。

## 4. 五个关注点逐条结论

1. **是否有第二条“路径/base64 直入”绕道 —— 没有。**
   runtime 的 `normalizeImageRequest` 只接受 `a_<16hex>` 字符串或 `{assetId}`（`workspace-runtime.cjs:144-171`），
   路径/data URL/裸 base64 在 0 上游时被 `AGENT_IMAGE_INVALID` 拒绝（探针 A1/R2）；
   `resolveAssetImage` 只认 assetId（`images.cjs:336-338`）。
2. **realpath 校验能否被 junction 换根绕过 —— 不能。**
   资产根必须 `realpath === projectReal/assets/images` 且 `projectReal` 在 `userDataReal` 内
   （`images.cjs:356-368`）；资产根 junction（探针 P1）与项目目录 junction（P2）都被拒；
   文件级 symlink 由 `lstat` 拒（P3 本机 EPERM 跳过，代码路径在 `:381-383`；报告 §7-1 已如实登记）。
3. **data URL 是否会漏进磁盘/日志 —— 产品运行时不会；证据脚本会（F1）。**
   runtime 结果只回 `{assetId,mime,bytes,sha256}`（`:758-760`），进度只带 assetId，trace 不含图片；
   探针 R3 对 userData 全量扫描无 `data:image`/base64。但 `run-real-call.cjs` 的报告字段会写 24 字符
   `data:image/...` 前缀 → 与验收的“证据不含 data:”冲突，必须先修。
4. **失败路径是否真的 0 次上游调用 —— 是。**
   视觉门/图片解析/通道预检都在 `modelChat.chat` 之前，失败直接 return；探针 R1（视觉 0 次）、
   R2（缺图/路径/base64/坏图/超 2 MiB 0 次）、Z3（400 KiB 通道 0 次）。F2 指出 t7 用例没测到 Z3 这条，
   但产品行为已由本探针独立证实。
5. **大小口径是否按 400 KiB 生效（不是 2 MiB）—— 是（在 runtime 生效边界上）。**
   `images.cjs` 的平台上限是 §14.8 的 2 MiB；通道 400 KiB 由 `model-credentials` 的
   `MAX_IMAGE_BYTES_PER_IMAGE=409600` 定义，经 `assertChannelAccepts` 权威预检映射成
   `AGENT_IMAGE_INVALID/channel_rejected`；660 KiB 样本在 runtime 被拒且 0 上游（Z3）。
   若未来出现绕过 runtime 直接用 `resolveAssetImage().dataUrl` 的调用方，会跳过 400 KiB（观察 O3，当前不阻塞）。

## 5. 观察（非阻塞，不单独要求修复）

- **O1（low，口径/防绕过）**：解析器 2 MiB 与通道 400 KiB 分属两层；当前唯一消费方是 runtime，
  所以“生效值 min=400 KiB”成立；建议在 `images.cjs#describe` 或注释里显式写明“dataUrl 仅供 runtime 使用，
  通道还有 400 KiB 上限”，避免以后被别的调用方绕过。
- **O2（info，环境）**：文件级 symlink 用例本机 EPERM 跳过（Windows 需要开发者模式），
  junction 换根用例实际运行并通过；不构成 FAIL，但属于本机未覆盖的路径。
- **O3（info，报告口径）**：`report.md` §6.1 的 F2 已如实承认 400 KiB/2 MiB 口径差；本复核确认
  “生效值 400 KiB”在 runtime 成立，口径差本身不阻塞 E0（但建议 rev 或改常量做一次统一）。

## 6. 事实边界

- 本次复核全部是静态/fake 上游：**真实 DeepSeek 调用 0 次**，不宣称 X2 已关闭；真实多模态证据由 t8 产出。
- 微信/UIA/安装包 = `NOT_RUN`（本复核不涉及）。
- 未修改任何被复核代码；本目录新增仅 `t7-probe.cjs` 与本文。

## 7. 复现方式

```powershell
node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"
node docs/evidence/workspace-agent/reviews/t7-probe.cjs
```

## 8. 总计划 §0.3 模板汇报

```text
任务 ID：t17 / Review-t7（E0-R2 图片解析与多模态消息独立复核）
目标是否完成：NO（verdict=NEEDS_REVISION；产品实现 17/17 探针成立，但有 2 条必须修的交付缺陷）
实际修改文件：
  - docs/evidence/workspace-agent/reviews/t7-review.md（本文）
  - docs/evidence/workspace-agent/reviews/t7-probe.cjs（独立探针，17 pass / 0 fail / 1 skip）
  - 未改 desktop/**、test/**、templates/**、miniprogram/**、docs/evidence/workspace-agent/e0-r2/**
执行命令与真实退出码：
  node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" → exit 0（86 tests / 85 pass / 0 fail / 1 skipped）
  node docs/evidence/workspace-agent/reviews/t7-probe.cjs → exit 0（17 pass / 0 fail / 1 skip + 3 observations）
关键结论：
  - assetId 唯一入口、canonical/junction 换根、魔数+真解码、摘要防篡改、单图、视觉 fail-closed、0 上游失败路径均成立
  - 400 KiB 生效值在 runtime 层成立（660 KiB → channel_rejected、0 上游），但 t7 自己的用例没测到（F2）
  - 证据脚本会把 data:image/ 前缀写进 real-call.json，t8 真实调用后 t7 的证据扫描用例必失败（F1，high）
剩余问题：F1/F2 需修；F1 修前 t8 不要产出 real-call.json
下一任务是否可开始：修复 F1/F2 后可进入 t8/E0-V1；E0/X2 结论不由本复核出具
```
