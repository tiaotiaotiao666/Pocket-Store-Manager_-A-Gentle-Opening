const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PACKAGE_NAME = `smart-store-generator-draft-v${VERSION}`;
const OUT_ROOT = path.join(ROOT, 'release-upload');
const STAGE_PARENT = path.join(OUT_ROOT, 'staging');
const STAGE = path.join(STAGE_PARENT, PACKAGE_NAME);
const SOURCE_DIR = path.join(STAGE, 'source');
const FINAL_ZIP = path.join(OUT_ROOT, `${PACKAGE_NAME}.zip`);
const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const TOP_LEVEL_EXCLUDES = new Set([
  '.git',
  '.arts',
  '.codeartsdoer',
  '.tools',
  '.npm-logs',
  '.npm-cache',
  '.npm-cache-run',
  'node_modules',
  'dist',
  'release',
  'release-upload',
  'generated-projects',
  '.merkle-snapshot.json',
]);

function isExcluded(rel) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (TOP_LEVEL_EXCLUDES.has(parts[0])) return true;
  if (parts[0].startsWith('.npm-cache')) return true;
  if (parts.some((part) => part === 'node_modules' || part === '.git' || part === '.tools' || part === '.npm-logs' || part === 'coverage' || part === '.nyc_output' || part === 'test-results')) return true;
  if (rel === 'docs/2026-11-02-上传包构建说明.md') return true;
  if (parts.length === 1 && /\.(rar|7z)$/i.test(base)) return true;
  if (base === '.env') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  if (base === 'project.private.config.json') return true;
  if (/\.(log|pem|key|sqlite|sqlite3|db|db-journal|tmp|temp|swp|swo)$/i.test(base)) return true;
  if (base.endsWith('~')) return true;
  if (rel === 'server/dist' || rel.startsWith('server/dist/')) return true;
  return false;
}

async function copyTree(fromDir, toDir, relPrefix = '') {
  await fsp.mkdir(toDir, { recursive: true });
  const entries = await fsp.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (isExcluded(rel)) continue;
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, rel);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
    }
  }
}

function zipDirectory(zipPath, cwdDir, entry) {
  execFileSync(SEVEN_ZIP, ['a', '-tzip', '-mx=9', '-y', zipPath, entry], { cwd: cwdDir, stdio: 'pipe' });
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function walk(dir, relPrefix = '', list = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), rel, list);
    } else if (entry.isFile()) {
      list.push(rel);
    }
  }
  return list;
}

async function writeManifest() {
  const files = (await walk(STAGE)).filter((rel) => rel !== 'MANIFEST.txt').sort();
  const lines = [
    `package: ${PACKAGE_NAME}`,
    `version: ${VERSION}`,
    `generatedAt: ${new Date().toISOString()}`,
    `files: ${files.length}`,
    '',
    'sha256  size  path',
  ];
  for (const rel of files) {
    const full = path.join(STAGE, ...rel.split('/'));
    const size = (await fsp.stat(full)).size;
    lines.push(`${sha256(full)}  ${size}  ${rel}`);
  }
  await fsp.writeFile(path.join(STAGE, 'MANIFEST.txt'), `${lines.join('\n')}\n`, 'utf8');
}

async function assertClean() {
  const files = await walk(STAGE);
  const problems = [];
  for (const rel of files) {
    const base = rel.split('/').pop();
    if (base === '.env') problems.push(`发现真实环境文件: ${rel}`);
    if (base.startsWith('.env.') && base !== '.env.example') problems.push(`发现环境文件: ${rel}`);
    if (rel.split('/').includes('node_modules')) problems.push(`发现依赖目录: ${rel}`);
    if (base === 'project.private.config.json') problems.push(`发现微信本机配置: ${rel}`);
  }
  if (problems.length > 0) {
    throw new Error(`上传包安全检查失败:\n${problems.join('\n')}`);
  }
  return files;
}

async function main() {
  if (!fs.existsSync(SEVEN_ZIP)) {
    throw new Error(`未找到 7za: ${SEVEN_ZIP}，请先执行 npm install`);
  }
  const setupFiles = fs.existsSync(path.join(ROOT, 'release'))
    ? fs.readdirSync(path.join(ROOT, 'release')).filter((name) => name.toLowerCase().endsWith('.exe'))
    : [];
  if (setupFiles.length === 0) {
    throw new Error('未找到桌面端安装包，请先执行 npm run build:win，并设置 ELECTRON_MIRROR 与 ELECTRON_BUILDER_BINARIES_MIRROR');
  }
  const setupSource = path.join(ROOT, 'release', setupFiles[0]);

  await fsp.rm(OUT_ROOT, { recursive: true, force: true });
  await fsp.mkdir(SOURCE_DIR, { recursive: true });

  await copyTree(ROOT, SOURCE_DIR);
  await fsp.copyFile(path.join(ROOT, 'docs', '上传包说明.md'), path.join(STAGE, 'README.md'));

  const desktopDir = path.join(STAGE, 'desktop');
  await fsp.mkdir(desktopDir, { recursive: true });
  const desktopTarget = path.join(desktopDir, `smart-store-desktop-setup-${VERSION}.exe`);
  await fsp.copyFile(setupSource, desktopTarget);

  const miniParent = path.join(STAGE, 'miniprogram');
  await fsp.mkdir(miniParent, { recursive: true });
  const miniZip = path.join(miniParent, `smart-store-miniprogram-${VERSION}.zip`);
  const miniBuildRoot = path.join(OUT_ROOT, 'miniprogram-build');
  await fsp.mkdir(miniBuildRoot, { recursive: true });
  await copyTree(path.join(SOURCE_DIR, 'miniprogram'), path.join(miniBuildRoot, 'smart-store-miniprogram'));
  zipDirectory(miniZip, miniBuildRoot, 'smart-store-miniprogram');

  await writeManifest();
  const files = await assertClean();

  zipDirectory(FINAL_ZIP, STAGE_PARENT, PACKAGE_NAME);

  const totalSize = (await fsp.stat(FINAL_ZIP)).size;
  const allStageFiles = await walk(STAGE);
  let stageSize = 0;
  for (const rel of allStageFiles) {
    stageSize += (await fsp.stat(path.join(STAGE, ...rel.split('/')))).size;
  }
  const summary = {
    package: FINAL_ZIP,
    version: VERSION,
    files: files.length + 1,
    desktopInstaller: path.basename(desktopTarget),
    desktopInstallerBytes: (await fsp.stat(desktopTarget)).size,
    miniprogramZip: path.basename(miniZip),
    miniprogramZipBytes: (await fsp.stat(miniZip)).size,
    packageBytes: totalSize,
    packageMegabytes: Number((totalSize / 1024 / 1024).toFixed(2)),
    stageMegabytes: Number((stageSize / 1024 / 1024).toFixed(2)),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});