# BUG-001 小程序导出工程 `require` JSON 导致四个页面全部白屏

- 状态：已修复（待微信开发者工具内实际渲染复验）
- 级别：P0 阻断
- 发现日期：2026-10-31
- 来源：用户截图 + 开发者工具控制台错误
- 影响版本：`templates/mini-program/` 及全部静态导出工程（含 `generated-projects/松月食堂`）
- 影响面：小程序全部页面

## 1. 现象

微信开发者工具打开导出工程后，模拟器只有导航栏和 tabBar，首页、菜单、订单、我的四个页面内容全部空白。控制台首条错误：

```text
module 'config/store.generated.js' is not defined, require args is './config/store.generated'
    at app.js:1
```

随后四条：

```text
Page "pages/home/index" has not been registered yet.
Page "pages/menu/index" has not been registered yet.
Page "pages/orders/index" has not been registered yet.
Page "pages/mine/index" has not been registered yet.
```

## 2. 根因

微信小程序 `require` 只解析 `.js` 模块，无后缀路径会被补成 `.js`。旧实现把门店配置写成 `config/store.generated.json`，而 `app.js` 与三个页面使用：

```js
require('./config/store.generated')
```

模块解析指向不存在的 `config/store.generated.js`，于是：

1. `app.js` 第 1 行抛错，`App()` 未执行；
2. 页面模块同样抛错，`Page()` 未注册；
3. 框架仍按 `app.json` 渲染导航栏和 tabBar，形成“只有外壳、内容全白”。

开发者工具日志中“基础库 3.17.6 首次下载失败重试、首次编译 45 秒”是环境耗时噪声，不是根因。

## 3. 修复

门店配置改为 CommonJS 模块，页面 `require` 路径保持不变：

- `templates/mini-program/config/store.generated.js` 新增，删除 `.json`；
- `scripts/generate-mini-program.cjs` 新增 `writeStoreConfig()`，复制模板后删除残留 `.json`，导出 README 文案同步；
- `generated-projects/松月食堂`、`generated-projects-test/松月食堂` 同步替换；
- 契约文档 `docs/template-schema.md` 增加“禁止 JSON 配置”的说明。

## 4. 验证

| 命令/操作 | 结果 |
| --- | --- |
| `npm run test:generator` | 2/2 通过 |
| `npm test` | 100/100 通过 |
| `node scripts/generate-mini-program.cjs <临时目录>` | 产物只含 `config/store.generated.js`，可 `require` |
| 静态扫描三套工程 18 个 JS 的 require | 目标全部可解析，无 `.json` require |
| 微信开发者工具点编译 | **未执行**，需人工复验 |

## 5. 防回归

- `test/generator.test.cjs` 已断言：产物含 `.js`、不存在 `.json`、页面不再 require `.json`。
- 任何小程序配置只允许 `.js` + `module.exports`。

## 6. 备注

完整技术记录见 `docs/2026-10-31-小程序配置模块白屏修复说明.md`。
同批发现的 `generated-projects/松月食堂` 旧模板样式问题见 BUG-008。