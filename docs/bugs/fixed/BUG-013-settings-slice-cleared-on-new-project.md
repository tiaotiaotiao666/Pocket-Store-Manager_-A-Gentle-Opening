# BUG-013 新建项目后设置页永久停在“正在读取应用设置…”

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：F4 人工走查（用户截图反馈）
- 影响版本：P0 验收收口 F1/F2 之后的桌面应用（2026-10-31 21:28 启动）
- 影响面：设置与自检页面；新建项目后无法读取配置、保存设置或运行自检
- 涉及文件：`src/state/sessionMachine.mjs`、`src/App.jsx`、`test/session-machine.test.cjs`

## 1. 现象

新建项目后进入“设置与自检”，页面主体为空，只显示“正在读取应用设置…”，等待数分钟不恢复。重新进入设置页仍然卡住，只能重启应用暂时恢复；再次新建项目后复现。

## 2. 根因

两处叠加导致：

1. `src/state/sessionMachine.mjs` 的 `PROJECT_NEW_SUCCESS` 使用 `createInitialState()` 生成 `blank` 后整体展开，未保留 `state.settings`。新建项目会把 `settings.config` 重置为 `null`、`status` 重置为 `idle`。删除当前活动项目走同一 blank 分支，也有同样问题。
2. `src/App.jsx` 只在组件挂载时加载一次设置。新建项目发生在挂载之后，`settings.config` 被清空后没有任何路径再触发 `settingsLoad`。
3. `SettingsPanel` 以 `!draft` 判断加载态，`config` 为 `null` 时永久显示“正在读取应用设置…”。

复现输出：

```text
loaded config: {"apiBaseUrl":"x","autoSaveEnabled":true}
after new project: null status= idle
```

## 3. 复现步骤

```text
1. 启动桌面应用，等待设置加载完成。
2. 在工作台点击“新建项目”。
3. 进入任意项目后点击“设置与自检”。
   期望：显示设置表单。
   实际：永久显示“正在读取应用设置…”。
```

## 4. 修复

1. `PROJECT_NEW_SUCCESS` 与 `PROJECT_DELETE_SUCCESS` 的 blank 分支保留 `settings: state.settings`，不再因项目切换清空设置。
2. `src/App.jsx` 增加兜底 effect：进入设置页且 `state.settings.config` 为空时主动补一次加载；复用既有 2.5 秒 IPC 超时兜底，失败回退默认配置，保证 UI 一定能渲染。
3. `test/session-machine.test.cjs` 新增“新建项目与删除当前项目不会丢失已加载的设置”。

## 5. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| `node --test test/session-machine.test.cjs` | 24/24 通过 |
| `npm test` | 332 项：331 pass / 0 fail / 1 todo |
| `npm run build` | exit 0，1639 模块 |
| `npm run test:desktop` | 12/12 通过 |
| `npm run mini:check` | 0 错误 0 警告 |
| `npm run mini:dup-check` | 0 错误，与修复前一致 |
| `npm run registry:check` | 2026.11.0 通过 |
| `npm run check:packaging` | 229 文件 / 10 条规则 |

## 6. 防回归

- 任何用 `createInitialState()` 覆盖当前状态的 reducer 分支，都必须显式保留长期设置切片（`settings`）或说明为什么允许重置。
- 设置页等依赖一次性启动加载的页面，必须保留“进入页面时缺数据则补加载”的兜底，不能只依赖挂载 effect。
- 该问题只通过真实点击暴露，说明 F4 人工走查不能由自动化测试替代。