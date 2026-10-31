# BUG-003 跳过开场后剩余消息未一次性展示

- 状态：已修复
- 级别：P2 中
- 发现日期：2026-10-31
- 来源：交互走查
- 影响面：桌面会话首次进入 / 开场引导

## 1. 现象

点击「跳过」后，剩余引导消息仍按逐条动画继续播完，等待时间没有减少；用户期望跳过即一次性看到全部剩余提示。

## 2. 根因

会话状态里没有“强制补齐”标记，`useSequentialReveal` 只依据当前进度继续逐条揭示，跳过动作只改变了阶段，没有改变揭示策略。

## 3. 修复

- 会话状态新增 `revealFlush` 计数，`SKIP_INTRO` 时自增：`src/state/sessionMachine.mjs:225`。
- `ChatStream` 透传 `flushKey`：`src/App.jsx:701`。
- 揭示逻辑抽成纯函数 `src/hooks/revealTransition.mjs`，由它决定归零或一次性补齐。
- 切换会话仍优先重新开始逐条揭示，不丢消息。

## 4. 验证

| 命令 | 结果 |
| --- | --- |
| `npm test` | 100/100 通过 |
| `test/session-machine.test.cjs:76-87` | `revealFlush` 初值、跳过后自增、进入新会话归零均通过 |
| `test/reveal-transition.test.cjs` | 揭示归零/补齐纯函数通过 |

## 5. 防回归

`revealFlush` 语义不得被合并进阶段字段；跳过行为由纯函数与状态机测试共同覆盖。

## 6. 备注

工作区中这批改动是用户资产（未提交），不得回滚。来源：`docs/handoff/当前工作区交接.md` 第 2 节。