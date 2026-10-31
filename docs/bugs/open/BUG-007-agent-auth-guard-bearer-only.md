# BUG-007 Agent 鉴权只校验 Bearer 形式，未接入 `SessionAuthGuard`

- 状态：待修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：B1 遗留 + 代码核对
- 影响版本：当前 `server/src/agent/`
- 影响面：`POST /api/v1/agent/turn` 的生产鉴权与租户归属
- 涉及文件：`server/src/agent/agent-auth.guard.ts`、`server/src/common/auth/`

## 1. 现象

生产环境开启 `AGENT_REQUIRE_AUTH=true` 后，任意“格式合法”的 `Authorization: Bearer <任意字符串>` 都能通过 Agent 接口鉴权，接口无法识别真实店主身份，也无法按门店隔离。

## 2. 根因

`AgentAuthGuard` 仅做格式校验，不解析会话、不查库、不注入 `request.user`。其实现注释已明确写出该限制：

```ts
// 有 Authorization 时只校验 Bearer 形式，不做真实身份解析（B1 auth 尚未实现）
```

而 B1 已实现 `SessionAuthGuard`（`server/src/common/auth/`，校验 session token 的 SHA-256、角色与门店成员关系），Agent 模块没有复用它。

## 3. 复现步骤

```text
1. production 环境启动，设置 AGENT_REQUIRE_AUTH=true
2. 调用 POST /api/v1/agent/turn，Header: Authorization: Bearer not-a-real-session
3. 期望：401
   实际：通过鉴权并执行 Agent 调用
```

## 4. 修复方案（可采纳可不采纳）

- **方案 A（推荐）**：Agent 控制器改用 `SessionAuthGuard`，并用 `@CurrentUser()` 获取用户；Agent 服务按用户所属门店隔离草稿与 turn。
- **方案 B**：保留 `AgentAuthGuard`，但注入 `PrismaService` 校验 token hash、过期时间与角色，并写入 `request.user`。
- 两种方案都必须保留 development/test 的显式联调开关，production 强制鉴权，缺失凭据时启动失败。

注意：Agent 与 B1 sessions 的 turn 目前相互独立，接入前需确认是否复用 session 表，避免把两套会话语义混在一起。

## 5. 验收标准

- [ ] 伪造/过期 token 返回 401，不触发模型调用
- [ ] 真实 session 返回 200，且只能访问自身门店数据
- [ ] production 下 `AGENT_REQUIRE_AUTH` 不能被关闭
- [ ] 覆盖 401、租户隔离、无 Key 503 的自动化测试

## 6. 验证证据

| 检查 | 结果 |
| --- | --- |
| `agent-auth.guard.ts` 实现 | 仅校验 Bearer 格式 |
| `SessionAuthGuard` 是否存在 | 已存在，未被 Agent 使用 |
| 安全测试 | 未执行 |

## 7. 备注

记录来源：`docs/待完成目标.md:126`、`docs/handoff/archive/2026-10-31-B1业务后端完成.md` 第 4 节。完整契约见 `docs/agent-turn-contract.md`。