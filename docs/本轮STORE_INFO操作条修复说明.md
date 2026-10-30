# 本轮构建说明：STORE_INFO 操作条吸底修复

## 1. 问题现象

店铺装修（`STORE_INFO`）阶段，菜品草稿填写到 4–5 道后，「添加菜品」与「资料无误，继续」两个按钮被新增卡片不断向下推，最终移出可视区域，用户找不到继续入口，表现为「无法推进」。

## 2. 根因

- 页面唯一滚动容器是 `.chat-stream`（`src/styles/chat.css:1`）。
- `AgentIntakePanel` 的确认按钮位于资料面板底部（原 `AgentIntakePanel.jsx:147`），`DraftEditor` 的添加按钮位于编辑器底部（原 `DraftEditor.jsx:234`）。
- 这两块内容都渲染在滚动流内（`renderStage()` 作为 `ChatStream` 的子内容），所以菜品卡片越多，按钮位置越靠下，与滚动流一起被推出视口。
- 状态机无问题：用 reducer 复现「添加 5 道菜 → 逐项填写名称与价格」可正常从 `collecting` 进入 `reviewing` 并通过 `CONFIRM_AGENT_DRAFT` 确认。

## 3. 修复方案

将「推进类操作」从滚动流中抽出，放到 `.workspace` 的固定区域（滚动区 `.workspace-conversation` 之后、输入框 `.workspace-composer` 之前），因此按钮位置与菜品数量完全解耦。

### 组件结构

```
.workspace (flex column)
├── .workspace-conversation (flex: 1, 内部 .chat-stream 滚动)
│   ├── AgentIntakePanel   ← 只保留状态、缺项 chips、字段错误、失败重试
│   └── DraftEditor        ← 只保留表单；添加按钮已移出
├── .workspace-actions (flex: none)  ← 新增，固定在输入框上方
│   └── StoreInfoActionBar
│       ├── 状态摘要 + 菜品计数
│       ├── 添加菜品（N/5）   ← 仅在草稿编辑器展开时显示
│       └── 资料无误，继续
└── .workspace-composer (flex: none)  ← 输入框「整理资料」
```

### 关键行为

| 状态 | 添加菜品 | 资料无误，继续 | 摘要文案 |
| --- | --- | --- | --- |
| `idle` | 可用 | 禁用 | 等待输入开店资料 |
| `collecting` | 可用（< 5 道） | 禁用 | 还有 N 项待补充 |
| `requesting` | 禁用 | 禁用 | 正在整理资料，请稍候 |
| `reviewing` | 满 5 道时禁用 | 可用 | 资料已齐全，可以继续 |
| `failed` | 可用 | 禁用 | 请求失败，还有 N 项待处理 |

- 草稿编辑器收起时：操作条仍显示「资料无误，继续」，只隐藏「添加菜品」。
- 资料确认后：操作条不再渲染，走原有 `AgentDraftSummary` 的「返回修改资料」。

## 4. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/components/agent/StoreInfoActionBar.jsx` | 新增：吸底操作条，纯属性 + 事件，无状态、无请求 |
| `src/components/agent/DraftEditor.jsx` | 展开状态改为受控（`open` / `onToggleOpen`）；移除底部添加按钮 |
| `src/components/agent/AgentIntakePanel.jsx` | 移除确认栏与已确认栏；保留状态、缺项、错误、重试 |
| `src/App.jsx` | 新增 `draftEditorOpen` 状态与展开时机；在输入框上方渲染操作条；调整两个子组件传参 |
| `src/styles/panel.css` | 新增 `.workspace-actions` 固定区域样式 |
| `src/styles/agent.css` | 新增 `.agent-action-bar` 及相关状态点、按钮组样式与窄屏适配 |

未改动：`server/`、`templates/`、`miniprogram/`、`package.json`，以及工作区中既有的其他未提交改动。

## 5. 验证记录

- `npm test`：96 项全部通过，0 失败。
- `npm run build`：`vite build` 成功，1614 个模块，产物写入 `dist/`。
- 组件级 SSR 渲染核对（临时脚本，已删除）：

```
collecting: 添加菜品（3/5）[enabled]  资料无误，继续[disabled]
reviewing:  添加菜品（5/5）[disabled] 资料无误，继续[enabled]
collapsed:  资料无误，继续[disabled]（添加按钮不渲染）
requesting: 添加菜品（3/5）[disabled] 资料无误，继续[disabled]
failed:     添加菜品（2/5）[enabled]  资料无误，继续[disabled]
```

- 布局固定性由 DOM 结构保证：`.workspace-actions` 是 `.workspace` 的 `flex: none` 直接子元素，不参与 `.chat-stream` 滚动。

## 6. 遗留与后续

- 尚未做点击级人工视觉走查（本机无浏览器自动化依赖）；已运行的 Vite 开发服务会通过 HMR 加载新代码，可在店铺装修阶段自行核对按钮是否恒定居中于输入框上方。
- `.agent-editor-foot`、`.agent-confirm-bar` 等旧 CSS 类已无组件引用，本轮保留未删，避免影响其他未提交改动。
- 若后续希望操作条在窄屏下换行更紧凑，可直接调整 `.agent-action-bar` 在 `max-width: 760px` 媒体查询中的规则。