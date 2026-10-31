# Bug 台账

> 本目录是项目中**唯一**的缺陷名录。待修复与已修复缺陷都必须在此登记。
> 详情文档：`open/`（待修复）与 `fixed/`（已修复）。索引与状态以本文件为准。

## 1. 登记规则

1. **编号递增且永不复用**：从 `BUG-001` 起顺序分配；修复、关闭、重开都不改编号。
2. **状态只能取以下四种**：`待修复`、`修复中`、`已修复`、`不修复`。
3. **严重级别**：
   - `P0 阻断`：主流程不可用（白屏、导出失败、服务起不来）。
   - `P1 高`：关键流程卡死、安全边界失效、数据错误。
   - `P2 中`：局部功能错误、静默失败、体验缺陷。
   - `P3 低`：测试/文档/脚本不一致，不影响当前主流程。
4. **每条必须有**：现象、根因、影响范围、修复方案或修复记录、验证证据。未验证的事项必须显式写“未验证”，不得用“已修复”掩盖。
5. **新增流程**：复制 `TEMPLATE.md` → 写入 `open/BUG-0xx-主题.md` → 在下方名录登记。
6. **修复流程**：把文件从 `open/` 移到 `fixed/`，补齐验证证据，更新名录状态列与统计。链接迁移后全仓检索旧路径。
7. **不重复**：同一根因的多个表象合并为一条 bug，在“现象”里列出全部表现。

## 2. 待修复名录

| 编号 | 标题 | 级别 | 状态 | 影响面 | 详情 |
| --- | --- | --- | --- | --- | --- |
| BUG-006 | 安装包缺少 `src/`，打包后导出功能不可用 | P0 阻断 | 待修复（待安装包实测确认） | Electron NSIS 安装包 | [详情](open/BUG-006-electron-package-missing-src.md) |
| BUG-007 | Agent 鉴权只校验 Bearer 形式，未接入 `SessionAuthGuard` | P1 高 | 待修复 | 后端 `POST /api/v1/agent/turn` | [详情](open/BUG-007-agent-auth-guard-bearer-only.md) |
| BUG-008 | 生成器主题色替换未命中时静默失败 | P2 中 | 待修复 | 导出工程 `app.wxss` | [详情](open/BUG-008-generator-theme-replace-silent-fail.md) |
| BUG-009 | `test:desktop` 指向不存在的测试文件 | P3 低 | 待修复 | 根目录测试脚本 | [详情](open/BUG-009-desktop-contract-test-missing.md) |

## 3. 已修复名录

| 编号 | 标题 | 级别 | 状态 | 影响面 | 详情 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | 小程序导出工程 `require` JSON 导致四个页面全部白屏 | P0 阻断 | 已修复 · 待微信开发者工具复验 | 导出模板、生成器、已导出工程 | [详情](fixed/BUG-001-mini-program-store-config-json.md) |
| BUG-002 | STORE_INFO 主操作按钮随聊天流滚出视口，流程卡住 | P1 高 | 已修复 | 桌面会话工作台 | [详情](fixed/BUG-002-store-info-primary-action-offscreen.md) |
| BUG-003 | 跳过开场后剩余消息未一次性展示 | P2 中 | 已修复 | 会话揭示动画 | [详情](fixed/BUG-003-skip-intro-reveal-flush.md) |
| BUG-004 | `.env` 覆盖真实进程环境变量 | P1 高 | 已修复 | 后端配置加载 | [详情](fixed/BUG-004-dotenv-overrides-process-env.md) |
| BUG-005 | ioredis 客户端首次连接失败后不可复用 | P2 中 | 已修复 | Redis 缓存连接 | [详情](fixed/BUG-005-ioredis-client-not-reusable.md) |
| BUG-010 | 旧登录请求覆盖已切换的演示身份 | P1 高 | 已修复 | 小程序登录、退出与身份切换 | [详情](fixed/BUG-010-stale-login-overrides-switched-identity.md) |
| BUG-011 | 店主页离开后异步初始化重新启动轮询 | P2 中 | 已修复 | 店主订单台生命周期与分段加载 | [详情](fixed/BUG-011-merchant-polling-restarts-after-hide.md) |
| BUG-012 | `cart-panel` 结算事件负载不符合组件契约 | P3 低 | 已修复 | 购物车面板组件复用 | [详情](fixed/BUG-012-cart-panel-checkout-payload-contract.md) |

## 4. 环境类已解决（不计 bug 编号）

以下为开发环境配置问题，不是产品缺陷，保留在此便于新会话排查：

- WSL NAT 端口转发间歇失效 → 改用 mirrored 网络模式（`docs/backend-local-dev.md`）。
- Redis 默认只监听 `127.0.0.1` → 调整 `bind`（mirrored 下按实际验证为准，同上文档）。

## 5. 统计

- 待修复：4 条（P0 ×1、P1 ×1、P2 ×1、P3 ×1）。
- 已修复：8 条（其中 BUG-001 尚待微信开发者工具内的实际渲染复验；BUG-010、BUG-011 的 Node 回归已通过，微信内人工复验未执行）。
- 最近更新：2026-10-31。

## 6. 与其他文档的边界

- 本文只记录**缺陷**。未实现的功能能力、里程碑差距写 `docs/待完成目标.md`，不在本目录冒充 bug。
- 需要后端补能力的事项仍按约定写入 `docs/后端待实现接口清单.md`，本目录只链接，不复制接口契约。
- 单次修复的完整技术说明可作为独立文档存在（如 `docs/2026-10-31-小程序配置模块白屏修复说明.md`），本目录详情页只保留摘要与证据。