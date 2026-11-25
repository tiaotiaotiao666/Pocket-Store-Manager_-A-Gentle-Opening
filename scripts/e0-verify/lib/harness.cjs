'use strict';

/**
 * E0-V1 独立验证器：用例执行骨架。
 *
 * 状态词只允许 PASS / FAIL / NOT_RUN / BLOCKED（rev15 §14.9 / §6）：
 *  - PASS：用例真实执行且断言成立；
 *  - FAIL：用例真实执行但断言不成立（= 被测实现缺陷，出结构化 finding 给 Captain）；
 *  - BLOCKED：环境不可用（如沙箱 EPERM/工具缺失），用例未真正执行；
 *  - NOT_RUN：依赖的冻结接口尚未落地或本阶段只声明不执行。
 *
 * 骨架本身**不给 E0 verdict**：verdict 恒为 NOT_RUN，由 t8（E0-V1 独立门禁）出具。
 */

const fs = require('node:fs');
const path = require('node:path');

const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED', NOT_RUN: 'NOT_RUN' });

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert 失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'assertEqual 失败') + '：期望 ' + JSON.stringify(expected)
      + '，实际 ' + JSON.stringify(actual));
  }
}

function assertCode(result, expectedCode, message) {
  const code = result && result.code;
  if (code !== expectedCode) {
    throw new Error((message || '错误码不符') + '：期望 ' + expectedCode + '，实际 ' + JSON.stringify(code));
  }
}

/** 期望“拒绝”：ok===false 且 code 在允许集合内（码集合从 rev15 §14.9 清单取，不私增）。 */
function assertRejected(result, allowedCodes, message) {
  if (!result || result.ok !== false) {
    throw new Error((message || '期望被拒绝') + '：实际 ' + JSON.stringify(result));
  }
  if (Array.isArray(allowedCodes) && allowedCodes.length > 0 && !allowedCodes.includes(result.code)) {
    throw new Error((message || '拒绝码不在允许集合') + '：实际 ' + JSON.stringify(result.code)
      + '，允许 ' + allowedCodes.join('|'));
  }
}

function createHarness(options) {
  const opts = options || {};
  const frozen = opts.frozen;
  const sanitize = opts.sanitize || ((value) => String(value));
  const sanitizeDeep = opts.sanitizeDeep || ((value) => value);
  const cases = [];

  function define(def) {
    if (!def || typeof def.id !== 'string' || !def.id) throw new Error('用例缺少 id');
    if (cases.some((entry) => entry.id === def.id)) throw new Error('用例 id 重复：' + def.id);
    cases.push(def);
    return def;
  }

  function defineAll(list) {
    for (const def of list || []) define(def);
  }

  async function runAll(ctx) {
    const results = [];
    for (const def of cases) {
      const started = Date.now();
      const base = {
        id: def.id,
        group: def.group || '未分组',
        title: def.title || def.id,
        x: Array.isArray(def.x) ? def.x : [],
        requires: Array.isArray(def.requires) ? def.requires : [],
        expected: def.expected || '',
        basis: def.basis || '',
      };
      const missing = base.requires.filter((name) => !(frozen && frozen.isPresent(name)));
      if (missing.length > 0) {
        results.push({
          ...base,
          status: STATUS.NOT_RUN,
          reason: '冻结接口未落地：' + missing.join('、') + (def.reason ? '；' + def.reason : ''),
          observed: null,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (typeof def.run !== 'function') {
        results.push({
          ...base,
          status: STATUS.NOT_RUN,
          reason: def.reason || '准备阶段声明（无可执行实现）',
          observed: null,
          durationMs: Date.now() - started,
        });
        continue;
      }
      try {
        const outcome = (await def.run(ctx)) || {};
        results.push({
          ...base,
          status: outcome.status || STATUS.PASS,
          detail: outcome.detail === undefined ? null : sanitize(outcome.detail),
          observed: outcome.observed === undefined ? null : sanitizeDeep(outcome.observed),
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const blocked = error && error.code === 'E0_VERIFY_BLOCKED';
        // 失败必带栈顶帧：没有栈就无法判断是“实现缺陷”还是“用例写错”，也无法出可复现的 finding。
        const stackTop = error && error.stack
          ? String(error.stack).split('\n').slice(1, 6).map((line) => line.trim())
          : [];
        results.push({
          ...base,
          status: blocked ? STATUS.BLOCKED : STATUS.FAIL,
          detail: sanitize(error && error.message ? error.message : String(error)),
          observed: sanitizeDeep({ stackTop }),
          durationMs: Date.now() - started,
        });
      }
    }
    return results;
  }

  function countsOf(results) {
    const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0, total: results.length };
    for (const item of results) counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }

  return { define, defineAll, runAll, countsOf, cases };
}

function blocked(message) {
  const error = new Error(message || '环境不可用');
  error.code = 'E0_VERIFY_BLOCKED';
  return error;
}

function readHead() {
  const gitDir = path.resolve(__dirname, '..', '..', '..', '.git');
  const headFile = path.join(gitDir, 'HEAD');
  try {
    const head = fs.readFileSync(headFile, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refFile = path.join(gitDir, head.slice(5).trim());
      if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 12);
      return head;
    }
    return head.slice(0, 12);
  } catch {
    return null;
  }
}

module.exports = {
  STATUS,
  assert,
  assertEqual,
  assertCode,
  assertRejected,
  createHarness,
  blocked,
  readHead,
};
