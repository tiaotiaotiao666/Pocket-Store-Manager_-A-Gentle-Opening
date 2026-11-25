# D0 目标 Flash / 当前配置模型能力探测

> 计划：《Workspace-Agent大规模重构与遗留收尾-Flash总计划》§7 D0
> 日期：2026-11-24（Asia/Shanghai）
> 探针：`scripts/model-capability-probe.cjs`（一次性最小真实请求；只读转译适配器源码，不改 `server/`）
> 脱敏样本：`requests.md`（46 条用例的请求/响应形状表 + 关键 wire body 形状）
> 原始完整落盘：`.tmp/d0-probe/shapes-compact.json`（本机执行产物；字段与 `requests.md` 同源）
> 结论：**真实模型证据** 与 **静态源码证据** 已分开标注；代理透传一项 **BLOCKED**。

## 1. 环境与凭据（不含密钥）

| 项 | 值 |
| --- | --- |
| Node | v24.14.0 / win32 x64 |
| 模型网关 | `https://api.deepseek.com`（`targetBaseUrlHost=api.deepseek.com`） |
| 凭据来源 | `server/.env` 的 `DEEPSEEK_API_KEY`（脚本只从环境/该文件读取；未打印、未落盘、未写入证据） |
| 当前服务端配置模型 | `DEEPSEEK_MODEL=deepseek-chat` |
| 目标视觉模型 | `DEEPSEEK_VISION_MODEL` 未显式配置 → 适配器默认 `deepseek-flash` |
| 桌面直连配置 | `modelChannel=deepseek`、`modelApiBaseUrl=https://api.deepseek.com`、`modelName=deepseek-chat`、`agentTransport=direct` |
| 本地模型代理 | `127.0.0.1:17863` / `192.168.222.1:17863` 均不可达（见 §7，BLOCKED） |
| 执行时间窗 | 2026-11-24T08:43:22Z → 2026-11-24T08:44:15Z |

## 2. 能力结论矩阵

| # | 待测项 | 结论 | 真实调用证据（case id） | 备注 |
| --- | --- | --- | --- | --- |
| 1 | tools / tool_calls / 多轮工具循环 | **PASS** | `tools:deepseek-flash`、`tool-loop:deepseek-flash`、`tools:deepseek-chat`、`tool-loop:deepseek-chat` | 两个请求模型名都返回 `finish_reason=tool_calls` + 1 个 `probe_echo`，`arguments` 可 JSON 解析（14 字符）；回填 assistant `tool_calls` + `role=tool` 后第二轮 200、`finish_reason=stop`。直连通道同样 PASS：`direct:tools`、`direct:tool-loop`。 |
| 2 | 多模态 content parts（`image_url`） | **PASS（Flash）**；`deepseek-chat` 别名同样可用 | `multimodal-answer:deepseek-flash`、`multimodal-answer:deepseek-chat`、`multimodal-raw:deepseek-flash`、`multimodal-direct:config-model` | 64×64 纯红 PNG（136 B，data URL 206 字符）问答：两个模型都返回长度 3 的正文，派生断言 `answerIsRed=true`（只记录布尔值，不保存正文）。直连（当前 `modelName=deepseek-chat`）带图也 200。**但**带图 + 长回答 + 小预算会出现“空正文 + `finish_reason=length`”，见 §6。 |
| 3 | tools 与 `response_format` 是否互斥 | **不互斥（本网关实测）** | `tools+response_format:deepseek-flash`、`tools+response_format:deepseek-chat` | 同一请求同时带 `tools`、`tool_choice=auto`、`response_format={"type":"json_object"}`：HTTP 200，返回 `tool_calls`，没有 400。单带 `response_format` 也 200（`response_format:*`）。结论仅限本网关本次实测；不据此推断其它网关/代理行为。 |
| 4 | 最大输出 / 截断 / 超时 / 错误形状 | **PASS（有重要边界）** | `max-output:*`、`truncation:max_tokens_16`、`timeout:local_1ms`、`error:invalid_model`、`error:invalid_key`、`error:invalid_key_raw` | 截断标记可靠：`finish_reason=length` → 适配器 `truncated=true`。上限：请求层 `max_tokens` 8192/16384/32768/65536/131072/262144 均 200（未观察到拒绝边界；**实际生成长度未压测**）。适配器硬上限 8000；直连 4096（非法值回退 1200）。超时映射 `DEEPSEEK_TIMEOUT`（cause=`AbortError`，retryable=true）。错误体形状见 §5。 |
| 5 | 本地模型代理是否原样透传 | **BLOCKED（未实测）** | `proxy` 段（非 case） | 两个代理地址均不可达；没有一次经过代理的真实请求，因此**不能**用官方 API 的结果代替代理结论。 |

### 2.1 模型名事实（重要）

- 官方 `/models`（旁证，不用于推断能力）：`["deepseek-flash", "deepseek-v4-pro"]`。
- 当前配置 `deepseek-chat` **被网关接受**，但响应 `model` 字段为 `deepseek-flash`（`baseline:deepseek-chat`）。即：**当前配置实际就由 Flash 服务**。
- 代理时代的命名 `deepseek-v4.1-flash`、`cn:deepseek-v4.1-flash` 在官方网关均为 **400**，错误消息（已脱敏）：
  `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: …)`
  → D1 起统一用官方名 **`deepseek-flash`**；`cn:…` 只在旧代理可用时成立，本轮代理不可达，不能验证。

## 3. 每条结论如何复现

```powershell
# 仓库根目录；密钥只从 server/.env / 进程环境读取，脚本不打印
node scripts/model-capability-probe.cjs --compact
# 输出：.tmp/d0-probe/shapes-compact.json
```

`--compact` 只影响落盘格式（去掉重复的 logger 事件与逐字节 usage 键名），不改变真实请求。探针会：

1. 从 `server/.env` 读取 `DEEPSEEK_*`（可用同名环境变量覆盖），缺失即写 BLOCKED 并以退出码 2 结束；
2. 用 TypeScript `transpileModule` 把 `server/src/agent/runtime/adapters/deepseek-chat-model.ts` 只读转译到 `.tmp/d0-probe/` 后执行，**真实走适配器 wire 形状与错误映射**；
3. 复用 `desktop/model-credentials.cjs` 的 `createModelCredentials().chat()` 走直连代码路径（`safeStorage` 用只读桩替换，HTTP 形状不变；密钥不落盘）；
4. 只记录字段名/类型/长度/`finish_reason`/错误码等形状，剔除 `resultRef`（模型正文）后落盘。

## 4. HTTP（服务端适配器）vs 直连（主进程 modelChat）

| 维度 | HTTP：`DeepseekChatModel` | 直连：`desktop/model-credentials.cjs` + `modelChat` |
| --- | --- | --- |
| 请求字段 | `model/messages/temperature/max_tokens/stream`；可选 `tools+tool_choice=auto`、`response_format`、`reasoning_effort` | 固定 `model/messages/stream/max_tokens/temperature/thinking`；可选 `tools+tool_choice=auto`；**不发** `response_format`、`reasoning_effort` |
| 图片模型路由 | 带图自动切 `DEEPSEEK_VISION_MODEL`（本次为 `deepseek-flash`） | 不换模型：始终用配置的 `modelName`（本次 `deepseek-chat` 别名到 flash，图片仍成功） |
| `thinking` | 不发送（除非配置 `DEEPSEEK_REASONING_EFFORT`） | 默认显式发送 `thinking:{type:"disabled"}`；`enabled` 被拒绝 |
| `max_tokens` | 100–8000（显式值优先，硬 clamp） | 1–4096 且必须是整数；非法值**整体回退 1200**（`maxTokens=8000` → 实际 1200） |
| tools 上限 | 注册表 32（单请求 16KB schema 等约束） | 8（9 个工具 → `MODEL_REQUEST_INVALID`） |
| 图片限制 | data URL（JPEG/PNG/WebP 等，业务侧另有限制） | 只接受内联 data URL；≤3 张、单张 ≤400 KiB、合计 ≤1 MiB；外链 → `MODEL_REQUEST_INVALID` |
| 返回体 | `message/finishReason/model/usage/latencyMs/truncated` | 只有 `model/content/toolCalls/usage`；**无 `finish_reason`、无 `truncated`**（`finishReasonPresent=false, truncatedPresent=false`） |
| 错误码 | 401/403→`DEEPSEEK_AUTH_FAILED`；429→`DEEPSEEK_RATE_LIMITED`；≥500→`DEEPSEEK_UPSTREAM_ERROR`；其它（含 400/404/402/422）→`DEEPSEEK_REQUEST_REJECTED` | 401/403→`DEEPSEEK_AUTH_FAILED`；**402/429→`DEEPSEEK_RATE_LIMITED`**；400/404/422→`DEEPSEEK_REQUEST_REJECTED`；≥500→`DEEPSEEK_UPSTREAM_ERROR` |
| 超时 | `AbortController` → `DEEPSEEK_TIMEOUT`（retryable=true） | `AbortController` → `DEEPSEEK_TIMEOUT`；网络失败 → `DEEPSEEK_UNREACHABLE` |

直连 wire 形状实测（`direct:tools`）：`keys=[max_tokens,messages,model,stream,temperature,thinking,tool_choice,tools]`，`thinking=disabled`；`direct:response_format_dropped` 传入 `response_format` 后 wire 中**不存在**该字段（静态 `normalizeChatPayload` 也只接受固定字段）。直连 `direct:truncation`：`maxTokens=20` 长故事，返回 `content` 长度 74，但对象键只有 `content/model/toolCalls/usage` —— 调用方无法得知被截断。

## 5. 错误体与错误映射（真实调用）

| 用例 | 上游 HTTP | 上游错误体形状（脱敏） | 适配器错误码 | retryable |
| --- | ---: | --- | --- | --- |
| `error:invalid_model` | 400 | `{error:{code:"invalid_request_error", type:"invalid_request_error", param:null, message}}` | `DEEPSEEK_REQUEST_REJECTED` | false |
| `error:invalid_key` / `error:invalid_key_raw` | 401 | 同上；`type=authentication_error`；`message` 含上游打码的 `****0000` 与 request_id | `DEEPSEEK_AUTH_FAILED` | false |
| `model-naming:*` | 400 | 同上，message 列出官方支持的模型名 | 原始 wire（不经适配器） | — |
| `timeout:local_1ms` | 本地中止 | 无上游响应；cause `AbortError` | `DEEPSEEK_TIMEOUT` | true |

统一错误体键为 `code/message/param/type`（`keys` 实测排序后为 `["code","message","param","type"]`）。上游 429/5xx 本轮**未主动制造**，其映射仅来自源码静态证据，未作为真实调用结论。

## 6. 截断与视觉预算（D1 必须处理的坑）

真实调用链：

1. `vision-budget:raw_100`：带图 + “至少 500 词描述” + `max_tokens=100` → HTTP 200，`finish_reason=length`，`content` 长度 **0**，`reasoning_content` 长度 467，`completion_tokens=100`。
2. `vision-budget:adapter_100`：同一请求走适配器（30 被 clamp 到 100 下限）→ **`DEEPSEEK_RESPONSE_INVALID`**（retryable=true）。原因在源码：`content.trim()==='' && toolCalls.length===0` 在计算 `finishReason/truncated` 之前就抛错，**截断信号丢失**。
3. `vision-budget:adapter_2000`：同请求 `maxTokens=2000` → 200，`finish_reason=stop`，正文 3294 字符（`completion_tokens=1894`），本次耗时 **18.0 s**。
4. `stability:image-adapter:1/2/3`：同一带图小预算请求重复 3 次 → 2 次成功（正文长度 3），第 3 次 `DEEPSEEK_RESPONSE_INVALID`。说明该失败是**预算/推理抖动**，不是稳定 400。
5. `truncation:max_tokens_16`：文本请求 `maxTokens=16` 被 clamp 到 100 → `finish_reason=length`、`truncated=true`、正文长度 423。截断标记本身可用。

含义：图片请求的 `max_tokens` 不是“正文预算”，而是“推理+正文”的总预算；Flash 在图片/长回答场景会先消耗推理 token。D1 若复用图片能力，必须给足预算（P5b 的 2000 依据在本轮复核成立），并把“空正文 + length”显式区分为截断/重试，而不是当成响应非法。

## 7. 本地代理透传：BLOCKED

| 目标 | TCP | HTTP 层 | 判定 |
| --- | --- | --- | --- |
| `127.0.0.1:17863` | `ECONNREFUSED`（1 ms） | `GET /v1/models` → `fetch failed`（cause `ECONNREFUSED`） | 不可达 |
| `192.168.222.1:17863` | `ETIMEDOUT`（1514 ms） | 未执行 | 不可达 |

因此以下问题**没有答案，不得写成 PASS/FAIL**：代理是否原样透传 `tools`/`tool_choice`、是否接受 `response_format`、是否保留 `finish_reason`。仓库文档中 `cn:deepseek-v4.1-flash` 的代理结论属于 2026-11 旧环境，本轮代理不在线，不能复用为当前证据。若 D1 仍需要代理结论，必须在代理启动后用同一探针 `--models cn:deepseek-v4.1-flash` 重跑。

## 8. 对 D1（工具循环编排）的直接含义

1. **工具循环可做**：`deepseek-flash` 真实支持 `tools → tool_calls → tool 回填 → 再调用`；HTTP 与直连两条通道都验证过。D1 可直接沿用 `agent-loop` 的“每个 tool_call 必有 tool 回复”约束。
2. **不要假设 `tool_calls` 一定伴随 `stop`**：适配器把 `finish_reason=length` 映射为 `truncated=true`；D1 必须在 `truncated=true` 时拒绝执行/回放该批工具调用（即使 `arguments` 恰好可解析），否则可能执行被裁切的参数。
3. **`response_format` 不能替代工具协议**：本网关同时接受 tools + json_object，但模型仍返回 `tool_calls`；D1 的规划轮应依赖 tools/tool_choice，JSON mode 只用于最终结构化输出（且需独立校验）。
4. **模型名统一 `deepseek-flash`**：`deepseek-chat` 只是被接受到别名且实际由 Flash 服务；`cn:deepseek-v4.1-flash` 在官方网关 400。配置层可保留兼容别名，但能力判定/日志以响应 `model` 为准。
5. **直连通道信息不足**：`modelChat` 返回体没有 `finish_reason/truncated`，且丢弃 `response_format`、`reasoning_effort`，`max_tokens` 上限 4096/非法回退 1200。D1 若在直连通道做工具循环，必须自行增加截断检测（或在 IPC 返回体补 `finishReason`/`truncated`，属 D1 范围，不在 D0 改动）。
6. **视觉预算**：带图调用至少 `maxTokens≥2000`，并把 `DEEPSEEK_RESPONSE_INVALID` 在带图场景视为“可能截断”而不是“服务不可用”；默认 30s 超时对 2000 预算的图片请求偏紧（本次实测 18.0 s）。
7. **错误处理**：直连与 HTTP 的 402 映射不同（直连→RATE_LIMITED，HTTP→REQUEST_REJECTED）；D1 的错误码表不要按通道混用。
8. **代理未定**：D1 不应把“本机代理透传 tools”当作既定前提；若产品仍要支持代理，先用本探针验证。

## 9. 限制与未做

- 代理透传：**BLOCKED**（§7）。
- 上游 429/5xx 未主动制造，只有静态映射证据；真实 5xx 重试行为未测。
- `max_tokens` 只验证了请求被接受（最高 262144），没有真的生成 262144 token；实际最大生成长度未压测。
- 多模态只用了 1 张 64×64 纯色 PNG；未测真实截图、大图、多图、`detail` 参数、JPEG/WebP。
- 直连通道的 `safeStorage` 用只读桩替代（HTTP wire 形状与返回体不受影响）；未走 Electron IPC 端到端。
- `deepseek-v4-pro` 未探测（本轮目标为 Flash/当前配置）。
- 所有证据只含形状；未保存密钥、完整 prompt、模型正文、图片 base64 或用户隐私。
