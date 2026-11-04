/**
 * T9：C-SERVER-ENV@1 环境变量校验。
 *
 * 覆盖点：
 * 1. 新增 DEEPSEEK_VISION_MODEL（默认 deepseek-flash）与 AGENT_MAX_BODY_BYTES（默认 2097152）；
 * 2. 两者支持覆盖与空值回落；
 * 3. 非法值在启动期被拒绝（不输出变量值）；
 * 4. 既有必填项、枚举、范围与生产安全校验不回归。
 */
import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/common/config/env.validation';

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'mysql://smart_store:smart_store_dev@127.0.0.1:3306/smart_store',
};

/**
 * validateEnv 会让真实 process.env 覆盖传入 config（模拟容器/CI 注入）。
 * 测试必须先把受管变量从 process.env 摘掉，否则结果依赖本机 .env / shell。
 */
const MANAGED_KEYS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_URL',
  'CACHE_DRIVER',
  'SESSION_TTL_SECONDS',
  'ALLOW_DEMO_LOGIN',
  'ALLOW_DEMO_PAYMENT',
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
  'DESKTOP_ORIGIN',
  'DEEPSEEK_API_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_VISION_MODEL',
  'DEEPSEEK_TIMEOUT_MS',
  'DEEPSEEK_REASONING_EFFORT',
  'DEEPSEEK_MAX_TOKENS',
  'AGENT_REQUIRE_AUTH',
  'AGENT_MAX_BODY_BYTES',
];

function withCleanEnv<T>(overrides: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.NODE_ENV = 'test';
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runValidate(overrides: Record<string, string> = {}): Record<string, unknown> {
  const env = { ...BASE_ENV, ...overrides };
  return withCleanEnv(env, () => validateEnv(env));
}

describe('C-SERVER-ENV@1 新增变量默认值', () => {
  it('未配置时 DEEPSEEK_VISION_MODEL=deepseek-flash、AGENT_MAX_BODY_BYTES=2097152', () => {
    const result = runValidate();

    expect(result.DEEPSEEK_VISION_MODEL).toBe('deepseek-flash');
    expect(Number(result.AGENT_MAX_BODY_BYTES)).toBe(2097152);
  });

  it('显式覆盖时保留调用方配置的值', () => {
    const result = runValidate({
      DEEPSEEK_VISION_MODEL: 'deepseek-vision-custom',
      AGENT_MAX_BODY_BYTES: '524288',
    });

    expect(result.DEEPSEEK_VISION_MODEL).toBe('deepseek-vision-custom');
    expect(Number(result.AGENT_MAX_BODY_BYTES)).toBe(524288);
  });

  it('空值/空白值回落到默认值，不被当成合法模型名或 0 字节上限', () => {
    const result = runValidate({
      DEEPSEEK_VISION_MODEL: '   ',
      AGENT_MAX_BODY_BYTES: '',
    });

    expect(result.DEEPSEEK_VISION_MODEL).toBe('deepseek-flash');
    expect(Number(result.AGENT_MAX_BODY_BYTES)).toBe(2097152);
  });
});

describe('C-SERVER-ENV@1 新增变量非法值', () => {
  it('DEEPSEEK_VISION_MODEL 含非法字符时启动失败', () => {
    for (const invalid of ['deepseek vision', '视觉模型', 'deepseek/flash']) {
      expect(() => runValidate({ DEEPSEEK_VISION_MODEL: invalid })).toThrow(/环境变量配置无效/);
      expect(() => runValidate({ DEEPSEEK_VISION_MODEL: invalid })).toThrow(/DEEPSEEK_VISION_MODEL/);
    }
  });

  it('AGENT_MAX_BODY_BYTES 低于 262144 / 高于 8388608 / 非整数时启动失败', () => {
    for (const invalid of ['1024', '99999999', '1048576.5', 'abc']) {
      expect(() => runValidate({ AGENT_MAX_BODY_BYTES: invalid })).toThrow(/环境变量配置无效/);
    }
  });

  it('AGENT_MAX_BODY_BYTES 边界值 262144 与 8388608 合法', () => {
    expect(Number(runValidate({ AGENT_MAX_BODY_BYTES: '262144' }).AGENT_MAX_BODY_BYTES)).toBe(262144);
    expect(Number(runValidate({ AGENT_MAX_BODY_BYTES: '8388608' }).AGENT_MAX_BODY_BYTES)).toBe(8388608);
  });
});

describe('既有环境变量校验不回归', () => {
  it('缺少 DATABASE_URL 时启动失败，并指出缺失变量名', () => {
    expect(() => withCleanEnv({}, () => validateEnv({}))).toThrow(/DATABASE_URL/);
  });

  it('非法 CACHE_DRIVER / PORT 仍被拒绝', () => {
    expect(() => runValidate({ CACHE_DRIVER: 'invalid' })).toThrow(/CACHE_DRIVER/);
    expect(() => runValidate({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('非法 DEEPSEEK_API_BASE_URL / AGENT_REQUIRE_AUTH 仍被拒绝', () => {
    expect(() => runValidate({ DEEPSEEK_API_BASE_URL: 'not a url' })).toThrow(
      /DEEPSEEK_API_BASE_URL/,
    );
    expect(() => runValidate({ AGENT_REQUIRE_AUTH: 'yes' })).toThrow(/AGENT_REQUIRE_AUTH/);
  });

  it('既有默认值保持不变（DEEPSEEK_MODEL / 超时 / 生产鉴权开关约束）', () => {
    const result = runValidate();
    expect(result.DEEPSEEK_MODEL).toBe('deepseek-chat');
    expect(result.DEEPSEEK_API_BASE_URL).toBe('https://api.deepseek.com');
    expect(result.AGENT_REQUIRE_AUTH).toBe('false');

    expect(() =>
      runValidate({
        NODE_ENV: 'production',
        WECHAT_APP_ID: 'wx-test',
        WECHAT_APP_SECRET: 'secret',
        AGENT_REQUIRE_AUTH: 'false',
      }),
    ).toThrow(/AGENT_REQUIRE_AUTH=true/);

    expect(() =>
      runValidate({
        NODE_ENV: 'production',
        WECHAT_APP_ID: 'wx-test',
        WECHAT_APP_SECRET: 'secret',
        AGENT_REQUIRE_AUTH: 'true',
        ALLOW_DEMO_LOGIN: 'true',
      }),
    ).toThrow(/ALLOW_DEMO_LOGIN/);
  });
});