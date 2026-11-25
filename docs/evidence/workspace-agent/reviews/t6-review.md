# Review-t6：E0-R1 direct Runtime 与截断/顺序契约独立复核

> 任务：`t16 / Review-t6`（复核者：workspace-lead2，attempt 2）
> 被复核任务：`t6 / E0-R1`（runtime-engineer）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.3 / §14.7 / §14.13-3；计划 §4 E0-R1
> 复核方式：**只读被复核源码**（未修改 `desktop/**`、`server/**`、`test/**`），另在本目录新增独立探针
> `docs/evidence/workspace-agent/reviews/t6-probe.cjs`（只 require 实现 + fake 上游/Coordinator，不复制实现逻辑）。
> 结论：**PASS**（t6 的 10 条验收在声明范围内成立；无阻塞 finding）。
> 边界：本复核**不是** E0 验收结论；真实 DeepSeek 调用 0 次（fake 上游），X2/微信/UIA 不在本复核范围。

## 0. 被测字节（本判定只对这些字节成立）

复核时（2026-11-25）逐文件复算 sha256（`Get-FileHash -Algorithm SHA256`），未采用 t6 报告自述：

| 文件 | 字节 | sha256 |
|---|---:|---|
| `desktop/agent-runtime/constants.cjs` | 4 693 | `8cfeb73e47adbbf80595e5466164e53f7af0ba33856e2bdb16ac967c16d1dda2` |
| `desktop/agent-runtime/tools.cjs` | 10 773 | `006d0eb39d3d341b5f3fbc56a342e97f88148bf960144907781bb28cbf3eb36c` |
| `desktop/agent-runtime/model-chat.cjs` | 4 523 | `0ca728cb590d8b05997d6a654f1dbcea01eaf29260625b30f03bc5846bea1405` |
| `desktop/agent-runtime/workspace-runtime.cjs` | 35 710 | `8b52c22e663a38399d3766cfd993e5c9e1c4efe742d329c1639df6ee10ff55ec` |
| `desktop/agent-runtime/http-bridge.cjs` | 3 691 | `c5e021e83fe77eb58beea44655a64cfa12fe2b26c6a48f2b2c3188874fe52d62` |
| `desktop/agent-runtime/index.cjs` | 2 973 | `f694a7c3ff7b7cddab1ddb8cb9a078f5f28672a44a2b16383cd23b1e11a847c5` |
| `desktop/model-credentials.cjs` | 32 677 | `70d15a78003a0a89f8aa7a8779f0de6e14990914c31f85fa5b375d37ab810a52` |
| `desktop/model-ipc.cjs` | 6 105 | `daad3b482ddd8328e4c99c2e28deb63e37046b7a57c51d3e2f41654e3325d607` |
| `server/src/agent/agent-guard-rails.ts` | 7 832 | `42c5c76ffd53ee0db385c373828dcbf2688740701e93281988cadbba38492722` |
| `server/src/common/config/env.validation.ts` | 11 539 | `72050fe794f632a1400ae4b9b42d834701c0027b3fa8a2cec25ddbb12ba5e2a7` |
| `desktop/agent-workspace/run-coordinator.cjs`（执行入口侧） | 88 235 | `eedd1823efad27ed620a751788e031295756ce160a610545b283348d22cf36f2` |
| `desktop/main.cjs`（接线，仅观察） | 20 915 | `481870ef515d6586b322613abf13f0f58f06e4aaf72778b7cf5ea59efb0c3d27` |

测试文件（独立复跑对象）：

| 文件 | 字节 | sha256 |
|---|---:|---|
| `test/runtime/workspace-runtime.test.cjs` | 28 896 | `63b092e516380bdf37642d88e2239693def1db33e96240e3f05157f63ddf594f` |
| `test/runtime/order-contract.test.cjs` | 14 360 | `0ab3e99d836086ad95ea2acaae6e972abd82e6f801cbc2259b77087a828094c8` |
| `test/runtime/model-chat.test.cjs` | 11 936 | `43a5abbe637f9f986dd5427c087910bfdfb41cc8f16c8270c15c17569575a20b` |
| `test/runtime/http-bridge.test.cjs` | 3 959 | `91b38eae95a5e2af6c50e0e1862ec006495be94007de6c60ead656b7aa6cb412` |
| `test/runtime/guard-rails-default.test.cjs` | 2 700 | `044aea7e99027ba77eecfea0d1d72412be0f823884983d3eaa13132701eedfcd` |
| `test/runtime/images.test.cjs`（t7，随 glob 一并跑） | 31 302 | `9bc1cc1925cdf70e55a0ed1b048e319d4d5ff4afcd25f90b120141b08925b13d` |
| `test/runtime/multimodal-upstream.test.cjs`（t7，随 glob 一并跑） | 10 676 | `7c039cb3ef7de36455948e9d48e2a1e61977e95e9ba383311e02806ddbaf09e8` |

> `test/runtime/*.test.cjs` 现在包含 t7（images / multimodal）的文件，因此用例数是 113 而不是 t6 报告里的 58；
> 这是 glob 的必然结果，不是 t6 追加或删减断言。t6 的 5 个测试文件全部在内。

## 1. 命令与真实退出码（本次复核独立执行）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" test/model-call-scheduler.test.cjs` | **0** | tests 113 / pass 112 / fail 0 / skipped 1（skip 属 t7 的图像探测用例） |
| `node docs/evidence/workspace-agent/reviews/t6-probe.cjs` | **0** | 独立探针 15/15 成立（fake 上游/Coordinator，真实上游 0 次） |
| `node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).length)"` | 0 | 导出面可加载（复核时 34 个导出，含 t7 的 12 个 X2 符号） |

独立探针 15 条：`S1` 无写盘 API、`S2` 无 child_process、`S3` 仅 images.cjs require fs（只读）、
`S4` 无伪状态改写、`T1` 11 工具 + 3 平台专用全拒、`R1` 截断带 tool_calls 停批、`R2` 空正文+length 仍 truncated、
`R3` signal 取消后上游 0 次、`R4` Coordinator 取消门后上游 0 次、`R5` 迟到结果工具 0 次、
`R6` stale 闸门本地拒绝 + run_check 后放行、`R7` trace 无 Key/prompt/图片/参数、
`R8` 无 Coordinator → `AGENT_RUNTIME_TOOL_MISSING`、`R9` X9 reply 透传、
`R10` maxTokens 契约（direct-edit 6000 / 1200→6000 raised / >8000 显式拒绝 / length→truncated）。

## 2. 五个关注点逐条结论

### ① 是否存在绕过 Coordinator 的第二条写入/执行链 —— **不存在**

- `workspace-runtime.cjs` 的工具执行只有一处：`coordinator.invokeTool({ projectId, runId, turnId, attemptId, tool, args })`
  （`desktop/agent-runtime/workspace-runtime.cjs:667-674`）；没有第二处直接写文件/起进程。
- 源码扫描（探针 S1/S2/S3）：7 个 `.cjs` 中 **0 个**包含 `writeFile*/mkdir*/rm*/rename*/unlink*/copyFile*`，
  **0 个** `require('child_process')` 或 `spawnSync/execSync`；唯一 require `node:fs` 的是 **`images.cjs`**
  （t7 的图片资产解析，只读文件，无写 API）。
- `desktop/agent-workspace/run-coordinator.cjs:1124-1153` 的 `invokeDirect` 只把 `context/request` 交给
  `directRuntime.invoke`，运行时的工具再回到 `invokeTool`，没有反向/旁路执行器。
- `desktop/main.cjs:387-395` 已用 getter 惰性接入同一个 Coordinator 与 `modelCredentials`（**观察**：
  这是 t6 报告里登记“由 workspace-lead 补一行”的接线，现已存在；未接线时的显式
  `AGENT_RUNTIME_TOOL_MISSING` 也由探针 R8 复核）。

### ② 截断分支是否真“停批”而不是只打日志 —— **真停批**

- `workspace-runtime.cjs:516-536`：构造 `stepTrace.truncated`（`completion.truncated===true || finishReason==='length'`）
  后**立即 return**，位置在 assistant 消息回填（`:541-554`）与工具循环（`:617-730`）**之前**；
  返回 `AGENT_OUTPUT_TRUNCATED` + `status:'output_truncated'` + `retryable:true` + `toolCalls:[]`。
- 探针 R1：上游返回正文 + `finishReason:'length'` + 一条 `write_files` tool_call → Coordinator 调用 **0 次**、
  上游 **1 次**；R2：空正文 + length → `AGENT_OUTPUT_TRUNCATED`（不是 `empty_reply`）。
- 测试覆盖同分支：`test/runtime/workspace-runtime.test.cjs:237-250`（“截断 + 带 tool_calls → 一个都不执行”）。
- 截断信号来源：`model-credentials.cjs:627-649`（`finishReason` + `truncated` 必回传）、
  `model-chat.cjs:24-48`（归一化，字段缺失也保留）、`model-ipc.cjs:39-52`（`settings:model:chat` 同口径）。

### ③ 顺序契约是否只在提示词里说、代码里没拦 —— **有代码闸门**

- 单一常量 `ORDER_CONTRACT`（`tools.cjs:175`）同时进入：11 个工具描述（`tools.cjs:199-204`，启动自检
  `:207-221`）、系统提示词（`workspace-runtime.cjs:48-57`）、`describe().orderContract/stopConditions`
  （`:772-804`）。平台专用步骤不出现于模型工具说明（`:217-219` 断言 + 测试 `order-contract.test.cjs:299-304`）。
- 运行期闸门：Coordinator 返回 `AGENT_EVIDENCE_STALE` → `evidenceStale=true`（`workspace-runtime.cjs:723-725`）；
  此后 `submit_candidate` 在 `:627-661` **本地拒绝**（不触达 Coordinator）并回填
  `nextAction:"rerun-checks"` + issue `EVIDENCE_STALE_RERUN_CHECKS`；`run_check` 成功后才解锁（`:726-729`）；
  连续无视第二次即终止（`:651-659`）。写入成功会回填“证据已失效”提示（`:684-688`），且该提示不进 trace。
- 探针 R6：`submit(stale) → submit(换参) → run_check → submit` 的 Coordinator 序列恰为
  `submit_candidate, run_check, submit_candidate`，第二次 submit 被本地标记 `blocked_by_order_contract`
  且 `error.nextAction==='rerun-checks'`。
- 边界：闸门在**收到** `AGENT_EVIDENCE_STALE` 后才上闸；写入后第一次 submit 仍会下发给 Coordinator 由平台门禁
  判定——这符合 §14.13-3「收到 stale 后本地拒绝」的字面判据，不是只在提示词里说。

### ④ 取消后是否仍可能发上游请求 —— **不会再发**

- 取消检查点：回合开始（`:450-451`）、每次上游调用前（`:457-458`）、上游返回后（`:490-492`）、
  每个工具前（`:620-621`）、工具返回后（`:677-681`）；取消即 return，不再进入下一轮。
- `cancellationOf` 同时看 `signal.aborted` 与 `coordinator.assertRunActive`（`:234-249`）；
  取消时返回 `AGENT_CANCELLED` / `status:'aborted'`。
- 探针 R3/R4/R5：预取消、Coordinator 拒绝、模型返回后取消三种情况，上游调用分别 0/0/1 次且工具 0 次。
- 上游出口唯一：`credentials.chat`（`model-credentials.cjs:665-692`，经 ModelCallScheduler），
  runtime 不新建 fetch/HTTP 出口；一轮内调用串行（`workspace-runtime.test.cjs:548-575` 断言峰值 1）。

### ⑤ 有没有为了让用例过而放宽断言 —— **没有发现放宽**

- 断言比到**具体码/具体字段**，而不是 `ok===false`：截断断言 `AGENT_OUTPUT_TRUNCATED`+`status`+`retryable`+
  `toolCalls.length===0`+`coordinator.calls===0`（`:221-263`）；闸门断言 Coordinator 实际收到的工具序列、
  `note==='blocked_by_order_contract'`、`nextAction`（`order-contract.test.cjs:167-275`）；
  取消断言上游调用次数（`:327-385`）；工具面断言名单长度/顺序/平台名（`:179-217`）。
- 反例有独立覆盖：平台专用名与未知名都断言 `coordinator.calls===0` 且不再发第二轮（`:179-203`）；
  X9 用“模型声称已采用”仍原样透传（`:434-441`）。
- 没有把“有 tool_calls + truncated”的用例跳过或改成只测正文截断；该分支有专门用例（`:237-250`）。
- 未发现测试里注入“只走成功路径”的替代实现：fake Coordinator 只替 `invokeTool`，工具名/表仍来自真实
  `run-coordinator.cjs` 的 `MODEL_TOOL_NAMES`（`constants.cjs:14-19`）。

## 3. 验收逐条核对表

| # | 验收项 | 结论 | 证据（文件:行 / 命令 / 探针） |
|---|---|---|---|
| 1 | 唯一执行入口 `Coordinator.invokeTool`；不 require fs/child_process、不自写 attempt | PASS | `workspace-runtime.cjs:667-674`；探针 S1/S2/S3（0 写盘、0 子进程；仅 images.cjs 只读 fs） |
| 2 | 11 个模型可见工具 + 3 个平台专用，平台专用不被模型调用 | PASS | `tools.cjs:207-221,224-236,243-252`；探针 T1；`workspace-runtime.test.cjs:179-217` |
| 3 | `modelChat/requestChat` 返回 `finishReason/truncated`，空正文+length 也 truncated | PASS | `model-credentials.cjs:627-649`；`model-chat.cjs:24-48`；`model-ipc.cjs:39-52`；探针 R2/R10；`model-chat.test.cjs:103-171` |
| 4 | 截断即停本批并返回 `output_truncated`，有“tool_calls + truncated”测试 | PASS | `workspace-runtime.cjs:516-536`；探针 R1；`workspace-runtime.test.cjs:237-250` |
| 5 | maxTokens 6000/8000，无 1200 回退 | PASS | `model-credentials.cjs:322-361`；探针 R10（6000 默认 / 1200→6000 raised / >8000 `MODEL_REQUEST_INVALID`）；`model-chat.test.cjs:172-228` |
| 6 | X9：无“已验证/已采用→待本地确认”正则改写，只允许敏感信息 scrub | PASS | 探针 S4；`workspace-runtime.cjs:812-821`（状态只来自证据）；`model-chat.cjs` 无改写；服务端 `workspace-agent.service.ts:78-81` 只剩路径/`file://` scrub；`desktop/`、`server/src/` 递归扫描 `待本地确认` 命中 0 处 |
| 7 | §14.13-3 顺序契约在工具说明/系统提示词/describe() 固化 | PASS | `tools.cjs:175,199-204`；`workspace-runtime.cjs:48-57,772-804`；`order-contract.test.cjs:89-143` |
| 8 | 写后证据失效；收到 `AGENT_EVIDENCE_STALE` 后 submit 在 run_check 成功前本地拒绝并带 nextAction | PASS | `workspace-runtime.cjs:626-661,684-688,722-729`；探针 R6；`order-contract.test.cjs:147-275` |
| 9 | 取消/loop detection/预算生效，取消后不再发上游 | PASS | `workspace-runtime.cjs:427,456,457-462,597-615,620-621`；探针 R3/R4/R5；`workspace-runtime.test.cjs:267-385` |
| 10 | trace 不含 Key/prompt/图片 data URL/工具参数 | PASS | `workspace-runtime.cjs:503-514,694-704`；探针 R7；`workspace-runtime.test.cjs:389-413` |
| 11 | 入口并发默认值统一 3（`AGENT_MAX_CONCURRENT`） | PASS | `server/src/agent/agent-guard-rails.ts:40,64,189`；`env.validation.ts:140,274`；`guard-rails-default.test.cjs` 4/4 |
| 12 | 独立复跑 verify 命令并记录真实退出码 | PASS | 本文 §1：exit 0（113 tests / 112 pass / 0 fail / 1 skipped）；探针 exit 0 |

## 4. 观察（非阻塞，不影响 PASS）

1. **报告措辞与实现口径需区分（文档级）**：`docs/evidence/workspace-agent/e0-r1/report.md:31` 写“任何路径都不再出现 1200”，
   但同一报告的 §1.1 与测试明确“普通对话（chat profile）保持 1200/4096”，`model-credentials.cjs:326-329` 也如此。
   代码对**源码编辑**路径（`profile==='direct-edit'`）确实 6000/8000、绝不 1200（探针 R10），符合 §14.7；
   建议报告把“任何路径”改为“源码编辑路径”，避免后续读者误以为 chat 通道也改了默认值。**无需改代码。**
2. **`images.cjs` 的 fs 只读例外**：它是 t7 的资产解析模块，`require('node:fs')` 但无任何写 API；
   `workspace-runtime.test.cjs:462-484` 已把该例外显式白名单化。它不是第二条写入链，但若后续 E0 证据统一写
   “agent-runtime 不碰文件系统”，应补一句“仅 images.cjs 只读资产”。
3. **main.cjs 接线现状**：t6 报告登记“接线由 workspace-lead 补”，复核时 `desktop/main.cjs:387-395`
   已接入 `createDirectWorkspaceRuntime({ coordinator: () => workspaceRunCoordinator, credentials: modelCredentials })`；
   因此生产路径的 `invokeDirect` 不再返回 `AGENT_RUNTIME_TOOL_MISSING`（未接线时的显式失败仍由探针 R8 证明）。
   此项属接线任务，不计入 t6 verdict。
4. **同一参数重复 submit 的拦截顺序**：若在 stale 后连续用**同一参数** submit 三次，loop detection 会先在
   第三批前终止（`loop_detected`），顺序契约闸门只拦到第一次重复；这是 t6 报告 §3.5-5 已声明的设计，
   探针 R6 用换参方式单独验证了闸门本身，两者不冲突。

## 5. 事实边界（防过度声明）

- 本次复核全部使用 fake 模型 / fake Coordinator / fake fetch：**真实 DeepSeek 上游调用 0 次**，
  不宣称“真实 Flash 工具循环已验收”（属 t8/E0-V1）。
- 不覆盖 X2 的真实图片链路（属 t7/t8）、微信/UIA（BLOCKED，未跑）、安装包。
- 本复核只回答 t6 的 10 条验收是否成立；**E0 整体 verdict 不由本文出具**。
- 未修改任何被复核代码；本目录新增文件仅 `t6-probe.cjs` 与本文。

## 6. 复现方式

```powershell
# 1) t6 官方 verify（记录真实退出码）
node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" test/model-call-scheduler.test.cjs
# 2) 独立探针（15/15，exit 0）
node docs/evidence/workspace-agent/reviews/t6-probe.cjs
# 3) 导出面
node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).length)"
```

## 7. 总计划 §0.3 模板汇报

```text
任务 ID：t16 / Review-t6（E0-R1 direct Runtime 独立复核）
目标是否完成：YES（10 条验收全部核对 PASS；无阻塞 finding）
实际修改文件：
  - docs/evidence/workspace-agent/reviews/t6-review.md（本文）
  - docs/evidence/workspace-agent/reviews/t6-probe.cjs（独立探针，15/15）
  - 未改 desktop/**、server/**、test/**、scripts/** 等被复核代码
执行命令与真实退出码：
  node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" test/model-call-scheduler.test.cjs → exit 0（113 tests / 112 pass / 0 fail / 1 skipped）
  node docs/evidence/workspace-agent/reviews/t6-probe.cjs → exit 0（15/15）
  node -e "require('./desktop/agent-runtime')" → exit 0（34 导出）
真实模型/微信/UIA/安装包：NOT_RUN（本复核 fake 上游，真实调用 0 次）
关键结论：
  - 唯一执行入口是 Coordinator.invokeTool；无第二条写入/执行链（0 写盘 API、0 child_process；仅 images.cjs 只读 fs）
  - 截断（含 tool_calls / 空正文 + length）真停批并返回 AGENT_OUTPUT_TRUNCATED，工具 0 次、上游不再发
  - 顺序契约不只写在提示词：stale 后 submit 本地拒绝 + nextAction，run_check 成功才放行；有代码闸门与测试
  - 取消三处检查点生效，取消后上游 0 次、迟到工具 0 次；loop detection/预算/trace 脱敏均成立
  - 观察（文档级）：e0-r1 report §“任何路径不再出现 1200”与 chat 通道 1200/4096 口径冲突，建议改措辞，无需改码
剩余问题：无阻塞项；X2 真实链路与真实 Flash 属 t7/t8
下一任务是否可开始：就 t6 门禁而言 YES
```
