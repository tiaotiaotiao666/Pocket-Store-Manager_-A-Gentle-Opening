'use strict';

/**
 * 项目 / 设置 IPC 通道（Electron 主进程）。
 *
 * 复用 desktop/composer-ipc.cjs 的 isTrustedSender，不复制来源白名单正则。
 * 统一返回体：{ ok: true, data } / { ok: false, code, message, details }。
 */

const path = require('node:path');

const { isTrustedSender } = require('./composer-ipc.cjs');
const { ProjectStoreError } = require('./project-store.cjs');

const MAX_CREATE_PAYLOAD = 8 * 1024;
const MAX_SAVE_PAYLOAD = 1.2 * 1024 * 1024;
const MAX_SETTINGS_PAYLOAD = 16 * 1024;

function payloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function fail(code, message, details) {
  return { ok: false, code, message, details: details || null };
}

function ok(data) {
  return { ok: true, data };
}

function toResult(error, fallbackCode, fallbackMessage) {
  if (error instanceof ProjectStoreError) {
    return fail(error.code, error.message, error.details);
  }
  return fail(fallbackCode, fallbackMessage, { cause: error && error.message });
}

function createProjectIpc(options) {
  const opts = options || {};
  const store = opts.store;
  const assets = opts.assets;
  const settings = opts.settings;
  const diagnostics = opts.diagnostics || null;
  const probeDevtools = opts.probeDevtools || null;
  const dialog = opts.dialog;
  const shell = opts.shell;

  if (!store || !assets || !settings || !dialog || !shell) {
    throw new Error('createProjectIpc 需要 store / assets / settings / dialog / shell');
  }

  const handlers = {
    'project:list': async () => {
      try {
        return ok({ projects: await store.listProjects() });
      } catch (error) {
        return toResult(error, 'PROJECT_READ_FAILED', '项目列表读取失败');
      }
    },

    'project:create': async (_event, payload) => {
      if (payloadBytes(payload) > MAX_CREATE_PAYLOAD) {
        return fail('PAYLOAD_TOO_LARGE', '新建项目参数过大');
      }
      try {
        if (payload && payload.inheritAppid === true) {
          const loaded = await settings.loadConfig();
          store.setDefaultAppid(loaded.config.defaultAppid);
        }
        const created = await store.createProject(payload);
        return ok({
          projectId: created.projectId,
          createdAt: created.createdAt,
          appid: created.appid,
          name: created.name,
        });
      } catch (error) {
        return toResult(error, 'PROJECT_WRITE_FAILED', '新建项目失败');
      }
    },

    'project:load': async (_event, payload) => {
      const projectId = payload && payload.projectId;
      try {
        return ok(await store.loadProject(projectId));
      } catch (error) {
        return toResult(error, 'PROJECT_READ_FAILED', '项目读取失败');
      }
    },

    'project:save': async (_event, payload) => {
      if (payloadBytes(payload) > MAX_SAVE_PAYLOAD) {
        return fail('PROJECT_TOO_LARGE', '项目数据过大，请清理会话记录');
      }
      const projectId = payload && payload.projectId;
      try {
        return ok(await store.saveProject(projectId, payload && payload.doc));
      } catch (error) {
        return toResult(error, 'PROJECT_WRITE_FAILED', '保存失败，请检查磁盘空间或权限');
      }
    },

    'project:delete': async (_event, payload) => {
      const projectId = payload && payload.projectId;
      const confirmName = payload && payload.confirmName;
      try {
        return ok(await store.deleteProject(projectId, confirmName));
      } catch (error) {
        return toResult(error, 'PROJECT_WRITE_FAILED', '删除项目失败');
      }
    },

    'project:reveal': async (_event, payload) => {
      const projectId = payload && payload.projectId;
      try {
        const directory = await store.getProjectDir(projectId);
        const message = await shell.openPath(directory);
        if (message) return fail('PROJECT_READ_FAILED', '无法打开项目目录：' + message);
        return ok({ path: directory });
      } catch (error) {
        return toResult(error, 'PROJECT_READ_FAILED', '打开项目目录失败');
      }
    },

    'project:pick-images': async (_event, payload) => {
      if (payloadBytes(payload) > 1024) return fail('PAYLOAD_TOO_LARGE', '参数过大');
      try {
        return ok(await assets.pickImages(dialog, payload));
      } catch (error) {
        return toResult(error, 'ASSET_READ_FAILED', '选择图片失败');
      }
    },

    'project:attach-images': async (_event, payload) => {
      if (payloadBytes(payload) > 4096) return fail('PAYLOAD_TOO_LARGE', '参数过大');
      const projectId = payload && payload.projectId;
      const tokens = payload && payload.tokens;
      try {
        return ok(await assets.attachImages(projectId, tokens));
      } catch (error) {
        return toResult(error, 'ASSET_READ_FAILED', '导入图片失败');
      }
    },

    'project:read-asset': async (_event, payload) => {
      if (payloadBytes(payload) > 1024) return fail('PAYLOAD_TOO_LARGE', '参数过大');
      try {
        return ok(await assets.readAsset(payload && payload.projectId, payload && payload.assetId, payload));
      } catch (error) {
        return toResult(error, 'ASSET_READ_FAILED', '图片读取失败');
      }
    },

    'project:remove-asset': async (_event, payload) => {
      if (payloadBytes(payload) > 1024) return fail('PAYLOAD_TOO_LARGE', '参数过大');
      try {
        return ok(await assets.removeAsset(payload && payload.projectId, payload && payload.assetId));
      } catch (error) {
        return toResult(error, 'ASSET_READ_FAILED', '图片删除失败');
      }
    },

    'settings:load': async () => {
      try {
        return ok(await settings.loadConfig());
      } catch (error) {
        return toResult(error, 'SETTINGS_INVALID', '设置读取失败');
      }
    },

    'settings:save': async (_event, payload) => {
      if (payloadBytes(payload) > MAX_SETTINGS_PAYLOAD) {
        return fail('SETTINGS_INVALID', '设置内容超过 16 KB');
      }
      try {
        return ok(await settings.saveConfig(payload && payload.config));
      } catch (error) {
        return toResult(error, 'SETTINGS_INVALID', '设置保存失败');
      }
    },

    'diagnostics:save-snapshot': async (_event, payload) => {
      if (payloadBytes(payload) > 64 * 1024) {
        return fail('DIAGNOSTICS_FAILED', '诊断快照超过 64 KB');
      }
      try {
        return ok(await settings.saveDiagnosticsSnapshot(payload && payload.json));
      } catch (error) {
        return toResult(error, 'DIAGNOSTICS_FAILED', '诊断快照保存失败');
      }
    },

    'diagnostics:run': async (_event, payload) => {
      if (!diagnostics) return fail('DIAGNOSTICS_FAILED', '自检模块未初始化');
      if (payloadBytes(payload) > 4096) return fail('PAYLOAD_TOO_LARGE', '参数过大');
      try {
        const scope = payload && Array.isArray(payload.scope) ? payload.scope : ['all'];
        return ok(await diagnostics.run(scope));
      } catch (error) {
        return toResult(error, 'DIAGNOSTICS_FAILED', '自检未完成');
      }
    },

    'settings:reveal-data-dir': async () => {
      try {
        const message = await shell.openPath(settings.userDataDir);
        if (message) return fail('PROJECT_READ_FAILED', '无法打开数据目录：' + message);
        return ok({ opened: true });
      } catch (error) {
        return toResult(error, 'PROJECT_READ_FAILED', '打开数据目录失败');
      }
    },

    'devtools:probe': async () => {
      if (!probeDevtools) return ok({ found: false, path: null, version: null, via: 'none' });
      try {
        return ok(await probeDevtools());
      } catch (error) {
        return ok({ found: false, path: null, version: null, via: 'none', error: error.message });
      }
    },
  };

  return { handlers };
}

function registerProjectIpc(ipcMain, options) {
  const created = createProjectIpc(options);
  Object.entries(created.handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) {
        return fail('UNTRUSTED_SENDER', '请求来源不受信任');
      }
      return handler(event, payload);
    });
  });
  return created;
}

/** 项目目录必须落在 userData/projects/<id> 内，供诊断与 flush 自愈复用。 */
function isInsideProjects(userDataDir, target) {
  const root = path.resolve(userDataDir, 'projects');
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

module.exports = {
  createProjectIpc,
  registerProjectIpc,
  isInsideProjects,
  MAX_CREATE_PAYLOAD,
  MAX_SAVE_PAYLOAD,
  MAX_SETTINGS_PAYLOAD,
};