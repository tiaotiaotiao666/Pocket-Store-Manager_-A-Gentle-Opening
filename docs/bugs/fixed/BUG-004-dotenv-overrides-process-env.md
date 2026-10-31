# BUG-004 `.env` 覆盖真实进程环境变量

- 状态：已修复
- 级别：P1 高
- 发现日期：2026-10-31
- 来源：后端测试 / 容器启动
- 影响面：后端配置加载、测试与部署环境

## 1. 现象

测试中向进程注入 `CACHE_DRIVER=memory`，服务仍按 `server/.env` 里的 `redis` 启动，在无 Redis 的环境直接启动失败；容器部署存在同类隐患。

## 2. 根因

配置加载顺序错误：`.env` 文件值覆盖了真实进程环境变量。按 dotenv 语义与十二要素应用约定，进程环境变量必须优先。

## 3. 修复

`server/src/common/config/env.validation.ts:79-82` 改为先读取真实 `process.env`，再用 `.env` 补齐缺失项：

```ts
// 真实环境变量（容器/CI/测试注入）优先于 .env 文件
for (const [key, value] of Object.entries(process.env)) { ... }
```

## 4. 验证

| 命令/操作 | 结果 |
| --- | --- |
| `cd server && npm test` | 9 个文件、139 项通过 |
| 真实进程联调（MySQL + memory 缓存降级） | 20/20 检查通过 |
| 无 Redis 环境注入 `CACHE_DRIVER=memory` | 正常启动 |

## 5. 防回归

新增配置项继续沿用“进程环境变量优先”顺序；不得通过修改 `.env` 来覆盖测试注入值。

## 6. 备注

记录来源：`docs/handoff/archive/2026-10-31-B1业务后端完成.md` 第 3 节。