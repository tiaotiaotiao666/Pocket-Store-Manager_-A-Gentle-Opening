# M5 路径鲁棒性证据

日期：2026-10-31 · 等级：L1（CLI，非 Electron 点击）

## 1. 三次真实导出

| 场景 | 父目录 | 工程名 | 结果 | 文件数 |
| --- | --- | --- | --- | --- |
| 中文 + 空格 | `<tmp>/m5-path/中文 目录` | 中文工程 | 成功 | 119 |
| 空格 | `<tmp>/m5-path/with space` | space project | 成功 | 119 |
| 长路径 | `<tmp>/m5-path/long-parent-name-0123456789-0123456789-0123456789-0123456789` | long-project-0123456789-0123456789 | 成功 | 119 |

三次产物均通过静态校验：

```text
node scripts/validate-miniprogram.cjs --root "<tmp>/m5-path/中文 目录/中文工程"
→ 静态校验通过：0 个错误，0 个警告
```

产物树摘要（工程名不同，因此摘要不同）：

- 中文工程：`sha256:5b498866947c4af57dc3e0452ebc0da91d49e8d4bfee6435cee8ea7eb4058ca1`
- space project：`sha256:617d0dcef027d83dde09ea0fc6c1c092246e159ac1d798b5f7ccf84305ee7063`
- long project：`sha256:816df8568fbcaab90532e5e1257d849e32aaa22d5407bf74aea0f99c4865943f`

> 同一工程名在不同父目录生成时摘要一致，由 `test/composer-determinism.test.cjs` 断言。

## 2. 失败路径

以下由 `test/composer-atomic.test.cjs` 覆盖（L1）：

- 同名目录：返回 `TARGET_EXISTS` + `suggestedName: demo-store-2`，原目录 `keep.txt` 逐字节不变。
- 父目录不存在：`TARGET_PARENT_MISSING`，不创建任何目录。
- 路径过长：`PATH_TOO_LONG`。
- 取消：`EXPORT_CANCELLED`，无 staging 残留。
- 只读目录：`preflight` 通过探测文件判断 `TARGET_NOT_WRITABLE`；**未在真实只读目录上做人工验证**。

## 3. 未执行

- Electron 图形界面下的中文/空格/长路径点击级导出（需人工操作）。
- 真实只读目录与磁盘空间不足的人工构造验证。