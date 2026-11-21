# 侧栏单图构建与微信预览：T9 修复后复验报告

## VERDICT: FAIL

T6–T8 的 R3 修复已通过真实 3101 探针，独立候选 dry-run 也通过；但真实 Electron 侧栏在外发确认后发生 run/revision 失配，并且失配分支没有进入终态，导致自动候选永久卡在 `analyzing`。因此后续自动 dry-run、采用和微信预览不能判 PASS。

本轮未修改产品代码或项目测试，只写入/调整 `.resultverify` 下的验证脚本与证据。

## 命令、退出码与结果

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `bash .resultverify/build.sh` | 0 | 根 Vite 与服务端 Nest build 均 SUCCESS，10 秒 |
| `bash .resultverify/contract_checks.sh` | 1 | 52 PASS / 2 个已知匹配误报；路由组合与 `PHASES.PROMPT_STUDIO` 常量均实际存在 |
| `npm.cmd test`（T10 后最终根测试） | 1 | 1243 项：1240 pass / 1 fail / 2 skipped |
| `npm.cmd test`（`server/`） | 0 | 35 files / 625 tests 全通过 |
| `node .resultverify/t5/server-probe.mjs` | 0 | 同一 3101 探针 11 项 PASS；R3 修复成立 |
| `node .resultverify/t5/candidate-probe.mjs` | 0 | 3 项 PASS；当前 Plan/门店/版本、非法输入和 dry-run 均通过 |
| `node .resultverify/t5/electron-uia-probe.mjs` | 1 | 真实 Electron CDP 侧栏链在自动候选阶段失败，详见下方缺陷 |

### R3 修复复验

真实 HTTP + MySQL 证据（`.resultverify/t5/server-probe-result.json`）：

- 相同 binding+payload 第二次返回 `replay:true`，复用首次 `importId`，双版本保持 `1/1`；
- 更新后再次重放保持第二版 `2/2`；
- A 的商品价格与描述均更新为第二版，B 保持第一版，跨绑定无覆盖；
- 201/401/409/422、确定性 storeId、6 并发只创建一次且单 OWNER、ensure 不覆盖已导入版本均通过；
- 验证产生的数据按精确 ID 清理，3101 子进程已停止。

### 独立候选 dry-run

`.resultverify/t5/candidate-probe-result.json`：

- 使用生产 `buildPlanFromSession` 生成当前 Plan，`source=provided`，候选 `frontendPack`、预览 `storeId` 与双版本 `2/3` 进入同一 attempt；
- 输出位于该 attempt 的 `verification/dry-run/candidate`，证据保留 Plan 来源和摘要；
- 显式 `plan:null` 返回 `DRY_RUN_INPUT_INVALID`，未回退默认 Plan；
- 非法 storeId、额外版本键、超过 256 KiB Plan 均返回 `FRONTEND_PAYLOAD_INVALID`；合法参数原样进入 IPC 服务。

## 新确认的产品缺陷

### R1/R4：外发确认后的 continuation 失配且状态永不清尾

真实操作：隔离 Electron 项目中，侧栏附加 `order-classic-home.png`，一次发送完整店名、品类、营业时间、履约、三道菜和按图生成要求。

已通过的步骤：

- app-assistant 真实返回 proposal，7 条低风险资料写入及变更卡可见；
- 图片附件与文字保留，外发确认弹窗可见；
- 点击「确认发送」后没有调用 `/api/v1/agent/frontend-reconstruct`。

实际失败：

1. `src/App.jsx:3084` 的 `pending.runId === frontendState.runId && pending.revision === frontendState.revision` 在用户提供确认后变为 false，进入“这次自动候选已因项目或输入变化而失效”分支；正常流程中用户没有换项目或改输入，不应发生该失配。
2. `src/App.jsx:3086-3088` 只调用 `setScreenConsentNotice`，没有 dispatch `FRONTEND_CANCELLED` 或失败终态。
3. 页面持续显示“识别中 / 正在写回资料并准备参考图分析（第 1/9 步）”，等待 720000 ms 仍无终态；侧栏继续显示“参考图候选正在自动构建或验证”，发送保持禁用。
4. 服务端日志只有 app-assistant 写回，未进入参考图分析；没有生成候选 attempt、dry-run 或微信证据。

证据：`.resultverify/t5/electron-uia-result.json`、`electron-cdp-snapshot.json`、`server-3000.log`。

修复要点：查明正常确认期间 revision 被推进的来源，保证同一 continuation 不被误判；即使确已失效，也必须在 `3086-3088` 分支将当前 run 转为明确 CANCELLED/FAILED 终态并解除忙碌，不得只显示提示而永久锁住侧栏。

## 根测试剩余失败口径

最终根测试仍有 1 个失败：

- `test/env-guide.test.cjs:66` 期望正则 `status !== 'ok'[\s\S]{0,300}return;`；
- 实际 `src/App.jsx:2089-2096` 是 `if (prepared.status !== 'ok') { return { ok:false, code, step, message }; }`，失败保护存在且会返回对象；
- 测试只接受裸 `return;`，没有接受 `return { ... }`，属于测试正则漏配。完整根测试命令退出码仍为 1，不能写成全绿。

## NOT_RUN / BLOCKED

- Electron UIA：**BLOCKED**。`agent-desktop` 返回 `INTERNAL private file DACL grants an untrusted principal`；后续证据来自 Electron CDP，不冒充 UIA。
- 侧栏自动候选 dry-run：**NOT_RUN**（上述 continuation 缺陷）。这与独立脚本已通过的 dry-run 是不同证据，不得混用。
- 同一 attempt 微信运行时编译、截图、加购：**NOT_RUN**。
- 候选采用、重生成和最终同源预览：**NOT_RUN**。
- 第二张真实样例的端到端复核：**NOT_RUN**。
- 微信工具没有因本轮自动链打开新窗口；未将“工具存在”写成运行时 PASS。