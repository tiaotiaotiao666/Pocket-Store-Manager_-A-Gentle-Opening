# 智能开店：独立微信小程序生成器

这是一个面向餐饮店主的 Windows 桌面应用原型。店主填写门店资料、选择功能、模板和视觉风格后，可以在本机预览并导出一份**独立的微信原生小程序工程**。生成器不创建微信主体、不替店主注册账号，也不代办上传、审核或发布；每家门店需使用自己的小程序账号、主体和 AppID。

AI 的首版职责限制为风格建议和页面图标生成，不生成或改写小程序业务代码。没有接入模型时，界面明确显示本地演示占位图。上传门店图片是可选操作，只有主动请求云端分析/生图并确认后才发送到模型服务。

## 运行

需要 Node.js 22 LTS 或更高版本和 npm。Windows 开发模式：

```powershell
npm install
npm run desktop:dev
```

仅启动浏览器原型可运行 `npm run dev`。导出脚本可独立验证：

```powershell
npm run mini:example
```

生成目录默认为 `generated-projects/松月食堂`。使用微信开发者工具导入该目录检查真实小程序页面。Windows 安装包：`npm run build:win`。

## 工程结构

- `src/`：Electron 界面与 React 向导、模板/功能目录、模型服务调用。
- `desktop/`：安全隔离的 Electron 主进程与有限 IPC 桥接。
- `templates/mini-program/`：可导出的原生小程序模板。
- `scripts/generate-mini-program.cjs`：本地生成独立工程。
- `server/`：可选的 NestJS 模型代理；密钥只配置在服务端环境变量。
- `docs/`：产品边界、模板契约、模型适配和发布指引。

## 当前边界

导出模板是可预览的演示工程，菜单数据是示例内容，未连接订单后端或真实支付。若需要线上点餐，每家店仍需独立部署/接入业务后端、HTTPS 域名与合法域名。禁止将微信 Secret、数据库密码或模型 API 密钥放进小程序或仓库。华为云具体图像生成 API 尚待实测，当前服务端仅提供兼容 OpenAI 风格 API 的适配器，不代表已接通华为云生图。

详见 [Windows 部署](docs/windows-deployment.md)、[小程序导出与发布](docs/wechat-export-and-publish.md)、[模板数据契约](docs/template-schema.md)、[模型适配说明](docs/image-model-adapter.md) 和 [产品范围](docs/product-scope.md)。

本轮实现和验证记录见 [本轮构建介绍](docs/本轮构建介绍.md)。每次导出的门店工程也会附带该门店自己的 `README.md`。
