# imagelfk 项目链路真实探测

> 日期：2026-11-01
> 结论：无参考图文生图通过；小参考图编辑通过；未修改适配层。完整后端数据库启动、前端 UI 点击和大参考图不属于本次通过范围。

## 1. 配置与探测方式

- 非密钥配置：`IMAGE_PROVIDER_NAME=imagelfk`、`IMAGE_API_BASE_URL=https://imagelfk.cc.cd/v1`、`IMAGE_MODEL_NAME=gpt-image-2`、`IMAGE_API_TIMEOUT_MS=90000`。
- SK 从用户提供的本地文件直接写入被 Git 忽略的 `server/.env`，未打印、未写入文档。
- 完整 `AppModule` 首次构建启动时因本机 MySQL `127.0.0.1:3306` 不可连接而以 Prisma `P1001` 退出；项目文档中的 `E:` MySQL 路径在本机不存在。
- 为隔离该环境问题，本次用临时 HTTP 宿主加载项目同一个 `GenerationModule`、`GenerationController` 和 `ModelProviderService`，设置相同 `/api/v1` 前缀。请求走真实 imagelfk，不是 Mock，也不是直连上游绕过项目适配层。
- `GET /api/v1/generation/health` 返回 HTTP 200，`provider=imagelfk`、`configured=true`、`imageModel=true`。`visionModel=true` 来自空视觉模型名的回退，不作为视觉链路证据。

## 2. 文生图：通过

请求：

```http
POST /api/v1/generation/icons
Content-Type: application/json

{"name":"招牌拿铁","theme":"modern-coffee","seed":1}
```

结果：

| 项 | 真实结果 |
| --- | --- |
| HTTP | 201 |
| 总耗时 | 35.997254 秒 |
| `provider` | `imagelfk` |
| 响应前缀 | `data:image/png;base64,` |
| PNG 签名校验 | 通过 |
| 文件大小 | 1,392,809 字节 |
| IHDR 尺寸 | 1254×1254（不是请求中的 512×512） |
| 图像内容检查 | 非空白咖啡杯图标，浅米色背景，无明显文字 |
| 证据 | `icon-generation.png` |

脱敏响应形状：

```json
{"dataUrl":"data:image/png;base64,<truncated>","provider":"imagelfk","disclaimer":"该图像由已配置的图像模型生成。"}
```

## 3. 参考图编辑：小图通过

先用第一次生成的 1,392,809 字节 PNG 作为 base64 参考图，本地立即返回：

```json
{"statusCode":413,"message":"request entity too large"}
```

该请求总耗时 0.007890 秒，未到达上游，不产生生图调用。原因是 HTTP 默认请求体限制，不是服务商拒绝 `image[]`。

随后按交接约束改用 64×64、180 字节的小 PNG，保持同一项目端点并传一个 `referenceImages` 项：

| 项 | 真实结果 |
| --- | --- |
| HTTP | 201 |
| 总耗时 | 33.260420 秒 |
| 项目适配层上游字段 | `image[]` |
| 字段兼容性 | 服务接受，无需改为 `image` |
| `provider` | `imagelfk` |
| PNG 签名校验 | 通过 |
| 文件大小 | 1,468,691 字节 |
| IHDR 尺寸 | 1254×1254 |
| 图像内容检查 | 非空白玻璃咖啡杯图标，浅米色背景，无明显文字 |
| 证据 | `icon-edit.png` |

## 4. 成本与边界

- 正常路径共两次真实上游调用：文生图一次、参考图编辑一次；没有循环压测。
- 项目响应未保留上游 `usage`，本次无法从项目链路记录 token，也没有可核验的人民币单价。
- 适配层未发送 `quality=low`，本记录不作此声称。
- 服务接受 `size=512x512` 请求，但实际返回 1254×1254，后续调用方不得硬编码输出尺寸。
- 大参考图 413 仍需另行修复和验证；本次没有擅自扩大全局 HTTP body limit。
- 视觉 `/recommend-style` 未测；华为云未接入；完整 AppModule 仍受本机 MySQL 环境阻塞；前端页面未点击验收。
## 5. Agent 文档独立验收：通过

另开无项目上下文的 General Agent，只允许阅读 `docs/生图模型接入说明.md`，不允许读其他文件、改文件或发网络请求。它正确给出了项目 curl 命令、前端 `generateIcon` 调用、`result.dataUrl` 取值和 SK 存放边界，结论为“通过”，未指出阻断性缺失。该验收没有产生新的生图调用。
## 6. 回归门禁

| 命令 | 真实结果 |
| --- | --- |
| 根目录 `npm test` | 通过：338 项中 337 passed、0 failed、1 todo |
| 根目录 `npm run build` | 通过：Vite 构建 1640 个模块 |
| `server/` 下 `npm run build` | 通过：NestJS 编译成功 |
| `server/` 下 `npm test` | 环境阻塞：85 passed、79 skipped；6 个数据库套件因 MySQL `P1001 / 127.0.0.1:3306` 不可连接而失败，另外 6 个无需数据库的套件通过 |

服务端测试失败与完整 AppModule 启动失败是同一个本机 MySQL 环境问题。本次没有修改业务代码，不能用上述结果声称全量服务端测试通过。