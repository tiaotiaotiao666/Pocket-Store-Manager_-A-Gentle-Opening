/**
 * E0-U1 独立原型导出（不接 App 主链）。
 *
 * 这里导出的是**纯展示组件 + 口径模块**：没有 `window.smartStore`、没有 IPC、
 * 没有 `src/services/**` 依赖，也没有 reducer/状态机。E3 接线时由 `src/services/workspaceAgent/**`
 * facade 提供数据，`App.jsx` / `sessionMachine.mjs` / `RightPanel.jsx` 由 Captain 另行派单。
 */

export { default as TargetPageSelect } from './TargetPageSelect.jsx';
export { default as ReferenceImageUploader } from './ReferenceImageUploader.jsx';
export { default as UtteranceInput } from './UtteranceInput.jsx';
export { default as RunProgressBar } from './RunProgressBar.jsx';
export { default as CandidateSummaryCard } from './CandidateSummaryCard.jsx';
export * from './e0UiContract.mjs';
