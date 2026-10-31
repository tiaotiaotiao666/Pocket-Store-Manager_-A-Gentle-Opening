# M5-S3 打包资源证据

日期：2026-10-31 · 等级：L1（静态资源断言）

## 命令与结果

```text
npm run build
→ vite v6.4.5 building for production
→ ✓ 1619 modules transformed
→ dist/index.html 0.60 kB │ gzip: 0.44 kB
→ dist/assets/index-DTC_Q0Pq.css 59.59 kB │ gzip: 9.69 kB
→ dist/assets/index-DgaCF_GJ.js 272.42 kB │ gzip: 87.68 kB
→ ✓ built in 2.58s

node scripts/check-packaging.cjs
→ 打包资源契约检查：180 个必需文件，10 条 files 规则
→ ✓ 注册表、Base、Composer 运行时、desktop 与 dist 均在 files 覆盖内
→ ✓ 旧复制模板脚本未进入安装包
```

## `build.files` 当前覆盖

```json
[
  "desktop/**/*",
  "dist/**/*",
  "templates/registry/**",
  "templates/base/**",
  "templates/components/**",
  "templates/features/**",
  "templates/recipes/**",
  "scripts/composer/**",
  "scripts/validate-miniprogram.cjs",
  "package.json"
]
```

## 能证明 / 不能证明

- **能证明**：`build.files` 静态覆盖了注册表、Base、Composer、desktop 与前端产物；旧脚本不在包内（BUG-006 的直接成因已消除）。
- **不能证明**：安装后能成功导出。必须完成 L3（安装包构建）与 L4（干净机安装导出）才能宣称。
- 本机 `%LOCALAPPDATA%\electron-builder\Cache` 不存在，`build:win` 需联网下载 Electron 运行时，本轮未执行。