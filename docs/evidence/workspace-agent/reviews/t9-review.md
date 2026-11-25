# t9 复核（Review-t9）：E0-R1b 服务端调度器 + 跨进程不叠加 独立复核

- 复核任务：**t24 / Review-t9**（独立验证工程师 verifier2，attempt 2，attempt_id `c4a2515c-d6bc-494b-b78f-46ce9c738b54`）
- 被复核任务：**t9 / E0-R1b**（runtime-engineer，attempt 2）
- 生成时间：2026-11-25 15:06（+08）
- 复核方式：只读；以**最终磁盘字节**为准；不引用 t9 自带测试的“绿”当结论。另写 4 个独立探针
  （`t9-probe-*.ts` / `t9-probe-child-*.{cjs,ts}`，只写 `os.tmpdir()`），并独立复跑门禁。
- 判定对象：rev15 §14.6 / §14.6.1 / §14.12-7 / §14.13、t9 的 9 条验收、`test/fixtures/model-scheduler/cases.json`
- 本文件**不是 E0 终局 verdict**（归 t8/E0-V1）；E1–E4 仍不开放。

---

## 0. 总计划 §0.3 模板

```text
任务 ID：t24 Review-t9（E0-R1b 服务端调度器/跨进程不叠加/入口语义/X9 删除 独立复核）
目标是否完成：NO（needs_revision）
  - 服务端调度器与桌面同语义（FIFO / 1–3 clamp+警告 / 180s 默认 / 槽位读完 body 才释放）：
    **调度器本体 PASS**（12 条共享用例两侧观测完全一致）
  - 所有 chat/completions 出口被覆盖：**覆盖成立（5 个出口全部有唯一限流路径），但“静态证明”弱于报告声称**
  - 跨进程不叠加：**PASS**（同一令牌目录两进程 4 请求峰值 3；不同目录对照组峰值 4）
  - 令牌目录不可用 fail closed：**PASS**（严格模式 0 次上游 + 可读原因；非严格 degraded + 警告；单例默认严格）
  - AGENT_MAX_CONCURRENT 默认 3、只作入口排队、调度器不读：**PASS**
  - X9 服务端改写删除：**PASS**（代码 + 行为 + 源码断言；但其中一条源码断言恒真，另行记录）
  - ⚠️ 偏差（medium）：presentation / generation 这两个「进程级 fetch 兜底」出口，
    请求 timeout 在**入队前**开始计时、槽位在**HTTP 头到达**即释放，与 §14.6-4/§14.6-5 字面不符；
    报告未披露这一边界（G03/G12 实证）。

实际修改文件：无（复核方只写 docs/evidence/workspace-agent/reviews/**）
行为变化：无（未改任何产品代码 / server 源码 / test/** / docs/handoff/**）
新增测试：无；新增 4 个独立探针 + 4 份结果 JSON（reviews 目录内）
执行命令与真实退出码：
  1) cd server; npx vitest run --configLoader native --pool=forks test/model-scheduler
     → exit 0，2 files / 32 tests pass（9.07 s；跨进程用例 4.5 s）
  2) cd server; npx tsc -p tsconfig.json --noEmit --incremental false
     → exit 0（无输出）
  3) node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs（桌面侧 parity 参照）
     → exit 0，27/27 pass
  4) 独立探针：parity 13/13、cross-process 3/3、guard 13/13、protocol 11/11（全部 exit 0）
真实模型/微信/UIA/安装包证据：NOT_RUN（本轮只跑 fake 上游与本机 127.0.0.1 计数服务器，真实上游 0 次）
与计划的偏差：无（复核范围按 t24 合同；不碰被复核代码）
剩余问题：F-R1B-01（medium）/ F-R1B-02（medium）/ F-R1B-03…06（low/info）
下一任务是否可开始：就「上游并发 ≤3」而言服务端侧可记关闭；但 X12 的“同语义”验收项
                未完全满足，建议先按 F-R1B-01 由 Captain 裁定“扩 scope 显式接线”或“书面接受降级 + E1 登记”，
                 再由 t8/E0-V1 引用本结论；E1–E4 继续不开放。
```

---

## 1. 被测字节指纹（复核开始/结束各复算一次，一致）

| 文件 | SHA-256 | bytes | mtime |
|---|---|---|---|
| `server/src/agent/model-scheduler/model-scheduler.types.ts` | `19c8b78885a7db4d…2b0876c8` | 7 252 | 11-25 00:29:52 |
| `server/src/agent/model-scheduler/upstream-token-broker.ts` | `0ff88b89f5c14018…e52ff9fd` | 13 300 | 11-25 00:30:11 |
| `server/src/agent/model-scheduler/model-scheduler.ts` | `c2a608ab370934f3…8c8c97e8` | 21 531 | 11-25 00:45:45 |
| `server/src/agent/model-scheduler/scheduled-fetch.ts` | `04b0b002ba1b0e71…8de3b8a8` | 4 384 | 11-25 00:34:00 |
| `server/src/agent/model-scheduler/agent-entry-queue.ts` | `beaa3d29dd0a5a12…bbb1a7ce5` | 7 608 | 11-25 00:51:03 |
| `server/src/agent/model-scheduler/index.ts` | `2a2adc053cbf0a8c…4a408364` | 2 092 | 11-25 00:51:06 |
| `server/src/agent/runtime/adapters/deepseek-chat-model.ts` | `17b17113c3ccb198…7e61c5989c` | 18 657 | 11-25 00:31:49 |
| `server/src/agent/provider/deepseek-agent.provider.ts` | `87530d4bc0198029…e9056a602f8` | 28 522 | 11-25 00:36:58 |
| `server/src/agent/workspace/workspace-agent.module.ts` | `784711122e4266a9…687695d7` | 4 622 | 11-25 00:51:41 |
| `server/src/agent/workspace/workspace-agent.service.ts` | `a2ae7b25a867140d…4b2a6faa6` | 15 663 | 11-25 00:32:51 |
| `server/src/agent/presentation/template-revise.provider.ts` | `4f8653217daecd16…3e4a4f03bd` | 19 061 | **11-19 22:22:05（t9 未改）** |
| `server/src/generation/model-provider.service.ts` | `6022e2c2e24a0e50…b9af9fdb` | 13 486 | **11-02 16:21:05（t9 未改）** |
| `server/src/agent/agent-guard-rails.ts` | `42c5c76ffd53ee0d…8492722` | 7 832 | 11-25 01:10:22 |
| `server/src/common/config/env.validation.ts` | `72050fe794f632a1…2bae5a2a7` | 11 539 | 11-25 00:33:13 |
| `server/test/model-scheduler/model-scheduler.test.ts` | `a89e1f1c843eb8fd…b1de88ad5` | 42 590 | 11-25 00:51:09 |
| `server/test/model-scheduler/cross-process.test.ts` | `dfabedc1ff882f92…0e60e1011c` | 8 750 | 11-25 00:36:05 |
| `server/test/workspace-agent.test.ts` | `8b09a5a3d537bb09…7f61f07a2` | 17 246 | 11-25 00:35:43 |
| `test/fixtures/model-scheduler/cases.json` | `3794c7214dbeb22c…51da4292` | 5 635 | 11-25 00:20:54 |
| `docs/evidence/workspace-agent/e0-r1b/report.md` | `e4f4a3111e78eb61…084ea6cf9c` | 17 213 | 11-25 01:00:05 |
| `server/.env.example` | `882f59576a8c39ab…c066b6e91d` | 5 115 | 11-25 00:33:34 |

- 复核前后各复算一次，`model-scheduler.ts`/`scheduled-fetch.ts`/`upstream-token-broker.ts` 等摘要不变；
  结论只对上面这组字节成立。
- `presentation` / `generation` 两个“兜底覆盖”文件 mtime 分别是 11-19 / 11-02 —— 与报告 §0「未改一行」一致，
  也说明这两条出口**只**靠进程级 fetch 兜底（不是显式接线）。

---

## 2. 门禁独立复跑（真实退出码）

| # | 命令（t24 合同 verify） | 真实退出码 | 结果 |
|---|---|---|---|
| 1 | `cd server; npx vitest run --configLoader native --pool=forks test/model-scheduler` | **0** | `Test Files 2 passed (2)`、`Tests 32 passed (32)`、9.07 s（含跨进程 4 509 ms） |
| 2 | `cd server; npx tsc -p tsconfig.json --noEmit --incremental false` | **0** | 无输出 |
| 3 | `node --test --experimental-test-isolation=none test/model-call-scheduler.test.cjs`（桌面 parity 参照） | **0** | `tests 27 / pass 27 / fail 0`（含“槽位读完 body 才释放”“跨进程两进程 ≤3”） |

> 报告 §3 用的是 `--pool=threads`；t24 合同指定 `--pool=forks`。我按要求跑 forks，32/32 通过。
> 报告提到的全量 681 tests 我**未复跑**（不在 t24 verify；记为 NOT_RUN，不作为结论依据）。

---

## 3. 接入点逐一核对（“所有 chat/completions 出口”）

我自己的枚举：`server/src/**/*.ts` 里出现 `chat/completions` 的文件共 7 个，其中 2 个是调度器自身
（`model-scheduler.ts`、`scheduled-fetch.ts`），其余 5 个如下（T05）：

| # | 出口 | 位置 | 接线方式 | 我的核对结论 |
|---|---|---|---|---|
| 1 | runtime adapter | `deepseek-chat-model.ts:191`（`this.fetchImpl(.../chat/completions)`） | `complete()` 在 `scheduler.run()` 内（:136），`sendAndParse` 含 **fetch→读 body→解析**（:150-230），调度器默认取进程共享单例（:145-148） | **已覆盖**；G04 实测第二个任务在响应体读完前不会开始 |
| 2 | agent provider | `deepseek-agent.provider.ts:500` | `extractTurn()` 整段重试在同一个 `scheduler.run()` 内（:316-332），未注入时懒取共享单例（:462-463） | **已覆盖**；429 重试不增并发（共享用例 `retry-holds-slot` 两侧一致） |
| 3 | workspace-agent 接线点 | `workspace-agent.module.ts:79`（`createScheduledFetch((input,init)=>fetch(...))`） | 不是独立出口，是 #1 的 fetch 注入点 + :45 装进程级兜底 | 接线正确；`isInsideScheduledSlot` 防二次排队（G04 无死锁） |
| 4 | presentation | `template-revise.provider.ts:388`（`this.fetchImpl`，`AGENT_FETCH`=裸全局 fetch） | **只靠进程级 fetch 兜底**（`ensureUpstreamFetchGuard`） | 请求确实被限到 ≤3（G05 同类路径峰值 3）；**但 timeout/槽位释放语义有偏差（见 F-R1B-01，G03/G12）** |
| 5 | generation | `model-provider.service.ts:109`（裸 `fetch(.../chat/completions)`） | 同上 | 同上 |

其他可能入口的排查（全部为空）：

- 无 `axios` / `openai` SDK / `undici` / `https.request` / `node-fetch`（grep 证据见下）。
- 其他 `/images/*` 调用（`model-provider.service.ts:54/56/82`、`poster-generation.service.ts:161/243`）不是
  `chat/completions`，按 §14.6 不属于本任务上游并发口径（E1 真实图片生成时需另行裁定，见 F-R1B-07）。
- `agent.module.ts:26` / `auth.module.ts:9` 的 `fetch(` 分别是 Agent 默认 fetch 注入与微信鉴权，不是模型出口；
  `poster-generation` 的 fetch 是图片下载/生图。

```text
# 我的 grep 证据（cd server）
Get-ChildItem src -Recurse -Filter *.ts | Select-String 'chat/completions'   → 7 文件（含 2 个调度器自身）
Select-String "from 'axios'|openai|undici|https?\.request|node-fetch"        → 0 命中
```

---

## 4. 与桌面同语义：共享用例 parity（12/12）

我自己写了一份**独立场景执行器**（`t9-probe-parity.ts`，不复用 t9 的 `runSharedScenario`），
把同一份 `test/fixtures/model-scheduler/cases.json` 分别跑在**服务端调度器**和**桌面调度器**
（`desktop/model-call-scheduler.cjs`）上，比较「观测 == 期望」且「服务端 == 桌面」：

| 用例 | 观测（两侧一致） |
|---|---|
| `fifo-order-single-slot` | dispatchOrder `[1,2,3,4]`、峰值 1、maxQueueLength 3 |
| `local-queue-timeout-code` | `MODEL_QUEUE_TIMEOUT`、被超时请求上游调用 0 次、`totalTimedOut=1` |
| `release-after-body-read` | body 读完前第二个不启动、读完才启动 |
| `cancel-queued` | `MODEL_ABORTED`、被取消请求上游 0 次、`totalAcquired` 不变 |
| `cancel-running` | `MODEL_ABORTED`、槽位释放、后继被派发 |
| `retry-holds-slot` | 峰值 3、每请求 2 次尝试、全部成功 |
| `clamp-above-max` / `clamp-invalid` | 都是 maxConcurrent 3 + 1 条可见警告 |
| `queue-wait-env-primary` / `-alias` | 60000、别名提醒 false/true |
| `agent-entry-env-ignored` | AGENT_MAX_CONCURRENT=9 → 仍 3、0 警告 |
| `stats-purity` | 7 个键，无 prompt/sk-/base64/image_url |

结果：`TOTAL=13 FAILED=0`（含 fixture 元数据一条）。**两侧观测值逐键相等**，不是“各自能过”而已。

---

## 5. 跨进程令牌协议：与桌面完全一致（不是近似实现）

`t9-probe-protocol.ts`（T01–T04）+ `t9-probe-cross-process.ts`（C01–C03）：

| 检查 | 实测 |
|---|---|
| T01 令牌文件形状 | 两侧都写 `slot-1.token`，payload 键完全相同 `[acquiredAt,expiresAt,host,label,pid,v]`，`v=1`，`expiresAt-acquiredAt=30000`，`maxTokens=3`、`leaseTtlMs=30000` |
| T02 桌面占满 3 个 → 服务端 | 服务端 `MODEL_QUEUE_TIMEOUT`（300ms 预算内拿不到）；桌面释放 1 个后服务端在 5s 内拿到 |
| T03 服务端占满 3 个 → 桌面 | 桌面 `MODEL_QUEUE_TIMEOUT`；服务端释放后桌面拿到 |
| T04 过期 + 同机死 pid | 两侧都能回收 `slot-1.token` 并重新拿到 index=1 |
| C01 同一 `MODEL_UPSTREAM_TOKEN_DIR`，两进程各 2 请求（起跑对齐） | 上游峰值 **3**、总请求 4、令牌文件峰值 3；两侧子进程 `degraded=false`、`held=0` |
| C03 对照组：两个进程各用不同令牌目录 | 上游峰值 **4**、令牌文件峰值 2 → 证明“同一目录”才是真正的门 |

> C01/C03 是我自己的子进程（`t9-probe-child-desktop.cjs` / `t9-probe-child-server.ts`），
> 不使用 t9 的 `observe-concurrency.cjs`；两组都真实发 HTTP 到本机计数服务器。

---

## 6. 令牌目录不可用：真 fail-closed（不是只报警）

| 检查 | 实测 |
|---|---|
| G01 严格模式（`strictGlobalTokens:true`），目录实为文件 | adapter 抛 `DEEPSEEK_UNAVAILABLE`，message 含「模型并发通道不可用」+ `ENOTDIR/EEXIST`；**上游调用 0 次**；可见 warning；`globalStats().degraded=true`、`reason` 带错误码；`active=0` |
| G11 进程级单例默认 | `getSharedModelCallScheduler({overrides:{tokenDir:阻塞目录}})` → `run()` 直接 `MODEL_BUSY`、`degraded=true`、`active=0`、guard 已安装 → 证明服务端默认 strict，不是“各算 3” |
| G02 非严格模式（仅测试可关） | 请求成功但 `degraded=true` + 警告「这不再是「全局最多 3」的保证」 |

---

## 7. AGENT_MAX_CONCURRENT：默认 3、只作入口排队、调度器不读

| 检查 | 实测 |
|---|---|
| G06 入口闸门 5 并发（max=3） | 先放行 3、排队 2（`queued=2`）、`totalBusy=0`；释放 1 → 第 4 个放行；**没有任何 429** |
| G07 默认与环境 | `DEFAULT_AGENT_MAX_CONCURRENT=3`；`NODE_ENV=development` 且未设 env → 3；设 `AGENT_MAX_CONCURRENT=9` → 入口 9（入口门槛允许），不影响上游 |
| G08 调度器不读 | `resolveSchedulerOptionsFromEnv({AGENT_MAX_CONCURRENT:'9'})` → `maxConcurrent=3`、`warnings=[]` |
| 静态 | `env.validation.ts:140 AGENT_MAX_CONCURRENT = 3`、`:274` numericDefaults 3；`model-scheduler/**` 无 `process.env.AGENT_MAX_CONCURRENT`/`config.get('AGENT_MAX_CONCURRENT')` |

备注：`NODE_ENV=test` 且未设 `AGENT_RAILS_ENFORCE` 时入口队列默认关闭（`readAgentEntryQueueOptions` 返回 0）——
这是测试隔离口径，**生产不受影响**；读 t9 的用例时不能据此推断“生产默认 0”。

---

## 8. X9 服务端副本：正则改写已删除

| 检查 | 实测 |
|---|---|
| T08 代码 | `workspace-agent.service.ts` 无 `FORBIDDEN_CLAIM_PATTERN`；`sanitizeReply` 只剩盘符路径与 `file://` → `[path]`（:78-82）；无 `.replace(...已采用/已导出/已验证...)`；`server/src/**` 全文无「待本地确认」 |
| T09 断言存在 | `server/test/workspace-agent.test.ts:243-245` 断言 `not.toContain('FORBIDDEN_CLAIM_PATTERN')`、`not.toContain("'待本地确认'")` |
| 行为 | 同文件 :223-233：模型回复带「已采用并导出到 E:\tmp…」→ reply 保留「已采用」、路径被 scrub、且不含「待本地确认」 |

但第 3 条源码断言 `/已采用\|已导出\|已验证/` 是**字面管道文本**（见 F-R1B-03），恒真、无断言力。

---

## 9. Findings（交 Captain 派修；我不改产品代码）

| ID | 严重度 | 位置 | 问题 | 必须的修复 |
|---|---|---|---|---|
| **F-R1B-01** | **medium** | `server/src/agent/model-scheduler/scheduled-fetch.ts:84-93` + `template-revise.provider.ts:378-388/426` + `model-provider.service.ts:106-114` | 两条「进程级 fetch 兜底」出口不满足 §14.6-4/§14.6-5：① 出口自身在 **fetch 之前**起 timeout 计时器（presentation :380、generation :107），guard 只能把 fetch 包进槽位 → **排队时间消耗请求 timeout**；G12 实测：占满 1 槽时，排队中的请求在 100ms 计时器到点后直接失败，**上游 0 次调用**（真实 30s timeout 遇上 3 个长请求时同样会发生）。② guard 的槽位在 fetch 解析（收到 HTTP 头）时释放，body 由出口在槽位外读取（presentation :426、generation :114）；G03 实测第二个任务能在第一个响应体读完前开始。报告 §1.1/§1.3/§1.4 把这两条出口描述为“在同一 ModelCallScheduler 里排队”，未披露该差异 | 二选一并写明：**(a)** 扩 scope（或 rev）把这两个出口改成显式 `scheduler.run()`（把计时器移进槽位、body 读完再 settle）；**(b)** 若 Captain 接受 E0 期降级：报告 §1.1/§1.3/§4 明确写“这两条出口的 timeout 从入队前计时、槽位在响应头到达即释放，与 §14.6-4/5 有偏差”，补一条用例锁定现状，并在 E1 任务书登记修复。**不得**继续让读者以为已满足 §14.6-4/5 |
| **F-R1B-02** | medium | `server/test/model-scheduler/model-scheduler.test.ts:779-804` | 静态出口用例的过滤条件是“同时含 `chat/completions` **且** `\bfetch\s*\(`”，实际只命中 2/5 个文件（`workspace-agent.module.ts`、`generation/model-provider.service.ts`）；`this.fetchImpl(...)` 形式的 3 个真实出口（adapter/provider/presentation）**永远不会被该断言捕获**（T06 实测 t9Filter=2）。报告 §1.3 声称“结果集合必须等于上表清单”，实际只验了“没有预期之外的命中”，证明力弱于声称 | 改成“所有含 `chat/completions` 的文件集合 ⊆ 白名单”，并对白名单里的每个文件断言其调度证据（`scheduler.run(` / `createScheduledFetch(` / `resolveScheduler()` / `getSharedModelCallScheduler`），否则新增注入式出口会静默通过 |
| **F-R1B-03** | low | `server/test/workspace-agent.test.ts:244` | `expect(source).not.toMatch(/已采用\|已导出\|已验证/)` 匹配的是带字面管道的字符串，恒真；且该源码注释本身含「已采用/已验证」，真正的 alternation 反而会失败 → 这条断言没有任何断言力（另两条 `toContain` 断言仍有效） | 改成对 `sanitizeReply` 的行为断言（已存在），或删掉注释里的字面词后使用真正的 `(已采用\|已导出\|已验证)` 并保留 |
| **F-R1B-04** | low | 报告 §0/§1.6；`server/src/agent/agent-guard-rails.ts:192` | 报告说残留 `config.get('AGENT_MAX_CONCURRENT') ?? 2`；实际是 `Number.isFinite(maxConcurrent) ? maxConcurrent : 2`。`DEFAULT_AGENT_MAX_CONCURRENT=3`，且 env 校验（`IsInt`）会在启动期拒绝非数字，所以不可达；但若绕过 `validateEnv`（测试/其它 bootstrap）传非数字，入口队列用 3、护栏用 2，两者不一致 | 报告措辞改正为实际形态；或把 `: 2` 改为 `DEFAULT_AGENT_MAX_CONCURRENT`（一行） |
| **F-R1B-05** | low | `server/src/agent/model-scheduler/scheduled-fetch.ts:73-106` | 若安装兜底后有代码重新赋值 `globalThis.fetch`，guard 不会被重装（`installedOriginal !== null` 直接 return），且 `isUpstreamFetchGuardInstalled()` 只看 `installedOriginal !== null` → 返回 true 的**误报**；G13 实测替换后 `totalAcquired` 不再增长（chat 请求绕过调度器） | `ensureUpstreamFetchGuard` 检测 `globalThis.fetch` 是否仍是当前守卫，不是则重装；`isUpstreamFetchGuardInstalled` 改成 identity 校验；补一条用例 |
| **F-R1B-06** | info | `docs/evidence/workspace-agent/e0-r1b/observe-output.json` | 该证据文件是 **UTF-16LE（首字节 FF FE）**，Node `fs.readFileSync(...,'utf8')` + `JSON.parse` 直接失败；AGENTS.md 明确要求不要用带 BOM/非 UTF-8 的方式落盘 JSON。内容本身与报告 §2 一致（4 进程/8 请求/峰值 3） | 用脚本以 UTF-8 重写该文件（或保留但在报告注明编码与读取方式） |
| **F-R1B-07** | info | `server/src/generation/model-provider.service.ts:54/56/82`、`poster-generation.service.ts:161/243` | 图片端点（`/images/edits`、`/images/generations`）不在 `/chat/completions` 匹配范围内，因此不进调度器/令牌池。E0 期真实图片生成被禁止，暂无影响；E1 开放后“上游并发 ≤3”是否覆盖图片模型需要另行裁定 | 在 E1 任务书登记：图片模型是否纳入同一令牌池（若纳入，guard 匹配范围与出口都要扩） |

**没有发现缺陷、已被独立证实的点**：调度器 FIFO/clamp/排队预算/取消三分支/重试持槽/stats 纯度与桌面逐键一致；
跨进程令牌协议（形状、双向互斥、过期回收、同一目录峰值 3 / 不同目录峰值 4）；
令牌目录不可用严格 fail-closed（0 次上游）与单例默认严格；入口排队不 429；X9 改写已删。

---

## 10. 未覆盖 / 不做背书

- 真实 DeepSeek 上游、真实微信、UIA、安装包：**NOT_RUN**（E0 期禁止真实生成；t9 报告也只声明 fake 上游）。
- 报告 §2.2 的 **4 进程 / 8 请求**观测（作者脚本 `observe-concurrency.cjs`）我**未重跑**；我用等价的
  2 进程 + 不同目录对照组独立复验了同一性质（C01/C03）。作者脚本输出文件本身存在 F-R1B-06 的编码问题。
- 全量 `npx vitest run`（681 tests）、`--pool=threads` 的偶发崩溃现象：**NOT_RUN**（不在 t24 verify；
  报告已如实记录，我不为其背书）。
- 服务端 `workspace-agent` 之外的服务（frontend-reconstruct / app-assistant / store-setup）与模型出口关系
  我按“都注入同一 `AGENT_CHAT_MODEL`”做了静态核对，但未逐个跑端到端用例。

---

## 11. 复现

```powershell
# 1) 钉摘要（与 §1 对比；不一致则本文件作废）
Get-FileHash server/src/agent/model-scheduler/*.ts -Algorithm SHA256

# 2) 合同门禁（真实退出码）
cd server
npx vitest run --configLoader native --pool=forks test/model-scheduler
npx tsc -p tsconfig.json --noEmit --incremental false

# 3) 我的独立探针（只写 os.tmpdir()；从 server 目录运行，需要 server/node_modules/tsx）
npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-parity.ts          # 12 条共享用例，两侧逐键一致
npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-cross-process.ts   # 两进程峰值 3 / 不同目录对照 4
npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-guard.ts           # fail-closed、guard 语义、入口排队、引导期
npx tsx ../docs/evidence/workspace-agent/reviews/t9-probe-protocol.ts        # 令牌协议互操作 + 静态/X9 核对
# 结果 JSON 已随本文件落在 reviews/t9-*-result.json
```

最小复核点（F-R1B-01 实证）：占满 1 个槽位 400 ms，同时发一条“先起 100 ms 计时器再 fetch”的请求
（presentation/generation 的写法）→ 请求在**排队期间**失败、上游 0 次调用（G12）；
且裸 fetch 的槽位在收到 HTTP 头时释放，body 尚未读完（G03）。

---

## 12. 结论

**t9 复核结论：FAIL / needs_revision。**

- **X12 服务端侧的核心事实成立**：所有 5 个 `chat/completions` 出口都只有一条限流路径；进程内 3 槽 +
  跨进程令牌池（与桌面同一协议、同一目录）实测把上游并发压在 3（两进程 4 请求峰值 3，
  不同目录对照峰值 4）；令牌目录不可用时严格模式 0 次上游；AGENT_MAX_CONCURRENT 只作入口排队；
  X9 服务端改写已删除。这些可按本文件引用。
- **但不能记“完全同语义”**：presentation/generation 两个兜底出口的请求 timeout 从入队前计时、
  槽位在 HTTP 头到达即释放，与 §14.6-4/§14.6-5 字面不符（F-R1B-01），且报告未披露；
  静止证明（F-R1B-02）、X9 源码断言（F-R1B-03）、guard 重装（F-R1B-05）等还需收紧。
- 建议 Captain 裁定 F-R1B-01 走 (a) 扩 scope 显式接线 还是 (b) 书面接受降级 + E1 登记；其余 low/info
  随下一次返修一并处理。t8/E0-V1 在 F-R1B-01 有结论前，不要把 t9 作为“X12 全语义关闭”的证据。
