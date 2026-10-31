# BUG-014 项目流程内点击“轻启”会被拉回功能选择页

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：F4 人工走查（用户反馈）
- 影响版本：P0 验收收口 F1/F2 之后的桌面应用
- 影响面：侧边栏“轻启”、所有已有项目的流程阶段（含部署阶段）
- 涉及文件：`src/state/sessionMachine.mjs`、`src/App.jsx`、`src/components/common/ConfirmDialog.jsx`、`src/styles/workbench.css`、`test/session-machine.test.cjs`

## 1. 现象

在任意已有项目阶段点击侧边栏“轻启”，页面会先回到命名引导，约 5 秒后自动跳到功能选择页；即使当前已经走到部署阶段也会发生。当前项目的阶段被覆盖，用户无法继续原来的流程。

## 2. 根因

三处叠加：

1. `START_ONBOARDING` reducer 在非 `HOME` 阶段直接执行 `{ ...state, phase: ONBOARDING }`，没有区分“开始新项目”和“在现有项目里点轻启”。
2. `src/App.jsx` 的自动推进 effect 只判断“当前处于命名引导且已有店名”，就会在 5.2 秒后自动 `SKIP_INTRO`；`SKIP_INTRO` 直接进入 `FEATURES`。
3. “轻启”没有新建项目或新会话，只是改当前 phase，导致现有项目被拉回引导。

复现输出：

```text
部署阶段 phase=deploy，store.name=test2
点击轻启 → phase=onboarding
5.2 秒后自动跳过 → phase=features
```

## 3. 复现步骤

```text
1. 打开任意已命名项目，走到店铺装修/部署阶段。
2. 点击左侧栏“轻启”。
   期望：开始一个新项目，或至少不破坏当前项目流程。
   实际：约 5 秒后跳到功能选择页，当前阶段丢失。
```

## 4. 修复

- `src/state/sessionMachine.mjs` 新增 `selectOnboardingStart(state)`：无活动项目返回 `start`，有活动项目返回 `confirm-create`。
- `src/App.jsx`：
  - `startOnboarding` 改为先判断 `selectOnboardingStart`；已有项目时打开确认对话框，不再直接改 phase。
  - 新增 `confirmStartOnboarding`：确认后调用 `handleProjectCreate()`，成功才 dispatch `START_ONBOARDING`；失败保持对话框并展示错误。
  - `handleProjectCreate` 改为返回布尔值，供轻启流程判断是否继续。
- 复用 `ConfirmDialog`，新增 `confirmButtonClass` prop；轻启使用主色按钮与 `accent` 图标样式，文案明确“当前项目会先保存，然后新建待命名项目”。
- 取消操作不改变任何状态。

## 5. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| `node --test test/session-machine.test.cjs` | 26/26 通过（新增轻启决策用例） |
| `npm test` | 334 项：333 pass / 0 fail / 1 todo |
| `npm run build` | exit 0，1639 模块，`index-n4r2q1cp.js` 396.88 kB |
| `npm run test:desktop` | 12/12 通过 |
| `npm run mini:check` | 0 错误 0 警告 |
| `npm run mini:dup-check` | 0 错误 |
| `npm run registry:check` | 2026.11.0 通过 |
| `npm run check:packaging` | 229 文件 / 10 条规则 |

## 6. 防回归

- 任何“开始新流程”的全局入口，不得在其他阶段直接覆盖当前 `phase`；必须先判断是否有活动项目，并走新建项目/确认路径。
- 自动推进 effect 依赖“已有店名”时，必须同时确认这次引导确实是新发起的，不能把已存在项目的店名当成“本轮已命名”。
- 轻启的决策逻辑保持在 `selectOnboardingStart` 纯函数中，新增入口应复用而不是重新写判断。