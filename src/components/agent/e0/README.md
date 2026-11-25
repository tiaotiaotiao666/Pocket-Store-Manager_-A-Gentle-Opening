# `src/components/agent/e0/` — E0-U1 独立原型（不接 App）

本轮（E0-U1）只交付**接口口径 + 独立展示组件 + 测试**，把 E1/E3 要用的 UI 面先钉死：

| 文件 | 作用 |
|---|---|
| `e0UiContract.mjs` | **唯一**口径来源：8 页枚举、progress stage 白名单（§9.1 + §14.9）、四态词、缺图/consent 口径、候选摘要聚合。纯函数、无 IO、无 React。 |
| `TargetPageSelect.jsx` | 8 页单选；非 `enabled` 页不可选并显示原因。 |
| `ReferenceImageUploader.jsx` | 参考图上传入口 + consent 勾选；**不读文件、不写文件、不调 IPC**。 |
| `UtteranceInput.jsx` | utterance 输入（受控、有字数上限与可读名称）。 |
| `RunProgressBar.jsx` | 真实进度；未知 stage 显示「未知阶段（x）」且保留该步。 |
| `CandidateSummaryCard.jsx` | 修改文件数、treeDigest、静态/运行时四态、BLOCKED/NOT_RUN 原因。 |
| `e0.css` | 样式（本轮**不被 App 引用**，E3 接线时再 import）。 |
| `index.js` | 展示组件与口径模块的导出面。 |

## 硬边界（本轮）

- 没有 `window.smartStore`、没有 `ipcRenderer`、没有 `src/services/**` 依赖、没有 reducer/状态机。
- 不改 `src/App.jsx`、`src/state/sessionMachine.mjs`、`src/components/layout/RightPanel.jsx`（冻结 §14.10 写入锁）。
- 不生成假进度：`steps` 只能来自主进程 `agent:progress` 事件；空列表显示 `NOT_RUN`。
- 缺图/未同意 → `MISSING` + `BLOCKED`，不得静默退化成纯文本生成（§14.8 第 5 条）。
- 状态词只有 `PASS / FAIL / BLOCKED / NOT_RUN`；`partial` 是标记不是第五态。

## 测试

```powershell
node --test --experimental-test-isolation=none "test/e0-ui*.test.cjs"
```

- `test/e0-ui-contract.test.cjs`：把口径模块与冻结文档逐项对齐（8 页、stage 白名单、四态、缺图口径）。
- `test/e0-ui-components.test.cjs`：组件源码级可访问性/边界断言（role + aria-label、无 smartStore、无第三份标签表）。

## 接口差距

UI 需要但冻结接口当前还缺的字段/命令，见
[`docs/evidence/workspace-agent/e0-u1/interface-gap.md`](../../../../docs/evidence/workspace-agent/e0-u1/interface-gap.md)；
E3 的 UIA 断言清单见 [`docs/evidence/workspace-agent/e0-u1/uia-checklist.md`](../../../../docs/evidence/workspace-agent/e0-u1/uia-checklist.md)。
