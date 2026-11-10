# Agent 工具体系与交互健壮性

> 日期：2026-11-10
> 状态：活动交接（规划态）。上游契约：`docs/agent-turn-contract.md`、`docs/2026-11-03-全链路Agent打通-构建说明.md`。
> 一句话结论：**链路已能跑通真实模型，但 AI 调用仍是「单轮 JSON mode + 手写白名单」，交互层缺 markdown 渲染与边界校验；本交接定义把这层升级为「function calling + zod + 工具权限 + 轮次约束」的任务分解。**
> 范围红线：**华为云相关（RDS / DCS / MaaS 迁移、云上 Web Demo）本阶段不做**，先把产品本身做扎实。
> 前序活动交接：`docs/handoff/当前工作区交接.md`（其 P0 环境阻塞已于 2026-11-10 实测解除，见第 4 节）。

## 1. 现在做到哪一步（2026-11-10 实测）

本机全链路已可运行，且脱离调试工具独立启动：

- 四个端口全部监听：MySQL `:3306`、后端 `:3000`、Vite `:5173`、模型代理 `:17863`。
- 后端 `readyz` 返回 `database=ok`、`cache=memory`（Redis 未启用，走内存降级属预期）。
- 真实模型链路可用：`POST /api/v1/agent/turn` 与 `POST /api/v1/agent/template-revise` 均返回 200，`provider=deepseek`、`mock=false`。
- 桌面端可用：Electron 窗口正常拉起，Vite dev server 正常，用户数据目录已能落盘。
- 启动方式为双击 `启动全部.cmd` → `scripts/start-all.ps1`，不依赖任何调试工具。

### 1.1 本阶段已修掉的三个环境缺陷

| 缺陷 | 根因 | 处置 |
|---|---|---|
| 桌面端自检「本地数据目录」EPERM | 本机 Electron 主进程无法写入 `%APPDATA%` / `%LOCALAPPDATA%` / `Documents` / `Desktop` / `~`，同会话下 `node.exe` 却可写（路径前缀级限制，ACL 无异常） | `desktop/main.cjs` 增加运行时目录探测回退（逐候选 `mkdir + 写探针 + 删除`，首个成功者胜出），并迁移 `config.json` 与 `projects` |
| IDE 调试 shell 里 Electron 以纯 Node 启动 | 调试环境注入了 `ELECTRON_RUN_AS_NODE=1`，`require('electron')` 退化为路径字符串 | `scripts/start-all.ps1` 启动桌面端前显式清除该变量 |
| 「应用修改」持续 `AGENT_HTTP_5XX` | `:3000` 被一个 14:16 从终端启动的旧后端进程占用，进程内持有过期鉴权状态，上游返回 401 → 被映射为 502 | 重启后端；同时暴露 `start-all.ps1` 的判定缺陷（见 2.1） |

## 2. 需要改进的问题（按优先级）

### 2.1 P0 — 启动脚本只判端口不判健康（真缺陷，会反复引发 5XX）

`scripts/start-all.ps1` 判断后端是否已在运行的方式是“`:3000` 端口是否可连接”，可连接即跳过启动。**端口可连接 ≠ 服务健康**：上一个缺陷里那个坏进程长期占着 `:3000`，脚本每次都跳过启动，导致坏的永远修不好。

要求：改为真实健康探测（`GET /api/v1/readyz` 返回 200 且 `database=ok` 才算健康）。端口通但不健康时，必须显式告警并给出处置路径，不得静默跳过。同一缺陷同样存在于 `:5173`、`:17863` 的判定，一并处理。

### 2.2 P1 — AI 调用模式为单轮 JSON mode，无工具语义

现状（`server/src/agent/provider/deepseek-agent.provider.ts`、`server/src/agent/presentation/template-revise.provider.ts`）：

- 请求体固定为 `model / messages / temperature: 0.2 / max_tokens / stream: false / response_format: {type:'json_object'}`。
- **无 `tools`、无 `tool_choice`，代码中无任何 `tool_calls` 解析**。
- 约束靠三层：系统提示词约定字段 → `json_object` 保证语法合法 → 服务端手写白名单（`AGENT_TURN_V2_ALLOWED_KEYS`、`ALLOWED_IMAGE_KEYS`）逐键过滤。
- 单轮单次请求，无 loop、无工具概念、无中间观测。

### 2.3 P1 — LLM 输出校验靠手写，规模已偏大

`agent-draft.validator.ts` 470 行 + `agent.service.ts` 241 行中的白名单逻辑，全部手写。`json_object` 只保证语法，不保证字段匹配，因此每个字段都要人工兜底。模糊指令兜底文案（如「未识别到可执行的展示修改…」）本质是这套手写校验的产物。

### 2.4 P1 — 错误码粒度不足

上游 401/403/429/5xx 被压平成 `AGENT_HTTP_5XX` 一类通道错误，前端只能统一显示「服务暂时不可用」。用户无法区分「配置错了」与「网络超时」与「模型拒绝了这次请求」。

### 2.5 P2 — 交互层缺 markdown 渲染

`src/components/agent/AgentIntakePanel.jsx:61-62` 直接用 `<div className="agent-reply">{message}</div>` 渲染纯文本；`src/App.jsx:1889` 以 `reply={agent.reply}` 传入。模型返回带换行、列表、加粗的文案会被压成一段。

### 2.6 P2 — 前端输入边界校验缺失

utterance 长度/空白、图片类型与真实格式（magic number）、重复提交、面板关闭时在途请求取消、按错误码差异化文案，均未系统化处理。

### 2.7 P2 — 无 AI 编排框架，全部手写 HTTP

`server/package.json` 依赖仅 NestJS 三件套 + `@nestjs/config` + Prisma + `class-validator/transformer` + `ioredis` + `rxjs`。**无 OpenAI SDK、无 LangChain/LlamaIndex/Vercel AI SDK、无向量库**。请求走原生 `fetch`，超时用 `AbortController` 手写，状态码映射手写。

> 这条不算缺陷，是当前架构选择（零依赖、可 mock、断网可测）。**保留该选择**，本阶段只补结构化约束，不引入编排框架。

## 3. 任务分解

### T0 前置验证（阻断性，未通过则整条路线改道）

必须先实测三件事，任一项不成立，本节 T2–T4 全部作废：

1. 本地代理 `:17863` 是否透传 `tools` 参数（返回 `tool_calls` 而非忽略或 400）。
2. `tools` 与 `response_format` 是否互斥（多数模型互斥；若互斥，切 tools 时必须移除 `response_format`）。
3. 具体模型 `cn:deepseek-v4.1-flash` 是否支持 tool calling（聚合网关对部分模型只做纯文本转发，`/v1/models` 列得出不代表支持）。

**不通过时的退路**：保留单轮结构，改用 `response_format: {type:'json_schema'}` 做结构约束。可拿到 zod 校验约八成收益，工作量降至约 1 天，但放弃多步工具编排。

**验收**：产出一次真实请求的请求体与响应体摘录（不得记录 key），写入本文档第 4 节。

### T1 zod 工具 schema 与注册表（纯新增，不碰现有链路）

- 新增 `server/src/agent/tools/tool-registry.ts`：`name → { zodSchema, allowedPhases, allowedSurfaces, mutating, maxCallsPerTurn, handler }`。
- 新增 `store-tools.schema.ts`、`presentation-tools.schema.ts`。
- 新增 `json-schema.ts`：由 zod 生成 `tools[].parameters`。
- **一份 schema 两用**：既生成 function calling 的 `parameters`，又做运行期 `parse` 校验，不写两遍。
- zod 取 v4，用其原生 `z.toJSONSchema()`，不引第三方转换器。

**职责边界（须在答辩中说明，避免被质疑重复造轮子）**：`class-validator` 继续管 HTTP 入参 DTO，`zod` 只管 LLM 输出。两套体系服务两个信任域，不是重复实现。

**验收**：注册表单测覆盖 schema→JSON Schema 生成一致性、非法参数被 `parse` 拒绝。

### T2 工具集设计

开店阶段（`phase=store-info`）：

| 工具 | 语义 | 权限 |
|---|---|---|
| `set_store_profile` | 门店名/品类/营业时间/取餐方式 | 写 draft，max 5 次/轮 |
| `add_dishes` | 批量加菜品（单次 ≤20） | 写 draft，累计 ≤60 |
| `remove_dish` | 按名删除菜品 | 写 draft |
| `ask_user` | 缺信息时反问，带 options | 只读，无副作用 |
| `finalize_draft` | 声明信息齐备 | 只读，仅当 `missingFields` 为空时允许 |

模板修订阶段（`phase=template-pick`）：

| 工具 | 映射到既有 patch 域 | 权限 |
|---|---|---|
| `apply_theme` | `theme.primaryColor / secondaryColor / fontFamily` | 路径白名单 |
| `update_copy` | `copy.storeName / heroTitle / heroSubtitle / cta` | 路径白名单 |
| `reorder_sections` | `layout.sections[]` | 仅已知 section id |
| `set_section_style` | 尺寸/间距 | 数值范围 clamp |
| `no_change` | 空操作 + 原因说明 | 兜底，替代现有自然语言兜底文案 |

**关键约束**：工具的落地必须复用 `server/src/agent/presentation/presentation-patch.ts`（923 行）既有 patch 域定义与校验，**不得新写一套 patch 逻辑**。该文件是执行层，本阶段不动。

**验收**：每个工具都有正常路径 + 越权路径的单测。

### T3 tool-loop runner（轮次 / 超时 / 去重 / 回灌）

新增 `server/src/agent/tools/tool-loop.runner.ts`，建议初值：

```ts
const LOOP_LIMITS = {
  maxRounds: 4,             // 最多 4 次模型往返
  maxToolCallsPerRound: 6,  // 单轮并发工具数
  totalToolCalls: 12,       // 单次会话总工具调用上限
  totalTimeoutMs: 25_000,   // 整个 loop 总预算（现行是单次 15s）
  perRoundTimeoutMs: 12_000,
  resultTruncateChars: 2000 // 回灌 tool_result 截断
};
```

轮次耗尽**不得抛 5XX**，必须返回已完成的部分 patch，附 `status: 'partial'` 与 `stopReason: 'MAX_ROUNDS' | 'TIMEOUT' | 'TOOL_ERROR'`，由前端展示「已完成 X 项，剩余未处理」。

同工具同参数重复调用须短路并回灌缓存结果，防止模型原地打转。

**验收**：单测覆盖①正常单工具②多工具同轮③轮次耗尽返回 partial④参数非法⑤编造工具名⑥phase 越权⑦中途超时。

### T4 切流：`agent-turn` 与 `template-revise` 改为 tools 驱动

- 改 `deepseek-agent.provider.ts`（348 行）、`template-revise.provider.ts`（447 行）：由 runner 驱动，移除 `response_format`（若 T0 判定互斥）。
- 改 `agent.service.ts`（241 行）：白名单逻辑下移至注册表，service 只做编排。
- 改 `agent.types.ts`（120 行）：新增 `ToolCall`、`ToolResult`、`LoopTrace`。
- **保留**现有错误码映射（`DEEPSEEK_AUTH_FAILED` / `DEEPSEEK_RATE_LIMITED` / `DEEPSEEK_TIMEOUT` 等），这套映射本身是对的，问题只在粒度。

**验收**：两阶段端到端各跑一次真实模型，记录 `latencyMs`、`toolCalls` 次数、最终 patch 内容，回填第 4 节。

### T5 错误码治理

新增：`TOOL_NOT_FOUND`(400)、`TOOL_ARGS_INVALID`(400，带 field 级 detail)、`TOOL_FORBIDDEN`(403)、`TOOL_BUDGET_EXCEEDED`(429)、`AGENT_MAX_ROUNDS`(200，返回部分结果非错误)。

前端按错误码给差异化文案，不再统一「服务暂时不可用」。

**验收**：每个错误码有对应前端文案，且有一次真实触发记录。

### T6 markdown 渲染

选型：**`react-markdown` + `remark-gfm`**，不用 `marked` + `DOMPurify`。理由：`react-markdown` 默认不渲染 raw HTML，天然免疫 XSS，无需额外 sanitize 依赖。Electron 渲染进程里 XSS 后果比浏览器更重（可能触达 IPC），此项优先。

- 新增 `src/components/common/MarkdownReply.jsx`：限制 `allowedElements`（禁 `img`/`iframe`/`script`），链接 scheme 白名单仅 `http`/`https`。
- 接入 `src/components/agent/AgentIntakePanel.jsx`、`src/components/flow/TemplateRevisePanel.jsx`。
- Electron 外链必须由主进程 `setWindowOpenHandler` 拦下并改走 `shell.openExternal`，实施时确认 `desktop/main.cjs` 现状。
- **只做加法**：不重构 `src/App.jsx`（2145 行巨型组件，动内部状态流转风险高）。

**验收**：含列表/加粗/代码块/裸链接的回复正确渲染；`<img onerror>`、`javascript:` 链接被剥离；外链走系统浏览器。

### T7 前端边界校验

| 校验点 | 规则 |
|---|---|
| utterance | 1–500 字，trim 非空，拒绝纯空白 |
| 图片 | ≤4 张、≤5MB/张、仅 png/jpeg/webp，**magic number 校验**（不只看 MIME） |
| 颜色输入 | 前端预检 `#RRGGBB` / 中文色名映射，减少无效请求 |
| 重复提交 | 请求中禁用按钮 + 幂等 key |
| 取消 | `AbortController`，切页/关面板时取消在途请求 |

**验收**：每条规则有对应交互验证记录。

### T8 测试与回归

- 单测：T1–T5 各阶段验收项。
- 冒烟：开店全流程 + 模板修订全流程，真实模型各一次。
- **回归注意**：`mock=true` 通路必须仍然可用；`test/*.test.cjs` 中依赖固定 JSON 结构的断言需随 T4 一起改；不得为让门禁变绿而删除或放宽测试。

## 4. 真实命令与结果（勿改写）

### 4.1 2026-11-10 环境恢复实测

| 检查 | 结果 |
|---|---|
| 端口 `3306` / `3000` / `5173` / `17863` | 全部可连接 |
| `GET /api/v1/readyz` | 200，`database=ok`，`cache=memory` |
| `POST /api/v1/agent/turn` | 200，727 字节，`model=cn:deepseek-v4.1-flash`，`latencyMs=2574` |
| `POST /api/v1/agent/template-revise` | 200，474 字节，`provider=deepseek`，`mock=false`，`latencyMs=3831`，`changeCount=2`，`patch.theme.primaryColor=#FF8A3D` |
| 后端日志 | 启动后 `errors=0` |

### 4.2 2026-11-10 缺陷复现记录（修复前）

| 现象 | 证据 |
|---|---|
| `agent/turn` 与 `template-revise` 均返回 502 且 body 为空 | 前端据此显示 `AGENT_HTTP_5XX` |
| 直连模型代理带正确鉴权 | 200，927 字节（证明问题不在模型通道与密钥） |
| `:3000` 占用者 | 一个早于当轮启动、由终端拉起的旧后端实例 |

### 4.3 T0 前置验证

**未执行**。需在实施前补测并回填本节。

## 5. 改动范围与规模

### 5.1 新增文件（后端约 700 行）

| 文件 | 估算 |
|---|---|
| `server/src/agent/tools/tool-registry.ts` | ~180 |
| `server/src/agent/tools/store-tools.schema.ts` | ~150 |
| `server/src/agent/tools/presentation-tools.schema.ts` | ~200 |
| `server/src/agent/tools/tool-executor.ts` | ~150 |
| `server/src/agent/tools/tool-loop.runner.ts` | ~120 |
| `server/src/agent/tools/json-schema.ts` | ~60 |

### 5.2 修改文件（后端 4 个 / 前端 4 个）

| 文件 | 现有行数 | 改法 |
|---|---|---|
| `server/src/agent/provider/deepseek-agent.provider.ts` | 348 | 改由 runner 驱动，去 `response_format` |
| `server/src/agent/presentation/template-revise.provider.ts` | 447 | 同上，复用同一 runner |
| `server/src/agent/agent.service.ts` | 241 | 白名单下移，只做编排 |
| `server/src/agent/agent.types.ts` | 120 | 加工具类型 |
| `src/components/agent/AgentIntakePanel.jsx` | — | 接 MarkdownReply + 输入校验 |
| `src/components/flow/TemplateRevisePanel.jsx` | 218 | 接 MarkdownReply + 颜色预检 |
| `src/services/agentTurn/agentImageUpload.js` | 328 | 补 magic number 与数量/大小校验 |
| `src/services/agentTurn/agentTurnService.js` | 191 | utterance 校验 + AbortController |

新增前端 `src/components/common/MarkdownReply.jsx`（~70 行）。

**不动**：`server/src/agent/presentation/presentation-patch.ts`（923 行，执行层复用）、`src/App.jsx`（2145 行，只接线不重构）。

### 5.3 工作量估算

净增约 1000–1300 行，约 3.5 个工作日（含测试）。其中后端中等偏大，前端小。

## 6. 三个必须提前知道的风险

1. **延迟会明显变长**。`template-revise` 现为 3831ms 单次调用；切 tools 后典型 2 轮（tool_call → tool_result → final），预计 6–9 秒。**必须在 UI 给「正在调用工具 xxx」的过程提示**，否则用户会判定卡死。这条对体验的影响大于代码本身。
2. **回归基线会变**。现有冒烟依赖固定 JSON 返回结构，T4 之后断言必须同步修改。
3. **`src/App.jsx` 是风险点**。前端改动看着只有 4 个文件，但 `agent.reply` 的状态流转全在这个 2145 行的单文件里，动内部逻辑容易连带出其他缺陷。

## 7. 优先级建议（时间有限时按此取舍）

| 优先级 | 内容 | 理由 |
|---|---|---|
| 高 | T6 markdown、T7 输入校验、T5 错误码 | 体验与健壮性肉眼可见，合计约 1.5 天 |
| 高 | 2.1 启动脚本健康探测 | 真缺陷，会反复制造 5XX |
| 中 | T1–T4 function calling | 评委看不出用的是 tools 还是 JSON mode，但「多轮工具编排」在答辩里可讲 |
| 低 | 引入 AI 编排框架 | 明确不做（见 2.7） |

若只剩 3 天：只做 2.1 + T5 + T6 + T7。

## 8. 未解决问题（不属于本阶段）

1. `presentation` 补丁未持久化，重开项目丢失（承自前序交接 P1）。
2. `assets.images` 无删除动作。
3. `AgentExceptionFilter` 未透出 422 `details`。
4. `composer:verify` 的 `PATH_ESCAPE` 既有缺陷未修。
5. `Plan.components` 不覆盖 Base 同名组件（`emit.cjs:654-701`）；Composer 产物固定 `touristappid`，编译需副本替换 AppID。

## 9. 下一步（按顺序）

1. **补做 T0 前置验证**，结果回填 4.3。这是唯一可能让 T2–T4 整条作废的未知数，先排除最划算。
2. 修 2.1 启动脚本健康探测（独立、低风险、立即降低故障率）。
3. 按 T6 → T7 → T5 做交互层（无需依赖 T0 结论）。
4. T0 通过后，按 T1 → T3 → T2 → T4 做工具层。
5. T8 全量回归，回填第 4 节真实结果。

## 10. 禁止项

- 不得在 T0 未验证的情况下直接改 provider 请求体。
- 不得新写一套 patch 逻辑替代 `presentation-patch.ts`。
- 不得引入 LangChain / LlamaIndex / OpenAI SDK 等编排框架（2.7 的选择明确保留）。
- 不得把密钥写入前端、导出工程、日志、仓库或交接文档。
- 不得为让门禁变绿而删除或放宽测试。
- 不得回滚工作区既有未提交改动（含 `docs.rar`、`package.json.bak-*`、`.dev-data/` 等用户资产）。
- 不得宣称任何未实测的验收通过。

## 11. 明确范围外（本阶段不做）

- 华为云 RDS / DCS / MaaS 迁移、云上 Web Demo 部署。
- 比赛交付物（LICENSE/NOTICE、SPDX 头、上游 fork 溯源、五阶段证据包、作品信息收集表）。
- 真机验收、L3/L4 安装包验收、海报视觉人工目视。

以上留待产品本身稳定后另行立项。
