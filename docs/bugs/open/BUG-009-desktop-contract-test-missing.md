# BUG-009 `test:desktop` 指向不存在的测试文件

- 状态：待修复
- 级别：P3 低
- 发现日期：2026-10-31
- 来源：脚本核对
- 影响面：根目录测试脚本、桌面 IPC 契约保护
- 涉及文件：`package.json`（`scripts.test:desktop`）、`test/`

## 1. 现象

执行 `npm run test:desktop` 会失败，因为脚本指向的文件不存在：

```text
node --test test/desktop-contract.test.cjs
```

`test/` 下当前只有：`agent-draft`、`agent-intake-flow`、`agent-transport-config`、`agent-turn`、`generator`、`reveal-transition`、`session-machine` 七个测试文件。

## 2. 根因

先声明了测试命令，但对应的桌面契约测试尚未编写。`docs/待完成目标.md:103` 也把它列为待办。

## 3. 复现步骤

```text
1. npm run test:desktop
2. 期望：桌面 IPC/导出契约测试执行
   实际：测试文件不存在，命令失败
```

## 4. 修复方案（可采纳可不采纳）

- **方案 A（推荐）**：新增 `test/desktop-contract.test.cjs`，覆盖：
  - `preload.cjs` 暴露的 IPC 通道白名单；
  - `generator:open-path`、`generator:save-image` 的路径/大小/格式校验；
  - `generator:export` 参数校验与取消路径；
  - 安装包 `build.files` 对导入依赖的覆盖断言（与 BUG-006 联动）。
- **方案 B**：暂时从 `package.json` 移除 `test:desktop`，在 `docs/待完成目标.md` 登记缺口，待桌面契约冻结后再补。移除前需确认没有 CI 依赖该命令。

推荐 A；即使选 B，也应保留一条“不得以不存在的测试命令冒充覆盖”的检查。

## 5. 验收标准

- [ ] `npm run test:desktop` 可执行且 0 失败
- [ ] 测试至少覆盖 IPC 通道白名单与导出参数校验
- [ ] 新增测试不依赖真实 Electron 窗口（可用纯函数/契约断言）

## 6. 验证证据

| 检查 | 结果 |
| --- | --- |
| `package.json` 脚本 | 指向 `test/desktop-contract.test.cjs` |
| `test/` 目录 | 文件不存在 |
| 实际执行 | 未执行 `test:desktop`（已知会因文件缺失失败） |

## 7. 备注

属于测试缺口而非运行时缺陷，因此定为 P3。记录来源：`docs/待完成目标.md` M10。