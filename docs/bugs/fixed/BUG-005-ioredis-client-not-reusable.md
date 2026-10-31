# BUG-005 ioredis 客户端首次连接失败后不可复用

- 状态：已修复
- 级别：P2 中
- 发现日期：2026-10-31
- 来源：本地 Redis 联调
- 影响面：后端缓存连接与降级

## 1. 现象

Redis 尚未就绪时首次连接失败，后续重试始终失败；即使 Redis 已恢复，服务仍停留在内存缓存模式（或 `CACHE_DRIVER=redis` 时启动失败）。

## 2. 根因

ioredis 实例一旦进入连接失败状态便不可复用，旧实现复用同一个 client 做重试。

## 3. 修复

`server/src/cache/cache.service.ts:33-65` 改为每次尝试新建客户端：

- `lazyConnect: true`、`retryStrategy: () => null`、`connectTimeout: 3000`；
- 最多 5 次、每次间隔 1 秒；
- 失败后 `quit()` 释放，最终按 `CACHE_DRIVER` 抛错或降级内存。

## 4. 验证

| 命令/操作 | 结果 |
| --- | --- |
| 真实 WSL Redis 链路 | `readyz` 返回 `cache: redis` |
| 无 Redis 时 `CACHE_DRIVER=auto` | 自动降级内存，服务可启动 |
| `CACHE_DRIVER=redis` 且 Redis 不可用 | 明确启动失败，不静默降级 |

## 5. 防回归

不得缓存失败过的 ioredis 实例；重试逻辑必须重建 client。

## 6. 备注

记录来源：`docs/backend-local-dev.md:221`。