# 仓库级 Agent Skills 索引

> 入口约定见根 [`AGENTS.md`](../../AGENTS.md)；图片驱动前端重构的契约见
> [`docs/frontend-reconstruct-contract.md`](../../docs/frontend-reconstruct-contract.md)。
> 本目录的 skill 是**操作规范**，可执行校验仍在 TS/CJS（服务端 schema、桌面 renderer、
> Composer、dry-run、修复与微信验证脚本）中；skill 不替代任何门禁。

## 启用状态

统一登记在 [`ProjectSkillStatus.txt`](ProjectSkillStatus.txt)（`<name>=true` 表示启用）。

## 技能清单

| Skill | 触发场景 | 主要产物/门禁 | 配套入口 |
| --- | --- | --- | --- |
| [`wechat-template-builder`](wechat-template-builder/SKILL.md) | 正式资产入库：新增/扩展 UI Block、Feature Pack、FrontendPack、Recipe 并冻结进全局 Registry | 版本化正式资产、Plan、Composer 导出、`registry:check`/`catalog:check`、微信真实编译回归 | `node scripts/registry-check.cjs --write`、`npm run composer:build`、`npm run composer:verify` |
| [`wechat-visual-spec`](wechat-visual-spec/SKILL.md) | 一张参考截图 → UiRequirement/VisualSpec；识别分区/配色/尺寸，标注未知与低置信度 | 有界 requirement JSON；`planned`/`needs-input`/`rejected` 三态 | `POST /api/v1/agent/frontend-reconstruct`、`server/src/agent/frontend-reconstruct/` |
| [`wechat-capability-coverage`](wechat-capability-coverage/SKILL.md) | 判断需求能否用现有 Catalog/Base 能力实现、最小改动路径、是否缺必需能力 | `CapabilityCoverageReport`（covered/partial/rejected）；缺能力即拒绝 | `get_frontend_capabilities`/`check_frontend_coverage`、`node scripts/frontend-capabilities.cjs --check` |
| [`wechat-frontend-pack-authoring`](wechat-frontend-pack-authoring/SKILL.md) | VisualSpec → `frontend-pack-draft.v1` 受控 DSL；私有 renderer/物化/overlay | 私有 attempt 的 `candidate/` + `overlay/`；DSL 白名单与 slot fallback | `desktop/frontend-reconstruct/{schema,render,materialize,registry-overlay}.cjs` |
| [`wechat-frontend-verification`](wechat-frontend-verification/SKILL.md) | 候选 dry-run → 真实微信验证 → 截图对照 → 最多 2 轮修复 | `PASS/FAIL/BLOCKED/NOT_RUN`、结构化 issues、证据与截图清单 | `node scripts/frontend-verify.cjs --attempt <attemptDir> [--runtime]` |

## 共同红线（所有 skill 一致）

1. 模型只产出有界 JSON DSL；**不写任意 WXML/WXSS/JS/WXS/HTML、不执行任意命令、不接受外部 URL/绝对路径**。
2. 用户私有候选**不写正式 `templates/**`、不重冻结全局 Registry、不改 `miniprogram/` 镜像**；正式入库只走 `wechat-template-builder`。
3. 能力事实只来自服务端打包的只读快照与 Base 事实，模型/客户端不能声明 `covered`。
4. 未执行、工具不可用、图片无法判断时必须 `needs-input`/`rejected`/`BLOCKED`/`NOT_RUN`，不得伪造通过或像素级承诺。
5. 日志、响应、证据、fixture 不含 API Key、base64 图片正文、完整 prompt、原始模型响应或本机绝对路径。
6. 所有过程报告带 `runId`/`attempt`/状态/耗时；过程卡只显示真实工具标签（如 `get_frontend_capabilities`、`dry-run`、`verify-runtime`）与有界摘要，不展示内部敏感细节。

## 新增/修改 skill 的约定

- 目录名 = frontmatter `name` = 文件名 `<name>/SKILL.md`。
- 必须包含章节：`触发条件`、`必读文件`、`输入`、`输出`（含 schema 示例）、`禁止项`、`验收`、`失败退出`。
- 结构由 `test/frontend-reconstruct.skills.test.cjs` 守护；修改后运行：

```powershell
node --test --test-isolation=none test/frontend-reconstruct.skills.test.cjs
```
