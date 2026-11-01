# BUG-018 空项目也会弹出「开始一个新项目？」确认框

- 状态：已修复
- 级别：P2 中
- 发现日期：2026-11-01
- 发现人/来源：用户反馈（截图 + 一句现象）
- 影响版本：桌面端渲染层，2026-11-01 修复前
- 影响面：左侧栏「轻启」入口、新建/复用项目流程
- 涉及文件：`src/state/sessionMachine.mjs:689-693`、`src/state/sessionMachine.mjs:1532`、`test/session-machine.test.cjs`

## 1. 现象

项目还处在第一步（刚创建、没填店名、没选功能、没导出），点击左侧栏「轻启」，仍然弹出「开始一个新项目？」确认框，文案为「当前项目会先保存，然后新建一个待命名项目并进入命名引导」。

期望：空项目直接进入命名引导，不弹确认、不新建项目。

## 2. 根因

`selectOnboardingStart` 只判断 `state.project.activeId` 是否存在：

```js
return project.activeId ? 'confirm-create' : 'start';
```

`PROJECT_OPEN_SUCCESS` 会给刚创建或刚打开的空项目填上 `activeId`，因此空壳项目也被判定为「有内容、必须先确认新建」。该判断是 BUG-014 修复时引入的，用「项目 ID 是否存在」代理「项目是否有内容」，语义不正确。

衍生问题：`START_ONBOARDING` 只改 `phase` 不改 `view`，而 `createInitialState` 的 `view` 是 `workbench`。若只移除弹窗，从「我的项目」页面点轻启会停在项目列表，不进入会话流。

## 3. 复现步骤

```text
1. 在「我的项目」新建一个项目（不填任何内容），或打开一个空项目。
2. 返回会话流，点击左侧栏「轻启」。
3. 期望：直接进入命名引导，复用当前空项目。
   实际：弹出「开始一个新项目？」确认框。
```

## 4. 修复方案（已采纳）

- 新增选择器 `hasProjectContent(state)`，以实质内容判定是否为空：店名/备注/地址/电话/logo/门店图片、已选模板、视觉提示词与图片与轮次、Agent 草稿字段、部署结果/目录/非 idle 状态。
- `selectOnboardingStart` 改为三态：
  - 无 `activeId` → `start`
  - 有 `activeId` 但无实质内容 → `start`，复用当前空项目（不新建、不弹窗）
  - 有实质内容 → `confirm-create`（保留 BUG-014 的「确认 + 保存 + 新建」）
- `START_ONBOARDING` 同步写入 `view: 'flow'`，保证从项目列表页也能进入会话流。

未采纳的替代方案：空项目也照旧新建（跳过确认）。该方案会在项目列表里持续堆积空壳项目。

## 5. 验收标准

- [x] 空项目点「轻启」不弹确认框，直接进入命名引导
- [x] 空项目被复用，`activeId` 不变，不产生新项目
- [x] 已填店名 / 已选模板 / 已生成视觉 / 已部署的项目仍弹确认框
- [x] 直接开始后 `view` 切换为 `flow`
- [x] 相关自动化测试通过
- [ ] 用户人工点击「轻启」复验（桌面端 GUI，需用户操作）

## 6. 验证证据

| 命令/操作 | 结果 |
| --- | --- |
| `node --test test/session-machine.test.cjs` | 27 项通过，0 失败 |
| `npm test` | 339 项：338 pass / 0 fail / 1 todo |
| `npm run build` | vite 构建成功，1640 modules transformed |
| 人工点击「轻启」 | 未执行（GUI 操作只能由用户在桌面端完成），未验证 |

## 7. 备注

- 关联：`docs/bugs/fixed/BUG-014-light-start-resets-active-project.md`。BUG-014 解决的是「有内容项目被静默重置」，本条解决的是它的过度触发。
- 判空口径固定为「实质内容」，后续任何「项目是否有内容」的判断不得再用 `activeId` 或会话消息条数代理。
- 改动仅涉及渲染层状态机与测试，主进程未改动，无需重启桌面端；Vite 热更新即可生效。