# Windows 开发与安装

## 本机运行

1. 安装 Node.js 22 LTS（含 npm）和 Git。
2. 在项目目录打开 PowerShell，运行 `npm install`。
3. 运行 `npm run desktop:dev`，桌面应用启动后按向导操作。
4. 如需真实模型服务，在服务端部署兼容代理并配置 `.env.example` 中的模型变量；不要把密钥填入 React/Vite 的 `VITE_*` 变量。模型未配置时可继续体验本地占位流程。
5. 通过“导出独立小程序”选择输出目录。运行 `npm run mini:example` 可生成示例工程。

## 打包

Windows 上安装依赖后运行 `npm run build:win`，安装包输出至 `release/`。发布前需在目标 Windows 版本上测试文件选择、目录导出、中文路径、取消操作和安装/卸载。未签名安装包可能出现 Windows SmartScreen 提示；正式分发应配置代码签名证书。

## 检查

运行 `npm test` 和 `npm run build`。微信小程序的真实渲染由微信开发者工具验证；桌面内嵌预览只是效果示意，不能替代小程序运行时。
