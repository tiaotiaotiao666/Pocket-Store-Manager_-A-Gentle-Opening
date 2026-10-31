# BUG-008 生成器主题色替换未命中时静默失败

- 状态：已修复
- 级别：P2 中
- 发现日期：2026-10-31
- 修复日期：2026-10-31
- 影响面：导出工程主题色

## 1. 根因

旧脚本对 `app.wxss` 做字符串锚点替换（`--store-bg:#FAF7F1` 等）。模板颜色变更后锚点不匹配，`String.replace` 原样返回且不检查命中，导致静默输出旧颜色。

## 2. 修复记录

1. **彻底移除字符串替换**：主题改由 `theme.generated.wxss` 提供，Composer 按 `themeTokens` 全量生成；`app.wxss` 只保留 `@import "theme.generated.wxss";`，不再定义 `--store-*`。
2. Base `app.wxss` 删除全部硬编码 `--store-*`，组件颜色统一走 `--color-*` 别名 → `--store-*`。
3. 旧脚本 `scripts/generate-mini-program.cjs` 标记 `@deprecated`，退出导出主链与安装包。
4. 生成前校验：主题 Token 缺失 → `THEME_TOKEN_MISSING`；未知 Token → `THEME_TOKEN_UNKNOWN`；对比度不足 → `THEME_CONTRAST_LOW`。
5. 插槽锚点缺失 → `SLOT_ANCHOR_MISSING`，不再静默保留旧内容。

## 3. 验证证据

| 检查 | 结果 |
| --- | --- |
| `templates/base/.../src/app.wxss` | 含 `@import "theme.generated.wxss"`，无 `--store-*` 定义 |
| `test/composer-emit.test.cjs` | 主题 7 个 Token 全部写入；同输入两次字节一致 |
| `test/composer-resolve.test.cjs` | 低对比度/未知 Token 被拒绝 |
| `test/composer-safety.test.cjs` | 产物禁止宿主依赖与秘密 |

## 4. 已知限制

- 组件内仍保留少量装饰性硬编码色（如渐变辅助色）；主色、背景、文字与 tabBar 已 Token 化。
- 旧产物（2026-10-30 生成）不会自动修复，需重新导出。