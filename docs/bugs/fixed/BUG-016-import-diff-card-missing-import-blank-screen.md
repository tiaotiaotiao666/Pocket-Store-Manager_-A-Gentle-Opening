# BUG-016 `ImportDiffCard` 未导入，点击导出后整页白屏

- 状态：已修复
- 级别：P0 阻断
- 发现日期：2026-10-31
- 来源：F4 人工走查（用户反馈“选择导出小程序之后程序白屏”）
- 影响版本：P0 验收收口 F1/F2 之后的桌面应用
- 影响面：导出后的导入预览；整个 React 根组件崩溃
- 涉及文件：`src/App.jsx`、`test/app-imports.test.cjs`

## 1. 现象

部署页体检通过后点击导出，窗口立即白屏。渲染层日志：

```text
Uncaught ReferenceError: ImportDiffCard is not defined
The above error occurred in the <App> component
```

## 2. 根因

`src/App.jsx` 在导入预览区域使用 `<ImportDiffCard>`，但没有 `import` 该组件。

Vite 开发模式不会把未定义标识符当作编译错误；生产构建也不会因此失败。因此 `npm run build` 一直通过，只有真实点击导出、渲染到该分支时才抛 `ReferenceError`，导致 React 根组件崩溃并白屏。

同类问题在同一天还出现过一次：`runPreflight` 使用了未导入的 `validatePlan`，表现为体检永久停在 `checking`（见 BUG-015）。

## 3. 复现步骤

```text
1. 部署页体检通过（0 error，warn 已确认）。
2. 选择导出位置并点击导出。
   期望：显示导入差异预览。
   实际：整页白屏；日志报 ImportDiffCard is not defined。
```

## 4. 修复

1. `src/App.jsx` 补上：

```js
import ImportDiffCard from './components/build/ImportDiffCard.jsx';
```

2. 新增 `test/app-imports.test.cjs` 静态门禁：
   - 提取 `App.jsx` 中所有 JSX 大写组件标签，断言都能解析到 import 或本地定义；
   - 提取所有 `await name(...)` 调用，断言都能解析到 import 或本地定义。
   - 该门禁同时覆盖 `ImportDiffCard` 与 `validatePlan` 两类问题。

## 5. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| `node --test test/app-imports.test.cjs` | 2/2 通过 |
| `npm test` | 338 项：337 pass / 0 fail / 1 todo |
| `npm run build` | exit 0，1639 模块，`index-CV5GEuSN.js` 403.70 kB |
| 用户实机点击导出 | 白屏消失，显示导入差异预览；同名目录冲突提示正常出现 |

## 6. 防回归

- 任何新增页面/组件分支，必须保证 JSX 组件与异步函数都在文件顶部导入；不能依赖构建器检查未定义标识符。
- `test/app-imports.test.cjs` 必须保持通过；新增 `App.jsx` 组件或 `await` 调用后，先跑该测试。
- 白屏类问题优先读渲染层 `ReferenceError` 日志，不要先怀疑状态机或数据。