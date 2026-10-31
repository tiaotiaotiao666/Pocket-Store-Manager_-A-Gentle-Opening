# M5 安装包与干净机验收

日期：2026-10-31 · 等级：L3 / L4

## 结论：未执行

## 环境探测（真实结果）

```text
npx electron --version
→ v20.18.1

ls "%LOCALAPPDATA%/electron-builder/Cache"
→ No such file or directory
```

- 本机没有 electron-builder 缓存；`npm run build:win` 需要联网下载 Electron 运行时，历史轮次曾因此在下载阶段失败。
- 本轮未执行 `npm run build:win`，因此没有 `release/*.exe`、没有解包清单、没有安装截图。
- 未执行干净 Windows 10/11 安装 → 导出 → 微信导入。

## 已完成的相关工作

- `desktop/main.cjs` 不再 `require('../scripts/generate-mini-program.cjs')`，不再依赖 `src/domain/catalog.mjs`（BUG-006 的运行时依赖已断开）。
- `build.files` 显式覆盖 `templates/registry`、`templates/base`、`templates/components`、`templates/features`、`templates/recipes`、`scripts/composer`、`scripts/validate-miniprogram.cjs`。
- `scripts/check-packaging.cjs` 通过：180 个必需文件，0 缺失，旧脚本未进入包内。

## 不得宣称

- 不得写“安装包验收通过”“干净机可导出”。
- `docs/待完成目标.md` 的 M5-7-02 保持未勾选。
- `npm run desktop`（本机 Electron 运行）不等同于 L4。

## 后续动作

1. 准备联网环境或 electron-builder 缓存/镜像。
2. 执行 `npm run build:win`，解包核对必需资源。
3. 在干净 Win10/11 x64 安装，走完导出并用微信开发者工具导入。
4. 补齐安装、导出、编译截图后，才可勾选 M5-7-02。