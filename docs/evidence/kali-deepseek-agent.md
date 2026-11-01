# Kali 真实大语言模型接入证据

> 日期：2026-11-01
> 范围：Windows 前端 → Kali 项目后端 → 局域网 OpenAI 兼容模型代理。该模型是用户自己的本地模型服务，不是华为云模型调用。

## 1. 配置与边界

- 上游：`http://192.168.222.1:17863/v1`
- 实际调用模型：`cn:deepseek-v4.1-flash`
- 用户显示名称：`Deepseek-V4.1-Flash`
- 协议：`POST /chat/completions`，Bearer 鉴权，OpenAI Chat Completions 形状
- API Key 只写入 Kali `/home/kali/smart-store/server/.env`，权限 600；未写入前端、文档或 Git
- 未配置地址返回 401，证明 Kali 到上游的网络路径存在；随后使用有效配置完成真实调用

前端本机配置使用 Kali 项目后端 `/api/v1/agent/turn`，不向浏览器下发模型 Key。实际模型名与用户显示名分开，未把显示别名冒充上游模型 ID。

## 2. 真实兼容性差异与最小修复

首次真实请求虽然 HTTP 200、`mock=false`，但日志出现 `hasReply=false`，不能算接入完成。

短诊断确认：该代理在“system 消息 + `response_format`”下可能返回普通文本；把同样的 JSON 约束放进用户消息后，可正确返回 `reply` 和 `draftPatch`。因此只做了一个适配：将原结构约束与当前草稿/店主输入合并到同一个用户消息，API 路径、密钥位置、响应契约和 JSON 白名单清洗均不变。

前端同时增加可选 `VITE_AGENT_MODEL_LABEL`，侧边栏改为展示当前真实传输标签，避免旧设置开关导致已接通时仍显示 Mock。

## 3. 项目真实调用结果

请求：`POST http://192.168.222.129:3000/api/v1/agent/turn`

输入资料：松月食堂、社区家常菜、10:00-21:00、堂食和自取、宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。

| 项 | 真实结果 |
| --- | --- |
| HTTP / 总耗时 | 200 / 7.155 秒 |
| `meta.mock` | `false` |
| `meta.provider` | `deepseek` |
| `meta.model` | `cn:deepseek-v4.1-flash` |
| 回复 | 中文自然语言总结店铺资料，非空、可读 |
| 状态 | `reviewing` |
| 店名 / 品类 | `松月食堂` / `社区家常菜` |
| 营业时间 | `10:00-21:00` |
| 堂食 / 自取 | `true` / `true` |
| 三道菜价格 | 2800、1600、300 分，全部正确 |
| 缺项 / 字段错误 | `[]` / `[]` |

系统 Edge 打开项目页后，实际找到 `Deepseek-V4.1-Flash`，未找到旧的“本地 Mock（未接入真实模型）”标签，无 JavaScript page error。验证后未继续循环调用模型。

## 4. 回归

| 验证 | 结果 |
| --- | --- |
| 前端传输配置定向测试 | 5 项通过，含自定义显示名 |
| 模型 Provider 定向测试 | 16 项通过 |
| 前端全量测试 | 337 passed、0 failed、1 todo |
| 前端生产构建 | 通过 |
| Kali 服务端全量测试 | 12 个文件、164 项全部通过 |
| Kali 服务端构建 | 通过 |
| 当前运行状态 | Kali 后端与 Windows 前端保持运行 |

## 5. 修改文件

- `server/src/agent/provider/deepseek-agent.provider.ts`：结构约束并入用户消息
- `server/test/deepseek-agent.provider.test.ts`：验证新消息构造与既有安全清洗
- `src/services/agentTurn/agentServiceConfig.js`：可选模型显示名
- `test/agent-transport-config.test.cjs`：显示名配置回归
- `src/App.jsx`：侧边栏使用真实传输标签

以上改动未提交 Git。真实验证仅证明当前 Kali/局域网链路，不代表华为云部署或华为云模型接入。