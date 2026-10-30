import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // 测试禁止真实外网调用：DeepSeek 请求全部走注入的 fetch stub。
    reporters: ['default'],
  },
});