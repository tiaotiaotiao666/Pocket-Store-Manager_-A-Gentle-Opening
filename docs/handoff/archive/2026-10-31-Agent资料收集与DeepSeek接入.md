# 历史摘要：Agent 资料收集与 DeepSeek 接入

> 日期：2026-10-31
> 状态：历史。当前契约和实现边界以 `docs/agent-turn-contract.md` 为准，本文只保留追溯信息。

## 1. 已完成演进

先在 STORE_INFO 内完成本地 Mock 资料收集，再实现：

```text
桌面端 → POST /api/v1/agent/turn → NestJS AgentModule
→ DeepSeek /chat/completions → 白名单合并 → 服务端独立校验
→ agent-turn.v1 → 前端草稿、追问、编辑与确认
```

前端保留 `mock|http` transport 切换，默认 mock 可离线运行；HTTP 模式不携带 DeepSeek Key。

## 2. 关键设计决策

- 不新增顶层 phase，Agent 是 STORE_INFO 内子状态。
- `AgentDraft` 与传输 `ContractDraft` 分离，金额只传 `priceCents` 整数分。
- 模型只返回 `reply + draftPatch`；后端忽略模型给出的 status、missingFields、errors 和 readyForReview，独立计算。
- 店主确认前不写库、不发布、不写 localStorage；turnId 不复用 B1 sessions。
- D-1 采用方案 A：请求期间 DraftEditor 只读，Composer 仍可输入，避免响应覆盖并发编辑。
- D-2 采用独立 `AgentTurnError`，由 mock/http/service 共用。
- 缺少 Key 返回 `503 DEEPSEEK_NOT_CONFIGURED`，HTTP 模式不隐式回退 Mock。
- development/test 可用显式开关联调；production 强制 AGENT_REQUIRE_AUTH=true，但当时 Guard 仍只校验 Bearer 形式。

## 3. 主要实现位置

- 前端：`src/domain/agentDraft.mjs`、`src/services/agentTurn/`、`src/components/agent/`、`src/state/sessionMachine.mjs`。
- 后端：`server/src/agent/`、`server/src/common/request-id.ts`、环境校验和 CORS。
- 契约：`docs/agent-turn-contract.md`。

原长设计、任务清单和两轮交接已由此摘要与当前契约替代，不再作为执行入口。

## 4. 当时真实验证

- 服务端测试 68/68，通过 mock fetch，无真实计费请求。
- 当时根目录测试 96/96，根目录和服务端构建通过。
- health、readyz、无 Key 503、契约不匹配 400 和 CORS 预检均有真实启动验证。
- 2026-10-31 使用临时测试 Key 完成真实 DeepSeek 调用：完整资料返回 reviewing，缺资料返回 collecting 和营业时间追问；模型未臆造营业时间。
- 经 Vite `/api` 代理到 NestJS 再调用 DeepSeek 的链路也返回 200。
- 测试 Key 只写本机被忽略的 `server/.env`，验证后由用户销毁；文档不保存 Key。

这些数字是当轮证据，不代表后续工作区的实时测试结果。

## 5. 当时未做、仍需后续处理

真实店主身份解析、Agent 幂等和限流、内容审核、独立 Agent 会话持久化、ModelArts/盘古 Provider、Skill/工具调用/多 Agent/自主规划、动态代码生成和自动发布。

未来模板组合不得扩张 `agent-turn.v1` 语义，应使用独立规划契约和确定性 Composer。