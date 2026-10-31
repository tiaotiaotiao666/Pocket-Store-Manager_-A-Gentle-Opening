# BUG-008 生成器主题色替换未命中时静默失败

- 状态：待修复
- 级别：P2 中
- 发现日期：2026-10-31
- 来源：白屏修复时的连带核对
- 影响版本：对旧模板产物的导出；新模板（CSS 变量版）不受影响
- 影响面：导出工程的 `app.wxss` 主题色
- 涉及文件：`scripts/generate-mini-program.cjs:74-77`

## 1. 现象

店主选择的主题色没有反映到导出工程的 `app.wxss`，且导出过程无任何报错或警告。`generated-projects/松月食堂`（2026-10-30 旧模板产物）即为此状态。

## 2. 根因

生成器用字符串替换注入主题色：

```js
wxss = wxss.replace('--store-bg:#FAF7F1', `--store-bg:...`)
  .replace('--store-primary:#E78A35', ...)
  .replace('--store-accent:#286957', ...)
  .replace('--store-text:#29332F', ...);
```

该实现依赖 `app.wxss` 中存在 `--store-*` CSS 变量锚点。旧模板把颜色硬编码为 `#faf7f1` 等小写值，锚点不匹配，`String.replace` 原样返回，脚本没有检查是否命中，于是静默输出旧颜色。

静态复现（对本机旧产物 `generated-projects/松月食堂/app.wxss`）：

```text
--store-bg:#FAF7F1      => matched: false
--store-primary:#E78A35 => matched: false
--store-accent:#286957  => matched: false
--store-text:#29332F    => matched: false
output changed: false
```

## 3. 复现步骤

```text
1. 取任意旧模板导出工程（app.wxss 不含 --store-* 变量）
2. 以非默认主题色调用 writeProject()
3. 期望：产物颜色等于所选主题
   实际：产物颜色保持旧硬编码值，无报错
```

## 4. 修复方案（可采纳可不采纳）

- **方案 A（推荐）**：每次 `replace` 后比较字符串；未命中时抛出明确错误，或收集 warning 并在导出结果中返回，禁止静默成功。
- **方案 B**：导出前校验模板版本/指纹（manifest 声明主题变量版本），旧模板直接拒绝导出。
- **方案 C**：不再做文本替换，改为生成 `app.wxss` 或主题变量文件，模板只保留占位符。
- 同时为命中/未命中两种路径补测试，防止回归。

## 5. 验收标准

- [ ] 新模板导出后颜色等于所选主题
- [ ] 旧模板导出明确失败或返回可感知警告
- [ ] 单测覆盖命中与未命中两种情况

## 6. 验证证据

| 检查 | 结果 |
| --- | --- |
| 旧产物 `app.wxss` 是否含变量锚点 | 否，硬编码颜色 |
| 四个锚点静态替换 | 全部未命中，输出未变化 |
| 新模板 `templates/mini-program/app.wxss` | 含 `--store-*`，替换正常 |

## 7. 备注

当前 `templates/mini-program/app.wxss` 已升级为 CSS 变量版本，因此新导出不受影响；本条只针对“未命中仍报告成功”的静默失败行为与旧产物兼容。相关背景见 BUG-001 的备注。