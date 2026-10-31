# BUG-006 安装包缺少 `src/`，打包后导出功能不可用

- 状态：待修复（待安装包实测确认）
- 级别：P0 阻断
- 发现日期：2026-10-31
- 来源：安装包审计 + 静态依赖核对
- 影响版本：electron-builder 生成的 Windows NSIS 安装包
- 影响面：安装包内「导出小程序」能力
- 涉及文件：`package.json`（`build.files`）、`desktop/main.cjs:5`、`scripts/generate-mini-program.cjs:35,115`

## 1. 现象

开发模式（`npm run desktop:dev`）导出正常；打包后的安装包中，导出应当因找不到运行时模块而失败。

预期错误类似：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../src/domain/catalog.mjs
```

> 当前尚未生成安装包实测，本条为静态依赖核对结论，不是已观测到的运行日志。

## 2. 根因

依赖链在打包后断裂：

1. `desktop/main.cjs:5` 在 Electron 主进程直接 `require('../scripts/generate-mini-program.cjs')`；
2. 该脚本在 `scripts/generate-mini-program.cjs:35` 与 `:115` 运行时执行 `await import('../src/domain/catalog.mjs')`；
3. `package.json` 的 `build.files` 只包含 `desktop/**/*`、`dist/**/*`、`templates/**/*`、`scripts/**/*`、`package.json`，**没有 `src/**/*`**。

因此 asar 内存在 `scripts/generate-mini-program.cjs`，但不存在 `src/domain/catalog.mjs`，`writeProject()` 第一步动态导入即失败。

## 3. 复现步骤

```text
1. npm run build:win（当前受 electron-builder 下载 Electron 运行时阻塞）
2. 安装产物后点击导出 → 期望生成工程，实际模块未找到
3. 或直接解包 app.asar 检查是否含 src/domain/catalog.mjs
```

阻塞：本机安装包构建卡在 Electron 运行时下载，暂无最终安装包产物。

## 4. 修复方案（可采纳可不采纳）

- **方案 A（兜底）**：`build.files` 增加 `src/**/*`。改动最小，但把前端源码一并放入 asar，体积与暴露面变大。
- **方案 B（推荐）**：把 `catalog.mjs` 中的模板/主题纯数据抽为独立共享模块（如 `shared/template-catalog.mjs`），前端与生成脚本共同引用，`build.files` 只包含该数据目录。
- **方案 C（彻底解耦）**：生成脚本不再 import 前端代码，改为读取自身目录内的 `templates/manifest.json`；模板清单与代码同源渲染，安装包只携带 `templates/`。

推荐 B 或 C；A 仅用于临时验证安装包。

同时补一条打包契约测试：断言 `build.files` 覆盖生成脚本的全部运行时依赖，或直接解包 asar 断言文件存在。

## 5. 验收标准

- [ ] 干净 Windows x64 环境生成 NSIS 与 win-unpacked 产物
- [ ] 安装后点击导出，真实生成可导入的微信工程
- [ ] asar 内依赖完整性有自动化断言
- [ ] `npm run test:desktop` 覆盖导出 IPC 的成功与失败路径

## 6. 验证证据

| 检查 | 结果 |
| --- | --- |
| `package.json` → `build.files` | 不含 `src/**/*` |
| 依赖链静态核对 | `desktop/main.cjs:5` → `scripts/...:35,115` → `src/domain/catalog.mjs` |
| 安装包实测 | 未执行（Electron 运行时下载阻塞） |

## 7. 备注

风险早已记录于 `docs/待完成目标.md:124` 与 `docs/handoff/archive/2026-10-31-Windows安装包审计.md:23`，但一直未修复。修复后请同步 `docs/windows-deployment.md` 的验收步骤。