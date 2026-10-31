# 智能开店：Windows 小程序生成器与扫码点餐 MVP

项目包含 Electron + React 桌面生成器、微信原生小程序模板/参考工程，以及 NestJS + MySQL + Redis 后端。近期主线是完成餐饮扫码点餐演示闭环，后续通过版本化模板资产和确定性 Composer 扩展小程序模板库。

**新会话和文档入口：[`docs/项目概览.md`](docs/项目概览.md)。** 文档索引与维护规范见 [`docs/README.md`](docs/README.md)，活动交接见 [`docs/handoff/README.md`](docs/handoff/README.md)。

## 快速启动

需要 Node.js 22 LTS 或更高版本和 npm：

```powershell
npm install
npm run desktop:dev
```

仅启动浏览器原型：

```powershell
npm run dev
```

检查与构建：

```powershell
npm test
npm run build
```

独立生成静态示例小程序：

```powershell
npm run mini:example
```

默认输出 `generated-projects/松月食堂`，使用微信开发者工具导入检查。当前会话式 UI 的部署动画不等于真实导出或发布。

后端本地环境、迁移和种子见 [`docs/backend-local-dev.md`](docs/backend-local-dev.md)。常用命令：

```powershell
cd server
npm run db:migrate
npm run db:seed
npm run start:dev
```

服务 API 前缀为 `/api/v1`。真实密钥只放未提交的服务端环境文件，不放入 `VITE_*`、小程序或仓库。

## 工程结构

- `src/`：React 会话式工作台、领域逻辑、服务层和效果预览。
- `desktop/`：Electron 主进程与有限 IPC。
- `scripts/`：当前本地模板复制和配置导出脚本。
- `templates/mini-program/`：当前静态展示导出模板。
- `miniprogram/`：微信原生点餐参考工程（B2 已完成，服务层/组件/页面齐全；渲染层待微信编译器验收）。
- `server/`：NestJS 后端、DeepSeek Agent、模型适配和 Prisma 数据层。
- `docs/`：项目概览、规划、契约和操作指引。
- `docs/handoff/`：活动交接与历史摘要。

## 当前边界

- B0、B1、B2 已完成；B2 的顾客/店主闭环已用真实后端冒烟验证，微信开发者工具编译与点击走查待补。
- DeepSeek 开店资料收集已实现并做过真实调用验证；ModelArts/盘古未接入。
- 导出脚本和 IPC 已存在，但当前会话 UI 未接真实导出。
- Manifest、CompositionPlan、Composer、组件注册表和云端模板库均为规划，尚未实现。
- 不包含真实微信支付、退款、外送、公开店主注册或自动审核发布。
- 每家门店必须使用自己的微信账号、主体和 AppID；生成器不代办平台发布。

详细路线见 [`docs/后端实现方案与套餐.md`](docs/后端实现方案与套餐.md)，模板库方案见 [`docs/模板库与组合生成规划.md`](docs/模板库与组合生成规划.md)，微信发布边界见 [`docs/wechat-export-and-publish.md`](docs/wechat-export-and-publish.md)。
