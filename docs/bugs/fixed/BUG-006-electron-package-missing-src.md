# BUG-006 安装包缺少 `src/`，打包后导出功能不可用

- 状态：已修复 · 待 L4 安装包实测
- 级别：P0 阻断
- 发现日期：2026-10-31
- 修复日期：2026-10-31
- 影响面：安装包内「导出小程序」能力

## 1. 根因（已消除）

旧链路：`desktop/main.cjs` → `require('../scripts/generate-mini-program.cjs')` → 运行时 `import('../src/domain/catalog.mjs')`，而 `build.files` 不含 `src/`。

## 2. 修复记录

1. `desktop/main.cjs` 不再 require 旧脚本，改接 `scripts/composer/index.cjs`（P0–P8）与 `desktop/composer-ipc.cjs`。
2. Composer 只读取 `templates/`、`scripts/composer/` 与 `scripts/validate-miniprogram.cjs`，不再依赖前端 `src/`。
3. `package.json` 的 `build.files` 改为显式覆盖：
   `desktop/**/*`、`dist/**/*`、`templates/{registry,base,components,features,recipes}/**`、`scripts/composer/**`、`scripts/validate-miniprogram.cjs`、`package.json`。
4. 新增 `scripts/check-packaging.cjs`：内置 glob 匹配器，断言注册表、Base、资产入口、Composer 运行时、desktop 与 dist 均被覆盖，并断言旧脚本不在包内。

## 3. 验证证据

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-packaging.cjs` | 180 个必需文件，0 缺失；旧脚本未进入安装包 |
| `grep generate-mini-program` | 仅命中脚本自身 `@deprecated` 注释 |
| `desktop/main.cjs` 依赖 | 不再引用旧脚本或 `src/domain` |
| NSIS 构建 | **未执行**（electron-builder 缓存缺失，需联网下载运行时） |
| 干净机安装导出（L4） | **未执行** |

## 4. 关闭条件

- 完成 `npm run build:win` 与解包核对；
- 干净 Windows 10/11 安装后真实导出并用微信开发者工具导入；
- 补齐 `docs/evidence/m5/installer/` 截图。

在此之前不得写“安装包验收通过”。