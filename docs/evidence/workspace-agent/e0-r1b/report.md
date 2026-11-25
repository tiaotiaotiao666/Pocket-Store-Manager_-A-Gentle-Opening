# E0-R1b 证据：服务端模型适配器接入统一调度器 + HTTP/direct 跨进程不叠加（X12 服务端侧）

> 任务：`t9 / E0-R1b`（runtime-engineer，attempt 2）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §14.6 / §14.6.1（rev15）+ 计划 §4 E0-R1b
> + 团队任务 t9 的 9 条验收（顺序即 §1 的编号）
> 日期：2026-11-25（Asia/Shanghai）
> 观测脚本：`docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs`（全部 fake 上游，**真实上游调用 0 次**）
> 结论：**服务端侧 X12 已关闭**：进程内 3 槽 + 跨进程全局令牌（与桌面同一 `MODEL_UPSTREAM_TOKEN_DIR` 协议），
> HTTP 与 direct 不各算一套。真实 DeepSeek / 微信 / UIA / 安装包证据 = `NOT_RUN`（本任务不涉及，E1–E4 仍关闭）。

## 0. §0.3 统一交付模板

```text
任务 ID：E0-R1b / t9（服务端模型适配器接入统一调度器 + HTTP/direct 跨进程不叠加，X12 服务端侧）
目标是否完成：YES（9 条验收逐条有代码与用例，见 §1；两条 verify 命令真实退出码 0）
实际修改文件：
  - server/src/agent/model-scheduler/（新目录：model-scheduler.types.ts / upstream-token-broker.ts /
    model-scheduler.ts / scheduled-fetch.ts / agent-entry-queue.ts / index.ts）
  - server/src/agent/runtime/adapters/deepseek-chat-model.ts（complete 整段进槽位）
  - server/src/agent/provider/deepseek-agent.provider.ts（extractTurn 整段重试进同一槽位）
  - server/src/agent/workspace/workspace-agent.module.ts（AGENT_CHAT_MODEL 经 createScheduledFetch +
    引导期初始化调度器与进程级 fetch 兜底 + APP_INTERCEPTOR 入口排队）
  - server/src/agent/workspace/workspace-agent.service.ts（删除「已验证/已采用 → 待本地确认」正则改写）
  - server/src/common/config/env.validation.ts（AGENT_MAX_CONCURRENT 2→3；新增 MODEL_* 三个变量）
  - server/.env.example（AGENT_MAX_CONCURRENT=3 + MODEL_* 段，只写「最多同时 3 次模型请求」，无 Key）
  - server/test/model-scheduler/model-scheduler.test.ts（新，31 个）
  - server/test/model-scheduler/cross-process.test.ts（新，1 个跨进程用例）
  - server/test/workspace-agent.test.ts（改写脱敏用例 + 新增源码断言）
  - server/test/b2-desktop-session-and-rails.test.ts（AGENT_MAX_CONCURRENT 默认值断言 2→3）
  - docs/evidence/workspace-agent/e0-r1b/report.md（本文）
  - docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs（新，并发观测脚本）
  - docs/evidence/workspace-agent/e0-r1b/observe-output.json（新，本次观测真实输出）
行为变化：
  - 每一次真正发往 /chat/completions 的服务端请求（runtime adapter、agent provider、workspace-agent、
    frontend-reconstruct / app-assistant / store-setup 所用的 AGENT_CHAT_MODEL，以及 presentation /
    generation 的裸 fetch）都在同一个 ModelCallScheduler 里排队：进程内 FIFO 3 槽 + 跨进程全局令牌 3；
  - 排队预算默认 180s（30–600s），超时 MODEL_QUEUE_TIMEOUT；请求自身 timeout 从拿到槽位后计时；
  - 一次逻辑请求（含视觉 429/5xx 重试）= 一个槽位 + 一个令牌，重试不产生第 4 个并发；
  - AGENT_MAX_CONCURRENT 默认 3，且只保护 Agent HTTP 入口：超限先排队，排队预算耗尽才 429 AGENT_BUSY；
    调度器完全不读它；
  - 令牌目录不可用（只读/EPERM/被文件占用）→ 启动/首请求即打印可读警告 + globalStats().degraded=true，
    严格模式（服务端默认）下直接禁用 HTTP 真实生成通道（MODEL_BUSY → 502/503 DEEPSEEK_UNAVAILABLE + 原因），
    不静默退回「各算 3」；
  - workspace-agent 不再用正则把模型的「已采用/已验证」改写成「待本地确认」，只脱敏本机绝对路径 / file://。
新增测试：server/test/model-scheduler/（32 tests = 31 + 1 跨进程）
执行命令与真实退出码：
  cd server; npx vitest run --configLoader native --pool=threads test/model-scheduler  → exit 0（32 pass / 0 fail）
  cd server; npx tsc -p tsconfig.json --noEmit --incremental false                    → exit 0（无输出）
  cd server; npx tsx ../docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs  → exit 0（见 §2）
  回归 cd server; npx vitest run --configLoader native --pool=threads                  → exit 0（39 files / 681 tests）
  （环境提示：threads 池跑全量时本机偶发 0xC0000005 进程崩溃、无测试失败信息；同一套命令换
    --pool=forks 连续通过 39 files / 681 tests，threads 复跑也通过；t9 指定的 verify 命令只跑
    test/model-scheduler，重复执行恒为 exit 0，见 §3）
真实模型/微信/UIA/安装包证据：NOT_RUN（本任务只用 fake 上游；真实上游调用 0 次）
与计划的偏差：
  - 无功能性偏差。frontend-reconstruct / generation 的调用点不在本任务 inScope，未改一行：
    它们由「进程级 fetch 兜底」覆盖（§4 有静态清单 + 行为用例双重证明），因此仍只有一条出口。
剩余问题：
  - server/src/agent/agent-guard-rails.ts（inScope 之外）里仍有 `config.get('AGENT_MAX_CONCURRENT') ?? 2`
    的二次兜底字面量；真实启动路径下 validateEnv 一定写入 3，所以该字面量不可达。建议后续在
    b2 任务里顺手改成 3（一行），本任务边界内无法修改。
  - 服务端「设置测试」与「真实生成」共用同一调度器已由用例证明（§1-9），但真实 DeepSeek 双通道同时
    打满 3 的上游观测仍需 E1 真实调用阶段复核（E0 期禁止真实生成）。
下一任务是否可开始：YES（就本任务门禁而言；E1–E4 是否开始由 Captain 另行判定）
```

## 1. 契约逐条对照（t9 的 9 条）

### 1.1 服务端调度器与桌面同语义

- 实现：`server/src/agent/model-scheduler/`（`model-scheduler.types.ts` 冻结常量/错误码/类型；
  `model-scheduler.ts` 队列与配置；`upstream-token-broker.ts` 跨进程令牌协议；
  `scheduled-fetch.ts` 单一出口包装 + 进程级兜底；`agent-entry-queue.ts` 入口排队）。
- 与桌面逐条对齐：FIFO；`MODEL_MAX_CONCURRENT` 1–3（>3 clamp + 可见警告，非法回落 3 + 警告）；
  `MODEL_QUEUE_WAIT_MS` 默认 180000（30s–600s clamp）；请求 timeout 从拿到槽位后计时（`ScheduleSlot.acquiredAt`）；
  槽位在响应体读完 / 明确失败 / 超时 / 取消之后才释放；一次 `run()` = 一个槽位 + 一个令牌；
  `AbortSignal` 取消三分支（排队出队 / 放弃等令牌 / 运行中 abort 后释放）；`stats()` 7 键冻结。
- 用例：§1-2 的 12 条共享用例覆盖上述全部语义。

### 1.2 直接执行共享用例做 parity（不写第二份）

- `server/test/model-scheduler/model-scheduler.test.ts` 里的 `runSharedScenario()` **直接读**
  `test/fixtures/model-scheduler/cases.json`（`contractVersion: model-scheduler.v1`，桌面 E0-R1a 交付、
  本任务只读），逐条执行 12 个 scenario：`fifo-order`、`queue-timeout-local`、`release-after-body`、
  `cancel-queued`、`cancel-running`、`retry-holds-slot`、`env-clamp`×2、`env-queue-wait`×2、
  `env-ignored-agent`、`stats-purity`。
- 结果：**12/12 服务端全过，结论与桌面一致**（同一份期望值，没有第二份用例文件）。
  另有用例断言服务端常量/错误码/env 主名/`statsKeys`/`tokenProtocol.poolSize` 与 cases.json 完全一致，
  防止两边悄悄漂移。

### 1.3 所有发往 chat/completions 的适配器外层统一 acquire/release

| 出口 | 位置 | 接入方式 |
| --- | --- | --- |
| runtime adapter | `src/agent/runtime/adapters/deepseek-chat-model.ts` | `complete()` 整段（计时→fetch→读 body→解析）在 `scheduler.run()` 内 |
| agent provider | `src/agent/provider/deepseek-agent.provider.ts` | `extractTurn()` 整段重试循环在同一个 `scheduler.run()` 内 |
| workspace-agent | `src/agent/workspace/workspace-agent.module.ts` | `AGENT_CHAT_MODEL` 的 fetch 经 `createScheduledFetch()` + 显式 `scheduler` |
| 既有 agent 服务 | `agent.service.ts` / `frontend-reconstruct` / `app-assistant` / `store-setup` 都注入同一个 `AGENT_CHAT_MODEL` | 同上（无独立出口） |
| presentation | `src/agent/presentation/template-revise.provider.ts` | 进程级 `globalThis.fetch` 兜底 |
| generation | `src/generation/model-provider.service.ts` | 进程级 `globalThis.fetch` 兜底 |

- 证明 1（静态）：用例扫描 `server/src/**/*.ts` 中同时含 `chat/completions` 与 `fetch(` 的文件，
  结果集合必须等于上表清单，且显式接线文件里必须真的出现 `scheduler.run(` / `createScheduledFetch(`。
- 证明 2（行为）：让「未接线的裸 fetch」连发 5 个 `/chat/completions`，父进程 HTTP 侧观测峰值 = 3、
  `totalAcquired` = 5；对非 `/chat/completions` 路径不变（不误伤图片等其它上游）。
- 证明 3（引导期）：Nest 引导 WorkspaceAgentModule 后立即 `isUpstreamFetchGuardInstalled() === true`
  ——兜底早于第一个请求，不存在「第一次生成绕过」的窗口。

### 1.4 跨进程不叠加

- 与桌面共用同一令牌协议（`MODEL_UPSTREAM_TOKEN_DIR` 下 `slot-<n>.token`，池固定 3，
  `O_CREAT|O_EXCL` 原子占用，心跳 temp+rename，`expiresAt` 过期且同机 pid 已死才回收）。
- `server/test/model-scheduler/cross-process.test.ts`：spawn 一个 plain-node 子进程（`require`
  桌面 `desktop/model-call-scheduler.cjs`）+ 一个 `node --import tsx` 子进程（服务端调度器源码），
  共享同一令牌目录、对齐起跑，各发 2 个真实 HTTP 请求 → **上游并发峰值 = 3**（不是 4）。
  spawn 正常执行，**没有 BLOCKED**；子进程 stderr 落文件，失败会带诊断。
- 复用的观测协议见 §2.2（与桌面 E0-R1a `observe-concurrency.cjs` 同一套：同一令牌目录 + 每进程 2 次真实 HTTP + 父进程计峰值）。

### 1.5 令牌目录不可用

- 三个用例：严格模式（服务端单例默认）→ `scheduler.run()` 直接 `MODEL_BUSY`，经 adapter 变成
  `DEEPSEEK_UNAVAILABLE`，message 含「模型并发通道不可用（EEXIST…）」；**上游一次都没被打到**；
  非严格模式 → 可见警告（与桌面同一文案）+ `globalStats().degraded=true`；
  单例默认严格（fail closed）也有用例。
- 启动期即暴露：`AgentEntryQueue` 工厂在引导期初始化调度器，令牌目录不可用的警告打在启动日志。

### 1.6 AGENT_MAX_CONCURRENT 2 → 3，只作入口保护

- `env.validation.ts`：类默认值与 `numericDefaults` 兜底都改成 3，并写明「只保护 `/api/v1/agent/**` 入口，
  超限先排队，不参与上游并发计算，不替代 ModelCallScheduler」。
- `agent-entry-queue.ts`：FIFO 入口闸门，默认预算 180s，只有预算耗尽才 429 `AGENT_BUSY`；
  用例证明：5 并发 → 3 放行 / 2 排队 / `totalBusy=0`；与既有 `AgentConcurrencyInterceptor` 叠加后
  5 个请求全部成功、没有 `AGENT_BUSY`（排队发生在其前面，其 429 分支不可达）。
- 用例证明调度器不读它：`resolveSchedulerOptionsFromEnv({AGENT_MAX_CONCURRENT:'9'})` → 仍为 3、无警告
  （也就是 cases.json 的 `env-ignored-agent`）。

### 1.7 删除「已验证/已采用 → 待本地确认」正则改写

- `workspace-agent.service.ts`：删掉 `FORBIDDEN_CLAIM_PATTERN` 与 `.replace(..., '待本地确认')`，
  `sanitizeReply()` 只剩本机绝对路径 / `file://` 脱敏（模型回复仅供参考，结构字段仍是权威）。
- 用例：`server/test/workspace-agent.test.ts` 断言 reply 保留模型措辞（含「已采用」）且路径已 scrub；
  另一条用例直接读源码断言 `FORBIDDEN_CLAIM_PATTERN` / `'待本地确认'` / `已采用|已导出|已验证` 正则都不存在。

### 1.8 配置与诊断口径

- `server/.env.example`：`AGENT_MAX_CONCURRENT=3`，新增 `MODEL_MAX_CONCURRENT=3` /
  `MODEL_QUEUE_WAIT_MS=180000` / `MODEL_UPSTREAM_TOKEN_DIR=`（注释口径统一为「最多同时 3 次模型请求」），
  **全文没有任何 Key**（Key 只在 `server/.env` 或云端密钥管理）。
- 诊断：`stats()` 只有 `maxConcurrent/active/queued/maxQueueLength/totalAcquired/totalTimedOut/lastWaitMs`；
  `globalStats()` 只有 `enabled/dir/maxTokens/held/available/degraded/reason`；`config()` 只有配置与警告。
  用例对三者序列化后断言不含 prompt / 源码 / image_url / base64 / `sk-`。

### 1.9 测试矩阵

| 要求 | 用例 | 结果 |
| --- | --- | --- |
| 5 并发 → 3 执行 2 排队 | `适配器接线` / `入口闸门` / 共享 `fifo-order` | pass |
| 取消排队不影响执行中 | `取消排队不影响执行中；取消运行中释放槽位` + `cancel-queued` | pass |
| 取消运行中释放槽位 | 同上 + `cancel-running` | pass |
| 429 重试不出现第 4 并发 | `429 重试…`（5 请求 × (429+成功) = 10 次上游、只占 5 槽、峰值 3）+ `retry-holds-slot` | pass |
| 错误/超时/解析失败不泄漏槽位 | `429 重试…` b) 五种失败逐个断言 active=0 / held=0 且可再次获取 | pass |
| 设置测试与真实生成同时不超 3 | `settings/视觉测试与真实生成共用同一调度器`（5 路混合峰值 ≤3） | pass |

## 2. 并发观测数据（真实执行，fake 上游）

脚本：`docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs`（输出原文见
`observe-output.json`）。命令：`cd server; npx tsx ../docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs`
→ exit 0；`node v24.14.0`，`win32-x64`，`realUpstreamCalls: 0`。

### 2.1 进程内：5 个并发 `DeepseekChatModel.complete`（经 createScheduledFetch 接线）

| 指标 | 观测值 |
| --- | --- |
| 请求数 / 成功数 | 5 / 5 |
| `maxConcurrent` | 3 |
| 排队期间的 `active` / `queued` | 3 / 2 |
| `maxQueueLength` | 2 |
| `totalAcquired` | 5 |
| **上游并发峰值** | **3** |
| 结束后 `globalStats().held` | 0 |
| `degraded` | false |

### 2.2 跨进程：4 个进程（2 桌面节点 + 2 服务端节点）各 2 次真实 HTTP

| 指标 | 观测值 |
| --- | --- |
| 进程数 / 每进程请求数 | 4 / 2 |
| 上游实际收到请求 | 8 |
| 每个子进程本地槽位 | 各 `maxConcurrent=2`，各 `totalAcquired=2`（合计 8 个本地槽位） |
| **上游并发峰值** | **3** |
| **令牌文件峰值** | **3**（`slot-*.token`） |
| 若两边各算一套的峰值 | 8 |
| 子进程 `globalStats().held` / `degraded` | 0 / false（4/4 全部如此） |
| 子进程等待令牌时长 | 248ms / 433ms / 452ms / 254ms（真实排队发生了） |

结论：桌面 direct 与 HTTP 两个方向、四个进程、8 个本地槽位，上游同一时刻只有 3 个请求在飞。

## 3. 全量回归

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cd server; npx vitest run --configLoader native --pool=threads test/model-scheduler` | 0 | 2 files / 32 tests pass（重复执行恒为 0） |
| `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | 0 | 无输出 |
| `cd server; npx tsx ../docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs` | 0 | 见 §2 |
| `cd server; npx vitest run --configLoader native --pool=threads`（全量） | 0 | 39 files / 681 tests pass |
| `cd server; npx vitest run --configLoader native --pool=forks`（全量对照） | 0 | 39 files / 681 tests pass |

环境提示（如实记录）：本机用 `--pool=threads` 跑**全量**时偶发进程级崩溃
（Windows `0xC0000005`，日志在若干文件后直接截断，**没有任何测试失败信息**）；同一时刻用
`--pool=forks` 跑同一套全量连续通过，threads 复跑也通过，说明是线程池/宿主的偶发不稳定，
不是用例失败。t9 指定的 verify 命令只跑 `test/model-scheduler`，多次执行恒为 exit 0。

定向复核：`npx vitest run --configLoader native --pool=threads test/workspace-agent.test.ts test/model-scheduler`
→ exit 0（3 files / 49 tests pass）。

## 4. E0 期事实边界（防过度声明）

- 全部用例与观测都用 fake 上游，**真实 DeepSeek 调用 0 次**；不宣称「真实模型并发已验收」。
- 不宣称「HTTP + direct 已功能验收」：本任务关闭的是代码与测试口径，真实双通道同时打满 3 需 E1 真实调用阶段复核。
- E1–E4（App 主链、真实图片生成）门禁状态不变。
- `AGENT_MAX_CONCURRENT` 只保护入口，`ModelCallScheduler` 才是上游并发上限；两者不互相替代。

## 5. 复现方式

```powershell
cd server
npx vitest run --configLoader native --pool=threads test/model-scheduler
npx tsc -p tsconfig.json --noEmit --incremental false
npx tsx ../docs/evidence/workspace-agent/e0-r1b/observe-concurrency.cjs
npx vitest run --configLoader native --pool=threads
```

跨进程用例要求：`server/node_modules/tsx` 可用（devDependency 已有）；子进程用
`node --import tsx`、`stdio` 落文件（不用管道），失败时把该文件尾部打进断言消息。
