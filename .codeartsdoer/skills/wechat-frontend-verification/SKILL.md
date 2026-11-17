---
name: wechat-frontend-verification
description: 当候选 FrontendPack 已物化，需要对它做 Composer P0–P6 dry-run、mini:check、产物一致性检查、真实微信编译/截图、参考图可观察项对照，并决定能否采用或最多两轮受控修复时使用。该技能强制 PASS/FAIL/BLOCKED/NOT_RUN 如实口径，绝不伪造通过、不用 React 截图替代微信截图、不做像素百分比承诺；只回灌结构化 issues，两轮失败即停止并保留当前版本。
---

# 微信小程序候选前端验证 Skill（dry-run → 真实微信验证 → 截图对照 → 最多 2 轮修复）

## 触发条件

- 候选已由 `wechat-frontend-pack-authoring` 物化成私有 attempt，用户要看验证结论/能否采用。
- 需要跑本地 dry-run（Composer P0–P6 + `mini:check` + `output-consistency` + 可观察项）。
- 需要真实微信开发者工具编译、页面截图、关键动作回归。
- 出现结构化失败，需要判断是否值得自动修复（最多 2 轮）。
- 实现或评审 `desktop/frontend-reconstruct/{dry-run,compare,repair,verify-runtime}.cjs`、`scripts/frontend-verify.cjs`。

不适用：

- 还没物化候选（先走 pack-authoring）。
- 工具不可用却想“先写通过”：只能 `BLOCKED`/`NOT_RUN`。
- 想改 Base、全局 Registry、`templates/`、`miniprogram/` 或放宽两轮上限。
- 想用 React 预览截图、模型自述或人工“看着差不多”替代微信真实证据。

## 必读文件

- `docs/handoff/图片驱动前端重构-Flash实施计划.md` §2（状态机）、§5.4、§7-P3、§8、§9
- `docs/frontend-reconstruct-contract.md` §9（状态机/repair 上限）、§10、§13、§14
- `desktop/frontend-reconstruct/README.md`（P3 结论口径与固定命令）
- `desktop/frontend-reconstruct/dry-run.cjs`（阶段、code、issue 结构）
- `desktop/frontend-reconstruct/compare.cjs`（可观察项与 `not_checked`/`not_run`）
- `desktop/frontend-reconstruct/repair.cjs`（2 轮、结构化 issues、`adoption`）
- `desktop/frontend-reconstruct/verify-runtime.cjs`（固定脚本、PASS/FAIL/BLOCKED/NOT_RUN）
- `scripts/frontend-verify.cjs`（固定 CLI、退出码 0/1/2/3）
- `scripts/wechat-devtools-run.cjs`、`scripts/validate-miniprogram.cjs`
- `scripts/composer/index.cjs`（`compose()` 内含 P0–P6 与 `verifyOutput`）
- `desktop/output-consistency.cjs`（候选产物与 Lock/Report 一致性）
- `docs/w5-微信小程序编译运行验证.md`（真实 CL 环境与截图口径）

## 输入

固定输入是**已提交的 attempt 目录**，它必须包含 `attempt.json`、`candidate/`、`overlay/`：

```text
<userDataDir>/projects/<projectId>/frontend-runs/<runId>/attempts/attempt-<n>/
├─ attempt.json          # candidate.id/version、attempt 序号、文件清单、摘要
├─ candidate/            # 候选 FrontendPack（只读输入）
└─ overlay/              # 私有 Registry overlay（必须显式使用，禁止回落到全局 Registry）
```

固定本地命令（不接受 `--command`/shell 等任意执行入口）：

```powershell
node scripts/frontend-verify.cjs --attempt <attemptDir> `
  [--draft <draft.json>] [--plan <plan.json>] [--requirement <requirement.json>] `
  [--runtime] [--auto-port 9420] [--timeout-ms 600000] `
  [--evidence <dir>] [--json <evidence.json>]
```

程序化入口：本地执行模块是 `desktop/frontend-reconstruct/index.cjs`（`dryRunCandidate`/`runRepairLoop`/`verifyRuntimeCandidate`/`compareObservable`）；桌面 IPC 只暴露语义 API（`frontend:analyze`/`build-candidate`/`validate-candidate`/`verify-candidate`/`adopt-candidate`/`discard-candidate`/`cancel-run`），不提供通用 read/write/exec。

运行约束：

- `privateRoot` = 本次 `attemptDir`；证据/截图只能写其下 `verification/dry-run[-n]/`、`verification/runtime[-n]/`。
- `projectDir` 必须是仓库外、规范的小程序工程（含 `app.json`），否则 `BLOCKED`。
- 微信 CLI 只允许 `scripts/wechat-devtools-run.cjs`，参数由包装层固定拼装；超时默认 600000ms、上限 1800000ms。
- 取消/超时/证据缺失必须如实反映，不产生“通过”。

可观察项对照清单（只检查看得见、可复现的项）：

1. Draft 分区顺序在生成 WXML 中同序命中；
2. 每个 component / button 真的渲染；
3. button 绑定的是真实 Base 控制器 handler；
4. 每个 slot 的四段 fallback 锚点完整（缺 → `SLOT_ANCHOR_MISSING` + DSL path）；
5. Draft 用到的颜色 token 在 Base 主题 CSS 变量中真实定义；
6. 每页至少一个可见节点（不是空壳）；
7. 关键动作不回归：运行时报告里的真实点击链路（如 `home.goMenu` 开始点餐、`menu.onCheckout` 结算提交）必须 PASS；没跑就是 `not_run`；
8. 密度/溢出不做像素测量，如实标 `not_checked` 并写原因。

## 输出（含 schema 示例）

dry-run 统一结果（`frontend-dry-run.v1`）：

```json
{
  "ok": false,
  "code": "SLOT_ANCHOR_MISSING",
  "summary": "dry-run 未通过；candidate=fr-1a2b3c4d5e6f@1.0.0；ComposerP0-P6=12 个文件；mini:check=通过；consistency=通过；1 个 slot 锚点缺失",
  "details": {
    "stage": "observable",
    "materialize": { "attempt": 2, "candidateId": "fr-1a2b3c4d5e6f", "candidateVersion": "1.0.0" },
    "compose": { "outputRelativePath": "verification/dry-run/candidate", "treeSha256": "sha256:…", "fileCount": 12 },
    "mini": { "pages": 2, "components": 10, "errors": 0 },
    "consistency": { "ok": true, "problems": 0 },
    "observable": {
      "ok": false,
      "counts": { "total": 24, "pass": 23, "fail": 1, "notRun": 0, "notChecked": 0, "notApplicable": 0 }
    }
  },
  "candidateId": "fr-1a2b3c4d5e6f",
  "revision": 2,
  "artifacts": { "attemptDir": "…", "verificationDir": "…/verification/dry-run", "outputDir": "…/verification/dry-run/candidate" },
  "issues": [
    {
      "code": "SLOT_ANCHOR_MISSING",
      "path": "$.pages[0].nodes[1].slotId",
      "field": null,
      "file": "pages/home/index.wxml",
      "message": "插槽 fallback 锚点不完整：home-hero",
      "severity": "error",
      "source": "observable"
    }
  ],
  "checks": [
    { "id": "materialize", "status": "pass", "message": "物化 attempt 2 通过" },
    { "id": "compose", "status": "pass", "message": "Composer P0–P6 通过" },
    { "id": "mini-check", "status": "pass", "message": "mini:check 通过" },
    { "id": "consistency", "status": "pass", "message": "产物与 Lock/报告一致（12 个文件）" },
    { "id": "observable", "status": "fail", "message": "1 个 slot 锚点缺失" }
  ]
}
```

dry-run 阶段固定为 `materialize → compose → mini-check → consistency → observable`；code 取自 `CODES`（`DRY_RUN_OK`、`DRY_RUN_INPUT_INVALID`、`DRY_RUN_CANCELLED`、`DRY_RUN_MATERIALIZE_FAILED`、`DRY_RUN_FAILED`、`MINI_CHECK_FAILED`、`CONSISTENCY_FAILED`、`DRY_RUN_OUTPUT_REJECTED`），缺锚点时额外可能是 `SLOT_ANCHOR_MISSING`。无 Draft 时可观察项明确 `not_run`。

微信运行时结果（`frontend-runtime.v1`）：

```json
{
  "ok": false,
  "status": "BLOCKED",
  "code": "RUNTIME_TOOL_MISSING",
  "summary": "微信运行时 BLOCKED：本机未找到开发者工具 cli.bat（可用 WX_CLI_PATH 指定）",
  "details": { "blockedReason": "本机未找到开发者工具 cli.bat（可用 WX_CLI_PATH 指定）", "toolchain": "unavailable" },
  "artifacts": { "evidencePath": "…/verification/runtime/frontend-runtime.json", "screenshots": [] }
}
```

状态口径（严格）：

| status | 条件 | `ok` |
| --- | --- | --- |
| `PASS` | 固定脚本真实执行、证据 status=PASS、退出码 0，且报告中的页面（若有）全部 PASS | true |
| `FAIL` | 证据/退出码显示真实失败（如页面未通过、交互失败） | false |
| `BLOCKED` | CLI/脚本缺失、输入非法、超时、脚本崩溃、证据缺失、证据与退出码矛盾、声称 PASS 但有页面未过 | false |
| `NOT_RUN` | 取消、或 dry-run 未通过而未启动运行时 | false |

截图清单只返回 `shotsDir` 内文件的相对名 + 字节数，不返回图片正文；blocked 文本会脱敏本机路径。

退出码（`scripts/frontend-verify.cjs`）：

| 退出码 | 含义 |
| --- | --- |
| 0 | dry-run 通过（runtime 未执行或 PASS） |
| 1 | dry-run 失败 / attempt 不可用 |
| 2 | 微信运行时 FAIL |
| 3 | 微信运行时 BLOCKED 或 NOT_RUN（工具缺失也是 3，绝不伪装通过） |

修复回灌只允许结构化最小集：

```json
{
  "contractVersion": "frontend-repair.v1",
  "runId": "frun-0001",
  "revision": 2,
  "round": 1,
  "issues": [{ "path": "$.pages[0].nodes[1]", "code": "SLOT_ANCHOR_MISSING" }],
  "previousDraft": { "…": "已通过 P2 schema 校验、≤32 KiB 的完整 Draft" }
}
```

repair issue code 白名单：`DRAFT_SCHEMA_INVALID`、`DRAFT_UNKNOWN_COMPONENT`、`DRAFT_UNKNOWN_EVENT`、`DRAFT_UNKNOWN_DATA_PATH`、`DRAFT_STYLE_INVALID`、`DRAFT_PAGE_JSON_INVALID`、`SLOT_ANCHOR_MISSING`、`DRY_RUN_FAILED`、`MINI_CHECK_FAILED`、`CONSISTENCY_FAILED`。issues 1–8 条；不可定位到 DSL path 的故障不自动修复（`REPAIR_NOT_APPLICABLE`）。修复成功 `adoption:'candidate'` 只表示“可进入采用流程”；任何失败/取消/超限 `adoption:'none'`，`keptDraft` 永远是进入本轮前的版本。

## 禁止项

1. **不伪造证据**：没跑成微信运行时不得写 `PASS`；CLI 缺失、超时、脚本崩溃、证据缺失、证据矛盾一律 `BLOCKED`；取消是 `NOT_RUN`。
2. **不用预览替代**：React 预览/静态截图不是微信运行时证据；不得把“看着差不多”写成通过。
3. **不做像素承诺**：不输出“相似度 97%”“像素 100%”等无依据分数；只报分区顺序/主题/组件/按钮/锚点/空白/关键动作等可观察项，密度与溢出标 `not_checked`。
4. **不执行模型命令**：只跑固定 `scripts/wechat-devtools-run.cjs`；拒绝自定义脚本/命令/shell/参数。
5. **不修 Base/全局 Registry**：修复只改 Draft；不改 `templates/**`、`miniprogram/**`、Base 页面 JS、服务层或全局 Registry；不重冻结。
6. **不放宽修复上限**：严格 2 轮，第 3 次 `REPAIR_LIMIT_EXCEEDED`；不得循环重试到成功。
7. **不回灌大文本**：只回灌 `{path,code}` + 有界 `previousDraft`；不上传日志、堆栈、绝对路径、源码、图片或原始模型响应。
8. **不静默回落**：dry-run 缺 `overlayRegistryRoot` 或指向全局 Registry → `DRY_RUN_INPUT_INVALID`；禁止用 Base 冒充候选验证。
9. **不覆盖旧版本**：dry-run/修复产物只写本次 attempt 的 `verification/dry-run[-n]`；两轮失败保留当前版本，别的 attempt 不被覆盖。
10. **不泄露**：报告不写密钥、base64、完整 prompt、原始响应或本机绝对路径。

## 验收

- [ ] dry-run 全部阶段有结果：Composer P0–P6（含 `verifyOutput`）、`mini:check`、output-consistency、可观察项；每阶段失败映射到稳定 code。
- [ ] `mini:check` 用 `scripts/validate-miniprogram.cjs#runChecks`（与 `npm run mini:check` 同实现）；不另写一套宽松校验。
- [ ] 可观察项覆盖分区顺序、关键组件/按钮、真实 handler、slot 四段锚点、主题 token、空白页；缺锚点返回 `SLOT_ANCHOR_MISSING` + DSL path。
- [ ] 微信验证只执行固定脚本；结果状态只可能是 `PASS/FAIL/BLOCKED/NOT_RUN`，且有证据 JSON 与截图清单。
- [ ] 关键动作不回归：运行时报告的真实点击链路（首页开始点餐、菜单结算）PASS；未跑标 `not_run`；失败标 `fail`；工具阻塞标 `not_checked`。
- [ ] 修复循环严格 ≤2 轮；失败保留输入与上一版本；`adoption:'none'`；非 DSL 可定位故障 0 次 repair。
- [ ] 退出码与结论一致：0/1/2/3；`--json` 证据只含相对路径与有界摘要。
- [ ] 定向测试全绿：

```powershell
node --test --test-isolation=none test/frontend-reconstruct.dryrun.test.cjs test/frontend-reconstruct.repair.test.cjs test/frontend-reconstruct.verify-runtime.test.cjs
```

- [ ] 过程报告带 runId/attempt/candidate/revision/状态/耗时；截图清单只列相对文件名与字节数。
- [ ] 未执行的项（例如本机无微信 CLI、无 AppID）在报告与交付中明确 `BLOCKED`/`NOT_RUN`，不得写“已验收”。

## 失败退出

| 触发 | 退出方式 |
| --- | --- |
| dry-run 输入非法（attempt 不完整、overlay 缺失/指向全局） | `DRY_RUN_INPUT_INVALID`，不写产物、不启动运行时 |
| Composer/mini/一致性失败 | `DRY_RUN_FAILED`/`MINI_CHECK_FAILED`/`CONSISTENCY_FAILED` + issues；CLI 退出码 1 |
| 只有可定位 DSL 的结构化失败 | 进入 repair：≤8 issues、payload 6 键、≤2 轮；成功才可继续验证 |
| 两轮仍失败 | `REPAIR_LIMIT_EXCEEDED` 或 `REPAIR_DRY_RUN_FAILED`；`adoption:'none'`，保留当前版本，候选不可采用 |
| 非 DSL 可定位故障（Base/Registry/工具/环境） | `REPAIR_NOT_APPLICABLE`；停止自动修复并人工处理 |
| 修复传输异常/服务端拒绝/返回非法 Draft | `REPAIR_TRANSPORT_FAILED`/`REPAIR_REJECTED`/`REPAIR_RESPONSE_INVALID`；不采用任何版本 |
| 微信 CLI 缺失、超时、脚本崩溃、证据缺失、证据矛盾 | `BLOCKED`（`RUNTIME_BLOCKED`/`RUNTIME_TOOL_MISSING`/`RUNTIME_TIMEOUT`/`RUNTIME_SCRIPT_FAILED`/`RUNTIME_EVIDENCE_MISSING`/`RUNTIME_INCONSISTENT`），退出码 3 |
| 微信验证真实失败 | `FAIL`（`RUNTIME_FAIL`），退出码 2 |
| 取消或 dry-run 未通过而未启动运行时 | `NOT_RUN`/`RUNTIME_CANCELLED`，退出码 3（dry-run 失败时为 1） |
| 依赖的微信开发者工具未登录/端口不可用/AppID 错误 | 如实 `BLOCKED` 并给出原因；不得重试伪造或改用 React 预览 |

只有静态门禁全绿且运行时 `PASS` 才允许进入采用；`partial` 必须明确“微信验证未完成”并要求用户显式确认。微信工具不可用时，其它门禁通过也只能是 `partial`，不得显示“已验收”。
