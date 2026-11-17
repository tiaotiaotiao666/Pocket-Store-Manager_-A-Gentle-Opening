'use strict';

/**
 * 微信开发者工具 CLI 调起模块。
 *
 * 职责：
 * 1. 复用 `desktop/devtools-cli.cjs` 的 CLI 解析（与候选验证同一条搜索顺序）；
 * 2. 用同一份工程身份检查（Composer 产物 + 真实 AppID + 摘要一致性）做预检；
 * 3. 用官方 CLI `open --project <dir>` 打开工程。
 *
 * 边界：不执行任意命令、不做渲染，只是把已导出工程交给微信开发者工具。
 * 单独成模块，让 `preview-channel.cjs` 保持“不直接执行子进程”的既有约束。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const { inspectOutput } = require('./output-consistency.cjs');
const {
  APPID_RE,
  DEVTOOLS_CLI_CANDIDATES,
  detectComposerOutput,
  inspectDevtoolsTarget,
  resolveDevtoolsCli,
  validateProjectDir,
} = require('./devtools-cli.cjs');

const UNSAFE_SHELL_CHARS = /["&|<>^%\r\n]/;

function isShellSafePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && !UNSAFE_SHELL_CHARS.test(value);
}

/**
 * 在微信开发者工具里打开工程目录。
 *
 * W1 约束（不可退让）：
 * 1. 不再隐式改写 project.config.json：预览产物里的 touristappid / 空 AppID
 *    一律视为未完成 AppID 写入，直接拒绝启动；
 * 2. 启动前必须通过统一只读一致性检查（config/lock/report/当前磁盘摘要一致 +
 *    verifyOutput 通过），任何一项失败都不调起 launcher；
 * 3. 所有预检（路径、身份、AppID、CLI 可用性）都在调起之前完成，本链路不写任何文件；
 * 4. 成功只代表"已请求打开"，不代表编译通过。
 *
 * @param {{ projectPath?: string }} payload
 * @param {{ defaultProjectPath?: string, launcher?: Function, env?: object,
 *   existsSync?: Function, inspectOutput?: Function, mode?: string }} [options]
 */
async function openProjectInDevtools(payload, options) {
  const opts = options || {};
  const requested = payload && typeof payload === 'object' ? payload.projectPath : null;
  const target = (typeof requested === 'string' && requested.trim())
    ? requested
    : (opts.defaultProjectPath || '');

  const validation = validateProjectDir(target);
  if (!validation.ok) {
    return {
      ok: false,
      cancelled: false,
      code: validation.code,
      message: validation.message,
    };
  }

  if (!isShellSafePath(validation.path)) {
    return {
      ok: false,
      cancelled: false,
      code: 'PATH_INVALID',
      message: `工程路径包含命令行特殊字符，请在微信开发者工具中手动导入：${validation.path}`,
    };
  }

  // ①② 统一身份检查：必须是 Composer 产物，且 AppID 必须是正式 AppID（本链路不写任何文件）
  const identity = inspectDevtoolsTarget({
    projectDir: validation.path,
    requireComposer: true,
    requireAppId: true,
  });
  if (!identity.ok) {
    return {
      ok: false,
      cancelled: false,
      code: identity.code,
      message: identity.message,
      details: {
        projectPath: validation.path,
        missing: identity.missing,
        appidKind: identity.appidKind,
      },
    };
  }
  const appid = identity.appid;

  // ③ 统一只读一致性检查（含 verifyOutput）：任一项失败都不调起
  const inspect = typeof opts.inspectOutput === 'function' ? opts.inspectOutput : inspectOutput;
  let inspected;
  try {
    inspected = inspect(validation.path, {
      expectAppid: appid,
      requireValidAppid: true,
      deep: true,
      mode: opts.mode,
    });
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: 'OUTPUT_VERIFY_FAILED',
      message: `产物一致性检查失败：${(error && error.message) || '未知错误'}`,
      details: { projectPath: validation.path },
    };
  }
  if (!inspected || inspected.ok !== true) {
    const problems = (inspected && inspected.problems) || [];
    return {
      ok: false,
      cancelled: false,
      code: (inspected && inspected.code) || 'OUTPUT_VERIFY_FAILED',
      message: `产物未通过一致性校验，已拒绝打开开发者工具：${(inspected && inspected.message) || '摘要不一致'}`,
      details: { projectPath: validation.path, problems: problems.slice(0, 10) },
    };
  }

  // ④ CLI 可用性预检（仍在任何写操作之前；本链路本来就不写文件）
  const cli = resolveDevtoolsCli({ env: opts.env, existsSync: opts.existsSync });
  if (!cli) {
    return {
      ok: false,
      cancelled: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `未找到微信开发者工具 CLI（cli.bat）。请安装后重试，或设置 WX_CLI_PATH 指向 cli.bat。工程：${validation.path}`,
      details: { via: 'devtools-cli', projectPath: validation.path },
    };
  }

  const launcher = typeof opts.launcher === 'function' ? opts.launcher : spawn;
  try {
    // cli.bat 必须经 shell 执行；路径已通过 isShellSafePath 校验，这里只做引号包裹。
    const child = launcher(`"${cli}"`, ['open', '--project', `"${validation.path}"`], {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (error) {
    return {
      ok: false,
      cancelled: false,
      code: 'DEVTOOLS_NOT_FOUND',
      message: `调起微信开发者工具失败（${(error && error.message) || '未知错误'}）。请手动导入工程：${validation.path}`,
      details: { via: 'devtools-cli', projectPath: validation.path },
    };
  }

  return {
    ok: true,
    cancelled: false,
    code: null,
    message: `已请求打开微信开发者工具（仅表示已发起调起，不代表编译通过）：${validation.path}`,
    details: {
      via: 'devtools-cli',
      projectPath: validation.path,
      cli,
      appidMasked: identity.appidMasked,
      appidFixed: false,
      status: 'devtools-open-requested',
      compiled: false,
      consistency: {
        tree: inspected.tree,
        lockDigest: inspected.lockDigest,
        fileCount: inspected.fileCount,
      },
    },
  };
}

/**
 * 旧实现（隐式改写 AppID）已删除：W1 起任何 AppID 写入都必须走
 * `desktop/appid-postprocess.cjs` 的事务（备份 + 全量校验 + 可回滚），
 * 本模块只读不写。
 */

module.exports = {
  DEVTOOLS_CLI_CANDIDATES,
  APPID_RE,
  isShellSafePath,
  resolveDevtoolsCli,
  validateProjectDir,
  detectComposerOutput,
  inspectDevtoolsTarget,
  openProjectInDevtools,
};
