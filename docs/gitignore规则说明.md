# .gitignore 规则说明（本轮构建）

本轮只做一件事：把根目录 `.gitignore` 从 15 行的粗略版本，补成覆盖「桌面生成器 + 小程序 + NestJS 后端 + 本机工具链」四类产物的完整规则。子工程（`server/`、`miniprogram/`）**不需要**再各写一份 `.gitignore`，因为本文件所有目录规则都不带前导斜杠，会匹配任意层级。

## 一、规则分区与理由

| 分区 | 规则 | 为什么这样写 |
| --- | --- | --- |
| 依赖 | `node_modules/`、`.pnpm-store/` | 同时覆盖根、`server/`、`miniprogram/`，避免三个工程各写一遍 |
| 构建产物 | `dist/`、`release/`、`.vite/`、`*.tsbuildinfo` | `dist/` 覆盖 Vite 根产物与 `server/dist`（Nest `nest build` 输出）；`release/` 是 electron-builder 的输出目录；`*.tsbuildinfo` 是 TypeScript 增量构建的本地缓存 |
| 环境变量与密钥 | `.env`、`.env.*`、`!.env.example`、`*.pem`、`*.key` | 覆盖根 `.env` 与 `server/.env`；`!` 规则让任意层级的 `.env.example` 仍可提交，保证新同学能照抄配置项 |
| 本机工具链 | `.tools/`、`.npm-cache*/`、`.npm-logs/`、`.mysql-data/`、`.mysql/` | 无管理员权限时用的 MySQL 8.4 ZIP 免安装实例位于 `.tools/`，数据目录、npm 缓存与安装日志都属于本机状态，提交上去只有噪声 |
| 数据库遗留 | `*.sqlite`、`*.sqlite3`、`*.db-journal` | 早期曾评估 SQLite 方案，保留规则防止误提交；当前正式方案是 MySQL，未忽略 `*.db` 以免误伤未来可能的样例文件 |
| 日志与临时 | `*.log` 及各包管理器 debug 日志、`*.tmp`、`*.swp`、`*~` | 统一兜底；`.npm-logs/` 虽有独立规则，单文件日志也能被 `*.log` 收住 |
| 测试与覆盖率 | `coverage/`、`.nyc_output/`、`test-results/` | Vitest 覆盖率与测试报告是本地产物 |
| 小程序本地配置 | `project.private.config.json`、`miniprogram_npm/`、`.miniprogram-ci/` | `project.config.json` 必须提交（团队共享 AppID 与编译配置），`private` 版本是微信开发者工具写入的**本机个人**配置；`miniprogram_npm/` 是小程序构建 npm 后的产物 |
| 编辑器 / 操作系统 | `.vscode/`、`.idea/`、`*.iml`、`.fleet/`、`.DS_Store`、`Thumbs.db`、`Desktop.ini`、`$RECYCLE.BIN/` | Windows 为主战场，顺带兼容 macOS / JetBrains |
| 生成器本地输出 | `generated-projects/` | 用户用桌面端生成的小程序工程属于本机资产，不入库 |
| AI 工具本地状态 | `.codeartsdoer/`、`.merkle-snapshot.json` | 前者是本机 agent 工作区（内部已有 `*` 的自忽略规则），后者是工具生成的文件哈希快照，均无共享价值 |

## 二、刻意保留、不被忽略的目录

- `generated-projects-test/`：仓库内的回归样例小程序工程，虽与 `generated-projects/` 名字相近，但规则 `generated-projects/` 只精确匹配该目录名，不会吞掉它。
- `server/prisma/migrations/`、`server/prisma/schema.prisma`、`server/prisma/seed.ts`：数据库结构与种子是交付物，必须提交。
- `server/.env.example`、`.env.example`：唯一允许入库的环境变量文件，只放占位值。
- `docs/`、`templates/`、`miniprogram/`、`src/`、`test/`：源码与契约文档。

## 三、验证方式（可复现）

逐条检查某路径是否被忽略：

```bash
git check-ignore -v <path>
```

本轮实测结果（23 条命中检查 + 全部已跟踪文件交叉验证）：

- 正确忽略：`node_modules/`、`server/node_modules/`、`dist/`、`server/dist/`、`release/`、`.tools/mysql-data/`、`.npm-cache*/`、`.npm-logs/`、`.merkle-snapshot.json`、`.codeartsdoer/`、`miniprogram/project.private.config.json`、`server/.env`、`generated-projects/*`。
- 正确保留：`.env.example`、`server/.env.example`、`docs/`、`src/`、`test/`、`templates/`、`miniprogram/`、`server/prisma/`、`package-lock.json`、`generated-projects-test/`。
- 交叉验证：对 `git ls-files` 的全部 97 个已跟踪文件逐个执行 `git check-ignore`，**无一条被新规则误伤**。
- 效果：`git status` 中 `.merkle-snapshot.json` 已不再出现，其余未跟踪项均为本轮及上一轮的真实源码与文档。

## 四、后续增补约定

1. 新增产物目录时，优先在根 `.gitignore` 加一条**不带前导斜杠**的规则，而不是新建子级 `.gitignore`。
2. 若某目录既有「本机产物」又有「需要提交的样例」，不要用宽泛的目录名规则，应显式写出路径，或像 `generated-projects-test/` 一样用不同命名隔离。
3. 新增环境变量文件一律命名为 `.env.example`，否则会被 `.env.*` 吃掉。