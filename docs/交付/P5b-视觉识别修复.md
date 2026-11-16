# P5b 参考截图真实识别 502：定位与修复

基线 `eba1840`。只改视觉调用链，不重做 P5，不新增功能。

## 1. 结论

参考截图识别现在是**真实调用成功**：一张餐饮小程序首页截图 → 1 个可用布局 + 5 个可用组件 + 2 项只能近似 + 1 项暂不支持 + 1 个尺寸档位 + 一句识别说明 → 确认识别 → 候选模板「经典点餐」→ 采用候选 → CompositionPlan（`planId=order-classic`，`registry=2026.11.0`）→ Composer 导出 138 个文件（`treeSha256:sha256:f3285f14…`、`lockDigest:sha256:310e180a…`）。

原 502 不是「视觉模型不支持图片」这么简单，而是**两个真缺陷叠在一起**（详见 §2），另外还有一处上游偶发抖动。

## 2. 定位过程（脱敏）

只记录状态码、错误码、字节数、耗时；不打印密钥、base64 或图片内容。

| 步骤 | 手段 | 结果 |
| --- | --- | --- |
| D1 | 读真实服务端日志 | `deepseek upstream error model=cn:deepseek-v4.1-flash status=503 images=1 latencyMs=12604` —— 视觉请求确实打到上游，拿到 5xx |
| D2 | 直连 `DEEPSEEK_API_BASE_URL`（实测是本机代理 `http://127.0.0.1:17863/v1`），纯文本请求 | `200` —— 鉴权与网关正常，缺口不在 key |
| D3 | 1×1 PNG + 图片 | `400 image_invalid`（上游 code 11135「Please start a new conversation…」）—— 极小图被上游判为无效，不是模型无视觉能力 |
| D4 | 真实截图（1833×1154 PNG，406 KB） | `200`，但 `finish_reason=length`、`content` 为空串 |
| D5 | 变量隔离（顺序 × `response_format` × `reasoning_effort`） | 带 `reasoning_effort=low` 时稳定返回正文；**去掉 `reasoning_effort` 后稳定出现 `finish=length` + 空正文**（推理把这 160 token 的预算吃光）。图片放在文本前还是后都能成功，不是顺序问题 |
| D6 | 用真实截图走完整界面 | 服务端不再 502，但界面显示「没能完成识别 / 识别结果为空」——上游给了合法的 `{"layouts":[…]}`，被裁成了空 |

结论：**502 的主因是「空正文 + 视觉错误映射」；空正文之后还藏着「两侧 JSON 契约不一致」**。

## 3. 根因与修复

### 3.1 空正文被当成「视觉不可用」（错误映射）
`extractTurn` 用 `settings.maxTokens`（实测 1000）发视觉请求，推理型模型先花预算思考，返回 `finish_reason=length` 且 `content=''`，落进 `throwResponseInvalid` → 502「图片识别暂时不可用」，把一次可重试的抖动说成了服务不可用。

修复：
- 视觉请求独立预算 `VISION_MIN_MAX_TOKENS = 2000`（文本请求仍是 `settings.maxTokens`，v1 语义不变）。
- 视觉请求允许**一次重试**（`VISION_MAX_ATTEMPTS = 2`），覆盖上游 5xx/429、空正文、非法 JSON；超时与 400 不重试，避免把用户等待翻倍或做无效重试。
- 错误体新增 `cause` 字段（`empty_content_truncated` / `invalid_json` / `rejected_400` / `upstream_503` …），对外仍是 502 `DEEPSEEK_VISION_UNAVAILABLE`，客户端那套「明确降级、不覆盖项目」的行为完全不变，但消息里写清真实原因。

### 3.2 参考截图的两侧契约不一致（真正的空结果来源）
- `screen-reference.v1` 的 utterance 让模型把 `layouts / components / style / approximate / unsupported / notes` 放在**顶层**；
- Provider 只白名单透出 `reply` 与 `draftPatch`；
- 服务端却从 `providerResult.draftPatch` 里读识别结果。

模型答对也被裁成空。修复：
- 新增 `DEEPSEEK_REFERENCE_PROMPT_ADDENDUM`：`kind=reference` 时改用这份提示词，明确要求把识别结果放进 `draftPatch`，并逐字给出键名、`sm|md|lg` 取值、`#RRGGBB` 约束、以及「只能取消息里列出的 id」。
- 容忍模型仍按 utterance 写顶层：`REFERENCE_TOP_LEVEL_KEYS` 折叠进 `draftPatch`（折叠后照样过 catalog 白名单裁剪，未知 id 依然被 `rejected`，不放行任何编造内容）。

## 4. 实测证据

| 项 | 命令 / 操作 | 状态 | 证据 |
| --- | --- | --- | --- |
| 真实识别 | 界面「上传截图」注入 `pages-home-index.png`（真实微信开发者工具运行截图，39228 字节）→「开始识别」 | PASS | `docs/交付/evidence/p5b-recognition.txt`（界面文本回读）：认出 1 个可用布局、5 个可用组件，布局经典点餐；组件扫码点餐/堂食桌号/到店自取/订单进度/门店介绍；2 项只能近似、1 项暂不支持、1 个尺寸档位、识别说明一句 |
| 白名单裁剪 | 同上 | PASS | 6 个可复用项（1 布局 + 5 组件）全部命中 catalog，2 个近似与 1 个不支持都带原因；`rejected` 为空，没有未知 id 落库 |
| 确认识别 | 「确认识别结果」 | PASS | `docs/交付/evidence/p5b-recognition.txt`：「已确认识别结果，可以生成候选模板（不会覆盖当前版本）」 |
| 候选 Recipe | 「生成候选模板」 | PASS | 同文件：「候选模板：经典点餐 / 组件：扫码点餐、堂食桌号、到店自取、订单进度、门店介绍 / 可沿用的样式：1 个尺寸档位 / 保留门店资料「柑橘小馆演示店」，菜品 0 道原样不动」 |
| 采用候选 | 「采用这个候选」 | PASS | 同文件：按钮变「已采用这个候选（禁用）」，门店资料与菜品未被覆盖 |
| CompositionPlan | 用项目真实状态调用 `src/composition/planFromSession.mjs` | PASS | `docs/交付/evidence/p5b-composition-plan.json`：`planId=order-classic`、`baseTemplate=ordering-base`、`registryVersion=2026.11.0`、`warnings=[]` |
| Composer 导出 | `node scripts/composer/cli.cjs --plan <plan> --out D:\dsh_work\p5b-export --project-name p5b-recognized` | PASS | `ok:true`，138 文件，`treeSha256:sha256:f3285f14…`，`lockDigest:sha256:310e180a…` |
| 服务不可用时的降级 | 修复前的失败现场（对照） | PASS | `docs/交付/evidence/p5b-recognition.txt` 末段：界面「没能完成识别」+ 换图/开始识别/重新识别/放弃，无「确认识别结果」、无候选 —— 确认按钮不会误启用；项目未被改动 |
| 晚响应 / 非法 JSON 不覆盖项目 | `node --test test/screen-reference.test.cjs`（已有用例） | PASS | P3 用例断言晚响应与换图后的旧响应都被丢弃 |

> 截屏说明：本机 Electron 窗口被遮挡时 `Page.captureScreenshot` 会超时，因此界面证据用可直接复核的文本回读（`p5b-recognition.txt`）留存，不用 PNG。

## 5. 回归测试

新增 9 条（`server/test/deepseek-agent.provider.test.ts`，共 26 条全绿）：

| 编号 | 断言 |
| --- | --- |
| V1 | 视觉请求 `max_tokens ≥ 2000`，且同一 user 消息里同时有文本与 `image_url` |
| V2 | 空正文（`finish=length`）重试一次后成功，且不会把空正文当结果 |
| V3 | 上游 503 重试一次后成功（恰好 2 次调用） |
| V4 | 上游 400 不重试，502 + `cause=rejected_400` + 消息写明「上游拒绝了这次图片请求」 |
| V5 | 两次非法 JSON，502 + `cause=invalid_json` |
| V6 | 两次空正文，502 + `cause=empty_content_truncated`，不返回编造结果 |
| V7 | 文本请求 5xx 仍只发一次（v1 语义不变） |
| V8 | `kind=reference` 时提示词含 `draftPatch` 识别契约，且不再套用菜单照约束 |
| V9 | 模型把识别结果写在顶层时折叠进 `draftPatch` |

全量回归：`npm test` 789/789 PASS；`npm run build` PASS；`git diff --check` 干净；`server` vitest **305 passed / 85 skipped**，`Test Files 6 failed | 19 passed` —— 仍失败的 6 个是 `test/b1-*.ts` 数据库套件，前置条件未满足（MySQL 账号无 `CREATE DATABASE` 权限，`ensureDatabaseExists` 阶段报 `User was denied access on the database 'mysql'`），与本次改动无关。

## 6. 剩余阻塞与边界

- 视觉模型来自本机代理（`http://127.0.0.1:17863/v1`，模型 `cn:deepseek-v4.1-flash`）。**唯一外部缺口**：该代理对极小图会判 `image_invalid`，偶发 5xx。已用重试 + 明确错误码兜住，没有换成 Mock、固定结果或 local-demo。
- 未接真实生图；参考识别成功也不生成海报素材，界面照旧如实说明。
- 真机预览 / 体验版发布仍未验证（需要你自己的 AppID 与账号）。
- 6 个数据库套件仍受 MySQL 权限前置限制。
