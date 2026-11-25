# `scripts/e0-verify/` — E0 独立验证器（无 UI 垂直链 + 攻击清单骨架）

> 所有者：`verifier`（E0-V1p 准备，任务 t4）；**E0 结论只由 t8（E0-V1）出具**。
> 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` **rev15** §14.2–§14.11；计划 §4 E0-V1。
> 配套文档：`docs/evidence/workspace-agent/e0-v1/plan.md`（步骤）、`…/attacks.md`（负例清单）。

## 1. 它是什么 / 不是什么

- **是**：一个只 `require` 冻结模块的独立执行器。它对已落地模块跑真实负例与前置链，
  对尚未落地的 E0 接口**如实记 `NOT_RUN`** 并写清依赖与归属。
- **不是**：实现替身、产品代码的一部分、E0 验收结论。本目录不含任何被复制过来的实现逻辑
  （没有第二份路径安全、没有第二份摘要、没有替身调度器）。
- **不写产品代码**：不改 `desktop/**`、`src/**`、`server/**`、`scripts/agent-checks/**`、
  `test/agent-*.test.cjs`、`docs/handoff/**`；不改 `package.json`。

## 2. 运行

```powershell
node scripts/e0-verify/run.cjs --mode offline              # 默认：只跑可离线用例，落报告
node scripts/e0-verify/run.cjs --mode offline --no-write   # 只看结果
node scripts/e0-verify/run.cjs --mode offline --only C07,S01  # 只跑指定用例（快速回归）
node scripts/e0-verify/run.cjs --mode real                 # 追加真实 Flash 用例（当前 NOT_RUN）
```

- 报告默认落 `docs/evidence/workspace-agent/e0-v1/run-report.json`（`--out <file>` 可改）。
- 退出码：`0` = 真实执行的用例无 FAIL（NOT_RUN/BLOCKED 允许，**不代表 E0 通过**）；
  `1` = 有 FAIL（被测实现缺陷，应出 finding 给 Captain）；`2` = 用法/环境错误。

## 3. 安全边界（硬性）

1. **临时 userData 自建自清**：只在系统 `tmpdir` 下 `mkdtemp('dsh-e0v1-')`，形状为
   `<temp>/projects/<projectId>/agent-workspace/…`；运行结束（含输出被管道截断）在 `finally` 清理，
   并以 `G02` 用例断言清理干净。
2. **绝不写项目真实 userData**：不使用仓库 `app-data/**`、不使用 `%APPDATA%/智能开店app`；
   `P01` 断言临时根与它们无交集。运行前后对 `app-data`、`generated-projects`、
   `generated-projects-test` 做「路径+大小」指纹比对，变化即 `G01` FAIL。
3. **零产品写入**：所有写入只发生在临时私有根内；伪造句柄/路径越界用例同时断言
   “目标位置指纹不变”（零落盘）。
4. **证据脱敏**：报告里不出现仓库绝对路径、临时绝对路径；不记录图片 base64、prompt、Key。

## 4. 目录结构

```text
scripts/e0-verify/
  run.cjs                  # CLI：装配用例 → 执行 → 守卫 → 落报告（PASS/FAIL/NOT_RUN/BLOCKED）
  readiness.cjs            # X1–X12 就绪度矩阵（只陈述事实，不关闭任何 X）
  lib/env.cjs              # 临时 userData 创建/清理、目录指纹、路径守卫、脱敏
  lib/frozen.cjs           # 冻结接口登记表：路径/导出面/所属任务（只 require）
  lib/harness.cjs          # 用例执行骨架：requires 不满足 → NOT_RUN；断言失败 → FAIL
  chains/preconditions.cjs # P01–P08：B1/B2 前置链（真实可跑）
  chains/coordinator.cjs   # C01–C17：对 t1 Coordinator 的桌面侧执行断言（真实可跑；C16 为真实检查链，零替身）
  chains/workspace-w2.cjs  # W01–W17：t5/E0-W2 复核（X4 检查目标 / X5 8 页 / X6 bundle / X7 证据绑定 / 句柄 / direct）
  chains/scheduler.cjs     # S01–S06：对 t2 ModelCallScheduler 的执行断言（虚拟时钟 + 真子进程跨进程峰值）
  lib/scheduler-child.cjs  # S04 用的跨进程观测子进程（stdio 忽略、结果落文件）
  chains/vertical.cjs      # V01–V14：E0-V1 无 UI 垂直链（声明 + 断言口径）
  chains/real-flash.cjs    # R01–R07：真实 Flash/UIA（仅在 --mode real 且接口就绪时执行）
  attacks/b1-b2.cjs        # A11O/A13/A14/A16–A21O/A23–A25：对已落地模块的真实负例
  attacks/e0.cjs           # A01–A12/A15/A21–A22/A26–A48/A49：需 E0 新接口的负例（当前 NOT_RUN）
```

**替身纪律（C 组）**：注入 `checks` 时 `definitions`（`checkId→subject` 平台表）必须来自真实 `checks.cjs`，
只允许替换 `runCheck` 的“执行子进程”这一层；C16 更进一步**完全不用替身**（真实注册表 + 真实子进程检查）。
把 `definitions` 一起造假的用例一律视为无效用例（曾导致 4 条假 FAIL，见 `incremental-w1r1a.md` finding F5）。

## 5. 状态词口径

| 状态 | 含义 | 谁来改 |
|---|---|---|
| `PASS` | 用例真实执行、断言成立 | 执行结果 |
| `FAIL` | 用例真实执行、断言不成立 → 实现缺陷 | 出 finding 给 Captain |
| `BLOCKED` | 环境不可用（沙箱 EPERM、工具缺失），用例未真正执行 | 换环境重跑 |
| `NOT_RUN` | 依赖的冻结接口未落地，或本阶段只声明不执行 | 实现落地后由 t8 补 `run()` |

**禁止**：为了让报告好看而把 `NOT_RUN` 改成 `PASS`；用替身模块跑绿；把 mock 结果当真实模型/微信证据。

## 6. 给 t8（E0-V1）的扩展规则

1. 新增用例只在 `chains/**`、`attacks/**` 里加，`id` 与 `docs/evidence/workspace-agent/e0-v1/attacks.md` 一一对应；
   **已有 id 不复用、不重排**（其他成员与历史报告都按 id 引用），需要新判据就新增 id（如 rev15 §14.12-1 的越级 adopt 落在 A49）。
2. 用例里的 `requires` 必须是 `lib/frozen.cjs` 已登记的冻结接口名；需要新接口先在此登记（写清 rev 与 owner）。
3. 用例只调用冻结模块的公开导出，**不得**在验证器里重建路径/摘要/并发/证据逻辑。
4. 断言必须能区分“拒绝”和“错误原因”：优先 `assertCode`/`assertRejected`（码集合取 rev15 §14.9），
   不要只断言 `ok===false`。
5. 每条 X 的关闭证据 = 本脚本对应用例 PASS + 代码位置 + 复核记录；单靠 PASS 数字不算关闭。
