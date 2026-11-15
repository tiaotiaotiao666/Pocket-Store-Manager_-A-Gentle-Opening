'use strict';

/**
 * W0 / P0-1：一键启动脚本的契约测试。
 *
 * 这些是静态/契约断言，不启动服务；真实启动场景由 `npm run agent:smoke` 与
 * 手工四场景（正常 / MySQL 停止 / 端口被不健康进程占用 / Redis 不可用）覆盖，
 * 结果写在回报里。这里只锁死「不允许退回只看端口」这件事。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// 用户实际双击的是工作区级脚本（仓库的同级目录），它不在版本控制里。
// 干净克隆下不存在，相应断言按 skip 处理，不伪造通过。
const WORKSPACE_LAUNCHER = path.resolve(REPO, '..', 'start-all.ps1');
const REPO_LAUNCHER = path.join(REPO, 'scripts', 'start-all.ps1');
const READINESS_CLI = path.join(REPO, 'scripts', 'backend-readiness.cjs');

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function hasUtf8Bom(file) {
  const bytes = fs.readFileSync(file);
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

test('就绪判定唯一实现在 scripts/backend-readiness.cjs，且判定条件是 readyz + database=ok', () => {
  assert.ok(fs.existsSync(READINESS_CLI), '缺少 scripts/backend-readiness.cjs');
  const source = readUtf8(READINESS_CLI);
  assert.ok(source.includes('/api/v1/readyz'), '必须探测 /api/v1/readyz');
  assert.ok(source.includes("database !== 'ok'"), '必须显式判定 database === ok');
  assert.ok(source.includes('DATABASE_NOT_READY'), '数据库未就绪要有稳定错误码');
  assert.ok(source.includes('cacheDegraded'), '必须暴露 cache 降级标识');
  const mod = require(READINESS_CLI);
  for (const name of ['probeOnce', 'evaluateReadiness', 'waitForReadiness']) {
    assert.strictEqual(typeof mod[name], 'function', `缺少导出 ${name}`);
  }
});

test('仓库启动脚本：后端通过条件改为 Invoke-BackendReadiness，不再只看端口或 /health', () => {
  const source = readUtf8(REPO_LAUNCHER);
  assert.ok(source.includes('Invoke-BackendReadiness'), '必须调用就绪探测');
  assert.ok(source.includes('backend-readiness.cjs'), '必须指向唯一实现');
  assert.ok(!source.includes('Test-BackendHealth'), '旧的 /health 判定必须移除');
  assert.ok(!source.includes('backend already healthy'), '不允许「端口通就算健康」的措辞');
  assert.ok(source.includes('Show-PortOccupancy'), '端口被占用时必须输出占用者');
  assert.ok(source.includes("$backendProbe.cache -eq 'memory'"), 'cache=memory 必须显式提示降级');
  assert.ok(source.includes('userdata-path.txt'), '必须显示与客户端同源的数据目录');
});

test('工作区一键启动脚本（用户实际双击的那份）：同样改为 readyz 判定并能报占用', (t) => {
  if (!fs.existsSync(WORKSPACE_LAUNCHER)) {
    t.skip('工作区级 start-all.ps1 不存在（干净克隆环境）');
    return;
  }
  const source = readUtf8(WORKSPACE_LAUNCHER);
  assert.ok(source.includes('Invoke-BackendReadiness'));
  assert.ok(source.includes('backend-readiness.cjs'));
  assert.ok(!source.includes('后端已在运行，跳过'), '端口被占用时不能静默跳过');
  assert.ok(source.includes('Show-PortOccupancy'), '必须输出占用端口/进程/启动时间');
  assert.ok(source.includes('RestartBackend'), '必须给出重启旧进程的处置手段');
  assert.ok(source.includes("$backendProbe.cache -eq 'memory'"), 'cache=memory 必须显式提示降级');
  assert.ok(source.includes('userdata-path.txt'), '必须显示与客户端同源的数据目录');
});

test('中文启动脚本保留 UTF-8 BOM（PS5.1 无 BOM 会把中文按 ANSI 解码而错切字符串）', (t) => {
  if (!fs.existsSync(WORKSPACE_LAUNCHER)) {
    t.skip('工作区级 start-all.ps1 不存在（干净克隆环境）');
    return;
  }
  assert.ok(hasUtf8Bom(WORKSPACE_LAUNCHER), 'ICT\\start-all.ps1 必须以 UTF-8 BOM 保存');
  const text = readUtf8(WORKSPACE_LAUNCHER);
  assert.ok(!text.includes('\uFFFD'), '文件里不应出现替换字符（说明编码已经损坏）');
  assert.ok(text.includes('智能开店'), '中文标题应可正常读出');
});

test('仓库启动脚本保持 ASCII-only 约定（其文件头明示 PS5.1 兼容要求）', () => {
  const bytes = fs.readFileSync(REPO_LAUNCHER);
  const text = bytes.toString('utf8');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(text), 'scripts/start-all.ps1 应保持纯 ASCII');
});
