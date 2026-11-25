# 测试问题名录 1–7：本轮真实界面验收证据（2026-11-25）

范围：只覆盖《测试问题名录.pdf》第 1–7 条。第 8–15 条由队友负责，本目录不涉及。

## 采集环境

- 真实 Electron（`node_modules/electron/dist/electron.exe .`），`--force-device-scale-factor=1` ⇒ `devicePixelRatio=1`（100% 缩放）
- 隔离 profile：`C:\Users\tiaotiao\Desktop\ICT\g1-uiverify`
- 视口尺寸全部由实测确认（`innerWidth × innerHeight`），不是估算：
  - 1280×912 ⇒ 窗口外框 1296×951
  - 1366×768 ⇒ 窗口外框 1382×807
  - 1920×1080 ⇒ 外框超出屏幕可用高度，按需用 CDP `Emulation.setDeviceMetricsOverride` 把视口钉成 1920×1080 后取帧
- 取帧通道：窗口被遮挡/会话不可见时 `PrintWindow` 与 `Page.captureScreenshot` 都拿不到像素，
  改用 CDP `Page.startScreencast` 从合成器取真实渲染帧（脚本 `g1-build-tmp/screencast.cjs`）。
  帧尺寸与视口一致，能证明真实布局，不是 DOM 坐标推算。
- 阈值：真帧 210–380 KB；空白失败帧约 17 KB。

## 截图清单（仓库外，避免把大文件提交进仓库）

目录：`C:\Users\tiaotiao\Desktop\ICT\g1-build-tmp\`

| 文件 | 内容 | 尺寸 |
| --- | --- | --- |
| `E1-storeinfo-hint-1280.png` | 门店资料待确认提示卡 + 输入区「＋」入口 | 1280×912 |
| `E2-1img-1280.png` | 本轮图片 1 张 | 1280×912 |
| `E3-3img-1280.png` | 本轮图片 3 张（计数 3/3） | 1280×912 |
| `E4-back-to-0-1280.png` | 删完回到 0 张（只剩「＋」） | 1280×912 |
| `E5-flash-1280.png` | 「前往处理」定位后高亮帧 | 1280×912 |
| `E6-tpl-detail-1280.png` | 模板详情（预览在上、信息/修改在下） | 1280×912 |
| `E7-tpl-satisfy-1280.png` | 「对于当前页面满意？下一步」横排不裁切 | 1280×912 |
| `E8-tpl-detail-1366.png` | 同上，1366×768 | 1366×768 |
| `E9-tpl-satisfy-1366.png` | 同上，1366×768 | 1366×768 |
| `E10-deploy-hint-1366.png` | 导出风险项待确认提示卡 | 1366×768 |
| `E11-storeinfo-1366.png` | 门店资料页底部贴合 + 提示卡 | 1366×768 |
| `E12-tpl-1920.png` | 模板匹配页（预览放大、候选并排） | 1920×1080 |
| `E13-upload-fail-1280.png` | 非图片文件被拒：只留一行错误提示 | 1280×912 |

## 复现项目（测试用，勿删）

- `C:\Users\tiaotiao\Desktop\ICT\g1-uiverify\projects\p_uirepro0001tpl`（复现模板页）
- 门店资料/导出用项目：`面香小馆牛肉面老店`、`云栖小馆`（部署阶段）

## 关键实测数字

- 底部留白：`.workspace-composer` 下内边距 22px 与 `.composer` 自身 22px 叠加 = 44px 死白，
  改为 6px 后 1280×912 / 1366×768 两档均 `documentElement.scrollHeight === innerHeight`（无页面级滚动），
  可见底部元素 `preview-dock` 距视口底 6px（1280）与 6px（1366 门店资料）/18px（1366 导出页）。
  长内容只在中列 `chat-stream` 内滚动（1280：3231/477px；1366：3231/477px），无双重滚动。
- 图片入口：0 张时 `.agent-chat-attachments` 高度 0，输入区工具行 1 个 28×28「上传图片」按钮；
  1 张时卡片 136px；3 张时 245–252px；删到 0 回到 0px。
- 等待提示：`门店资料`、`导出风险项` 两个阶段实拍可见「等你确认…」+「需要你确认后才会继续」+ 单个「前往处理」。
- 高亮：点击后目标 `class=is-jump-flash`，`animation: jump-flash-twice 0.62s × 2`；
  `prefers-reduced-motion: reduce` 下 `animation: none` 且保留 `outline 3px` 稳定高亮。

## 未完成的验证（见交付报告）

- 第三个不同阶段的等待态截图（候选骨架待选 / 参考图候选待采用）：本轮只实拍到 2 个阶段。
- 待确认卡「前往确认」的过期态实拍。
