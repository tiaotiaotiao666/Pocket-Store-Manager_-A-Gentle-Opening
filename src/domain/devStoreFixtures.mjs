/**
 * 开发者测试夹具（dev fixture）：预先备好「测试用户说出完整开店资料」的一句话，
 * 在 `npm run desktop:dev` 里一键填进输入框。
 *
 * 设计约束（改动前务必读）：
 * 1. 夹具只作用于**用户输入**。它不修改系统提示词、不新增任何「让模型忽略规则」的开关：
 *    agent 记录这五个字段的唯一理由，仍然是「用户在消息里真的提供了它们」。
 *    这样测到的就是真实产品行为，而不是把规则摘掉之后的另一种程序。
 * 2. 开关必须是**可静态折叠**的 `import.meta.env.DEV`（直接写在 App.jsx 的 JSX 条件里）。
 *    不要改成 `isDevFixtureEnabled(import.meta.env)` 这类把整个 env 对象传进函数的写法：
 *    Vite 折叠不了函数调用，代码只会「运行时关闭」，语料仍会进打包产物。
 *    也不要接受 query string / localStorage / 暗号，否则它就是一条能进生产的旁路。
 * 3. 每一句都必须能被 `parseMockUtterance` 解析成 readyForReview 的草稿，
 *    这样 mock 与 http 两种 transport 用同一句话都能一次跑完（校验见
 *    test/dev-store-fixtures.test.cjs）。
 */

export const DEV_FIXTURE_MAX_UTTERANCE = 500;

export const DEV_STORE_FIXTURES = Object.freeze([
  Object.freeze({
    id: 'coffee',
    label: '咖啡茶饮',
    utterance: '店名是朝花里，品类是咖啡茶饮，营业时间 09:00-21:00，堂食和到店自取。菜品有拿铁 28 元、可颂 22 元、提拉米苏 30 元。',
  }),
  Object.freeze({
    id: 'community',
    label: '社区餐馆',
    utterance: '店名是松月食堂，品类是社区餐馆，营业时间 10:30-14:00,16:30-20:30，堂食和到店自取。菜品有宫保鸡丁 38 元、番茄炒蛋 22 元、米饭 3 元。',
  }),
  Object.freeze({
    id: 'bakery',
    label: '烘焙甜品',
    utterance: '店名是小满烘焙，品类是烘焙甜品，营业时间 08:00-19:30，不堂食，只做外带。菜品有可颂 22 元、吐司 18 元、肉桂卷 26 元。',
  }),
]);
