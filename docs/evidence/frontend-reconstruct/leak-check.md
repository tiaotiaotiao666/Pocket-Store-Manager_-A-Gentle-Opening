# 泄漏检查（P7）

> 范围：本功能新增/修改的文档、证据、桌面模块、服务端模块与测试；以及 `git status` 的候选资产检查。
> 执行时间 2026-11-17 03:00–03:05（+08:00）。扫描脚本只输出"文件+模式+计数"，**不打印匹配内容**。

## 1. 密钥 / 图片 base64 / prompt / 原始响应

扫描口径（只读，239 个文本文件）：`docs/**`、`.codeartsdoer/skills/**`、`desktop/frontend-reconstruct/**`、
`scripts/**`、`test/frontend-reconstruct.*`、`server/src/agent/frontend-reconstruct/**`、`server/test/**`、
`src/domain/frontendReconstruct.mjs`、`src/services/frontendReconstruct/**`。模式：

- 密钥：`sk-[A-Za-z0-9]{16,}`、`BEGIN … PRIVATE KEY`、`AKIA[0-9A-Z]{16}`、`(apiKey|api_key|DEEPSEEK_API_KEY)=['"]…`
- 图片正文：`data:image/<type>;base64,`、≥250 字符的 base64 连续串
- 其它：`system prompt` / `raw response` / `原始模型响应` 字样

命中与逐条判定（全部为**历史文档/测试替身**，无真实秘密）：

| 文件 | 模式 | 判定 |
| --- | --- | --- |
| `docs/2026-11-02-上传包构建说明.md:117-118` | `sk-…` ×2 | 文档在引用**测试里的假 key**（形如 `sk-…-key-never-real`），不是真实密钥 |
| `docs/evidence/image-provider/probe.md:32,42`、`docs/2026-11-03-全链路Agent打通-构建说明.md:34`、`docs/M5-M7…实现方案.md`、`docs/生图模型接入说明.md` | `data:image/…;base64,` | 只有 22 字符的 **MIME 前缀占位**（后面为空），无图片正文 |
| `docs/2026-10-31-P0工作台与交接-实现方案.md:1461` | ≥250 字符连续串 | 一段 IPC 方法名清单（`project…`），不是 base64 |
| `server/test/agent-turn-v2.test.ts`、`deepseek-agent.provider.test.ts`、`frontend-reconstruct.runtime.test.ts` | 假 `apiKey` 字面量 / `data:image` | 单测夹具（假 key、极小合成数据），pre-existing；不在文档/证据/产物中 |
| `server/test/*` 若干 | `data:image/…;base64,` | 多模态 wire shape 测试的 MIME 前缀/极小夹具，pre-existing |

**本轮新增的 7 个证据文件单独复扫**（`docs/evidence/frontend-reconstruct/**` 全部为文本，7 个文件）：
0 个密钥、0 个图片 base64、0 个 ≥250 字符 base64（最终文件落盘后复扫 `findings: []`）。
`real-probe-evidence.json` 只有状态/计数/耗时/摘要值；文档中出现“不含 prompt / 原始模型响应”字样只是
**声明性文字**，不是 prompt 本体或模型原文。
t37 更新后可复核性声明与死链清理已落地，再次复扫 9 个相关文档（7 个证据文件 + 计划 + 交接）：
0 密钥、0 图片 base64、0 新增 Windows 绝对路径（计划 §11 的 `E:\智能开店app` 为原有示例文本，未新增）。

- `server/.env` 被 `.gitignore:21:.env` 忽略，未进入仓库；本轮读取 key 只做存在性判断，**未打印、未写入证据**。
- 真实模型探针只落盘有界摘要；未写入图片 base64、prompt、原始响应。**临时探针脚本在 `%TEMP%`，
  原始图/脚本/候选 attempt 原件在 `.tmp/frontend-real-probe/` 与系统临时 userData，均已在 F3 清理中删除**，
  因此本目录只保留摘要、不含二进制或脚本（见 `real-probe.md` 的 provenance/UNVERIFIABLE 声明）。

## 2. 候选资产泄漏（全局 templates / miniprogram）

```text
$ git rev-parse --short HEAD                  → e2eb16a
$ git diff --quiet -- templates miniprogram   → exit 0
$ git status --porcelain -- templates miniprogram → （空）
$ ls templates/frontend-packs                 → 仅 warm-home-menu
$ Test-Path templates/frontend-packs/fr-5038d20dde55 → False
```

t13 的真实候选 `fr-5038d20dde55`（8 文件，摘要见 `real-probe-evidence.json`）曾写系统临时 userData 的
`projects/p7-real/frontend-runs/frun-p7-real/attempts/attempt-1`；**该临时目录与候选原件已随会话/F3
清理删除，仓库未归档候选**。`templates/`、`miniprogram/`、全局 Registry 摘要均未变化。
`miniprogram/` 的摘要失败是 HEAD 基线（见 `baseline.md`），不是候选写入造成的（候选从未写到该目录）。

## 3. 探针残留（执行时清单，现由 captain 在 F3 收口清理）

| 路径 | 执行时状态 | 当前状态 / 说明 |
| --- | --- | --- |
| `server/src/agent/frontend-reconstruct/.write-probe` | 0B，被目录内 `.gitignore`（`/.write-probe`）忽略 | **已删除（Test-Path=False）**：t4 的 ACL 写权限探针，不会进入提交 |
| `server/src/agent/frontend-reconstruct/.gitignore` | 328B，自忽略（`/.gitignore`），同时忽略 `/.write-probe`、`/page-capabilities.snapshot.{json,ts}` | **已删除（Test-Path=False）**：为隐藏上述探针与 t19 合并前的页面事实中间产物而临时添加；`server/src` 无任何源码 import `page-capabilities.snapshot`，`check-packaging` 也不要求它 |
| `server/.tmp-probe/`（`frontend-real-probe.mts`、`real-probe.test.ts`、`pagefacts.test.ts`、`.gitignore`） | gitignored（自身 `.gitignore: *`） | **已删除（Test-Path=False）**：P1 真实模型探针脚本，不含密钥（只判断 `.env` 是否存在） |
| `.tmp/frontend-real-probe/`（曾含 3 张合成图 + `evidence.json` + `gen_images.py`） | gitignored（根 `.gitignore: *.tmp` 命中 `.tmp/`） | **已删除（Test-Path=False）**：合成线框图（28156/25739/8475B，无品牌素材）；删除后仓库只剩摘要，导致真实链路 `UNVERIFIABLE`（见 `real-probe.md`）。不得为了保住 PASS 而重造这些文件；如需恢复可复核性，应新建取证任务并归档图片 sha256 与生成脚本 |

以上文件**从未进入 git 提交**；当前工作区已由 captain 在 F3 收口清理（`Test-Path=False`，见
`README.md` §已知遗留）。本节保留为**执行时历史记录**，不代表当前仍存在。

## 4. 结论

- 仓库（含本轮新增文档/证据）**未发现真实密钥、图片 base64 正文、完整 prompt 或原始模型响应**。
- `templates/`、`miniprogram/`、全局 Registry **无候选资产泄漏**。
- 执行时探针残留已由 captain 在 F3 收口清理；本目录只保留文本证据与**不可复核的摘要**，
  不含图片二进制、生成脚本或候选工程。探针残留清单保留为历史记录。
