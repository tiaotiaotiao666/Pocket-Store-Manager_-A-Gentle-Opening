# BUG-015 体检链路缺少失败兜底，IPC 无回执时永久“正在体检…”

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：F4 人工走查（用户截图：部署页体检一直停在“正在体检…”）
- 影响版本：P0 验收收口 F1/F2 之后的桌面应用
- 影响面：部署页导出前体检；导出入口被阻断
- 涉及文件：`src/services/exportService.js`、`src/App.jsx`、`test/export-service.test.cjs`

## 1. 现象

进入部署页后，“导出前体检”一直显示“正在体检…”，规则列表为空；点击“重新体检”仍然卡住。等待数分钟不恢复，无法导出。

用户怀疑与“所有字段都填 1”有关。

## 2. 排查结论

- 用相同输入构造 Plan（店名 `test2`、分类/地址/电话/介绍均为 `1`、3 道菜价格为 `1` 分、营业时间 `1`）调用 `buildPlanFromSession` + `validateComposition`，返回 `ok=true`，**输入值本身不会导致校验异常或挂起**。
- 加诊断日志后定位到直接原因：`App.jsx` 使用了未导入的 `validatePlan`，本地规则通过后走到 Composer 校验时抛 `ReferenceError: validatePlan is not defined`。
- 该异常又被两层缺失的兜底掩盖：
  1. `runPreflight` 没有 `try/catch`，任何同步异常都会让 promise reject，`PREFLIGHT_RESULT` 永远不会 dispatch。
  2. `validatePlan` 直接 `await` IPC，没有超时，也没有异常兜底；主进程 handler 抛错或旧版本缺少通道时会 reject。
  3. `preflightTarget` 只有 `try/catch`，没有超时；主进程无回执时会永久 pending。
- 状态停在 `PREFLIGHT_START` 写入的 `checking`，UI 因此永久显示“正在体检…”。
- 补上 `validatePlan` 导入后，日志显示 `validate done ok`、`dispatch result 0 1`，体检恢复；用户实机确认体检通过并成功进入导出。

## 3. 复现步骤

```text
1. 进入部署页，让体检自动开始。
2. 若 Composer 校验或目标预检的 IPC 抛错/无回执：
   状态停在 checking，界面永久“正在体检…”。
3. 点击“重新体检”重复同一路径，仍然卡住。
```

## 4. 修复

`src/services/exportService.js`：

- 新增 `withTimeout(promise, timeoutMs)`，返回 `{ value }` / `{ rejected: true }` / `{ timedOut: true }`。
- `validatePlan(plan, options)`：默认 10 秒超时；reject 返回 `COMPOSE_FAILED`，超时返回 `COMPOSE_TIMEOUT`。`options.timeoutMs` 仅供测试注入。
- `preflightTarget(payload, options)`：默认 5 秒超时；reject 返回 `TARGET_CHECK_FAILED`，超时返回 `TARGET_CHECK_TIMEOUT`。
- 两者都不再向调用方抛异常。

`src/App.jsx`：

- 补上 `validatePlan` 的 import。
- `runPreflight` 整体包 `try/catch`。
- 异常时 dispatch `PREFLIGHT_RESULT`，写入 `E-PREFLIGHT-FAILED` 规则与可读消息，`status` 变为 `failed`，面板显示“体检未完成，请重试”而不是永久 loading。

`test/export-service.test.cjs`：

- 新增 Composer 校验 reject / 超时、目标预检无回执超时三档用例。

## 5. 验证证据

| 命令 | 结果 |
| --- | --- |
| `node --test test/export-service.test.cjs` | 9/9 通过 |
| `node --test test/app-imports.test.cjs` | 2/2 通过（防同类导入缺失） |
| `npm test` | 338 项：337 pass / 0 fail / 1 todo |
| `npm run build` | exit 0，1639 模块，`index-CV5GEuSN.js` 403.70 kB |
| `npm run test:desktop` | 12/12 通过 |
| 用户实机复测 | 体检正常完成并进入导出；同名目录冲突提示正常出现 |
| `npm run mini:check` / `mini:dup-check` | 0 错误 |
| `npm run registry:check` / `check:packaging` | 通过 |

## 6. 防回归

- 任何 `ipcRenderer.invoke` 读取都必须有超时、异常、未注册三种失败路径的兜底，且失败也要 dispatch 终态 action；UI 不得永久停在 loading。
- 长耗时校验类 IPC 必须设置明确超时（本处校验 10 秒、目标预检 5 秒），超时文案要写明“已停止本次体检”，不能让用户误以为仍在进行。
- 排查“体检卡住”时先区分输入值与异步链路：输入值问题应表现为规则错误，不应表现为状态机停在 `checking`。