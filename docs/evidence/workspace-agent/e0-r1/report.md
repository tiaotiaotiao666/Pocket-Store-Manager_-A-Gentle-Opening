# E0-R1 证据：direct Workspace Runtime、截断/预算、HTTP 可选桥（X8 / X9）

> 任务：`t6 / E0-R1`（runtime-engineer，attempt 1）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.3（工具与 subject）/ §14.6（调度器）/
> §14.7（direct 与 modelChat 对等，X8/X9）/ §14.9（错误码）；计划 §4 E0-R1；D0 §12（D-RT-1：`finish=length` 会丢信号）
> 依赖：t1 E0-W1（`desktop/agent-workspace/run-coordinator.cjs`，79/79）、t2 E0-R1a（`desktop/model-call-scheduler.cjs`，27/27）
> 日期：2026-11-25（Asia/Shanghai）
> 结论：**X8 桌面侧关闭、X9 桌面侧确认为“无伪状态改写”**；上游并发仍由 ModelCallScheduler 保证 ≤3。

```text
任务 ID：E0-R1 / t6（direct Workspace Runtime、截断/预算、HTTP 可选桥）
目标是否完成：YES（10 条验收：8 条主体 + 第 9 条 §14.13-3 顺序契约 + 第 10 条入口并发默认值；三条 verify 命令真实退出码全 0）
实际修改文件：
  - desktop/agent-runtime/（新增，主进程纯 CJS，5 个模块 + 入口）
      constants.cjs / tools.cjs / model-chat.cjs / workspace-runtime.cjs / http-bridge.cjs / index.cjs / package.json
  - desktop/model-credentials.cjs（requestChat 增加 finishReason/truncated；maxTokens 改为显式契约，删掉 1200 静默回退）
  - desktop/model-ipc.cjs（settings:model:chat 返回体强制带 finishReason/truncated，可传 profile）
  - test/runtime/workspace-runtime.test.cjs（新增，29 用例）
  - test/runtime/model-chat.test.cjs（新增，10 用例）
  - test/runtime/http-bridge.test.cjs（新增，5 用例）
  - test/runtime/order-contract.test.cjs（新增，10 用例，§14.13-3 顺序契约）
  - test/runtime/guard-rails-default.test.cjs（新增，4 用例，入口并发默认值）
  - server/src/agent/agent-guard-rails.ts（`?? 2` → `DEFAULT_AGENT_MAX_CONCURRENT = 3`，与 validateEnv 同源）
  - server/test/b2-desktop-session-and-rails.test.ts（连带一行断言 2 → 3，见“与计划的偏差”）
  - docs/evidence/workspace-agent/e0-r1/report.md（本文）
行为变化：
  - 新增 direct 循环：模型 tool_calls → `coordinator.invokeTool`（唯一执行入口）→ 回填 assistant.tool_calls +
    tool 结果 → 多轮推进，直到 stop / 预算耗尽 / 取消 / 截断；
  - `requestChat`/`modelChat` 现在一定返回 finishReason 与 truncated，`finish_reason=length` 一律 truncated；
  - truncated 时**本批工具一个都不执行**，返回 `AGENT_OUTPUT_TRUNCATED`（status=output_truncated、retryable=true）；
  - 源码编辑 maxTokens：默认 6000 / 硬上限 8000，非法值显式报错，任何路径都不再出现 1200；
  - 工具名只允许 §14.3 的 11 个，平台专用名直接 `AGENT_TOOL_NOT_ALLOWED` 且不触达 Coordinator；
  - **顺序契约（§14.13-3）**：11 个工具说明与系统提示词/停止条件都写明唯一合法顺序，
    写入成功即回填“证据已失效”提示；收到 `AGENT_EVIDENCE_STALE` 后 `submit_candidate` 在重跑检查前
    一律本地拒绝（带 nextAction），连续无视则终止本轮；
  - HTTP 桥未连接时 `available:false` + `reason=HTTP_BRIDGE_NOT_CONNECTED`，direct 不受影响；
  - `AGENT_MAX_CONCURRENT` 兜底字面量统一到一个常量 = 3（与 validateEnv 一致）。
新增测试：test/runtime/ 5 个文件 / 58 用例（全部 fake 模型 + fake Coordinator，无真实上游）
执行命令与真实退出码：
  node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"        → exit 0（58 pass / 0 fail）
  node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs → exit 0（27 pass / 0 fail）
  node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).join(','))" → exit 0（22 个导出）
  回归（服务端）：cd server; npx vitest run --configLoader native --pool=forks → exit 0（39 files / 681 tests）
  回归（桌面）：node --test test/*.test.cjs → 1442 pass / 2 fail，两处均为与本次改动无关的既存/他人进行中问题（见 §6）
真实模型/微信/UIA/安装包证据：NOT_RUN（本任务只用 fake 上游，真实 DeepSeek 调用 0 次；真实 Flash 工具循环留给 t8）
与计划的偏差：
  1. `desktop/main.cjs` 的一行注入未做（不在 t6 inScope，属 workspace-lead 写入锁）——见 §5 的接线说明。
  2. `server/test/b2-desktop-session-and-rails.test.ts` 有一行 `maxConcurrent` 断言 2 → 3，是第 10 条
     （2 → 3）的必然连带；该文件不在 t6 声明的 inScope 里，已在 output 里如实登记。
  3. 文件末尾 `desktop/agent-runtime/package.json` 只为 `require('./desktop/agent-runtime')` 目录解析
     （main 指向 index.cjs），不含任何依赖与脚本。
剩余问题：
  - 真实 Flash 的 tool_calls 循环（含视觉）需 t8 用真实 Key 执行 R01–R07 才可判 PASS；本报告不构成 E0 验收结论。
  - 图片多模态（X2）仍是 t7；本 runtime 的 `request.images` 尚未接（只预留 messages 直通）。
  - `main.cjs` 注入 `directRuntime` 之前，`coordinator.invokeDirect` 会返回 `AGENT_RUNTIME_TOOL_MISSING`（设计如此）。
下一任务是否可开始：就 t6 门禁而言 YES（t7 图片管线可开工，t7 会复用本 runtime 的 modelChat 与 messages 回填）。
```

## 1. X8 / X9 关闭判定（本任务的核心）

### 1.1 X8：截断/信号丢失三处全堵

| X8 子项（计划 §4 / D-RT-1） | 处理 | 证据 |
|---|---|---|
| 截断被当完整结果 | `truncated` 时**立即停止本批工具执行**，返回 `AGENT_OUTPUT_TRUNCATED` + `retryable:true`，不写工作树 | `截断（正文 + finish_reason=length）→ output_truncated，本批工具零执行`、`截断 + 带 tool_calls → 立即停止本批（工具一个都不执行）` |
| 直连缺 finishReason | `performChat` 回传 `finishReason`/`truncated`；`modelChat` 归一保证字段永在（上游不给时置 `finishReasonMissing:true`） | `requestChat 返回 finishReason 与 truncated（既有字段不变）`、`上游完全没给 finish_reason → 字段仍存在` |
| 空正文 + length 被当“无响应” | 视为 truncated，走 `output_truncated`，**不是** `empty_reply` | `空正文 + finish_reason=length → truncated（不得当成“无响应”）` |
| maxTokens 非法回退 1200 | 非法值 → `MODEL_REQUEST_INVALID`；direct 编辑默认 6000 / 上限 8000，显式更小值抬到 6000 并标记 `maxTokensRaised`，**任何路径都不出现 1200** | `maxTokens：direct-edit 默认 6000、上限 8000，绝不出现 1200`、`maxTokens 非法值一律显式报错`、`请求体断言：direct-edit 走 6000，普通对话走 1200（fake 上游捕获）` |

### 1.2 X9：没有伪状态改写，状态只来自本地证据

- `desktop/agent-runtime/**` 里不存在任何把模型措辞改写为“待本地确认”的正则，也没有 claim 白名单
  （源码断言用例逐文件检查 `待本地确认` / `replace(…已采用…)` / `FORBIDDEN_CLAIM`）。
- `reply` 原样透传（只做 `maxReplyCharacters` 长度限幅），用例断言模型说“已采用并通过验证”时
  reply 一字不改。
- `deriveStatusFromEvidence(evidence)` 是唯一状态派生入口：`adopted/verified/exported` 只从证据来，
  函数签名**不接收 reply**；空证据 = 全 false，非法状态值（如 `partial`）不放大成 PASS。
- 服务端副本已在 t9（E0-R1b）删除并提供源码断言 → X9 判据“桌面已删 且 服务端副本已删”成立
  （最终仍以 t8 独立复核为准）。

## 2. 契约逐条对照（t6 验收 8 条 + Captain 追加第 9 条）

| # | 验收 | 实现位置 | 用例 |
|---|---|---|---|
| 1 | tool_calls → `Coordinator.invokeTool`，回填 assistant tool_calls + tool 结果，多轮推进到 stop/预算；不复制第二套状态链 | `workspace-runtime.cjs`（唯一执行入口 + 消息回填） | 多轮用例、`runtime 不碰文件系统` 源码断言（无 `node:fs`/`child_process`/`spawnSync`） |
| 2 | modelChat/requestChat 返回 finishReason 与 truncated；空正文+length 记为 truncated | `model-credentials.cjs`、`model-chat.cjs`、`model-ipc.cjs` | 4 条（stop / length / tool_calls / 缺字段） |
| 3 | truncated=true 立即停本批工具，返回 output_truncated（可定向重试），不写工作树 | `workspace-runtime.cjs` 截断分支 | 2 条（有/正文 + 带 tool_calls） |
| 4 | direct 编辑 maxTokens 默认 6000、硬上限 8000，禁止回退 1200，超限明确报错 | `model-credentials.cjs#resolveMaxTokens` | 3 条（含 fake 上游请求体断言） |
| 5 | 删除伪状态改写；reply 仅供参考；adopted/verified/exported 只来自本地证据 | `workspace-runtime.cjs#deriveStatusFromEvidence` | 3 条（透传 / 证据派生 / 源码断言） |
| 6 | 工具名只允许 11 个；平台专用名 → AGENT_TOOL_NOT_ALLOWED | `tools.cjs`（名单来自 Coordinator 导出） | 3 条（三个平台专用名 + 4 个未知名 + 工具表长度/顺序） |
| 7 | 预算/取消/loop detection 生效；取消后不再发起上游调用、迟到不入库；敏感信息不进 trace | `workspace-runtime.cjs` | 8 条（模型次数/工具次数/死循环/墙钟/3 种取消/安全 trace/超大结果） |
| 8 | HTTP 可选桥：未连接明确 unavailable 且不影响 direct；不得伪造可用 | `http-bridge.cjs` | 5 条（未连接/未连接 send/别的 run 的 channel/真 channel/direct 不受影响） |
| 9 | §14.13-3 顺序契约写入 direct 循环：工具说明与停止条件固化唯一顺序；写入即失效；收到 `AGENT_EVIDENCE_STALE` 必须按 nextAction 重跑检查，不得重复 submit / 改证据；有测试 | `tools.cjs`（`ORDER_CONTRACT` + 11 个工具说明）、`workspace-runtime.cjs`（系统提示词 + 闸门） | `order-contract.test.cjs` 10 条（见 §3.5） |
| 10 | `AGENT_MAX_CONCURRENT` 默认 2 → 3，与 validateEnv 一致、不新增第二份常量 | `server/src/agent/agent-guard-rails.ts` | `guard-rails-default.test.cjs` 4 条（源码一致性 + 不读 MODEL_*） |

## 3. 并发（X12）复核：仍然是 ≤3- runtime 每轮**串行**发起上游调用（用例 `X12 口径：一轮内的模型调用是串行的` 断言实时并发峰值 = 1），
  多轮之间也没有并行；因此整个 direct 循环的上游并发上限仍由 `ModelCallScheduler` 决定（进程内 3 槽 +
  跨进程令牌 3，t2/t9 已实测跨进程峰值 3）。
- runtime 不新建任何新的 fetch/HTTP 出口：唯一模型出口是 `credentials.chat`（`model-credentials.cjs`），
  也就是 t2 的单一出口。
- 本任务未改动调度器参数（不读 `AGENT_MAX_CONCURRENT`，也不改 `MODEL_*` 默认）。

## 3.5 顺序契约（§14.13-3 / F3）落地细节

**唯一合法顺序**（`ORDER_CONTRACT` 单一常量，`tools.cjs` 导出，工具说明/系统提示词/`describe()` 同一份文本）：

```text
写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt
```

1. **工具说明**：11 个工具描述都追加「顺序契约 + 任何写入都会使既有检查证据失效」；`write_files` /
   `delete_files` 追加“写入后必须重新派生并重跑检查，不得拿旧证据提交”；`run_check` 追加“这是收到
   `AGENT_EVIDENCE_STALE` 后的下一步（nextAction=rerun-checks）”；`submit_candidate` 追加
   “证据不符返回 `AGENT_EVIDENCE_STALE` + issue `EVIDENCE_STALE_RERUN_CHECKS` + nextAction，不得重复 submit、不得改证据”。
   平台步骤 `derive_source_bundle` / `adopt_attempt` **不出现**在任何模型工具说明里（有断言）。
2. **停止条件**：系统提示词含「唯一合法顺序 / 写入即失效 / 证据陈旧必须重跑检查 / 停止条件」四段；
   `describe().stopConditions` 列出 `final_answer … output_truncated` 与 `evidence_stale_after_repeated_submit`。
3. **写入即失效**：`write_files`/`delete_files` 成功后，回填给模型的 tool 结果里带
   `note:"写入已生效：既有检查证据失效，必须先重新派生 bundle 并重跑 source.check / composer.dry-run /
   mini/output，再 submit。"`（只进消息，不进 trace——有断言）。
4. **陈旧闸门**：Coordinator 返回 `AGENT_EVIDENCE_STALE` 时，运行时的 `nextAction`/`issues[].code` 会原样
   回填给模型；此后 `submit_candidate` **一律本地拒绝**（不触达 Coordinator、不改证据），错误体仍带
   `nextAction:"rerun-checks"` 且提示先跑 `run_check`。`run_check` 成功后闸门解除，`submit` 才重新下发。
5. **不死循环**：同一参数重复 submit 先被顺序契约拦一次，再被既有 loop detection 判死（`stopReason=loop_detected`）；
   换参数反复 submit 则闸门第二次拒绝即终止本轮，返回 `AGENT_EVIDENCE_STALE` + issue + nextAction。
6. 闸门只挡 `submit_candidate`：陈旧期间 `read_file`/`get_diff`/`run_check` 等照常执行（有用例）。

## 4. 测试清单（58）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/runtime/workspace-runtime.test.cjs` | 29 | 多轮 tool_calls/回填、工具失败回填、平台专用名、未知名、工具表、截断×2、空正文截断、模型次数/工具次数/死循环/墙钟、取消×4、安全 trace、超大结果、X9×2、缺 Coordinator、缺用户消息、空回复 nudge、attempt 只读、profile 预算下传、串行并发、惰性 Coordinator、非法参数 |
| `test/runtime/order-contract.test.cjs` | 10 | 11 个工具说明含顺序链、写入/检查/提交专属细则、系统提示词与 describe()、写入即失效提示、stale 回填与本地拒绝、先重跑检查再 submit 成功、同参重复 submit → loop_detected、换参重复 submit → 闸门终止、闸门只挡 submit、不得出现平台步骤 |
| `test/runtime/model-chat.test.cjs` | 10 | finishReason/truncated（stop/length/tool_calls/缺字段）、maxTokens 契约 3 条、`settings:model:chat` 对等、归一层、一次 chat 一次上游 |
| `test/runtime/http-bridge.test.cjs` | 5 | 未连接 status/send、跨 run channel 拒绝、真 channel、direct 不受影响 |
| `test/runtime/guard-rails-default.test.cjs` | 4 | guard-rails 唯一常量 = 3、env.validation 两处 = 3、`.env.example`、入口/上游两件事不互相顶替 |

## 5. 接线说明（需要 workspace-lead 在 `desktop/main.cjs` 补一行）

`main.cjs:382-388` 目前是 `directRuntime: null`（注释“由 E0-R1 注入”）。把 direct 通道接上只需一行
（runtime 已支持惰性 Coordinator，不会与创建顺序打架）：

```js
const { createDirectWorkspaceRuntime } = require('./agent-runtime');

const workspaceRunCoordinator = createRunCoordinator({
  // ...
  directRuntime: createDirectWorkspaceRuntime({
    coordinator: () => workspaceRunCoordinator,   // 惰性，规避创建顺序
    credentials: modelCredentials,               // 与 settings:model:chat 共用同一个调度器
  }),
});
```

未接线时 `coordinator.invokeDirect` 返回 `AGENT_RUNTIME_TOOL_MISSING`（明确、不静默）。

## 6. 回归与全量测试

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"` | 0 | 58 pass / 0 fail |
| `node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs` | 0 | 27 pass / 0 fail（t2 未被破坏） |
| `node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).join(','))"` | 0 | 22 个导出 |
| `cd server; npx vitest run --configLoader native --pool=forks` | 0 | 39 files / 681 tests pass |
| `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | 0 | 无输出 |
| `node --test test/*.test.cjs`（桌面全量） | 1 | 1442 pass / 2 fail（**均与本次改动无关**，见下） |

两处既存失败（如实登记，未掩盖）：
1. `miniprogram/ 是受控镜像…摘要与内容一致` —— 单独跑也失败（`node --test test/w5d-table-source.test.cjs` exit 1），
   原因是 `miniprogram/**` 已被他人改动而 `npm run mirror:sync` 未重跑（镜像陈旧）。`miniprogram/**` 不在任何
   E0 任务 inScope，本任务不修。
2. `E0-W1：submit 静态门禁…` —— 并行跑通过、串行跑偶发失败，属 workspace-lead 正在改的
   `desktop/agent-workspace/**` 与他人编辑竞态；单独跑该文件通过。

## 7. E0 期事实边界（防过度声明）

- 全部用例用 fake 模型与 fake Coordinator，**真实 DeepSeek 调用 0 次**；不宣称“真实 Flash 工具循环已验收”。
- 不宣称 X2（图片真实进入多模态消息）已关闭：属 t7。
- 不宣称 E0 整体通过：X8/X9 只是“桌面侧已落地并有测试”，最终以 t8 独立门禁为准。
- 真实微信 / UIA / 安装包证据 = `NOT_RUN`。

## 8. 复现方式

```powershell
# 本任务门禁（三条 verify）
node --test --experimental-test-isolation=none "test/runtime/*.test.cjs"
node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs
node -e "const r=require('./desktop/agent-runtime');console.log(Object.keys(r).join(','))"

# 服务端回归（guard-rails 默认值改动）
cd server
npx vitest run --configLoader native --pool=forks
npx tsc -p tsconfig.json --noEmit --incremental false
```

测试全部使用 `os.tmpdir()` 下的临时目录，令牌目录在文件级只建一次并在 `test.after` 清理；
不写仓库、不写真实 userData、不需要 API Key。
