'use strict';

/**
 * 运行自检（Electron 主进程部分）。
 *
 * 主进程只做「文件系统 / 运行时 / Composer 资源」级探测；
 * 后端可达性与 CORS 判定必须在渲染进程做（见实现方案 5.5）。
 *
 * 输出严格按 6.2.2 白名单：不输出绝对路径、不输出项目业务数据、不输出密钥。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { loadRegistry, REPO_ROOT } = require('../scripts/composer/registry.cjs');
const { COMPOSER_VERSION } = require('../scripts/composer/version.cjs');

const MIN_FREE_SPACE_MB = 50;
const BASE_SRC = path.join('templates', 'base', 'ordering-base', '1.0.0', 'src');

function line(id, title, result, message, action) {
  return { id, title, result, message, action: action || null };
}

function assetCounts(assets) {
  const counts = { base: 0, uiBlock: 0, featurePack: 0, recipe: 0 };
  for (const asset of assets || []) {
    if (Object.prototype.hasOwnProperty.call(counts, asset.kind)) counts[asset.kind] += 1;
  }
  return counts;
}

/** 探测 userData 是否可写；statfs 在部分 Windows 文件系统不可用时跳过。 */
async function probeStorage(userDataDir) {
  const result = { writable: false, freeSpaceMb: null, projectCount: 0, corruptProjectCount: 0, cause: null };
  try {
    await fsp.mkdir(userDataDir, { recursive: true });
  } catch (error) {
    result.cause = `MKDIR_${error && error.code ? error.code : 'FAILED'}`;
    return result;
  }
  try {
    // 用唯一临时名：点前缀文件在部分 Windows 安全软件下会被拒绝写入（EPERM）。
    const probe = path.join(userDataDir, `probe-${process.pid}-${Date.now()}.tmp`);
    await fsp.writeFile(probe, 'ok', 'utf8');
    await fsp.unlink(probe).catch(() => {});
    result.writable = true;
  } catch (error) {
    result.cause = error && error.code ? error.code : 'WRITE_FAILED';
    return result;
  }

  try {
    const stats = await fsp.statfs(userDataDir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(free)) result.freeSpaceMb = Math.floor(free / (1024 * 1024));
  } catch (error) {
    result.freeSpaceMb = null;
  }

  try {
    const projectsDir = path.join(userDataDir, 'projects');
    const entries = await fsp.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      result.projectCount += 1;
      try {
        const raw = await fsp.readFile(path.join(projectsDir, entry.name, 'project.json'), 'utf8');
        JSON.parse(raw);
      } catch (error) {
        result.corruptProjectCount += 1;
      }
    }
  } catch (error) {
    result.corruptProjectCount = 0;
  }

  return result;
}

function createDiagnostics(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || !opts.userDataDir) {
    throw new Error('createDiagnostics 需要 userDataDir');
  }
  const userDataDir = path.resolve(opts.userDataDir);
  const runtime = opts.runtime || {};
  const registryRoot = opts.registryRoot || undefined;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const baseSrcDir = path.join(REPO_ROOT, BASE_SRC);

  function scopeEnabled(scope, id) {
    const list = Array.isArray(scope) && scope.length > 0 ? scope : ['all'];
    return list.includes('all') || list.includes(id);
  }

  async function run(scope) {
    const lines = [];
    const json = {
      generatedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      app: {
        name: '智能开店',
        version: runtime.appVersion || '0.0.0',
        mode: 'desktop',
        platform: runtime.platform || process.platform,
        arch: runtime.arch || process.arch,
      },
      runtime: {
        electron: runtime.electron || '',
        chrome: runtime.chrome || '',
        node: runtime.node || process.versions.node,
      },
    };

    if (scopeEnabled(scope, 'runtime')) {
      const hasVersion = Boolean(runtime.appVersion);
      lines.push(line(
        'runtime',
        '运行环境',
        hasVersion ? 'pass' : 'warn',
        `桌面模式 · ${runtime.appVersion || '版本未知'} · Electron ${runtime.electron || '—'} · Node ${runtime.node || process.versions.node}`,
      ));
    }

    let storageProbe = null;
    if (scopeEnabled(scope, 'storage')) {
      storageProbe = await probeStorage(userDataDir);
      const pass = storageProbe.writable && (storageProbe.freeSpaceMb === null || storageProbe.freeSpaceMb > MIN_FREE_SPACE_MB);
      let message = '数据目录可写';
      let action = null;
      if (!storageProbe.writable) {
        message = `数据目录不可写（${storageProbe.cause || '权限或磁盘已满'}）`;
        action = '检查用户目录权限，或清理磁盘后重试';
      } else if (storageProbe.freeSpaceMb !== null && storageProbe.freeSpaceMb <= MIN_FREE_SPACE_MB) {
        message = `剩余空间不足 ${MIN_FREE_SPACE_MB} MB`;
        action = '清理磁盘空间后重试';
      } else if (storageProbe.freeSpaceMb === null) {
        message = '数据目录可写，剩余空间未知';
      } else {
        message = `数据目录可写 · 剩余约 ${storageProbe.freeSpaceMb} MB`;
      }
      lines.push(line('storage', '本地数据目录', pass ? 'pass' : 'fail', message, action));
      json.storage = {
        userDataWritable: storageProbe.writable,
        freeSpaceMb: storageProbe.freeSpaceMb,
        projectCount: storageProbe.projectCount,
        corruptProjectCount: storageProbe.corruptProjectCount,
        lastSaveBytes: 0,
        cause: storageProbe.cause || null,
      };
    }

    if (scopeEnabled(scope, 'composer')) {
      let registryMessage = '';
      let registryResult = 'fail';
      try {
        const loaded = loadRegistry({ verifyFreeze: true, registryRoot });
        if (!loaded.ok) {
          registryMessage = `模板资产与注册表不一致（${loaded.code}），请重新安装或运行 registry:check`;
        } else {
          const baseSrcExists = await fsp.stat(baseSrcDir).then((stat) => stat.isDirectory()).catch(() => false);
          if (!baseSrcExists) {
            registryMessage = '基础模板源目录缺失，请重新安装应用';
          } else {
            registryResult = 'pass';
            registryMessage = `注册表 ${loaded.registry.registryVersion} · 资产 ${loaded.assets.length} 项 · 已冻结`;
          }
          json.composer = {
            registryVersion: loaded.registry.registryVersion,
            registryDigest: loaded.registryDigest,
            frozen: loaded.registry.frozen === true,
            assets: assetCounts(loaded.assets),
            composerVersion: COMPOSER_VERSION,
          };
        }
      } catch (error) {
        registryMessage = `模板资产自检失败（${error && error.code ? error.code : 'UNKNOWN'}）`;
      }
      lines.push(line('composer', 'Composer 资源完整性', registryResult, registryMessage, registryResult === 'pass' ? null : '运行 npm run registry:check 或重新安装应用'));
      if (!json.composer) {
        json.composer = { registryVersion: null, registryDigest: null, frozen: false, assets: { base: 0, uiBlock: 0, featurePack: 0, recipe: 0 }, composerVersion: COMPOSER_VERSION };
      }
    }

    return { lines, json };
  }

  return { run, userDataDir };
}

module.exports = {
  createDiagnostics,
  probeStorage,
  MIN_FREE_SPACE_MB,
};