# 证据索引（docs/evidence）

> 本目录只记录**真实执行结果**，不写设计愿景。
> 证据等级：`L1` 本机 Node 契约/静态测试；`L2` 本机 Electron 运行与资源断言；`L3` 安装包构建；`L4` 干净机安装；`W` 微信开发者工具人工编译；`R` 真机走查。
> 本机绝对路径仅用于诊断，不进入发布材料。

## M5 本地 Composer 与导出升级

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `m5/s0.md` | 五类契约、样例、注册表冻结、安全扫描 | L1 | 已完成 |
| `m5/s1.md` | Base 提炼、插槽锚点、主题 Token 化、双份一致性 | L1 | 已完成 |
| `m5/s2.md` | 解析器、Lock、确定性生成、原子写盘 | L1 | 已完成 |
| `m5/s3.md` | Electron IPC、preload、exportService、会话接线 | L1 + L2(未点击) | 部分完成 |
| `m5/s3-packaging.md` | Vite 构建与打包资源覆盖 | L1 | 已完成 |
| `m5/paths.md` | 中文/空格/长路径导出 | L1（CLI） | 已完成 |
| `m5/installer.md` | NSIS 安装包与干净机验收 | L3/L4 | 未执行（环境阻塞） |

## M6 生成器与后端联通

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `m6/s4.md` | B3 契约、迁移、导入事务/幂等、公开桌号 | L1 | 实现完成；B3 测试修复后未重跑 |
| `m6/s5.md` | 配置 v2、版本守卫、桌面导入服务/UI | L1 | 实现完成；测试与构建未运行 |

## M7 模板资产扩展

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `m7/s6.md` | 资产目录、Manifest、四类预览、恢复步骤 | L1 | 资产落盘；注册表未冻结 |
| `m7/s6-final.md` | M7 门禁汇总 | L1 + W | 未通过（未运行） |
| `m7/assets.md` | 逐资产记录 | L1 | 未验证 |
| `m7/recipes.md` | 三份 Recipe 与晋升状态 | L1 | 全部 candidate |

## P0 验收收口（批次 A）

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `p0-closeout/baseline.md` | F0 七条基线门禁复跑 | L1 | 已完成（七条退出码均为 0） |
| `p0-closeout/final-gates.md` | F3 F1/F2 改动后全量门禁复跑 | L1 | 已完成（七条退出码均为 0，331 项测试） |
| `p0-closeout/manual-checklist.md` | F4 人工验收操作单与记录表 | W/GUI | 待人工执行（状态均为 NOT_RUN） |

## 生图 Provider

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `image-provider/probe.md` | imagelfk 经项目 GenerationModule 的文生图与小参考图编辑真实调用 | 本机 HTTP + 真实上游 | 两条链路通过；数据库阻塞已由 Kali 部署解除，完整 UI 未验收 |

## 本地联调部署

| 证据 | 内容 | 等级 | 状态 |
| --- | --- | --- | --- |
| `kali-local-deployment.md` | Windows 前端连接 Kali 后端、MariaDB/Redis、迁移种子和运行时检查 | 本机 + 局域网 VM | 后端运行正常；服务端 164 项全通过；首页无运行错误 |
| `kali-deepseek-agent.md` | Kali 后端调用局域网模型，真实回复、店铺字段提取、显示名与回归 | 真实模型 + 本机/VM | `mock=false`；资料提取完整；前后端全量回归通过 |

## 收尾

- `s7-checklist.md`：全量命令矩阵与真实结果
- `s7-decisions.md`：用户决策记录
- `s7-boundaries.md`：交付边界与未执行项声明