# E0-R2：图片资产解析与真实多模态消息（X2）

- 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 **§14.8**（图片资产与多模态消息）
- 计划：`docs/handoff/Workspace-Agent-E0闭环纠偏与E阶段-Flash续期计划.md` §4 E0-R2
- 执行者：runtime-engineer（t7，attempt 3）
- 任务状态：**静态链路 PASS**；**真实 direct 多模态调用 = BLOCKED（本机无 Key，按 Captain 裁定移交 t8 执行）**
- X2 是否关闭：**否（等 t8 真实调用 PASS 才能关闭）**；桌面侧实现与静态证据已就绪，本文明确区分「已做」与「未做」。

---

## 0.3 统一交付模板

```text
任务 ID：t7 / E0-R2（X2）
目标是否完成：PARTIAL（桌面实现在位、静态证据全绿；真实 direct 多模态调用未执行 → BLOCKED，见 §5）
实际修改文件：
  desktop/agent-runtime/images.cjs（新增，§14.8 资产解析）
  desktop/agent-runtime/multimodal.cjs（新增，多模态 parts 构造 + 视觉门 + 通道预检）
  desktop/agent-runtime/workspace-runtime.cjs（改：request.images 接入、vision 门、结果只带图片元数据、describe().images）
  desktop/agent-runtime/model-chat.cjs（改：supportsVision 进 describe()，视觉能力只有显式声明才算）
  desktop/agent-runtime/index.cjs（改：导出 X2 的 12 个符号）
  test/runtime/images.test.cjs（新增，25 例）
  test/runtime/multimodal-upstream.test.cjs（新增，3 例）
  test/runtime/workspace-runtime.test.cjs（改：X9 源码断言放宽为「只允许 images.cjs 只读资产、任何模块不得写盘」）
  docs/evidence/workspace-agent/e0-r2/report.md（本文）
  docs/evidence/workspace-agent/e0-r2/probe.png（真实小图样本，341 B，sha256 见 §5）
  docs/evidence/workspace-agent/e0-r2/probe-tools.cjs（确定性 PNG 生成器，可复核）
  docs/evidence/workspace-agent/e0-r2/run-real-call.cjs（t8 一键真实取证脚本）
  docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs（跨任务缺口复现脚本）
  docs/evidence/workspace-agent/e0-r2/real-call.json（本机 BLOCKED 记录，t8 覆盖）
行为变化：
  1) 参考图只能以 assetId 进入 direct 回合；主进程按 project.json → fileName → 项目资产根派生路径，
     realpath/canonical 双检（资产根必须在 projects/<pid>/ 内、文件必须正好等于「根 realpath + fileName」），
     拒 symlink/junction/越界/`../`/绝对路径/base64/data URL。
  2) 魔数判真实类型并与登记 MIME 一致；PNG 逐 chunk CRC + IDAT inflate + 扫描行长度一致性（真解码），
     JPEG 段结构/SOF/SOS/EOI，WebP RIFF 长度/首块位流；内容摘要与登记 sha256/bytes 不符即拒（防篡改）。
  3) 单张 ≤2 MiB（硬上限，调用方不得抬高）；E0 每轮只 1 张；缺图/坏图/超限/输入非法 → AGENT_IMAGE_INVALID。
  4) buildMultimodalContent 产出文本块与 image_url 内联图片块，顺序稳定；
     data URL 只存在于本次调用内存，结果/进度/trace/落盘一律只有 {assetId,mime,bytes,sha256}。
  5) 视觉能力 fail-closed：只有显式 supportsVision:true（或 vision:true）才发图，否则 AGENT_VISION_UNAVAILABLE
     + needs_input，且一次上游调用都不发；把 assetId 当纯文本时是普通文本调用（不构造 image_url）。
新增测试：test/runtime/ +28 例（images 25 / multimodal-upstream 3），runtime 套件合计 86 例
执行命令与真实退出码：见 §4（全部 exit 0）
真实模型/微信/UIA/安装包证据：真实模型 = BLOCKED（无 Key，实际错误见 §5）；微信/UIA/安装包 = NOT_RUN（本任务不涉及）
与计划的偏差：
  - 真实 direct 多模态调用不在本任务执行（Captain 2026-11-25 裁定：Key 由 t8 使用，避免消耗额度），
    脚本 `run-real-call.cjs` 已就绪，t8 一条命令即可产出 PASS/FAIL 与全部证据字段。
  - 视觉能力开关放在 modelChat.describe().supportsVision（agent-runtime 内），主进程接线由 t5 的 main.cjs 负责。
剩余问题：
  - F1（**已由 t12 修复**，见 §6/§10）：修复前 `model-credentials.cjs` 的工具上限（写死）< §14.3 的 11 个模型工具，
    真实 direct 回合会在发图之前先 `MODEL_REQUEST_INVALID: 工具数量超过上限`（复现见 §6）。
  - F2（跨任务，口径差）：通道单张上限 400 KiB < §14.8 的 2 MiB。已用「通道预检」把它变成明确的
    `AGENT_IMAGE_INVALID/ channel_rejected`，但两者数值仍需一次口径对齐（rev 或改常量）。
下一任务是否可开始：YES（t8 可开始；但 F1 未修前 t8 的真实 direct 工具循环必须收窄工具集，或先修 MAX_TOOLS）
```

---

## 1. §14.8 冻结约束 → 实现落点（逐条）

| §14.8 约束 | 落点 | 证据 |
|---|---|---|
| 1. 输入只有 `assetId`，不接受路径/base64 文本 | `images.cjs#ASSET_ID_PATTERN = /^a_[0-9a-f]{16}$/`；`workspace-runtime.cjs#normalizeImageRequest` 对 `request.images` 逐项校验形状 | 用例「assetId 形状非法…」「缺图/坏图/超限/路径/base64 输入…」 |
| 2. 从 assetId 派生 + canonical 校验（realpath 在项目资产根内、拒 symlink/junction/越界） | `images.cjs#resolveAssetImage`：`project.json → assets.images[].fileName → ASSET_FILE_PATTERN → lstat(非链接) → realpath === rootReal/fileName`；并额外要求 `rootReal === <projectReal>/assets/images` 且 projectReal 在 userData 内 | 用例「junction 指向外部 → asset_root_outside_project」「文件是 symlink → asset_symlink_rejected」「fileName 越界 → asset_file_invalid」 |
| 3. 魔数 + 真实 MIME（PNG/JPEG/WebP）+ 解码校验 + 单张 ≤2 MiB + E0 只 1 张 | `validateImageStructure`（PNG：CRC/IPDAT inflate/扫描行；JPEG：段/SOF/SOS/EOI；WebP：RIFF 长度/VP8·VP8L·VP8X）；`MAX_IMAGE_BYTES = 2 MiB`、`MAX_IMAGES_PER_TURN = 1`（`limits.maxBytes` 只能调小） | 用例「单张 ≤2 MiB 生效（1.40 MiB 通过 / 2.32 MiB 拒绝）」「JPEG/WebP 魔数与结构校验」「resolveAssetImages…2 张 → too_many_images」 |
| 4. data URL 只在调用内存 | 结果 `data.images` 只含 `{assetId,mime,bytes,sha256}`；进度 detail 只带 assetId；`steps/toolCalls` 无图片字段 | 用例「data URL 只进调用内存：落盘全量扫描」「进度回调…detail 不含图片内容」「direct 回合带图…结果里不得出现 data URL/base64」 |
| 5. 缺图/坏图/超限 → `AGENT_IMAGE_INVALID`；无视觉能力 → `AGENT_VISION_UNAVAILABLE`/needs-input，不得静默降级 | `imageInvalid()/visionUnavailable()`（复用 `RUNTIME_CODES`，未新增 `AGENT_*` 码）；runtime 在解析前先过视觉门，任一失败**都在 0 次上游调用下返回** | 用例「无视觉能力：…一次上游调用都不发」「缺图/坏图/超限…一次上游调用都不发」「只给 assetId 文本…content 是字符串」 |
| 6. 真实小图走 direct 证明回答依赖图像内容 | 样本 `probe.png`（96×96 白底 + 红圆 + 蓝方块）+ `run-real-call.cjs`（A 带图 / B 同提示无图 / C 只给 assetId 文本，三路对照并自动判定） | 本机 **BLOCKED**（无 Key）；t8 执行后 `real-call.json` 即证据 |

设计取舍（写清以免被误读）：

- **视觉能力 fail-closed**：`createModelChat({ supportsVision })` → `describe().supportsVision`；runtime
  先判能力再解析图片。「不知道模型能不能看图」时**不发图、不降级**，报 `AGENT_VISION_UNAVAILABLE`
  （reason `vision_unsupported`，issue 带 `nextAction:"attach-vision-model"`），data.status = `needs_input`。
- **通道预检**：`multimodal.cjs#assertChannelAccepts` 直接调用 `model-credentials` 的 `normalizeChatPayload`
  做一次“能不能发”的权威预检，把它的更严上限（当前单张 400 KiB）翻译成 `AGENT_IMAGE_INVALID/channel_rejected`，
  而不是等上游返回 `MODEL_REQUEST_INVALID`，更不会静默丢图（不复制第二份上限常量）。
- **不新增错误码**：只用 §14.9 已有的 `AGENT_IMAGE_INVALID` / `AGENT_VISION_UNAVAILABLE`；
  大小/结构/路径等原因放在 `issues[].code`（机器可读 reason），不进 `AGENT_*` 命名空间。

---

## 2. 新模块形态

```js
// desktop/agent-runtime/images.cjs
resolveAssetImage({ userDataDir, projectId, assetId, limits? })
  => { assetId, mime, bytes, sha256, dataUrl }          // 5 个键，冻结形状；dataUrl 离开调用即无
resolveAssetImages({ userDataDir, projectId, assetIds, limits? })
  => { images: [...], meta: [{ assetId, mime, bytes, sha256 }] }   // meta 无 dataUrl，可进 trace/报告
createAssetImageResolver({ userDataDir })               // 主进程复用（无状态：每次调用重做 canonical 校验）
validateImageStructure(buffer, mime?) => { mime, width, height }   // 结构/解码校验
sniffImageMime(buffer)                                  // 纯魔数，不信任扩展名与元数据

// desktop/agent-runtime/multimodal.cjs
buildMultimodalContent({ utterance, images, limits? })
  => [文本块, image_url 内联图片块]（图片内容只存在于本次调用内存）
assertChannelAccepts(messages)                          // 用 model-credentials 的规范器做权威预检
resolveVisionSupport({ vision, modelDescribe }) => { ok, source, error? }
```

runtime 侧接口（对 Coordinator 不变，仍只有 `invokeTool` 一个执行入口）：

```js
createDirectWorkspaceRuntime({
  coordinator,                 // 或 () => coordinator
  modelChat,                   // 或 credentials
  userDataDir,                 // §14.8：主进程私有根，只用于 assetId → 路径
  vision: 'auto' | true | false,
  resolveImages,               // 测试注入
})
// runTurn 的 request 新增：images: ['a_…' | { assetId }], imageLimits: { maxBytes }
// 返回 data 新增：images: [{assetId,mime,bytes,sha256}], multimodal: boolean
```

---

## 3. 样本（可复核的真实小图）

- 文件：`docs/evidence/workspace-agent/e0-r2/probe.png`
- 尺寸：96×96，RGB8 PNG，**非纯色**（白底 + 红色实心圆 + 蓝色实心方块）
- 字节数：341
- **sha256：`5dae3842d7bfe72cc97883cfdc6424a1774acd10fc958432d63125b4395eea34`**
- 生成：`node -e "require('./docs/evidence/workspace-agent/e0-r2/probe-tools.cjs')…"`，
  生成器确定性（无时间戳/无随机源），逐次 sha256 相同；用例
  「归档的真实样本可复核：…与报告里的 sha256 一致」会同时校验：文件存在、PNG 真解码、≥64×64、
  与生成器输出逐字节一致、报告里记录的 sha256 一致、像素取值种类 > 5（非纯色）。

期望断言（t8 真实调用时必须同时成立）：

| 项 | 期望 |
|---|---|
| A 带图 | `ok:true`、`multimodal:true`、`data.images[0].sha256 === 5dae3842…ea34`、reply 命中「红/蓝」（颜色）且「圆/方」（形状） |
| B 同提示不带图 | reply **不得**出现「红/蓝/圆/方」这类只可能来自图像的结论 |
| C 只给 assetId 文本 | 同上，且 `multimodal:false`（assetId 字符串不能当视觉输入） |

---

## 4. 执行命令与真实退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"` | 0 | 86 tests / 85 pass / 0 fail / 1 skipped（本机不允许创建文件 symlink，见 §7） |
| `node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).join(','))"` | 0 | 34 个导出（含 X2 的 12 个） |
| `node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs` | 0 | 打印 `GAP：通道上限小于 §14.3 的工具数`（复现 F1） |
| `node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs` | 2 | `status:"BLOCKED", reason:"NO_API_KEY"`（本机无 Key；t8 设 `DEEPSEEK_API_KEY` 后重跑，退出码 0=PASS / 1=FAIL） |

测试文件分布（`test/runtime/`，合计 86 例）：

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `workspace-runtime.test.cjs` | 29 | E0-R1 原有（工具循环/截断/预算/取消/loop/X9） |
| `order-contract.test.cjs` | 10 | §14.13-3 顺序契约（E0-R1） |
| `model-chat.test.cjs` | 10 | finishReason/truncated + maxTokens 契约（E0-R1） |
| `http-bridge.test.cjs` | 5 | HTTP 可选桥（E0-R1） |
| `guard-rails-default.test.cjs` | 4 | 入口并发默认 3（E0-R1） |
| **`images.test.cjs`** | **25** | X2：资产解析（canonical/链接/越界/魔数/MIME/解码/2 MiB/1 张/防篡改）+ parts 构造 + 视觉门 + 落盘全量扫描 + 样本复核 |
| **`multimodal-upstream.test.cjs`** | **3** | X2：fake fetch 断言**真实上游请求体**里有 image_url data URL、字节/摘要一致；通道上限映射；runtime 全链路 |

---

## 5. 真实 direct 多模态调用：**BLOCKED**（如实记录，未伪造）

```json
{
  "status": "BLOCKED",
  "reason": "NO_API_KEY",
  "message": "环境里没有 DEEPSEEK_API_KEY（或格式不对），无法执行真实多模态调用。",
  "actualError": "DEEPSEEK_API_KEY missing",
  "tookEffect": false
}
```

- 本机 `$env:DEEPSEEK_API_KEY` 为空；Electron `safeStorage` 密钥库在打包应用里，Node 脚本无法解密，
  因此本任务**不执行真实调用**，`real-call.json` 记录的就是上面这条真实结果（不是占位）。
- Captain 2026-11-25 裁定：真实 Flash 调用由 verifier 在 **t8** 执行（Key 已确认可用），本任务只出静态用例
  与可复核样本，**不消耗真实额度**。t8 执行方式：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-…'          # 不要写进仓库/日志
node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs
# 需要 treeDigest 时（真实工作区）：
node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs --project "<app userData>" --project-id p_xxxxxxxx
```

脚本会打印并写入 `real-call.json`：`probe.sha256`、`model`、`sentParts`（类型/前缀/字节数/摘要是否等于样本）、
`coordinator.treeDigest`（有真实工作区时）、三路 `cases`（reply 摘要、trace 模型标签、usage、latency、判定）、
`verdict`；退出码 0=PASS / 1=FAIL / 2=BLOCKED。脚本**不打印 Key**，safeStorage 用进程内随机密钥的
AES-256-GCM（落盘密文离开本进程不可解），临时目录结束即删。

---

## 6. F1：真实 direct 回合会被工具数上限挡住（历史记录，已由 t12 修复 → 见 §10）

```text
$ node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs
modelToolCount: 11, definitionCount: 11
probe:  1 → accepted,  8 → accepted,  9 → rejected(MODEL_REQUEST_INVALID 工具数量超过上限),
        10 → rejected, 11 → rejected
verdict: GAP：通道上限小于 §14.3 的工具数（真实 direct 回合会先因工具数失败）
```

- 原因（**历史值，现已删除**）：旧的写死上限小于 rev15 §14.3 的 **11** 个模型可见工具；现在上限 = 模型工具清单长度（单一来源）。
- 影响：`createDirectWorkspaceRuntime` 默认发送全部 11 个工具 → 真实上游调用直接 `MODEL_REQUEST_INVALID`，
  runtime 包成 `AGENT_TXN_ABORTED`（用例里已如实复现过一次）。**与 X2 无关，但会让 t8 的真实工具循环无法开跑。**
- 最小修法（需 rev 或授权改 `model-credentials.cjs`，本任务 inScope 不含它）：
  `const MAX_TOOLS = MODEL_TOOL_NAMES.length;` 或直接 `11`（单一来源优先前者，避免第三份数字）。
- 本任务的规避：`multimodal-upstream.test.cjs` 的 runtime 全链路用例显式收窄 `request.tools` 到 3 个，
  并加注释指向本条。

## 6.1 F2：通道单张上限 400 KiB < §14.8 的 2 MiB（口径差，已降级为明确报错）

- `model-credentials.cjs`：`MAX_IMAGE_BYTES_PER_IMAGE = 409600`（400 KiB）、`MAX_IMAGE_BYTES_TOTAL = 1 MiB`。
- `images.cjs` 按 §14.8 执行 2 MiB；两者不一致时由 `assertChannelAccepts` 提前拦成
  `AGENT_IMAGE_INVALID / channel_rejected`（用例「通道上限（400 KiB）比 §14.8 更严…」）。
- 需一次口径裁决（改 §14.8 写 400 KiB，或把通道常量提到 2 MiB）。E0 参考图通常 < 200 KiB，不阻塞 t8。

---

## 7. 已知例外与未做项（不掩盖）

1. **文件 symlink 用例本机 skipped**：普通用户创建 file symlink 需要开发者模式；用例已 `t.skip` 并打印实际错误，
   同级目录 **junction** 越界用例（`asset_root_outside_project`）在 Windows 上始终可跑且已通过。
2. **JPEG/WebP 结构校验是「段结构级」**：PNG 走 CRC + inflate 真解码；JPEG/WebP 只验证段/RIFF 长度与必要头
   （不引入 sharp 等运行时依赖）。E0 参考图实际是 PNG（pick-images 常见路径），真实可解码性由归档样本保证。
3. **未接 App 主链**：`desktop/main.cjs` 的 `directRuntime: null → createDirectWorkspaceRuntime(...)` 接线属
   workspace-lead（已并入 t5 第 14 条），本任务不碰；未接线时 `invokeDirect` 仍显式返回
   `AGENT_RUNTIME_TOOL_MISSING`（不静默）。
4. **真实模型/微信/UIA/安装包**：真实模型 = BLOCKED（§5）；微信/UIA/安装包 = NOT_RUN（本任务不涉及）。
5. **X2 未关闭**：本文只声明「桌面侧实现 + 静态证据全绿」，真实 direct 多模态证据必须由 t8 产出后才能关闭 X2。

---

## 8. 复跑方式

```powershell
cd E:\智能开店app
node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"
node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).length); console.log(Object.keys(r).join(','))"
node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs          # F1 复现
node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs         # 无 Key → BLOCKED；t8 设 Key 后 → PASS/FAIL
```

---

## 9. 回归（本任务改动之外的全量结果，如实登记）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test test/*.test.cjs`（桌面全量） | 1 | 1455 tests / 1451 pass / 2 fail / 2 skipped |
| `node --test test/desktop-contract.test.cjs` | 0 | 24/24 |
| `node --test test/agent-workspace.repo-safety.test.cjs` | 0 | 5/5 |

两条 fail 均与本任务无关，且单独跑均通过/属既有基线：

1. `miniprogram/ 是受控镜像…摘要与内容一致`（`test/w5d-table-source.test.cjs:143`）——
   镜像摘要陈旧（`MIRROR.json` 与 `templates/base/ordering-base/1.0.0/src` 不同步），
   修复动作是 `npm run mirror:sync`，属 F3/镜像基线，不在任何 E0 写入锁内；单独跑同样失败（既有基线）。
2. `正式仓库零写入：完整 B1 流程前后…指纹不变`（`test/agent-workspace.repo-safety.test.cjs`）——
   该用例对整个仓库（含 `desktop/**`）做前后指纹比对；本次全量运行时**队友正在并发写
   `desktop/agent-workspace/**`、`desktop/main.cjs`**，指纹中途变化即判失败。单独跑 5/5 通过，
   属于并发竞态而非真实写穿。

---

## 10. F1 已修复（t12 / E0-Fix1，2026-11-25）

`desktop/model-credentials.cjs` 的写死上限 `MAX_TOOLS = 8` 已删除，改为**单一来源**
`maxToolCount() = agent-runtime/constants.cjs → MODEL_TOOL_NAMES.length`（当前 11）；
超限仍拒绝（伪造第 12/20 个 → `MODEL_REQUEST_INVALID`）。

- 复跑：`node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs` → 退出码 0，12 条断言全绿
  （1/8/9/10/11 全通过；12/20 被拒；端到端 fake 上游 1 次调用、`sentTools: 11`）。
- 细节与改动 diff：`docs/evidence/workspace-agent/e0-r2/fix-max-tools.md`。
- 上表 §6 保留的是**修复前**的原始记录，作为 F1 的历史证据，不再重复执行。
