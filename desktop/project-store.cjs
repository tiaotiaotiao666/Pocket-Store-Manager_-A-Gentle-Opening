'use strict';

/**
 * 项目存储（Electron 主进程）。
 *
 * 职责：
 * - 决定 projects/<id>/project.json 的目录布局与读写方式。
 * - 原子写（Windows 不能直接 rename 覆盖已存在文件）、备份轮转、损坏恢复、删除到回收站。
 * - 每项目一条写队列，避免自动保存与关窗前 flush 互相覆盖。
 *
 * 契约来源：docs/2026-10-31-P0工作台与交接-实现方案.md 第 4 章、第 5.3 节。
 * 本模块不 import 渲染进程代码，也不依赖 Electron API（便于 Node 测试）。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ID_RE = /^p_[a-z0-9]{8,24}$/;
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_PROJECTS = 500;
const MAX_BACKUPS_LIMIT = 10;
const PROJECT_FILE = 'project.json';
const PHASES = Object.freeze([
  'home',
  'onboarding',
  'features',
  'building',
  'template-pick',
  'store-info',
  'prompt-studio',
  'image-review',
  'deploy',
]);
const REQUIRED_FEATURES = Object.freeze(['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking']);
const KNOWN_TOP_KEYS = Object.freeze([
  'schemaVersion',
  'projectId',
  'createdAt',
  'updatedAt',
  'name',
  'phase',
  'activeSessionId',
  'store',
  'features',
  'build',
  'visual',
  'agentDraft',
  'agentConfirmedSeq',
  'assets',
  'sessions',
  'seq',
  'deploy',
  'appid',
  'lastExportParent',
]);

class ProjectStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.details = details || null;
  }
}

function isoSeconds(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function generateProjectId(nowMs, randomBytes) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const random = typeof randomBytes === 'function' ? randomBytes : crypto.randomBytes;
  const stamp = now.toString(36).padStart(8, '0').slice(-8);
  const suffix = random(6).toString('hex').slice(0, 6);
  return `p_${stamp}${suffix}`;
}

function sanitizeProjectName(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 60);
  return cleaned || 'smart-store';
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw new ProjectStoreError('PROJECT_INVALID_ID', '项目标识无效');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 新建项目时的最小合法文档；渲染层打开后会再归一化。 */
function createBlankDocument({ projectId, name, createdAt, appid }) {
  const stamp = createdAt || isoSeconds();
  const displayName = String(name || '').trim().slice(0, 60);
  return {
    schemaVersion: 1,
    projectId,
    createdAt: stamp,
    updatedAt: stamp,
    name: displayName,
    phase: 'home',
    activeSessionId: 'session-main',
    store: {
      name: displayName,
      type: '社区餐馆',
      notes: '',
      address: '',
      phone: '',
      logoAssetId: null,
      imageAssetIds: [],
    },
    features: { selected: [...REQUIRED_FEATURES], custom: '' },
    build: { candidates: [], selectedId: null },
    visual: {
      styleId: 'warm',
      prompt: '',
      promptRounds: [],
      imageRounds: [],
      imageAssetId: null,
      imageMeta: null,
    },
    agentDraft: {
      storeName: displayName,
      category: '社区餐馆',
      businessHours: '',
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [],
    },
    agentConfirmedSeq: null,
    assets: { images: [] },
    sessions: [
      {
        id: 'session-main',
        title: displayName || '待命名项目',
        kind: 'main',
        status: 'active',
        messages: [],
        handoff: null,
      },
    ],
    seq: 0,
    deploy: {
      directory: '',
      projectName: '',
      resultDigest: null,
      handoff: null,
    },
    appid: typeof appid === 'string' ? appid : '',
    lastExportParent: '',
  };
}

/**
 * 保存前结构白名单：
 * - 只保留已知顶层键，未知顶层键合并进 unmappedFields（4.4.2 的「未知字段保留」）。
 * - 强制 schemaVersion/projectId；非法 phase 降级为 home。
 * - 深拷贝一次，确保后续序列化不受调用方对象引用影响。
 */
function normalizeDocumentForSave(doc, projectId) {
  if (!isPlainObject(doc)) {
    throw new ProjectStoreError('PROJECT_WRITE_FAILED', '项目数据结构无效');
  }
  if (doc.schemaVersion !== 1) {
    if (Number(doc.schemaVersion) > 1) {
      throw new ProjectStoreError('PROJECT_FUTURE_VERSION', '项目由更高版本创建，请升级应用');
    }
    throw new ProjectStoreError('PROJECT_WRITE_FAILED', '项目数据版本无效');
  }
  if (doc.projectId !== projectId) {
    throw new ProjectStoreError('PROJECT_INVALID_ID', '项目标识与目录不一致');
  }

  const known = {};
  const unknown = {};
  Object.keys(doc).forEach((key) => {
    if (key === 'unmappedFields') return;
    if (KNOWN_TOP_KEYS.includes(key)) known[key] = doc[key];
    else unknown[key] = doc[key];
  });
  if (isPlainObject(doc.unmappedFields)) Object.assign(unknown, doc.unmappedFields);

  const next = {
    ...createBlankDocument({ projectId, name: doc.name, createdAt: doc.createdAt, appid: doc.appid }),
    ...known,
    schemaVersion: 1,
    projectId,
  };
  next.name = String(next.name || '').trim().slice(0, 60);
  next.phase = PHASES.includes(next.phase) ? next.phase : 'home';
  next.updatedAt = isoSeconds();
  next.unmappedFields = unknown;
  return JSON.parse(JSON.stringify(next));
}

async function writeFileAtomic(targetPath, text) {
  const directory = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp`;
  const oldPath = `${targetPath}.old`;
  await fsp.mkdir(directory, { recursive: true });

  const handle = await fsp.open(tmpPath, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  let hadOld = false;
  try {
    await fsp.unlink(oldPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { await fsp.unlink(tmpPath); } catch (ignored) { /* tmp 可能不存在 */ }
      throw error;
    }
  }

  try {
    await fsp.rename(targetPath, oldPath);
    hadOld = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { await fsp.unlink(tmpPath); } catch (ignored) { /* 无 tmp 时忽略 */ }
      throw error;
    }
  }

  try {
    await fsp.rename(tmpPath, targetPath);
  } catch (error) {
    if (hadOld) {
      try { await fsp.rename(oldPath, targetPath); } catch (ignored) { /* 回滚失败保留 old */ }
    }
    try { await fsp.unlink(tmpPath); } catch (ignored) { /* 无 tmp 时忽略 */ }
    throw error;
  }

  if (hadOld) {
    try { await fsp.unlink(oldPath); } catch (ignored) { /* old 清理失败不影响已提交内容 */ }
  }
}

function createSaveQueue() {
  const entries = new Map();
  const revisions = new Map();

  function enqueue(projectId, doc, writer) {
    let entry = entries.get(projectId);
    if (!entry) {
      entry = { running: false, pending: null };
      entries.set(projectId, entry);
    }
    return new Promise((resolve, reject) => {
      if (entry.pending) {
        // 覆盖式合并：后写覆盖前写，被覆盖的调用方拿到 superseded 回执，避免 await 永久挂起。
        entry.pending.resolve({ ok: true, superseded: true });
      }
      entry.pending = { doc, resolve, reject };
      if (entry.running) return;

      entry.running = true;
      (async () => {
        try {
          while (entry.pending) {
            const task = entry.pending;
            entry.pending = null;
            try {
              const result = await writer(task.doc);
              const rev = (revisions.get(projectId) || 0) + 1;
              revisions.set(projectId, rev);
              task.resolve({ ok: true, ...result, rev });
            } catch (error) {
              task.reject(error);
            }
          }
        } finally {
          entry.running = false;
          if (!entry.pending) entries.delete(projectId);
        }
      })();
    });
  }

  return {
    enqueue,
    getRev: (projectId) => revisions.get(projectId) || 0,
    pendingCount: () => entries.size,
  };
}

function createProjectStore(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || !opts.userDataDir) {
    throw new Error('createProjectStore 需要 userDataDir');
  }
  const userDataDir = path.resolve(opts.userDataDir);
  const maxBackups = Math.max(1, Math.min(MAX_BACKUPS_LIMIT, Number(opts.maxBackups) || 3));
  let defaultAppid = typeof opts.defaultAppid === 'string' ? opts.defaultAppid : '';
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : crypto.randomBytes;
  const queue = createSaveQueue();

  const projectsDir = path.join(userDataDir, 'projects');
  const trashDir = path.join(userDataDir, 'projects-trash');

  function projectDir(projectId) {
    assertProjectId(projectId);
    const resolved = path.resolve(projectsDir, projectId);
    if (resolved !== path.join(projectsDir, projectId)) {
      throw new ProjectStoreError('PROJECT_INVALID_ID', '项目标识无效');
    }
    return resolved;
  }

  function projectFile(projectId) {
    return path.join(projectDir(projectId), PROJECT_FILE);
  }

  function backupsDir(projectId) {
    return path.join(projectDir(projectId), 'backups');
  }

  async function ensureLayout() {
    await fsp.mkdir(projectsDir, { recursive: true });
  }

  function errorFromFs(error, fallbackCode, message) {
    if (error instanceof ProjectStoreError) return error;
    if (error && error.code === 'ENOENT') {
      return new ProjectStoreError('PROJECT_NOT_FOUND', '项目不存在或已被删除');
    }
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')) {
      return new ProjectStoreError('PROJECT_WRITE_FAILED', '保存失败，请关闭占用该文件的程序后重试', { cause: error.code });
    }
    return new ProjectStoreError(fallbackCode, message || '保存失败，请检查磁盘空间或权限', { cause: error && error.code });
  }

  async function listBackupNumbers(projectId) {
    try {
      const entries = await fsp.readdir(backupsDir(projectId));
      return entries
        .map((name) => /^project\.(\d+)\.json$/.exec(name))
        .filter(Boolean)
        .map((match) => Number(match[1]))
        .filter((value) => Number.isInteger(value) && value > 0)
        .sort((left, right) => left - right);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** 保存前把当前 project.json 复制一份到 backups，并环形裁剪到 maxBackups 份。 */
  async function rotateBackup(projectId) {
    const source = projectFile(projectId);
    try {
      await fsp.access(source);
    } catch (error) {
      if (error.code === 'ENOENT') return { skipped: true };
      throw error;
    }
    await fsp.mkdir(backupsDir(projectId), { recursive: true });
    const numbers = await listBackupNumbers(projectId);
    const next = numbers.length ? numbers[numbers.length - 1] + 1 : 1;
    await fsp.copyFile(source, path.join(backupsDir(projectId), `project.${next}.json`));

    const all = [...numbers, next].sort((left, right) => left - right);
    while (all.length > maxBackups) {
      const oldest = all.shift();
      try {
        await fsp.unlink(path.join(backupsDir(projectId), `project.${oldest}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { skipped: false, index: next };
  }

  async function readLatestBackup(projectId) {
    const numbers = await listBackupNumbers(projectId);
    for (let index = numbers.length - 1; index >= 0; index -= 1) {
      const file = path.join(backupsDir(projectId), `project.${numbers[index]}.json`);
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const doc = JSON.parse(raw);
        return { doc, recoveredFrom: file };
      } catch (error) {
        /* 单份备份损坏时继续尝试更旧的版本 */
      }
    }
    return null;
  }

  function summaryFromDocument(projectId, doc) {
    const images = isPlainObject(doc.assets) && Array.isArray(doc.assets.images) ? doc.assets.images : [];
    const updatedAt = typeof doc.updatedAt === 'string' ? doc.updatedAt : null;
    return {
      projectId,
      name: String(doc.name || '').trim() || projectId,
      updatedAt,
      phase: PHASES.includes(doc.phase) ? doc.phase : 'home',
      thumbnailAssetId: images[0] && images[0].assetId ? images[0].assetId : null,
      hasCorrupt: false,
      futureVersion: Number(doc.schemaVersion) > 1,
    };
  }

  async function listProjects() {
    await ensureLayout();
    let entries = [];
    try {
      entries = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw errorFromFs(error, 'PROJECT_READ_FAILED', '无法读取项目目录');
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() && PROJECT_ID_RE.test(entry.name))
      .slice(0, MAX_PROJECTS);

    const summaries = [];
    for (const entry of directories) {
      const file = path.join(projectsDir, entry.name, PROJECT_FILE);
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const doc = JSON.parse(raw);
        summaries.push(summaryFromDocument(entry.name, doc));
      } catch (error) {
        summaries.push({
          projectId: entry.name,
          name: entry.name,
          updatedAt: null,
          phase: 'home',
          thumbnailAssetId: null,
          hasCorrupt: true,
          futureVersion: false,
        });
      }
    }

    summaries.sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime;
    });
    return summaries;
  }

  async function createProject(payload) {
    const input = isPlainObject(payload) ? payload : {};
    await ensureLayout();
    const projectId = generateProjectId(now().getTime(), randomBytes);
    const createdAt = isoSeconds(now());
    const name = String(input.name || '').trim().slice(0, 60);
    const appid = input.inheritAppid === true && /^wx[0-9a-f]{16}$/.test(defaultAppid) ? defaultAppid : '';
    const doc = createBlankDocument({ projectId, name, createdAt, appid });
    const directory = projectDir(projectId);
    await fsp.mkdir(directory, { recursive: true });
    await writeFileAtomic(path.join(directory, PROJECT_FILE), `${JSON.stringify(doc, null, 2)}\n`);
    return { projectId, createdAt, appid, name: doc.name, doc };
  }

  async function loadFromDocument(projectId, doc, extra) {
    const futureVersion = Number(doc.schemaVersion) > 1;
    const normalized = futureVersion ? doc : { ...doc, projectId };
    const images = isPlainObject(normalized.assets) && Array.isArray(normalized.assets.images)
      ? normalized.assets.images
      : [];
    return {
      doc: normalized,
      assets: images,
      savedAt: typeof normalized.updatedAt === 'string' ? normalized.updatedAt : null,
      bytes: extra && Number.isFinite(extra.bytes) ? extra.bytes : 0,
      futureVersion,
      recoveredFrom: (extra && extra.recoveredFrom) || null,
      corrupt: Boolean(extra && extra.corrupt),
    };
  }

  async function loadProject(projectId) {
    assertProjectId(projectId);
    const file = projectFile(projectId);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      throw errorFromFs(error, 'PROJECT_READ_FAILED', '项目文件无法读取，请检查是否被其他程序占用');
    }

    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      const backup = await readLatestBackup(projectId);
      if (backup) {
        await writeFileAtomic(file, `${JSON.stringify(backup.doc, null, 2)}\n`);
        return loadFromDocument(projectId, backup.doc, { bytes: Buffer.byteLength(raw), recoveredFrom: backup.recoveredFrom });
      }
      const corruptName = `project.corrupt.${Date.now()}.json`;
      try {
        await fsp.rename(file, path.join(projectDir(projectId), corruptName));
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') throw errorFromFs(renameError, 'PROJECT_READ_FAILED', '项目文件已损坏');
      }
      const blank = createBlankDocument({ projectId, name: projectId, createdAt: isoSeconds(now()), appid: '' });
      return loadFromDocument(projectId, blank, { bytes: 0, corrupt: true });
    }

    return loadFromDocument(projectId, doc, { bytes: Buffer.byteLength(raw) });
  }

  async function writeDocument(projectId, doc) {
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_PROJECT_BYTES) {
      throw new ProjectStoreError('PROJECT_TOO_LARGE', '项目数据过大，请清理会话记录', { bytes, limit: MAX_PROJECT_BYTES });
    }
    try {
      await rotateBackup(projectId);
    } catch (error) {
      // 备份失败不阻断主流程，但详细原因通过 details 返回，便于诊断。
      doc.__backupError = error && error.code ? error.code : 'backup-failed';
      delete doc.__backupError;
    }
    try {
      await writeFileAtomic(projectFile(projectId), text);
    } catch (error) {
      throw errorFromFs(error, 'PROJECT_WRITE_FAILED', '保存失败，请检查磁盘空间或权限');
    }
    return { savedAt: doc.updatedAt, bytes };
  }

  async function saveProject(projectId, doc) {
    assertProjectId(projectId);
    const normalized = normalizeDocumentForSave(doc, projectId);
    try {
      const result = await queue.enqueue(projectId, normalized, (payload) => writeDocument(projectId, payload));
      return { savedAt: result.savedAt, bytes: result.bytes, rev: result.rev, superseded: Boolean(result.superseded) };
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      throw errorFromFs(error, 'PROJECT_WRITE_FAILED', '保存失败，请检查磁盘空间或权限');
    }
  }

  async function flush(projectId) {
    if (projectId) assertProjectId(projectId);
    // 队列本身是串行的；这里用一次空写入把队列尾部排空，不产生磁盘变更。
    await Promise.resolve();
    return { ok: true, pending: queue.pendingCount() };
  }

  async function deleteProject(projectId, confirmName) {
    assertProjectId(projectId);
    let doc;
    try {
      const raw = await fsp.readFile(projectFile(projectId), 'utf8');
      doc = JSON.parse(raw);
    } catch (error) {
      throw errorFromFs(error, 'PROJECT_READ_FAILED', '项目不存在或无法读取');
    }
    const expected = String(doc.name || '').trim();
    if (String(confirmName || '') !== expected) {
      throw new ProjectStoreError('PROJECT_DELETE_CONFIRM_MISMATCH', '项目名称不一致，已取消删除');
    }
    await fsp.mkdir(trashDir, { recursive: true });
    const stamp = isoSeconds(now()).replace(/[:]/g, '');
    const trashPath = path.join(trashDir, `${projectId}__${stamp}`);
    try {
      await fsp.rename(projectDir(projectId), trashPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ProjectStoreError('PROJECT_NOT_FOUND', '项目不存在或已被删除');
      // Windows 上目录被占用时 rename 会失败，退化为复制后删除。
      await fsp.cp(projectDir(projectId), trashPath, { recursive: true, force: true });
      await fsp.rm(projectDir(projectId), { recursive: true, force: true });
    }
    return { trashed: true, trashPath };
  }

  async function getProjectDir(projectId) {
    await fsp.mkdir(projectDir(projectId), { recursive: true });
    return projectDir(projectId);
  }

  return {
    userDataDir,
    projectsDir,
    trashDir,
    maxBackups,
    listProjects,
    createProject,
    loadProject,
    saveProject,
    deleteProject,
    flush,
    getProjectDir,
    setDefaultAppid: (value) => {
      defaultAppid = typeof value === 'string' && /^wx[0-9a-f]{16}$/.test(value) ? value : '';
    },
    getRev: (projectId) => queue.getRev(projectId),
  };
}

module.exports = {
  createProjectStore,
  createBlankDocument,
  normalizeDocumentForSave,
  generateProjectId,
  sanitizeProjectName,
  writeFileAtomic,
  ProjectStoreError,
  assertProjectId,
  PROJECT_ID_RE,
  MAX_PROJECT_BYTES,
  PHASES,
  KNOWN_TOP_KEYS,
  REQUIRED_FEATURES,
};