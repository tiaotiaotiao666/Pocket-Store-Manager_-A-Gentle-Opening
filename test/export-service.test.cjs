'use strict';

const test = require('node:test');
const assert = require('node:assert');

async function loadService() {
  return import('../src/services/exportService.js');
}

test('无桌面桥接时明确返回 desktop-required，不发请求', async () => {
  delete global.window;
  const service = await loadService();
  assert.strictEqual(service.isDesktopExportAvailable(), false);
  assert.deepStrictEqual(await service.chooseDirectory(), {
    status: 'desktop-required',
    message: service.DESKTOP_REQUIRED_MESSAGE,
  });
  const exported = await service.exportProject({ parentDir: 'C:/tmp', plan: {} });
  assert.strictEqual(exported.status, 'desktop-required');
  const unsubscribe = service.subscribeProgress(() => {});
  assert.strictEqual(typeof unsubscribe, 'function');
  unsubscribe();
});

test('桌面桥接导出成功并透传参数', async () => {
  const calls = {};
  global.window = {
    smartStore: {
      isDesktop: true,
      chooseExportDirectory: async () => ({ cancelled: false, path: 'C:/exports' }),
      composerValidate: async (payload) => ({ ok: true, warnings: [], payload }),
      composerExport: async (payload) => {
        calls.exportPayload = payload;
        return {
          ok: true,
          outputPath: 'C:/exports/demo',
          lockDigest: 'sha256:' + 'a'.repeat(64),
          previewOnly: [],
          warnings: [],
        };
      },
      composerCancel: async (payload) => ({ ok: true, taskId: payload && payload.taskId }),
      composerReadReport: async () => ({ ok: true, report: { checks: [] }, lock: null }),
      onComposerProgress: (listener) => {
        calls.listener = listener;
        return () => { calls.unsubscribed = true; };
      },
      openPath: async (target) => {
        calls.opened = target;
        return '';
      },
    },
  };
  const service = await loadService();
  assert.strictEqual(service.isDesktopExportAvailable(), true);

  const chosen = await service.chooseDirectory();
  assert.deepStrictEqual(chosen, { status: 'ok', path: 'C:/exports' });

  const exported = await service.exportProject({ parentDir: 'C:/exports', plan: { planId: 'order-classic' }, projectName: 'demo', mode: 'development' });
  assert.strictEqual(exported.status, 'ok');
  assert.strictEqual(exported.result.outputPath, 'C:/exports/demo');
  assert.deepStrictEqual(calls.exportPayload.plan, { planId: 'order-classic' });
  assert.strictEqual(calls.exportPayload.mode, 'development');

  const validated = await service.validatePlan({ planId: 'order-classic' });
  assert.strictEqual(validated.status, 'ok');

  const unsubscribe = service.subscribeProgress(() => {});
  assert.strictEqual(typeof calls.listener, 'function');
  unsubscribe();
  assert.strictEqual(calls.unsubscribed, true);

  const opened = await service.openProjectDirectory('C:/exports/demo');
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(calls.opened, 'C:/exports/demo');

  const report = await service.readReport('C:/exports/demo');
  assert.strictEqual(report.ok, true);
  delete global.window;
});

test('错误码映射为可读中文并区分冲突/取消', async () => {
  global.window = {
    smartStore: {
      isDesktop: true,
      composerExport: async (payload) => {
        if (payload.projectName === 'exists') {
          return { ok: false, code: 'TARGET_EXISTS', message: '同名目录已存在', details: { suggestedName: 'demo-2' } };
        }
        if (payload.projectName === 'cancel') return { ok: false, code: 'EXPORT_CANCELLED' };
        return { ok: false, code: 'THEME_CONTRAST_LOW' };
      },
    },
  };
  const service = await loadService();

  const conflict = await service.exportProject({ parentDir: 'C:/exports', plan: {}, projectName: 'exists' });
  assert.strictEqual(conflict.status, 'conflict');
  assert.strictEqual(conflict.suggestedName, 'demo-2');
  assert.ok(conflict.message.length > 0);

  const cancelled = await service.exportProject({ parentDir: 'C:/exports', plan: {}, projectName: 'cancel' });
  assert.strictEqual(cancelled.status, 'cancelled');

  const failed = await service.exportProject({ parentDir: 'C:/exports', plan: {}, projectName: 'theme' });
  assert.strictEqual(failed.status, 'failed');
  assert.ok(failed.message.includes('对比度'));
  delete global.window;
});

test('目标预检：无桌面桥接返回 desktop-required', async () => {
  delete global.window;
  const service = await loadService();
  const result = await service.preflightTarget({ parentDir: 'C:/exports', projectName: 'demo' });
  assert.strictEqual(result.status, 'desktop-required');
  assert.strictEqual(result.message, service.DESKTOP_REQUIRED_MESSAGE);
});

test('目标预检透传参数并区分不存在、冲突与检查失败', async () => {
  let payloadSeen = null;
  global.window = {
    smartStore: {
      isDesktop: true,
      composerPreflightTarget: async (payload) => {
        payloadSeen = payload;
        if (payload.projectName === 'exists') {
          return { ok: true, exists: true, projectName: 'exists', suggestedName: 'exists-2' };
        }
        if (payload.projectName === 'broken') {
          return { ok: false, code: 'TARGET_PARENT_MISSING', message: '导出位置不存在，请重新选择目录' };
        }
        return { ok: true, exists: false, projectName: payload.projectName, suggestedName: null };
      },
    },
  };
  const service = await loadService();

  const ok = await service.preflightTarget({ parentDir: 'C:/exports', projectName: 'demo' });
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.exists, false);
  assert.deepStrictEqual(payloadSeen, { parentDir: 'C:/exports', projectName: 'demo' });

  const conflict = await service.preflightTarget({ parentDir: 'C:/exports', projectName: 'exists' });
  assert.strictEqual(conflict.status, 'conflict');
  assert.strictEqual(conflict.exists, true);
  assert.strictEqual(conflict.suggestedName, 'exists-2');

  const failed = await service.preflightTarget({ parentDir: 'C:/exports', projectName: 'broken' });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.code, 'TARGET_PARENT_MISSING');
  assert.ok(failed.message.includes('导出位置不存在'));
  delete global.window;
});

test('目标预检：IPC 抛异常时按失败处理，不当作不存在', async () => {
  global.window = {
    smartStore: {
      isDesktop: true,
      composerPreflightTarget: async () => { throw new Error('ipc boom'); },
    },
  };
  const service = await loadService();
  const result = await service.preflightTarget({ parentDir: 'C:/exports', projectName: 'demo' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.code, 'TARGET_CHECK_FAILED');
  assert.ok(result.message.length > 0);
  delete global.window;
});

test('Composer 校验：IPC 抛异常或超时都按失败返回，不永久挂起', async () => {
  global.window = {
    smartStore: {
      isDesktop: true,
      composerValidate: async () => { throw new Error('validate boom'); },
    },
  };
  const service = await loadService();

  const rejected = await service.validatePlan({ plan: {} });
  assert.strictEqual(rejected.status, 'failed');
  assert.strictEqual(rejected.code, 'COMPOSE_FAILED');

  global.window.smartStore.composerValidate = () => new Promise(() => {});
  const timedOut = await service.validatePlan({ plan: {} }, { timeoutMs: 40 });
  assert.strictEqual(timedOut.status, 'failed');
  assert.strictEqual(timedOut.code, 'COMPOSE_TIMEOUT');
  delete global.window;
});

test('目标预检：IPC 无回执时超时失败，不永久挂起', async () => {
  global.window = {
    smartStore: {
      isDesktop: true,
      composerPreflightTarget: () => new Promise(() => {}),
    },
  };
  const service = await loadService();
  const result = await service.preflightTarget(
    { parentDir: 'C:/exports', projectName: 'demo' },
    { timeoutMs: 40 },
  );
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.code, 'TARGET_CHECK_TIMEOUT');
  delete global.window;
});

test('打开目录失败时给出可重试文案', async () => {
  global.window = {
    smartStore: {
      isDesktop: true,
      openPath: async () => ({ error: 'not found' }),
    },
  };
  const service = await loadService();
  const result = await service.openProjectDirectory('C:/exports/missing');
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.includes('重新导出'));
  delete global.window;
});