# Kali 本地 VM 部署与联调证据

> 日期：2026-11-01
> 范围：局域网演示部署。Kali 不是华为云，本记录不能作为华为云部署证据。

## 1. 部署形态

- Windows 前端：`http://127.0.0.1:5173/`
- Kali 后端：`http://192.168.222.129:3000/api/v1`
- 后端目录：`/home/kali/smart-store/server`
- Node：22.20.0，仅安装在 `kali` 用户目录 `/home/kali/.local/node22`
- 数据库：Kali 已有 MariaDB 11.8；缓存：Kali 已有 Redis 8.0
- 新建独立 `smart_store` / `smart_store_test` 数据库，没有修改原有 PostgreSQL 或其他数据库
- 代码来自当前 Git HEAD 的 `server/` 归档；未复制 Windows `node_modules`
- imagelfk SK 只写入 Kali 权限为 600 的 `server/.env`，未复制本机其他模型密钥，未写入本文

## 2. 数据初始化

- `prisma migrate deploy`：两个既有迁移全部成功
- `npm run db:seed`：`store-demo-001`、2 个分类、6 个商品、2 个桌号、2 个成员
- 正式数据库账号只有业务库权限；测试使用独立测试账号，未提升正式账号权限

## 3. 真实验证

| 验证 | 结果 |
| --- | --- |
| Kali `GET /api/v1/health` | 200，服务正常 |
| Kali `GET /api/v1/readyz` | `database=ok`、`cache=redis` |
| Windows 请求 Kali `/readyz` | 200，局域网连接正常 |
| Windows 请求演示门店目录 | 返回 2 个分类及真实种子商品 |
| Kali `GET /api/v1/generation/health` | `provider=imagelfk`、`configured=true`、`imageModel=true`；未重复收费出图 |
| Kali 服务端全量测试 | **12 个文件、164 项测试全部通过** |
| Windows 前端 HTTP | 200 |
| 系统 Edge 无头页面加载 | 页面正常渲染，无白屏、无 JavaScript page error；未点击生图 |

此前 Windows 前端 337 项测试与构建、服务端构建也已通过。此次完整数据库测试是在 Kali 上补跑成功，不再保留“本机缺 MySQL 导致服务端数据库套件无法验证”的结论。

## 4. 当前运行与恢复

当前保持运行：Kali 的 MariaDB、Redis、后端，以及 Windows 的 Vite 前端。后端使用 `nohup`，数据库服务是本次手动启动，**未配置开机自动启动**。

Kali 重启后恢复：

```bash
sudo systemctl start mariadb redis-server
cd /home/kali/smart-store/server
nohup env PATH=/home/kali/.local/node22/bin:/usr/local/bin:/usr/bin:/bin node dist/main.js > /home/kali/smart-store/server.log 2>&1 &
```

Windows 前端恢复：

```bash
npm run dev
```

本机被忽略的 `.env.local` 当前指向：

```env
VITE_API_BASE_URL=http://192.168.222.129:3000/api/v1
VITE_IMAGE_MODEL_ENDPOINT=http://192.168.222.129:3000/api/v1/generation
VITE_AGENT_TRANSPORT=http
VITE_AGENT_ENDPOINT=http://192.168.222.129:3000/api/v1/agent/turn
VITE_AGENT_CONTRACT_VERSION=agent-turn.v1
VITE_AGENT_MODEL_LABEL=Deepseek-V4.1-Flash
```

## 5. 尚未完成/不能据此宣称

- 只验证了首页渲染和后端目录/健康接口，尚未完整点击六步生成流程、导出工程和微信开发者工具发布。
- 后续已于 2026-11-01 接通 Kali 模型代理，真实 Agent 验证见 `kali-deepseek-agent.md`；该模型仍是用户本地模型，不是华为云模型。
- 视觉 `/recommend-style` 未验证；`generation/health` 的 `visionModel=true` 来自模型名回退，不是视觉成功证据。
- 大 base64 参考图仍有 HTTP 413 限制；生图返回尺寸实测为 1254×1254。
- 当前是 development、局域网 HTTP、演示登录和演示支付；不是生产 HTTPS、真实微信登录或真实支付。
- 未配置 Kali 开机自启、进程守护、备份和监控；演示之外如需长期使用应另行加固。
- 华为云 ECS/RDS/DCS/ModelArts 真实部署与调用仍未完成，比赛云端资格不能由本记录替代。