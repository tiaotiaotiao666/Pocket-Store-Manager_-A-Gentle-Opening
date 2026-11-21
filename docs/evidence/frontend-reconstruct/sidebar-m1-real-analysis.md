# 侧栏单图构建：M1 真实双样例分析记录

> 日期：2026-11-20
> 范围：只记录真实 `POST /api/v1/agent/frontend-reconstruct` 响应；本轮侧栏自动编排与候选 dry-run/微信验收另记。
> 结论：**两张不同首页截图均获得 `planned` 且 DSL 节点树存在实质结构差异；M1 尚未全部完成，dry-run 产物与微信页面复核为 NOT_RUN。**

## 1. 输入与来源

两张图均为本仓库已有、由本项目微信工程产生的验收截图，可作为本项目对照样例继续使用。

| 样例 | 文件 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| classic | `docs/evidence/m7/wechat/order-classic-home.png` | 91690 | `50c574353d27bb4d7c79057a627ff639a3bd36a53f7acc7d0f5fc0ff837ef527` |
| poster | `docs/evidence/m7/wechat/order-poster-home.png` | 81111 | `fa6d05f20e64ba82d60db7a0b19c66e79ac31e6bcebc9297bc122009865b7755` |

两轮使用相同补充要求：

> 首页按图生成新骨架。订单列表保留现有首页数据与 order-card，底部导航使用 Base 原生 tabBar，不需要从图片推断数据或实现；其它区域按参考图结构生成，保留门店与点餐能力。

## 2. 真实请求过程

- 首次探针的 `requestId` 少了契约要求的 `fr-` 前缀，两次均为 HTTP 400 / `FRONTEND_REQUEST_INVALID`；修正请求标识后重发，未把该次计为模型结果。
- 第二次两次均为 HTTP 200 / `needs-input`：模型要求澄清订单列表数据、订单卡片细节或原生 tabBar。补齐上述统一要求后继续。
- 后续真实请求两次均为 HTTP 200 / `planned`，`questions=[]`，`coverage.missingCapabilities=[]`。下面结构来自最终一次提取 DSL `draft.pages[].nodes` 的实际输出；未保存 base64、完整 prompt 或原始模型响应，模型名未在本摘要中断言。

## 3. DSL 结构对照

### classic

节点顺序（缩进表示 container 子节点）：

```text
container
  text
  button(action=home.goMerchant)
  button(action=home.goMine)
slot(home-hero)
component(store-header)
container
  text
  component(fulfillment-switch)
  button(action=home.onPickTable)
  button(action=home.goMenu)
container
  text
  button(action=home.goOrders)
component(order-card)
component(state-view)
component(error-banner)
```

### poster

```text
component(store-header)
slot(home-hero)
container
  text
  text
slot(home-marketing)
component(order-card)
container
  component(fulfillment-switch)
  button(action=home.onPickTable)
  button(action=home.goMenu)
container
  text
  button(action=home.goOrders)
component(order-card)
component(state-view)
component(error-banner)
container
  button(action=home.goMine)
  button(action=home.goMerchant)
```

## 4. 判定与未完成项

- 结构差异不是换色或文案：classic 以账号操作 container 开头，poster 以 `store-header` 开头；poster 多出独立的 `slot(home-marketing)`、双 text container、额外 `order-card` 和不同末尾操作 container，组件/slot 顺序及 container 层级均不同。
- 因而「真实参考图可以驱动不同 DSL 骨架」这一子项有真实响应证据。
- **尚未证明**：两个 draft 是否都能通过白名单 renderer、Composer dry-run、微信实际渲染；输出工程与微信页面是否保持上述结构；侧栏一次发送是否自动生成并验证。上述项在本记录中一律为 `NOT_RUN`，不能用本记录的 `planned` 代替整项 M1 或端到端验收。