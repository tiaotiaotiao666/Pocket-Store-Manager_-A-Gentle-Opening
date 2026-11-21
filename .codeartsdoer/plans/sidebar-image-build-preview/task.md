# 侧栏单图构建与微信预览任务

契约以同目录 `design.md` §2.2 为准；工作区已有未提交改动属于用户资产，只能在各自 write set 内做加法或必要修改。

## T1: 项目私有预览门店分配

- **Objective**: 为每个用户与预览绑定键提供幂等、-owner 隔离的开发预览门店。
- **Requirements**: R3, R6
- **Write set**: `server/src/imports/preview-stores.controller.ts`, `server/src/imports/preview-stores.service.ts`, `server/src/imports/preview-stores.dto.ts`, `server/src/imports/imports.module.ts`
- **Provides**: C-PREVIEW-STORE@1 (design.md §2.2)
- **Consumes**: none
- **Blocked by**: none
- **Deliverable**: `POST /api/v1/merchant/preview-stores`、确定性 `store-preview-*` 门店与当前用户 OWNER membership；重复绑定复用原门店和版本，冲突 fail closed，既有导入模块暴露该入口。

## T2: 本次 Plan 与预览数据注入候选构建

- **Objective**: 让候选 dry-run 和微信验证使用调用方本次 Plan、storeId 与数据版本，而不是隐式示例配置。
- **Requirements**: R2, R4
- **Write set**: `src/services/frontendReconstruct/frontendReconstructService.js`, `desktop/frontend-reconstruct-ipc.cjs`, `desktop/frontend-reconstruct/dry-run.cjs`
- **Provides**: C-CANDIDATE-PLAN@1 (design.md §2.2)
- **Consumes**: none
- **Blocked by**: none
- **Deliverable**: `buildCandidate` 的有界 `plan/storeId/backendVersions` 参数链、IPC 白名单与校验、dry-run 到 Composer 的同 attempt 参数传递，以及非法显式 Plan 的拒绝行为。

## T3: 侧栏一键编排、独立预览数据与骨架继续制作

- **Objective**: 将参考图与文字的一次发送接通资料写回、自动候选构建/验证、项目私有预览数据、继续制作和最终微信预览。
- **Requirements**: R1, R2, R3, R4, R5, R6
- **Write set**: `src/App.jsx`, `src/services/importService.js`, `src/domain/frontendReconstruct.mjs`, `src/components/agent/AgentChatAttachments.jsx`, `src/components/agent/AgentSidebarPanel.jsx`, `src/components/screenRef/FrontendCandidatePanel.jsx`, `src/styles/agent-sidebar.css`
- **Provides**: C-SIDEBAR-AUTOMATION@1, C-ADOPT-CONTINUE@1 (design.md §2.2)
- **Consumes**: C-PREVIEW-STORE@1, C-CANDIDATE-PLAN@1 (design.md §2.2)
- **Blocked by**: none（两个跨任务接口均已冻结，可并行实现）
- **Deliverable**: 明确的参考图发送会产生资料变更卡与自动候选进度；写回后的 Plan 和独立预览门店进入候选及最终导出；候选卡提供「按这个骨架继续制作」与「修改要求并重新生成」，采用后进入 `prompt-studio` 且不自动打开预览。
## T6: 修复商品描述进入导入差异与更新

- **Objective**: 让商品描述与价格、上下架一样参与受控导入差异和原子更新。
- **Requirements**: R3
- **Write set**: `server/src/imports/import-diff.ts`, `server/src/imports/imports.service.ts`
- **Provides**: C-PREVIEW-STORE@1 的 description 澄清 (design.md §2.2)
- **Consumes**: C-PREVIEW-STORE@1 (design.md §2.2)
- **Blocked by**: none
- **Deliverable**: `DESCRIPTION_CHANGED` 差异原因、产品冲突确认与 apply 同事务 description 更新；仅改描述也产生对应导入结果，其他预览门店不受影响。

## T7: 修复私有预览导入的稳定幂等请求

- **Objective**: 让同一预览绑定和 payload 在首次冲突确认后仍以相同请求摘要安全重放。
- **Requirements**: R3, R6
- **Write set**: `src/services/importService.js`
- **Provides**: C-PREVIEW-STORE@1 的稳定 confirmations 澄清 (design.md §2.2)
- **Consumes**: C-PREVIEW-STORE@1 (design.md §2.2)
- **Blocked by**: none
- **Deliverable**: 覆盖本次真实 conflicts 的排序稳定确认集合，同一 bindingKey+payload 重放复用原 importId 与双版本，新 payload 仍只写当前预览门店。

## T8: 更新新链路与描述差异的回归断言

- **Objective**: 将旧「侧栏只投递」及同步预览断言改为冻结的新自动链路，并补充描述差异覆盖。
- **Requirements**: R1, R2, R3, R4, R5, R6
- **Write set**: `test/agent-sidebar-panel.test.cjs`, `test/app-agent-sidebar-wiring.test.cjs`, `test/app-assistant-attachments.test.cjs`, `test/app-assistant-image-wiring.test.cjs`, `test/env-guide.test.cjs`, `server/test/b3-import-diff.test.ts`, `server/test/b3-imports.test.ts`
- **Provides**: none
- **Consumes**: C-PREVIEW-STORE@1, C-SIDEBAR-AUTOMATION@1, C-ADOPT-CONTINUE@1 (design.md §2.2)
- **Blocked by**: none（新行为契约已冻结）
- **Deliverable**: 根测试表达参考图自动构建、动态忙碌原因和异步预览准备；服务端测试表达 description 变化的冲突、确认与持久化结果，不删除既有安全门槛断言。
## T10: 校正两条源码定位误匹配

- **Objective**: 让防双击与预览数据准备断言匹配实际 useCallback/同步 guard 结构，同时保留行为门槛。
- **Requirements**: R1, R4, R6
- **Write set**: `test/app-agent-sidebar-wiring.test.cjs`, `test/env-guide.test.cjs`
- **Provides**: none
- **Consumes**: C-SIDEBAR-AUTOMATION@1, C-ADOPT-CONTINUE@1 (design.md §2.2)
- **Blocked by**: none
- **Deliverable**: 根测试直接断言提交防重 guard、动态阻断原因传递，以及 `runPreviewExport` 内先 `await prepareProjectPreview` 再导出且失败停止，不再要求错误的函数声明位置。
## T11: 修复外发确认后的 revision 卡死

- **Objective**: 消除共享图片同步造成的 revision 竞态，并让失效确认结束原自动任务的忙碌状态。
- **Requirements**: R1, R4
- **Write set**: `src/App.jsx`
- **Provides**: C-SIDEBAR-AUTOMATION@1 的确认竞态澄清 (design.md §2.2)
- **Consumes**: C-SIDEBAR-AUTOMATION@1 (design.md §2.2)
- **Blocked by**: none
- **Deliverable**: 自动请求先于共享图片提交；同 run 的 revision 失配会按当前身份取消并显示原因，不同 run 的旧确认不会取消新任务，确认后能够进入真实分析请求。

## T12: 补充竞态与安全返回的回归断言

- **Objective**: 固化自动动作/图片提交顺序与预览失败返回对象的行为口径。
- **Requirements**: R1, R4, R6
- **Write set**: `test/app-assistant-image-wiring.test.cjs`, `test/env-guide.test.cjs`
- **Provides**: none
- **Consumes**: C-SIDEBAR-AUTOMATION@1 (design.md §2.2)
- **Blocked by**: none
- **Deliverable**: 根测试约束自动请求先于共享图片提交，并允许数据准备失败以 `return { ok:false, ... }` 停止导出，不再只接受裸 `return`。