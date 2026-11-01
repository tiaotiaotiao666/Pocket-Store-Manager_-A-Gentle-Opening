# 图片模型适配与华为云验证

当前服务端 `ModelProviderService` 提供 OpenAI 风格兼容端点适配：图标请求走 `/images/generations` 或 `/images/edits`，风格建议走 `/chat/completions`。服务端通过 `IMAGE_API_BASE_URL`、`IMAGE_API_KEY`、`IMAGE_MODEL_NAME`、`VISION_MODEL_NAME` 读取配置；密钥不得进入 Electron renderer、小程序、日志或仓库。

这只是兼容层，不代表华为云已接入。华为云各服务的模型、图像生成能力、鉴权签名、输入输出格式和区域可用性必须先用官方文档和测试账号验证。若 API 不是兼容协议，应新增 provider adapter，在服务端实现 IAM/SDK 鉴权和响应映射，并保留可替换接口；不要让桌面客户端直连带密钥的模型 API。

上线前验证：文本生图、参考图编辑/条件生成、图片格式和大小、限流/超时、错误码、区域可用性、数据留存政策及费用。服务状态只有在端点、模型和凭据通过健康探测后才能显示已配置。没有配置时必须标为本地演示，不可将占位图称为 AI 生成。

`.env.example` 是变量名称示例；真实凭据仅放本地未提交的服务端环境文件或云端密钥管理服务。
当前 imagelfk 的可执行配置、Agent 调用方式和真实探测结果见 [`生图模型接入说明.md`](生图模型接入说明.md)。
