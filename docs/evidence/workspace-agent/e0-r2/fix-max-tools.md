# E0-Fix1（t12）：模型工具上限 → 单一来源（§14.3 工具清单长度）

- 契约：t7 报告 F1；rev15 §14.3（11 个模型可见工具）、§14.9（`MODEL_REQUEST_INVALID`）
- 写入范围：`desktop/model-credentials.cjs` + `docs/evidence/workspace-agent/e0-r2/`（本文件与 `gap-max-tools.cjs`）
- 结论：**PASS**（上限改为 `MODEL_TOOL_NAMES.length` 单一来源；11 个工具一次发送通过；超限仍拒绝；两套回归全绿）

---

## 0.3 统一交付模板

```text
任务 ID：t12 / E0-Fix1
目标是否完成：YES
实际修改文件：
  desktop/model-credentials.cjs（删 1 行常量、加 1 个惰性解析函数、替换 3 处用法、错误信息带上限来源）
  docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs（升级为自校验回归脚本：12 条断言 + 端到端 fake 上游）
  docs/evidence/workspace-agent/e0-r2/fix-max-tools.md（本文件）
  docs/evidence/workspace-agent/e0-r2/report.md（§6 追加「F1 已修复」指针，不改原记录）
行为变化：
  修复前：`payload.tools.length > 8` → MODEL_REQUEST_INVALID「工具数量超过上限。」
          （真实 direct 回合默认发 §14.3 的 11 个工具 → 整轮在发图之前就被拒，runtime 包成 AGENT_TXN_ABORTED）
  修复后：上限 = `MODEL_TOOL_NAMES.length`（当前 11）。1–11 个工具全部通过；第 12 个仍被拒，
          错误信息「工具数量超过上限（最多 11 个，等于 §14.3 的模型工具清单长度）。」
          runtime 默认（不发 request.tools）即可一次发全 11 个工具，端到端 1 次上游调用成功。
新增测试：无新增测试文件（本任务 inScope 不含 test/）；改为把 `gap-max-tools.cjs` 升级成
          自校验脚本（12 条断言，任一失败退出码 1），并在其中跑一条真实 credentials + fake fetch 的端到端回合。
执行命令与真实退出码：见 §3（4 条命令，全部 0）
真实模型/微信/UIA/安装包证据：真实模型 = NOT_RUN（本任务用 fake 上游，真实 Flash 仍归 t8）；微信/UIA/安装包 = NOT_RUN（不涉及）
与计划的偏差：
  - 无（修法与 t12 契约一致：不写死 11、不留第二份工具名常量、保留超限拒绝）。
  - 说明一处**必须**的写法差异：不能用顶层 `const MAX_TOOLS = MODEL_TOOL_NAMES.length;`，
    因为 `agent-runtime/constants.cjs` 反过来 require `model-credentials.cjs`（maxTokens 单一出口），
    加载期 require 会成环（`DIRECT_EDIT_MAX_TOKENS` 会拿到 undefined）。因此改成函数内**惰性 require**，
    语义仍是「单一来源 = 工具清单长度」，且调用点全部走同一个函数。
剩余问题：
  - 已由 t13 / E0-Clean1 关闭：`test/runtime/multimodal-upstream.test.cjs` 的过期收窄与注释已删除，
    该用例改为默认 11 个工具并加断言；`run-real-call.cjs` 的三路取证也改为走生产默认工具集（见本文件 §6）。
下一任务是否可开始：YES（t8 的硬阻断点已解除）
```

---

## 1. 改动行（新文件行号，t12 只动这些）

1) 删除写死的上限（**修复前**的历史值，`desktop/model-credentials.cjs:35`；现已不存在，上限只来自工具清单长度）：

```diff
-const MAX_TOOLS = 8;
```

2) 新增惰性单一来源解析（新文件 57–77 行，紧跟 `isPlainObject`）：

```js
/**
 * 工具数上限的**唯一来源**：rev15 §14.3 的模型可见工具清单。
 * ...（清单唯一出处 run-coordinator.cjs 的 MODEL_TOOL_NAMES，经 agent-runtime/constants.cjs 转出）...
 * 惰性 require 是必须的：agent-runtime/constants.cjs 反过来 require 本模块，加载期 require 会成环。
 */
function maxToolCount() {
  const { MODEL_TOOL_NAMES } = require('./agent-runtime/constants.cjs');
  const count = Array.isArray(MODEL_TOOL_NAMES) ? MODEL_TOOL_NAMES.length : 0;
  if (count <= 0) {
    // 清单不可用属于构建/接线错误：明确报错，绝不退化成“无上限”。
    throw new ModelCredentialError('MODEL_REQUEST_INVALID', '模型工具清单不可用，已拒绝发送工具定义。');
  }
  return count;
}
```

3) 三处旧用法全部改走同一函数：

```diff
-      normalized.tool_calls = message.tool_calls.slice(0, MAX_TOOLS).map((call) => ({
+      normalized.tool_calls = message.tool_calls.slice(0, maxToolCount()).map((call) => ({

-    if (payload.tools.length > MAX_TOOLS) {
-      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具数量超过上限。');
+    if (payload.tools.length > maxToolCount()) {
+      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '工具数量超过上限（最多 '
+        + maxToolCount() + ' 个，等于 §14.3 的模型工具清单长度）。');
     }

-      const toolCalls = rawToolCalls.slice(0, MAX_TOOLS).map((call) => ({
+      const toolCalls = rawToolCalls.slice(0, maxToolCount()).map((call) => ({
```

未新增任何工具名常量：脚本 C1c 断言 `desktop/model-credentials.cjs` 里**不出现任何一个**模型工具名字面量。

---

## 2. 为什么是「函数内惰性 require」而不是顶层常量

要求之间有一个真实冲突：

- 契约要求「上限取工具清单长度」，即必须 `require` 到 `MODEL_TOOL_NAMES`；
- `desktop/agent-runtime/constants.cjs` 头部就是 `const { DIRECT_EDIT_MAX_TOKENS } = require('../model-credentials.cjs');`
  （§14.7 预算单一出口），`agent-runtime/model-chat.cjs`、`multimodal.cjs` 也都 require 本模块。

即 `model-credentials → agent-runtime/constants → model-credentials` 成环。顶层 `const` 会在环里拿到
**半初始化的模块**（`MODEL_TOOL_NAMES` 可能 undefined），正是“看起来能跑、偶发 undefined”的坑；
把它放进函数体内，等调用时两个模块都已加载完成，环自然解开。

验证：`node -e "require('./desktop/model-credentials.cjs')"` 正常（12 个导出）；
`require` 顺序两向都试过（先 credentials 后 runtime、先 runtime 后 credentials），均无 undefined。

清单不可用时（返回空数组/非数组）→ 明确抛 `MODEL_REQUEST_INVALID`「模型工具清单不可用，已拒绝发送工具定义。」，
**不会**退化成“无上限”（这是最容易写错的方向：拿不到清单就放过工具定义）。

---

## 3. 执行命令与真实退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs` | **0** | 12 条断言全 ok；`verdict: OK：上限 = §14.3 工具清单长度（单一来源）…` |
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" test/model-call-scheduler.test.cjs` | **0** | 113 tests / 112 pass / **0 fail** / 1 skipped（= runtime 86 + scheduler 27；skip 仍是 file symlink 权限） |
| `node -e "const m=require('./desktop/model-credentials.cjs');console.log(Object.keys(m).join(','))"` | **0** | 12 个导出，无环、无 undefined |
| `node --test test/model-channel.test.cjs test/agent-tools-ipc.test.cjs test/desktop-contract.test.cjs` | **0** | 54 tests / 54 pass / 0 fail（额外回归：通道校验、工具 IPC、桌面契约） |

修复前后的同一脚本输出对照（修复前为 t7 已记录的原始输出，见 `report.md` §6）：

| 工具数 | 修复前 | 修复后 |
|---|---|---|
| 1 / 8 | accepted | accepted |
| 9 | `MODEL_REQUEST_INVALID` 工具数量超过上限 | accepted |
| 10 | `MODEL_REQUEST_INVALID` | accepted |
| 11 | `MODEL_REQUEST_INVALID` | **accepted** |
| 12（伪造） | — | `MODEL_REQUEST_INVALID` 工具数量超过上限（最多 11 个…） |
| 20（伪造） | — | `MODEL_REQUEST_INVALID`（同一条） |

端到端（脚本 C5，真实 `model-credentials` + fake fetch，**故意不传 `request.tools`**）：

```json
{ "ok": true, "stopReason": "final_answer", "upstreamCalls": 1, "sentTools": 11 }
```

即：runtime 默认按 §14.3 发全 11 个工具，上游只收到 1 次请求并正常返回——不再出现
`MODEL_REQUEST_INVALID` / `AGENT_TXN_ABORTED`。真实上游调用 0 次。

---

## 4. 验收映射

| 验收项 | 结论 | 证据 |
|---|---|---|
| 上限单一来源（`MODEL_TOOL_NAMES.length`），不再硬编码 8、无第二份工具名常量 | PASS | 脚本 C1a（代码里 0 处 `MAX_TOOLS`）/ C1b（require `agent-runtime/constants.cjs` + 用 `.length`）/ C1c（0 个工具名字面量）/ C1d（3 处调用点全部 `maxToolCount()`） |
| `gap-max-tools.cjs` 由 1/8 通过变为全通过 | PASS | 退出码 0，`probe` 中 1/8/9/10/11 全 `accepted:true` |
| 11 个工具一次发送不触发 `MODEL_REQUEST_INVALID`；平台专用 3 名仍不在模型列表 | PASS | C3a（`buildToolDefinitions().length === 11` 且 accepted）、C3b（唯一/非空）、C3c（`derive_source_bundle / adopt_attempt / attach_image_asset` 未泄漏进模型清单，平台专用仍 3 个） |
| 上限仍然存在：伪造第 12 个仍拒绝且错误码明确 | PASS | C4a（`MODEL_REQUEST_INVALID`）、C4b（信息含「上限」与 11）、C4c（20 个同样被拒） |
| 回归：runtime + scheduler 全绿；`require('./desktop/model-credentials.cjs')` 正常 | PASS | 113/112/0/1 退出码 0；require 12 导出退出码 0；额外 54/54 |
| 证据写入本文件（改动行、前后行为、真实退出码） | PASS | §1 / §3 |

---

## 5. 影响面与回滚

- 只放宽**工具定义条数**（8 → 11 = 清单长度），其余校验一条没动：`MODEL_PATTERN` 工具名、`type==='function'`、
  `parameters` 形状、消息/图片/正文大小上限全部照旧。
- `assistant.tool_calls` 回填与上游 `tool_calls` 截断也一并改用同一函数（原来用 8 截断，现在用 11），
  两者都只是“不会多于工具数”的上界收紧，不新增放行路径。
- 回滚：把三处 `maxToolCount()` 换回常量即可；本文件 §1 给出了完整 diff。
- 风险：清单若未来新增第 12 个工具，上限自动变成 12（这是“单一来源”的目的），不需要再改本文件。

---

## 6. 追加（t13 / E0-Clean1）：取证脚本与单测去掉过期工具收窄

t12 的遗留清理，让 t8 的真实取证走**生产默认路径**（不再靠收窄工具集规避上限）。

```text
任务 ID：t13 / E0-Clean1
目标是否完成：YES
实际修改文件：
  docs/evidence/workspace-agent/e0-r2/run-real-call.cjs（删 NARROW_TOOLS 收窄；新增出站工具条数观测与断言）
  test/runtime/multimodal-upstream.test.cjs（删过期注释与 tools 收窄；改走默认 11 个工具并加断言）
  docs/evidence/workspace-agent/e0-r2/fix-max-tools.md（本节 + 过期说法改为指向单一来源）
  docs/evidence/workspace-agent/e0-r2/report.md（§0.3 F1 条目、§6 标题标注“历史记录，已由 t12 修复”）
行为变化：
  - `run-real-call.cjs`：A/B/C 三路都**不传 request.tools**，由 runtime 发生产默认的模型工具集；
    新增 `let lastSentTools` + 包装 `credentials.chat`（只观测，不改行为）记录真正发给上游的工具条数，
    每个 case 输出 `sentTools`，并在 verdict 里加 `productionToolSet`（三路都等于清单长度才 true）。
    冒烟（fake 上游）实测 A/B/C 均为 `sentTools: 11`、`productionToolSet: true`。
  - `multimodal-upstream.test.cjs`：runtime 全链路用例不再收窄，改断言 `body.tools.length === 11`。
新增测试：无新增文件（只改既有用例的收窄与注释）
执行命令与真实退出码：见下表
真实模型/微信/UIA/安装包证据：真实模型 = NOT_RUN（本节仍不消耗额度；真实调用是 t8 的事）；其余不涉及
与计划的偏差：无
剩余问题：无（t12 遗留的过期收窄已清）
下一任务是否可开始：YES（t8 的真实取证与生产路径一致）
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --experimental-test-isolation=none "test/runtime/*.test.cjs" test/model-call-scheduler.test.cjs` | **0** | 113 tests / 112 pass / 0 fail / 1 skipped（skip 仍是本机建不了 file symlink） |
| `node docs/evidence/workspace-agent/e0-r2/gap-max-tools.cjs` | **0** | `verdict: OK：上限 = §14.3 工具清单长度（单一来源）…`，`failed: []` |
| `node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs`（无 Key） | **2** | `{status:'BLOCKED', reason:'NO_API_KEY', actualError:'DEEPSEEK_API_KEY missing'}`；不打印 Key、未留临时目录 |
| 同上 + fake 上游冒烟（本机自检，不消耗额度） | **0** | A/B/C 三路 `sentTools: 11`、`sentTools` 与 `productionToolSet: true`，A `multimodal: true` |

仍保留的 `MAX_TOOLS = 8` 字样只有三类，都是**历史叙述且已就地指向单一来源**：

1. 本文件 §1 的 before/after diff 中的 `-const MAX_TOOLS = 8;`（标注「修复前」）；
2. `gap-max-tools.cjs` 的注释与 C1a 断言说明（“旧的 `const MAX_TOOLS = 8;` **已被移除**”）；
3. `report.md` §6 的修复前记录（标题已标「历史记录，已由 t12 修复 → 见 §10」，原因行已标「历史值，现已删除」）。

现在任何“上限是多少”的说法都指向单一来源：`agent-runtime/constants.cjs → MODEL_TOOL_NAMES.length`（当前 11）。
