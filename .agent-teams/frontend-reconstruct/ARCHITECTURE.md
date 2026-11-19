# frontend-reconstruct 协作架构摘要

本目录原先是 P0–P7 阶段「图片驱动前端重构」的多人协作过程区。过程文件
（`team.json` 的 41 条任务记录、`inbox/*.jsonl` 的 8 个信箱）**体积持续增长且只在协同时有用**，
已从版本库移出（`.gitignore` 忽略 `.agent-teams/**/inbox/`）；磁盘文件保留在本机，
不再提交也不再扩写。这里只保留一份可复查的架构摘要。

## 团队与职责

| 成员 | 职责 |
| --- | --- |
| `contracts` | 契约与 schema 工程师：`frontend-reconstruct.v1` DSL、校验器与 fixture |
| `vision` | 服务端视觉与能力工程师：参考图理解、能力快照与覆盖判定 |
| `renderer` | DSL 渲染与候选工作区工程师：DSL → Pack、私有 attempt 目录与 dry-run |
| `verifier` | 本地验证与微信运行时工程师：`frontend:verify`、truthful `BLOCKED`/`NOT_RUN` |
| `desktop` | 桌面 IPC/状态/UI 工程师：主进程门禁、渲染进程候选面板（含 B5 截图外发确认） |
| `skills` | Agent skills 与文档工程师：`.codeartsdoer/skills/**`、AGENTS/README 同步 |
| `reviewer` | 独立复核者：跨面一致性、安全拒绝与证据真实性复核 |

协作已收尾：41 条任务中 34 条完成，其余为验证类阻塞项（缺微信开发者工具/真实模型密钥时如实标
`BLOCKED`/`NOT_RUN`，不算验收通过）。

## 真正的契约与说明（仍在版本库中，继续维护）

- 契约唯一事实源：`contracts/frontend-reconstruct.v1.json`
  （由 `scripts/frontend-contract.cjs` 生成 server/desktop 两份 `contract.generated.*`，
  漂移由 `node scripts/frontend-contract.cjs --check` 与 `test/frontend-contract.test.cjs` 拦截）。
- 契约文档：[`docs/frontend-reconstruct-contract.md`](../../docs/frontend-reconstruct-contract.md)。
- 执行侧说明：[`desktop/frontend-reconstruct/README.md`](../../desktop/frontend-reconstruct/README.md)。
- 操作规范：[`.codeartsdoer/skills/README.md`](../../.codeartsdoer/skills/README.md)。
- 双跑 fixture：`test/fixtures/frontend-reconstruct/contract/cases.json`
  （服务端 `server/test/frontend-reconstruct.parity.test.ts` 与桌面端
  `test/frontend-contract.test.cjs` 跑同一批用例，结论必须一致）。

## 边界（不变）

模型只产出有界 JSON DSL；不产出任意 WXML/WXSS/JS/WXS/命令，不接受外部 URL、绝对路径或
模型指定的输出目录；候选只落在 `<userData>/projects/<projectId>/frontend-runs/<runId>/` 下，
不写 `templates/**`、不改 `miniprogram/`。缺必需能力即 `rejected`，`partial` 不等于验收通过。
