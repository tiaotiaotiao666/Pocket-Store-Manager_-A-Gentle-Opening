#!/usr/bin/env node
'use strict';

/**
 * 智能开店：面向 agent 的桌面应用启动器。
 *
 * 背景：从 Electron 宿主（如 DeepSeek Harness）派生的 shell 会继承
 * ELECTRON_RUN_AS_NODE=1，此时 `electron .` 会以纯 Node 模式运行，
 * desktop/main.cjs:17 的 app.getPath('userData') 直接抛
 * `TypeError: Cannot read properties of undefined (reading 'getPath')`。
 * 本脚本在子进程环境里清掉该变量后再执行 npm run desktop:dev，
 * 因此 agent 可以一条命令拉起可被无障碍树读取的应用窗口。
 *
 * 用法：
 *   node scripts/agent-app.cjs          # 启动 vite + electron
 *   node scripts/agent-app.cjs --help
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  return `智能开店 · agent 友好的桌面启动器

  node scripts/agent-app.cjs

等价于 npm run desktop:dev，但会清掉 ELECTRON_RUN_AS_NODE，
避免 Electron 退化为纯 Node 进程而报 app.getPath 未定义。
启动后另开终端执行 npm run agent:smoke 验证无障碍调试链路。`;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const isWindows = process.platform === 'win32';
  const child = isWindows
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run desktop:dev'], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        windowsHide: false,
      })
    : spawn('npm', ['run', 'desktop:dev'], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        windowsHide: false,
      });

  child.on('error', (error) => {
    process.stderr.write(`[agent-app] 启动失败：${error.message}\n`);
    process.exit(1);
  });

  const forward = (signal) => () => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.stderr.write(`[agent-app] 子进程被信号终止：${signal}\n`);
    process.exit(code ?? 1);
  });

  return null;
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (typeof result === 'number') process.exitCode = result;
}
