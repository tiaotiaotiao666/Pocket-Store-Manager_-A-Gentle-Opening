# E0-R1a 证据：ModelCallScheduler（上游并发上限 3 / X12）

> 任务：`t2 / E0-R1a`（runtime-engineer，attempt 2）
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §14.6（rev15）+ 计划 §4 E0-R1a 的 10 条要求
> + Captain amend rev1（跨进程全局令牌 / 共享用例 / env 主名）
> 日期：2026-11-25（Asia/Shanghai）
> 观测脚本：`docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs`（全部 fake 上游，**真实上游调用 0 次**）
> 结论：**X12（上游并发 ≤3）代码与测试已关闭**；真实模型/微信/UIA/安装包证据 = `NOT_RUN`（本任务不涉及）。

## 0. §0.3 统一交付模板

```text
任务 ID：E0-R1a / t2（ModelCallScheduler 上游并发上限 3，X12）
目标是否完成：YES（进程内 3 槽 + 跨进程全局令牌；rev15 §14.6 / 计划 §4 / amend rev1 全部条目有代码与用例）
实际修改文件：
  - desktop/model-call-scheduler.cjs（新，含跨进程令牌代理 createUpstreamTokenBroker）
  - desktop/model-credentials.cjs（requestChat 单一底层出口接入模块级单例调度器）
  - test/model-call-scheduler.test.cjs（新，27 个测试）
  - test/fixtures/model-scheduler/cases.json（新，桌面/服务端共享行为用例）
  - docs/evidence/workspace-agent/e0-r1a/report.md（本文）
  - docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs（新，并发观测脚本）
行为变化：
  - 每一次上游 chat/completions 实际请求都先经公平 FIFO 队列（默认 3）+ 跨进程全局令牌（池 3）；
  - 排队预算默认 180s（30–600s 可配），超时抛 MODEL_QUEUE_TIMEOUT，不误报上游超时；
  - 请求自身 timeout 从真正发请求时计时（排队不消耗）；槽位在响应体读完后才释放；
  - 取消（AbortSignal）可出队 / 放弃等令牌 / 中断运行中请求并释放槽位；
  - MODEL_MAX_CONCURRENT 只允许 1–3，>3/非法 → clamp 到 3 + 可见警告（console.warn + config().warnings）；
  - 环境变量主名 MODEL_MAX_CONCURRENT / MODEL_QUEUE_WAIT_MS / MODEL_UPSTREAM_TOKEN_DIR，
    不读 AGENT_MAX_CONCURRENT；MODEL_QUEUE_TIMEOUT_MS 仅兼容别名（用了会提醒）。
新增测试：test/model-call-scheduler.test.cjs（27 tests：12 条共享用例 + 15 条验收/协议用例）
执行命令与真实退出码：
  node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs  → exit 0（27 pass / 0 fail）
  node -e "const m=require('./desktop/model-call-scheduler.cjs');if(m.MAX_UPSTREAM_CONCURRENCY!==3)process.exit(1);const fs=require('fs');if(!fs.existsSync('test/fixtures/model-scheduler/cases.json'))process.exit(2);console.log('scheduler+cases ok')" → exit 0（输出 scheduler+cases ok）
  node docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs → exit 0（见 §2 实测数字）
  回归 node --test --experimental-test-isolation=none test/model-channel.test.cjs → exit 0（10 pass）
  全量 npm test → exit 1（1434 pass / 1 fail / 2 skipped；唯一失败为既有的 miniprogram/ 镜像陈旧，
  与本次改动无关，见 §6）
真实模型/微信/UIA/安装包证据：NOT_RUN（本任务只用 fake 上游；真实调用 0 次）
与计划的偏差：
  - 计划的测试清单第 8 条（direct + HTTP 同时启用时合计 ≤3）在 E0 期无法功能验收：rev15 §14.6-9 规定
    E0 真实链只走桌面 direct 单出口。本轮交付的是"跨进程令牌协议 + 桌面侧实现 + 跨进程实测"，
    HTTP transport 仍默认不可用；**不宣称"HTTP + direct 合计 ≤3 已功能验收"**。
剩余问题：
  - 服务端（E0-R1b / t9）需要按同一协议接入（用例与协议已冻结在 cases.json，未写第二份）；
  - 令牌目录降级时会话仍可用但只保留进程内限流：`globalStats().degraded=true` + 可见警告；
    需要"要么全局限流要么拒绝"的调用方可开 strictGlobalTokens=true。
下一任务是否可开始：YES（见 §5：调度器门禁已清）
```

## 1. 契约逐条对照

### 1.1 rev15 §14.6 冻结接口

| 冻结项 | 实现位置 | 用例 |
| --- | --- | --- |
| `createModelCallScheduler({ maxConcurrent=3, queueTimeoutMs=180000, requestTimeoutMs?, now?, timers? })` | `desktop/model-call-scheduler.cjs` | 导出与冻结常量 |
| `scheduler.run(task, { signal?, label? })`，task 收到 `{ signal, slotId, waitMs, acquiredAt }` | 同上 `run()` / `taskStart()` | run() 支持 AbortSignal 等 |
| `scheduler.stats()` = `{maxConcurrent,active,queued,maxQueueLength,totalAcquired,totalTimedOut,lastWaitMs}` | 同上 `stats()`（键集严格一致） | stats-purity 共享用例 + settings 用例 |
| `scheduler.configure({ maxConcurrent?, queueTimeoutMs? })` | 同上 `configure()`（>3 截断+警告；非整数 `MODEL_CONFIG_INVALID`） | clamp 用例 |
| 常量 `MAX_UPSTREAM_CONCURRENCY=3` / `MIN_QUEUE_TIMEOUT_MS=30000` / `MAX_QUEUE_TIMEOUT_MS=600000` / `DEFAULT_QUEUE_TIMEOUT_MS=180000`（另导出同值别名 `DEFAULT_QUEUE_WAIT_MS`，对齐 amend rev1 的 env 主名） | 同上导出 | 导出与冻结常量 + verify 命令 2 |
| 错误码 `MODEL_QUEUE_TIMEOUT / MODEL_BUSY / MODEL_ABORTED / MODEL_CONFIG_INVALID` | 同上 `ERROR_CODES`；`model-credentials.cjs` 映射成 `ModelCredentialError` 同码 | 排队超时 / 取消 / configure / close 用例 |

### 1.2 rev15 §14.6 九条冻结语义

1. **唯一出口**：`desktop/model-credentials.cjs#requestChat` 内部 `scheduler.run(...)` 包住真正的 fetch；
   `settings:model:test`、`settings:model:chat`、direct workspace 都经过同一个模块级单例
   （`getSharedModelCallScheduler`）；UI/IPC 层未加任何限流。
2. **上限 1–3**：`normalizeMaxConcurrent` —— >3 截断、非法回落，两条路径都 `warn`；`configure()` 同红线。
3. **FIFO + 排队超时**：`run()` 只在 `queue.length===0 && active<maxConcurrent` 时立刻派发，否则入队尾；
   `onQueueTimeout` → `MODEL_QUEUE_TIMEOUT`（默认 180s，30–600s clamp）。
4. **请求 timeout 从拿槽位后计时**：`performChat()` 的定时器只在 `taskStart()` 之后创建；
   179s 排队后用 `timeoutMs=1000` 的请求仍成功。
5. **槽位在 body 读完/失败/超时/取消后才释放**：`finish()` 只在 task Promise settle 后执行；
   `performChat()` 把 `clearTimeout` 放到 body 读完之后，测试用"HTTP 头已返回但 body 未读完"验证 `active` 仍为 1。
6. **重试不产生第 4 个并发**：一次 `run()` = 一个槽位 + 一个令牌；共享用例 `retry-holds-slot` 与
   "429→重试期间不出现第 4 个并发" 用例观测 `maxInFlight===3`。
7. **取消**：排队 → 出队 + `MODEL_ABORTED`（不计入 `totalAcquired`）；等令牌 → 放弃等待；
   运行中 → abort 内部 signal，settle 后释放；取消后不再发起上游请求。
8. **可观测性**：`stats()` 7 个计数字段；`globalStats()` 只有目录/占用/降级原因；
   断言序列化结果不含 prompt、Key、图片 data URL、`image_url`、`Authorization`。
9. **E0 并发事实**：见 §4（本报告不宣称 HTTP+direct 合计 ≤3 已功能验收）。

### 1.3 计划 §4 E0-R1a 的 10 条

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 上游每次 chat/completions 都过调度器（主对话/图片/设置测试/repair/vision） | PASS（代码） | 唯一出口在 `requestChat`；`test()` 复用 `requestChat` |
| 2 | 默认 3，读 `MODEL_MAX_CONCURRENT`（1–3），不得更高 | PASS | clamp 用例（4/9/100/abc/0/-1/3.5/NaN 全部收敛到 3） |
| 3 | 公平 FIFO；排队超时可读 `MODEL_QUEUE_TIMEOUT`；180s 默认（30–600s）；请求 timeout 从拿槽后计时 | PASS | 共享用例 fifo-order / local-queue-timeout-code；179s 用例 |
| 4 | 槽位在 body 读完或确认失败/超时/取消后释放；只拿到头不释放 | PASS | release-after-body 共享用例 + credentials 级 body 用例 |
| 5 | 429/5xx 重试继续持有或重新排队，不得 3→4 | PASS | retry-holds-slot 共享用例 + 429 用例 |
| 6 | 取消必须出队并释放已占槽位，取消后不得再发请求 | PASS | cancel-queued / cancel-running + run() AbortSignal 用例 |
| 7 | 只控制进程内并发；跨进程须单出口或共享限流器 | PASS（amend rev1 已升级）+ 见 §4 | 跨进程令牌 + 两进程实测 |
| 8 | 不把 `AGENT_MAX_CONCURRENT` 混同上游并发 | PASS | 共享用例 `agent-entry-env-ignored`（env 里给 9 也不影响） |
| 9 | 设置页只显示"最多同时 3 次"；模型测试也走调度器 | PARTIAL | 调度器侧 PASS（`test()` 与 direct 共用单例、合计 ≤3）；设置页文案属 product-ui 范围，未在本任务改 UI |
| 10 | 只记录入队/出队/等待/占用/最大排队，不记 prompt/源码/图片/Key | PASS | stats 键集 + 敏感串断言 |

### 1.4 Captain amend rev1 的五条增量

| # | 增量 | 落实 |
| --- | --- | --- |
| 1 | 跨进程全局令牌（原子创建 + 心跳续租 + 过期回收，`MODEL_UPSTREAM_TOKEN_DIR`，默认 `<tmp>/smart-store-model-slots`）；只做桌面侧 + 令牌模块 + 用例 | `createUpstreamTokenBroker`（同文件导出）+ 协议用例 + 跨进程用例 |
| 2 | 共享行为用例 `test/fixtures/model-scheduler/cases.json`（排队顺序/超时码/释放时机/取消/429 重试），供 t9 parity | 12 条用例；桌面测试**逐条执行该文件**，不是装饰文档 |
| 3 | env 主名 `MODEL_MAX_CONCURRENT` / `MODEL_QUEUE_WAIT_MS`（`MODEL_QUEUE_TIMEOUT_MS` 仅别名）；不读 `AGENT_MAX_CONCURRENT` | `ENV_NAMES` 常量 + `readQueueWaitEnv` + 三条共享用例 |
| 4 | 跨进程实测：两进程各 2 次请求，上游实际并发 ≤3；不允许就写 BLOCKED | 实测 `upstreamPeakInFlight=3`（见 §2）；spawn 不可用时测试自动 skip 并标 BLOCKED |
| 5 | 令牌目录不可用 → 明确 warning + 可读原因，不得静默退回 | `markDegraded()` + `globalStats().degraded/reason` + 用例（非目录路径）；`strictGlobalTokens` 可 fail closed |

## 2. 并发观测数据（真实执行）

命令：`node docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs`（exit 0，fake 上游、真实上游调用 0 次）

### 2.1 进程内：5 个并发 `credentials.chat`

| 指标 | 实测值 |
| --- | --- |
| 请求数 | 5 |
| 观测时刻 `stats().active` | 3 |
| 观测时刻 `stats().queued` | 2 |
| fake 上游并发峰值（fetch→body 读完） | **3** |
| 完成后 `totalAcquired` | 5 |
| `maxQueueLength` | 2 |
| 观测时刻持有的全局令牌 | 3 |

### 2.2 跨进程：两个独立 node 进程各 2 次真实 HTTP 请求

父进程起本地 HTTP 上游（每请求 120ms），两个子进程各自 `createModelCallScheduler({ tokenDir })`
后并发发 2 次请求；**不做任何跨进程共享代码路径以外的假设**。

| 指标 | 实测值 |
| --- | --- |
| 进程数 × 每进程请求 | 2 × 2 = 4 |
| 上游实际收到 | 4 |
| **上游并发峰值** | **3**（无令牌时会是 4） |
| 令牌文件峰值 | 3 |
| 子进程 1 收尾 `lastWaitMs` | 24 ms |
| 子进程 2 收尾 `lastWaitMs` | 144 ms（证明它真的排队等过令牌） |
| 两子进程收尾 `active` / `globalStats().held` | 0 / 0（无泄漏） |

结论：跨进程拓扑下上游并发 ≤3 成立（第 4 个请求在等令牌，而不是同时打上游）。

### 2.3 令牌协议（与 E0-R1b 共用的冻结项，机器可读副本在 cases.json）

| 项 | 值 |
| --- | --- |
| 目录 | `MODEL_UPSTREAM_TOKEN_DIR`，默认 `<os.tmpdir()>/smart-store-model-slots` |
| 池大小 | 3（恒为 `MAX_UPSTREAM_CONCURRENCY`，与本地 `maxConcurrent` 解耦） |
| 文件 | `slot-<n>.token`（n=1..3），`O_CREAT\|O_EXCL` 原子创建即互斥 |
| 内容 | `{"v":1,"pid","host","acquiredAt","expiresAt","label"}` |
| 心跳 | 每 `leaseTtl/3`（默认 10s）用"临时文件 + rename"续租 `expiresAt`（默认 TTL 30s） |
| 回收 | `expiresAt` 已过且（同机 pid 已死 / 跨机 / 内容不可读且 mtime > TTL）才 unlink 重试；同机仍活着的令牌不抢 |
| 目录不可用 | 可见 warning + 可读原因 + `globalStats().degraded=true`；`strictGlobalTokens:true` → `MODEL_BUSY` fail closed |

## 3. 测试清单（27 个，全部通过）

共享用例（执行 `test/fixtures/model-scheduler/cases.json`，服务端 t9 parity 同源）：

| 用例 | 断言 |
| --- | --- |
| fifo-order-single-slot | 单槽 4 请求派发顺序 `[1,2,3,4]`，队列峰值 3，并发峰值 1 |
| local-queue-timeout-code | `MODEL_QUEUE_TIMEOUT`，且 `≠ DEEPSEEK_TIMEOUT`，上游调用数 0 |
| release-after-body-read | body 未读完第二个任务不启动；读完后启动 |
| cancel-queued | `MODEL_ABORTED`，上游调用 0，`totalAcquired` 不变 |
| cancel-running | `MODEL_ABORTED`，槽位释放，后续任务被派发 |
| retry-holds-slot | 5 请求 × 2 次尝试，并发峰值 3，全部成功 |
| clamp-above-max / clamp-invalid | `MODEL_MAX_CONCURRENT=4`/`abc` → 3 + 恰好 1 条警告（且真的 emit） |
| queue-wait-env-primary / -alias | `MODEL_QUEUE_WAIT_MS` 生效；别名生效但产生"兼容别名"提醒 |
| agent-entry-env-ignored | `AGENT_MAX_CONCURRENT=9` 不影响上限（3），无警告 |
| stats-purity | `stats()` 键集严格等于 7 个冻结字段 |

桌面验收用例：

| 用例 | 断言 |
| --- | --- |
| 导出与冻结常量 | 四个常量 + 接口 + 令牌协议常量与 cases.json 一致；令牌目录被创建 |
| 并发 5 次 fake credentials.chat | 观测 active=3 / queued=2 / 上游并发 3；全部成功；令牌清零 |
| 1 慢 + 4 排队 | 取消排队项不减已执行数（`totalAcquired` 不变、上游未调用）；取消运行中释放槽位并让后续继续 |
| 取消运行中（credentials signal 路径） | `MODEL_ABORTED` 后 `active=0`，新请求立刻可跑 |
| 排队 179s | 仍成功，`lastWaitMs=179000`，拿槽后耗时≈上游耗时（<900ms 且 `timeoutMs=1000`） |
| 排队 > 180s | `MODEL_QUEUE_TIMEOUT`，文案含"排队"、不含"模型响应超时"，上游调用 0 |
| 429→重试 / 失败矩阵 | 并发 ≤3；429、5xx、ECONNRESET、超时、body 解析失败、choices 缺失六种失败后槽位与令牌都归零，且能再次获取 |
| clamp + 可见警告 | 单例路径 `console.warn` 出现 `[model-call-scheduler]`；`configure(8)`→3 且 1 条警告；非法值 `MODEL_CONFIG_INVALID`；排队预算 clamp 到 30s/600s |
| settings:model:test + direct 生成 | 5 路混合并发峰值 3；`stats()/config()/schedulerStats()` 序列化不含 prompt/Key/图片 |
| run() AbortSignal | 入队前/排队中/运行中三种取消都 `MODEL_ABORTED`；`close()` 后 `MODEL_BUSY` |
| 槽位在 body 读完后释放 | 头已返回时 `active=1`、`bodiesRead=0`；读完 `active=0` |
| 令牌目录不可用 | 非目录路径 → `degraded=true` + 可读原因 + 可见警告；strict 模式 `MODEL_BUSY` |
| 令牌代理 | 两代理互斥（1/2 号各一）；释放后文件清零；死 pid 过期令牌被回收；未过期令牌不被抢 |
| 跨进程实测 | 2 进程 × 2 请求：上游收到 4、并发峰值 ≤3 且 ≥2（非空跑）、收尾无泄漏 |

## 4. E0 期并发事实（必须写清，防止过度声明）

- 调度器只保证**进程内**并发 ≤3；跨进程靠文件令牌（本轮桌面侧已实现并实测）。
- E0 真实模型链**只走桌面 direct 单出口**（rev15 §14.6-9）；HTTP transport 保持"可选且默认不可用"。
- 因此本报告**不宣称**"HTTP + direct 合计 ≤3 已功能验收"：本轮验收的是
  ①单进程 direct 出口 ≤3；②跨进程令牌协议在两进程实测下 ≤3。
- 服务端 `AGENT_MAX_CONCURRENT` 只限制 Agent HTTP 请求入口，不参与上游并发；桌面调度器
  **不读**该变量（`agent-entry-env-ignored` 用例锁定）。
- 真实上游调用次数：**0**（全部 fake 上游 / 本地 HTTP stub）。

## 5. E0-R1 真实工具循环是否可以开始

**YES（就本任务这道前置门禁而言）。** 依据：

1. X12 的代码与测试已关闭：上游每一次 chat/completions 都经唯一出口排队，单进程与双进程实测并发均 ≤3；
2. rev15 §14.6 接口面（4 个方法 + 4 个常量 + 4 个错误码）与 9 条冻结语义逐条有实现与用例；
3. amend rev1 的五条增量（令牌协议、共享用例、env 主名、跨进程实测、降级可见）全部落实；
4. `test/fixtures/model-scheduler/cases.json` 已冻结，服务端 E0-R1b（t9）无需再写第二份用例。

前置条件（不满足则仍不得做真实多轮/多工具生成）：

- E0-R1 的 direct 工具循环本体（`desktop/agent-workspace/run-coordinator.cjs` 等）属 workspace-lead 写锁，
  本任务未改；真实工具循环必须在 R1 接线完成后再跑；
- 真实模型调用仍需 E0 独立验收（verifier）PASS 后才能开始，且必须如实记录真实调用次数；
- 设置页"最多同时 3 次模型请求"的文案属 product-ui（E0-U1）范围，本任务未改 UI。

## 6. 回归与全量测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs` | 0 | 27 tests / 27 pass / 0 fail |
| `node -e "const m=require('./desktop/model-call-scheduler.cjs');if(m.MAX_UPSTREAM_CONCURRENCY!==3)process.exit(1);console.log('scheduler ok')"` | 0 | `scheduler ok` |
| `node --test --experimental-test-isolation=none test/model-channel.test.cjs` | 0 | 10 tests / 10 pass（直连通道回归，未被调度器破坏） |
| `npm test`（全量） | 1 | 1437 tests / 1434 pass / 1 fail / 2 skipped |

全量唯一失败：`test/w5d-table-source.test.cjs`「miniprogram/ 是受控镜像…摘要与内容一致」 →
`镜像内容与清单摘要不一致（镜像已陈旧）`。这是**既有工作区状态**（`miniprogram/` 有他人未提交改动，
本任务未触碰 `miniprogram/`、`templates/`、`scripts/sync-miniprogram-mirror.cjs`），与调度器改动无关；
修复入口是 `npm run mirror:sync`，属对应写者范围，本任务不越界处理。

## 7. 复现方式

```powershell
cd E:\智能开店app
node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs
node docs/evidence/workspace-agent/e0-r1a/observe-concurrency.cjs
node -e "const m=require('./desktop/model-call-scheduler.cjs');if(m.MAX_UPSTREAM_CONCURRENCY!==3)process.exit(1);const fs=require('fs');if(!fs.existsSync('test/fixtures/model-scheduler/cases.json'))process.exit(2);console.log('scheduler+cases ok')"
```

> 全部用例使用 fake 上游与临时目录（`os.tmpdir()` 前缀 `model-call-scheduler-` / `model-slots-`），
> 不读真实 Key、不访问 api.deepseek.com；令牌目录默认落在系统临时目录，可用
> `MODEL_UPSTREAM_TOKEN_DIR` 覆盖。
