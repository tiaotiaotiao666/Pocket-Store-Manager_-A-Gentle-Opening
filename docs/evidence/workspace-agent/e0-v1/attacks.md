# E0-V1 负例清单（攻击清单）

> 任务：`t4 / E0-V1p`（verifier）。契约：rev15 §14.2–§14.9 + 计划 §1（X1–X12）、§4（E0-V1）。
> 执行器：`scripts/e0-verify/`（`attacks/b1-b2.cjs` = 今天可跑；`attacks/e0.cjs` = 需 E0 新接口）。
> 步骤计划见同目录 [`plan.md`](./plan.md)。**本文件不是 verdict**：条目状态是“当前能否执行”，不是“是否通过”。

## 0. 通用判定规则

1. **拒绝必须带码**：期望码取自 rev15 §14.9、§14.12 与既有 `AGENT_*` 表；只断言 `ok===false` 不算通过。
2. **“零落盘”必须可测**：写入类攻击一律在攻击前后对目标目录做「路径+字节数」指纹比对，指纹变化即攻击成功。
3. **检查类攻击的判据**是“检查的 `--root`/`treeDigest`/`subjectKind` 指向哪棵树”，不是“检查脚本退出码”。
4. **不得用替身**：所有攻击只调用冻结模块公开导出；没有接口就记 `NOT_RUN`，不写 mock 冒充实测。
5. **adopt 失败三分（rev15 §14.12-1）**：`state ≠ submitted` → `AGENT_ADOPTION_FAILED` + issue `NOT_SUBMITTED`；
   已 submitted 但证据摘要不符 → `AGENT_EVIDENCE_STALE`；运行时 `BLOCKED/NOT_RUN` 未确认 → `AGENT_PARTIAL_CONFIRM_REQUIRED`。
   **三者不得互相顶替**，断言必须比到具体码 + issue code。
6. 状态词：`PASS`（今天真实执行且断言成立）/ `NOT_RUN`（接口或执行体未就绪）/ `BLOCKED`（环境不可用）/ `FAIL`（真实执行但不成立 → 出 finding）。

---

## 1. A 组：submit / adopt 证据绑定（X7）

> 编号注记：Captain 在 rev15 §14.12-1 里提到的“A10「二者之一」记录”，指的就是**越级 adopt** 这条
> （原 plan §8 Q1 的指代）。为保持既有 id 稳定（脚本 / run-report / 其他成员引用），该条现落在 **A49**，
> **A10 仍是“用 Base 冒充候选检查”**；Q1 三分判据已写入 A49 / A07 / A08 / A09。

| ID | 攻击输入 | 期望（码/状态/零落盘） | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A01 | 起 run→写候选→**不 derive bundle** 直接 `submitAttempt` | `AGENT_STATIC_GATE_FAILED`；attempt 状态非 `submitted`；磁盘无 submitted 证据 | 复算 attempt 树 & 状态文件前后一致 | X6,X7 | `e0.cjs` | NOT_RUN（t5） |
| A02 | 只写候选、**不跑 source.check** 就 submit | `AGENT_STATIC_GATE_FAILED` | 同上；且“模型说检查过了”不影响 | X4,X7 | `e0.cjs` | NOT_RUN（t1/t5） |
| A03 | 跑了 source.check=PASS、**不跑 composer.dry-run** 就 submit | `AGENT_STATIC_GATE_FAILED` | 缺 dry-run 证据 = 缺证据 | X4,X7 | `e0.cjs` | NOT_RUN（t1/t5） |
| A04 | 手写 `attempt/verification/*.json`（伪造 PASS），再 submit | `AGENT_STATIC_GATE_FAILED` 或 `AGENT_EVIDENCE_STALE` | 平台重算证据（treeDigest/subjectKind/attemptId/at/内容摘要），手写记录不得放行 | X7 | `e0.cjs` | NOT_RUN（t5） |
| A05 | dry-run 导出自 tree1，写候选使树变 tree2，再 submit | `AGENT_EVIDENCE_STALE` | 比 `exportTreeDigest` 与当前 `treeDigest`，不得只比 checkId 字符串 | X7 | `e0.cjs` | NOT_RUN |
| A06 | 提交成功后改文件使 treeDigest 变化，再用旧证据 submit | `AGENT_EVIDENCE_STALE`（若已 submitted 则写入先被 `AGENT_ATTEMPT_IMMUTABLE` 拦） | 两条路径都不得放行 | X3,X7 | `e0.cjs` | NOT_RUN |
| A07 | adopt 前改写证据里的 `treeDigest`（或让工作树与证据不一致） | `AGENT_EVIDENCE_STALE`（已 submitted 分支）；不生成新版本目录；指针不变 | `versions/` 目录集合与 `project.json` 前后一致 | X7 | `e0.cjs` | NOT_RUN（t5） |
| A08 | 提交后篡改 `attempt/verification/dry-run/**` 再 adopt | `AGENT_EVIDENCE_STALE` | 重算 `exportTreeDigest` 与记录比对；不清洗、不回落 | X7 | `e0.cjs` | NOT_RUN（t5） |
| A09 | runtime 证据为 `BLOCKED`/`NOT_RUN`（微信不可用）、未 `partialConfirmed` 就 adopt | `AGENT_PARTIAL_CONFIRM_REQUIRED`；显式 `partialConfirmed:true` 时才可 adopt 且结果仍标 partial | `version.json.verification.runtime` 四态与确认标记 | X7 | `e0.cjs` | NOT_RUN |
| A49 | **越级 adopt**：attempt 未 submitted（从未提交 / 已取消 / 已被取代）就 adopt | `AGENT_ADOPTION_FAILED` + issue code `NOT_SUBMITTED`；**不得**用 `AGENT_EVIDENCE_STALE`/`AGENT_PARTIAL_CONFIRM_REQUIRED` 顶替；不生成新版本、`versions/` 目录集合不变 | 比到具体码 + `issues[].code`；`versions/` 目录集合与指针前后一致 | X7 | `e0.cjs` | NOT_RUN（t1/t5，rev15 §14.12-1 新增判据） |

## 2. B 组：检查目标必须落在 attempt / 派生导出树（X4）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A10 | 用 `templates/base/ordering-base/1.0.0/src` 当 root 跑 `source.check` | 平台拒绝外部 root（`AGENT_PAYLOAD_INVALID`）；若仍检查 Base → 判 **FAIL** | 证据 `subjectKind` 必须是 `attempt`，`treeDigest` 必须等于 attempt 摘要 | X4 | `e0.cjs` | NOT_RUN（t5） |
| A11 | 用 `versions/<current>/source` 冒充候选跑 `source.check` | 同上；摘要等于版本摘要即 FAIL | 同上 | X4 | `e0.cjs` | NOT_RUN（t5） |
| A12 | 用仓库 `miniprogram/` 镜像跑 `mini.check` 冒充派生导出树 | 无派生根 → `AGENT_CHECK_UNKNOWN`；root 指向镜像 → 拒绝 | 镜像结果不得进入候选门禁 | X4 | `e0.cjs` | NOT_RUN（t5） |
| A11O | **现状观察**：用注入 runner 捕获 `source.check` / `composer.dry-run` 的实际 argv | 记录 `--root` 指向（期望：attempt/candidate） | 实测：`source.check` 不带 `--root`（查仓库能力快照），`composer.dry-run` 的 `--root` = 已采用版本 source | X4 | `b1-b2.cjs` | **NOT_RUN（观察成立：X4 未关闭）** |
| A13 | `run_check` 传 `{root}`/`{path}`/`{command}`/`{shell}`/`{cwd}`/`{env}` | `AGENT_PAYLOAD_INVALID`；不触发子进程 | runner 调用计数必须为 0 | X4 | `b1-b2.cjs` | **PASS**（6 类参数全拒，runnerCalls=0） |
| A14 | 未知/变形 checkId（`source-check`、`composer.dryrun`、`shell`、`../scripts/x.cjs`） | `AGENT_CHECK_UNKNOWN`；不回落“等价命令” | runner 调用计数必须为 0 | X4 | `b1-b2.cjs` | **PASS**（5 个全拒） |
| A15 | 证据缺字段（`treeDigest`/`subjectKind`/`attemptId`/`at`/`issues`）或 dry-run 导出树写到 `attempt/verification/dry-run/` 之外 | 不完整证据不参与门禁；越界导出点拒绝且零落盘 | 指纹比对 attempt 与仓库 `templates/` | X4,X7 | `e0.cjs` | NOT_RUN（t5） |

## 3. C 组：句柄 / 路径 / 越权（X1/X3）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A16 | 伪造 attempt 句柄，把 `candidateDir` 指到 `versions/v1/source` 后 `writeFile` | 拒绝（`AGENT_WORKSPACE_INVALID`/`AGENT_PATH_*`）；`versions/v1` 指纹不变 | 目录指纹 | X3 | `b1-b2.cjs` | **PASS**（实测码 `AGENT_WORKSPACE_INVALID`） |
| A17 | `../escape-probe.txt`、`pages/../../escape-probe.txt` | `AGENT_PATH_INVALID`；临时根内无该文件 | 全根名扫描 | X3 | `b1-b2.cjs` | **PASS** |
| A18 | `C:/Windows/win.ini`、`/etc/passwd`、`\\server\share\x.txt` | `AGENT_PATH_INVALID` | 三种输入全拒 | X3 | `b1-b2.cjs` | **PASS** |
| A19 | 带故意错误的 `expectedBaseSha256` 覆盖写 | `AGENT_BASE_DIGEST_MISMATCH`；内容不变 | 读回内容比对 | X3 | `b1-b2.cjs` | **PASS** |
| A20 | `createAttempt({runId:'frun-../../x'})` | `AGENT_ID_INVALID`；`runs/` 不新增目录 | 目录清单 | X3 | `b1-b2.cjs` | **PASS** |
| A21 | 跨项目句柄（A 项目 handle 指向 B 项目树 / 伪造 `projectId` 与私有根不一致） | **Coordinator 层必须拒绝** `AGENT_PROJECT_MISMATCH` 且零落盘（rev15 §14.12-2 明确由 t5 在句柄校验层补 `projectId ↔ 私有根` 一致性断言） | 两个项目树指纹均不变；判据只认 Coordinator 入口 | X1,X3 | `e0.cjs` | NOT_RUN（t1 语义待 t8 + t5 补断言） |
| A21O | **现状观察**：把 handle 的 `projectId` 改成另一个项目后直接调 B1 `writeFile` | **不判 FAIL**（rev15 §14.12-2）：B1 直调属非产品链，跨项目拒绝归 Coordinator §14.2-5 | 只登记“B1 不做该一致性校验 → 必须由 Coordinator 兜底” | X1,X3 | `b1-b2.cjs` | **NOT_RUN（观察成立，不构成 FAIL）** |
| A22 | 跨 run / 跨 turn 句柄（`runId`/`turnId` 混用或编造） | `AGENT_ATTEMPT_NOT_FOUND`；不创建任何目录 | 目录清单 | X3 | `e0.cjs` | NOT_RUN |
| A23 | 在 `candidate/` 内建 junction/symlink 指向外部，再读写 | `AGENT_PATH_LINK`（读写法都拒）；外部无落盘；环境禁止建链则 `BLOCKED` | 指纹 + 外部目录扫描 | X3 | `b1-b2.cjs` | **PASS**（实测码 `AGENT_PATH_LINK`） |

## 4. D 组：重开与导出身份（X11/X7）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A24 | 直接篡改 `versions/<current>/source/app.json` 后 `reopenProject` | `AGENT_VERSION_CONFLICT`；`currentVersionId` 不回退、不静默采用磁盘内容 | 指针读取 | X11 | `b1-b2.cjs` | **PASS**（恢复后 reopen 回绿） |
| A25 | 篡改当前版本 source 后 `verifyExportIdentity` | `AGENT_EXPORT_IDENTITY_MISMATCH`（不给导出根）；恢复后重新 PASS | 干净状态先过一次 | X7 | `b1-b2.cjs` | **PASS** |

## 5. E 组：attempt 不可变与生命周期（X3/X7）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A26 | submit 成功后继续 `write_files`/`delete_files` 同一 attempt | `AGENT_ATTEMPT_IMMUTABLE`；attempt 摘要与 submitted 证据不变 | 指纹 | X3,X7 | `e0.cjs` | NOT_RUN |
| A27 | submit 成功后再次 submit | `AGENT_RUN_ALREADY_SUBMITTED`；不产生第二候选身份 | 候选 id/摘要不变 | X7 | `e0.cjs` | NOT_RUN |
| A28 | repair 时仍写 `attempt-1`（覆盖已提交候选） | 拒绝；修复必须落 `attempt-2` | 两个 attempt 摘要可追溯 | X3,X7 | `e0.cjs` | NOT_RUN |
| A29 | 工具写入 `subject={kind:"version"}`（改 base/已采用版本） | `AGENT_TOOL_NOT_ALLOWED`/`AGENT_PAYLOAD_INVALID`；读 version 仍允许 | 版本目录指纹 | X3 | `e0.cjs` | NOT_RUN |

## 6. F 组：工具白名单（X1/X3/X6）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A30 | 模型调用 `derive_source_bundle`/`adopt_attempt`/`attach_image_asset`（含大小写/前缀变体） | `AGENT_TOOL_NOT_ALLOWED` | 三个名字不在 `MODEL_TOOL_NAMES`，只在 `PLATFORM_ONLY_TOOL_NAMES` | X6,X7 | `e0.cjs` | NOT_RUN（t8 执行） |
| A31 | 模型给出未登记工具名（`write_file` 单数、`shell`、`exec`、`child_process`） | `AGENT_TOOL_NOT_ALLOWED`；不存在通用命令入口 | 工具表固定 11 个 | X1,X3 | `e0.cjs` | NOT_RUN |

## 7. G 组：截断与预算（X8）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A32 | 上游 `finish_reason=length` 且带 `tool_calls` | truncated → **本批工具不执行**；返回 `output_truncated`（`AGENT_OUTPUT_TRUNCATED`）；attempt 摘要不变；只允许定向重试 | 工具执行计数=0 + 指纹 | X8 | `e0.cjs` | NOT_RUN（t6） |
| A33 | 空正文 + `finish_reason=length`（带图长回答） | 记 truncated；不得抛“无响应”，不得把空正文当成功写盘 | 返回体字段 + 指纹 | X8 | `e0.cjs` | NOT_RUN（t6） |
| A34 | `maxTokens` 请求 1200（旧回退值）或 > 8000 | 不得静默回退 1200；>8000 明确报错；源码编辑默认 6000、硬上限 8000 | 请求体断言（fake upstream 捕获） | X8 | `e0.cjs` | NOT_RUN（t6） |

## 8. H 组：取消与迟到（X8/X12）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A35 | 起 3 个上游请求后 cancel | 取消后不再发起上游；排队项出队；`scheduler.stats()` 的 active/queued 归零 | 上游调用计数器不再增长 | X12 | `e0.cjs` | NOT_RUN（t2 模块已在，执行待 t8） |
| A36 | 取消后让迟到的工具结果返回 | 迟到工具不落盘；返回 `AGENT_CANCELLED`/`AGENT_ATTEMPT_IMMUTABLE` | attempt 指纹不变 | X8,X12 | `e0.cjs` | NOT_RUN |
| A37 | cancel 三态：运行中 → 停止后 → 已完成后再 cancel | `requested` → `cancelled` → `too-late`（`cancelled:false`，UI 不得显示失败） | 状态序列 | X12 | `e0.cjs` | NOT_RUN |

## 9. I 组：上游并发 ≤3（X12）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A38 | 同一时刻发起 5 个上游请求 | 峰值并发恰好 3；最大排队 2；5 个最终都成功 | fake upstream 计数峰值 + `stats().maxQueueLength` | X12 | `e0.cjs` | NOT_RUN（t8，模块已落地） |
| A39 | 让第 4 个请求排队 > 180s | `MODEL_QUEUE_TIMEOUT`（不是上游超时/429）；排队 179s 后拿到槽位的请求仍有完整请求超时 | 计时 + 错误码 | X12 | `e0.cjs` | NOT_RUN |
| A40 | 1 慢请求占槽 + 4 排队；取消 1 个排队项 / 取消运行中任务 | 取消排队项不减少已执行数；取消运行中任务释放槽位可被立即复用 | `totalAcquired` 与并发峰值 | X12 | `e0.cjs` | NOT_RUN |
| A41 | 让请求得到 429/5xx 并重试 | 任意时刻并发 ≤3；重试结束（成功或失败）释放槽位 | 峰值计数 | X12 | `e0.cjs` | NOT_RUN |
| A42 | `MODEL_MAX_CONCURRENT=4` 或非法值 | clamp 到 3，且有可见警告（`MODEL_CONFIG_INVALID` 或等价） | `stats().maxConcurrent===3` + warnings | X12 | `e0.cjs` | NOT_RUN |

## 10. J 组：图片与视觉（X2）

| ID | 攻击输入 | 期望 | 判据 | X | 脚本 | 现状 |
|---|---|---|---|---|---|---|
| A43 | assetId 不存在 / 魔数不符 / 解码失败 | `AGENT_IMAGE_INVALID`；不得把 assetId 字符串当视觉输入、不得静默走纯文本 | 错误码 + 请求体无 image part | X2 | `e0.cjs` | NOT_RUN（t7） |
| A44 | 单图 > 2 MiB（真实字节） | `AGENT_IMAGE_INVALID`；不裁剪、不压缩后静默通过 | 字节长度 | X2 | `e0.cjs` | NOT_RUN |
| A45 | GIF/BMP/SVG，或 `.png` 扩展名但 GIF 魔数 | `AGENT_IMAGE_INVALID`（魔数 + MIME 双检） | 魔数读取 | X2 | `e0.cjs` | NOT_RUN |
| A46 | 输入是路径 / base64 / data URL 文本而非 assetId | 拒绝；不读取该路径 | 文件系统访问计数 | X2 | `e0.cjs` | NOT_RUN |
| A47 | 模型无视觉能力（视觉探测失败） | `AGENT_VISION_UNAVAILABLE` 或 needs-input；不得改用纯文本生成当完成 | 错误码/状态 | X2 | `e0.cjs` | NOT_RUN（t6/t7） |
| A48 | 跑完整轮后扫描 `runs/**`、trace、日志 | 不得出现 `data:image`、长 base64 串、prompt 原文、Key；图片只在内存 | 全量文本扫描 | X2 | `e0.cjs` | NOT_RUN |

---

## 11. 任务必含项 → 条目对照（自检）

| 任务要求 | 覆盖条目 |
|---|---|
| 未 derive bundle / 未 source.check / 未 composer.dry-run 就 submit → `AGENT_STATIC_GATE_FAILED` | A01 / A02 / A03（+A04 伪造证据） |
| 用旧 treeDigest 的证据 submit/adopt → `AGENT_EVIDENCE_STALE` | A05 / A06 / A07 / A08 |
| 越级 adopt（未 submitted）→ `AGENT_ADOPTION_FAILED` + issue `NOT_SUBMITTED` | **A49**（rev15 §14.12-1；Captain 裁定中所称“A10 记录”） |
| 用 Base 或 miniprogram 镜像冒充候选检查 → 判 FAIL | A10 / A11 / A12（+A11O 现状） |
| 跨项目 / 跨 run / 跨 turn / 伪造 attempt 句柄 → 拒绝且零落盘 | A16 / A21 / A22（+A20 / A21O / A23） |
| submitted 后再写同一 attempt → `AGENT_ATTEMPT_IMMUTABLE` | A26（+A27 / A28） |
| 截断（finish=length）→ 不回放 tool_calls、返回 `output_truncated` | A32 / A33 |
| 5 个并发上游请求 → 第 4 个排队（≤3） | A38（+A39–A42） |
| 缺图/坏图/超 2MiB/非 PNG-JPEG-WebP → `AGENT_IMAGE_INVALID`；无视觉 → `AGENT_VISION_UNAVAILABLE` | A43 / A44 / A45 / A47（+A46） |
| 取消后不再发起上游请求；迟到工具不落盘 | A35 / A36（+A37） |
| partial（微信 BLOCKED）未确认 adopt → `AGENT_PARTIAL_CONFIRM_REQUIRED` | A09 |

合计 **51 条**（A01–A49 共 49 条攻击 + 2 条现状观察 A11O/A21O）。

## 12. 当前执行状态（`node scripts/e0-verify/run.cjs --mode offline`，2026-11-25 01:0x）

- 前置/Coordinator/Scheduler/垂直/真实/攻击/守卫用例合计 **104 条：PASS 42 / FAIL 0 / NOT_RUN 62 / BLOCKED 0**
  （退出码 0；`e0Verdict=NOT_RUN`，准备阶段固定不判 PASS）。
- 今天真实可跑并 PASS 的攻击：**A13、A14、A16、A17、A18、A19、A20、A23、A24、A25**。
- 今天真实可跑并 PASS 的桌面侧断言（E0-V1a 新增）：**C01–C17**（Coordinator）、**S01–S06**（调度器）、**P01–P08**、**G01/G03**。
  明细与 findings 见 [`incremental-w1r1a.md`](incremental-w1r1a.md)。
- 今天跑不了的攻击全部因 E0 新接口未落地或执行体未写（见 `plan.md` §6 的归属表），
  其中 **A38–A42（并发）已由 S01–S06 桌面侧覆盖部分判据**；
  **A01–A03/A10–A12/A26–A48 仍需真实模型/direct/图片/IPC**（t5/t6/t7/t8）。
- 现状观察两条（A11O/A21O）不是失败，是**事实登记**：检查未绑定 attempt（X4 未关闭，已登记 §14.12-5）、
  B1 直调不校验 `handle.projectId` 一致性（按 §14.12-2 由 Coordinator 兜底，**不判 FAIL**）。
  A21 的“Coordinator 层拒绝”判据已由 **C10** 实测命中（`AGENT_PROJECT_MISMATCH`/`AGENT_ATTEMPT_NOT_FOUND`/`AGENT_RUN_NOT_FOUND`，零落盘）。
- rev15 §14.12 带来的判据变更已落地：A49 新增（Q1 三分）、A21 升级为“Coordinator 层必须拒绝”（C10 实测）、
  X9 判据改为“桌面侧已删 + 服务端副本已删/不可达（t9 E0-R1b）”、X12 记“桌面侧已关闭（服务端待 t9，S01–S06 已复验）”。
