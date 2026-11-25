'use strict';

/**
 * E0-R1 附项（Captain 2026-11-25 裁定并入 t6）：`AGENT_MAX_CONCURRENT` 默认值 2 → 3，
 * 且**只有一份常量**——`server/src/agent/agent-guard-rails.ts` 的字面量兜底必须与
 * `server/src/common/config/env.validation.ts` 的 validateEnv 默认值一致。
 *
 * 本用例不跑服务端运行时，只做源码级一致性断言（漂移即失败）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const GUARD_RAILS = path.join(REPO, 'server', 'src', 'agent', 'agent-guard-rails.ts');
const ENV_VALIDATION = path.join(REPO, 'server', 'src', 'common', 'config', 'env.validation.ts');
const ENV_EXAMPLE = path.join(REPO, 'server', '.env.example');

test('agent-guard-rails 只有一份 DEFAULT_AGENT_MAX_CONCURRENT = 3，且不再有 `?? 2` 兜底', () => {
  const source = fs.readFileSync(GUARD_RAILS, 'utf8');
  assert.match(source, /export const DEFAULT_AGENT_MAX_CONCURRENT = 3;/, '必须导出唯一的默认值常量');
  assert.ok(!/\?\?\s*2\b/.test(source), '不得再有 `?? 2` 字面量兜底');
  // 两处用法都指向同一个常量（构造器 + ConfigService 工厂）
  const uses = source.match(/DEFAULT_AGENT_MAX_CONCURRENT/g) || [];
  assert.ok(uses.length >= 3, '常量定义 + 至少两处引用，实际 ' + uses.length);
});

test('env.validation 的 AGENT_MAX_CONCURRENT 默认值同样是 3（两处口径一致）', () => {
  const source = fs.readFileSync(ENV_VALIDATION, 'utf8');
  assert.match(source, /AGENT_MAX_CONCURRENT = 3;/, '类字段默认值必须是 3');
  assert.match(source, /AGENT_MAX_CONCURRENT: 3,/, 'numericDefaults 兜底必须也是 3');
  assert.ok(!/AGENT_MAX_CONCURRENT = 2;/.test(source), '不得残留旧默认值 2');
});

test('server/.env.example 写 AGENT_MAX_CONCURRENT=3（只保护入口，不写 Key）', () => {
  const source = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  assert.match(source, /^AGENT_MAX_CONCURRENT=3$/m);
  assert.ok(!/^DEEPSEEK_API_KEY=\S+/m.test(source), '.env.example 不得写真实 Key');
});

test('上游并发（MODEL_MAX_CONCURRENT）与入口并发是两件事，不得互相顶替', () => {
  const guard = fs.readFileSync(GUARD_RAILS, 'utf8');
  const env = fs.readFileSync(ENV_VALIDATION, 'utf8');
  // 入口护栏不读 MODEL_*；调度器不读 AGENT_MAX_CONCURRENT（t9 已在服务端用例里断言）。
  assert.ok(!/MODEL_MAX_CONCURRENT/.test(guard), 'agent-guard-rails 不得读上游并发变量');
  assert.match(env, /MODEL_MAX_CONCURRENT/, 'env.validation 必须声明上游并发变量');
});
