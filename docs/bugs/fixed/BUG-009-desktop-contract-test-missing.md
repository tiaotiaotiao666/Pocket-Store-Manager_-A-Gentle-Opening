# BUG-009 `test:desktop` 指向不存在的测试文件

- 状态：已修复
- 级别：P3 低
- 发现日期：2026-10-31
- 修复日期：2026-10-31
- 影响面：根目录测试脚本、桌面 IPC 契约保护

## 1. 修复记录

新增 `test/desktop-contract.test.cjs`，覆盖：

- Composer IPC 来源校验（仅 `file://` 与 `http://127.0.0.1:5173/`）；
- 导出父目录白名单（必须经系统对话框确认）；
- payload 256 KB / Plan 64 KB 上限 → `PAYLOAD_TOO_LARGE`；
- 单任务并发 → `EXPORT_BUSY`；
- 取消信号；
- 报告读取仅限本次导出路径；
- `preload.cjs` 桥接方法白名单、进度订阅与退订。

## 2. 验证证据

```text
npm run test:desktop
→ pass 7 / fail 0
```

## 3. 备注

测试使用 `ipcMain`/`dialog`/`ipcRenderer` 桩，不启动真实 Electron 窗口。真实点击级导出仍属于 L2 验收，未执行。