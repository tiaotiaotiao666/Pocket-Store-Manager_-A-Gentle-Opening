# C1 生图进入生成链路与 Agent 自主调用证据

> 2026-11-02。密钥仅从 `server/.env` 读取，本目录不保存密钥、Authorization、完整上游响应、base64 或完整模型 URL。

## 实际产出

- `home-background.png`：通过项目 `POST /api/v1/generation/images` 适配层真实生成，provider 为 imagelfk，模型为 gpt-image-2。
- `home-mark.svg`：由执行 Agent 直接编写的本地安全 SVG，没有调用图片模型，不冒充 AI 生图。
- `media.json`：只含相对文件引用、真实 SHA-256、实际尺寸和来源，不进入 `composition.v1`，不含图片字节。
- `generation-result.json`：最终真实调用的脱敏结果。
- `compose-result.json`：完整顾客端写盘导出及校验结果。

## 成功路径

1. 临时 HTTP 宿主只加载项目 `GenerationModule`，不依赖 MySQL。
2. `GET /api/v1/generation/health` 返回 200，配置存在。
3. 背景图只调用一次，项目接口返回 HTTP 201，耗时 38271 ms，无自动重试。
4. 上游返回的实际图片为 1254×1254、2334962 字节；不是请求中的 1024×1024，因此清单以 PNG IHDR 实际值为准。
5. SHA-256：`sha256:baab441f135f917180a1260e230f6973b6c1159233f3157ac3a72388337e72c7`。
6. SVG 为 256×256、657 字节，SHA-256：`sha256:48543ffb49ac764590c493344cad643fdafe8ab5b542ca2d615f2cb246d4ac76`。
7. Composer 将两项媒体落盘到 `assets/media/`，生成 `media.v1` 清单并在顾客端首页用本地 `<image>` 引用；完整导出 123 个文件，安全扫描、媒体交叉校验和小程序静态校验通过。
8. 项目响应没有可核验的 usage 数据，因此记录为 `usage: null`，不虚构 token 或费用。

## 失败与降级记录

- 初次临时宿主 health 返回 HTTP 500，原因是 `tsx` 宿主缺少构造器类型元数据，Controller 未注入 Provider；此时上游生图调用次数为 0，没有消耗生图额度。为 Controller 增加显式 `@Inject(ModelProviderService)` 后成功。
- 未配置、上游非 200、网络失败、非法 base64、坏 PNG、响应过大均有 `server/test/model-provider-images.test.ts` 覆盖；35 项测试通过，异常路径不自动重试。
- 无媒体输入时 Composer 保持旧产物，不伪造 AI 来源；`local-demo` 不得声明为 `ai-generated`。路径逃逸、外部 URL、恶意 SVG、错误哈希和尺寸均在导出前拒绝。
- 当前模型不能直接查看图片，因此未声称完成视觉内容审查。PNG 结构和 IHDR 已校验；像素统计为 RGB 标准差 41.18/50.46/62.12、64×64 缩样 3022 色，确认不是空白或单色文件。
- 尚未在微信开发者工具中进行首页实际渲染验收；静态校验不被当作该人工验收的替代。

## 复现

```bash
cd server
npx tsx scripts/c1-generate.ts --generate-once
cd ..
node scripts/composer/cli.cjs --plan .arts/a2-plan-customer.json --out generated-projects-test --project-name c1-customer-ai-media --role customer --media docs/evidence/c1/media.json --json
node scripts/validate-miniprogram.cjs --root generated-projects-test/c1-customer-ai-media
```

脚本在已有成功缓存时直接复用，不重复调用；只有没有成功缓存且显式传入 `--generate-once` 时才生成一次。无该参数不会发起生图请求。