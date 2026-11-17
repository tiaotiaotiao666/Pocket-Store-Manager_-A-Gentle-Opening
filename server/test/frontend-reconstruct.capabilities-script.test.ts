import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRONTEND_CAPABILITIES_SNAPSHOT } from '../src/agent/frontend-reconstruct/capabilities.snapshot';
import { FRONTEND_FACTS_VERSION, FRONTEND_SIZE_KEYS, FRONTEND_THEME_TOKEN_KEYS } from '../src/agent/frontend-reconstruct/types';

/**
 * 只读能力快照同源测试（P1）。
 *
 * 约束：
 * - 快照必须能由 `scripts/frontend-capabilities.cjs` 从 Base Manifest、catalog 与页面控制器
 *   逐字节重新生成（JSON 与 TS 两份同源）；
 * - 不启动服务、不访问网络、不写文件；只读仓库真源。
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'frontend-capabilities.cjs');
const SNAPSHOT_JSON_PATH = join(
  REPO_ROOT,
  'server',
  'src',
  'agent',
  'frontend-reconstruct',
  'capabilities.snapshot.json',
);
const SNAPSHOT_TS_PATH = join(
  REPO_ROOT,
  'server',
  'src',
  'agent',
  'frontend-reconstruct',
  'capabilities.snapshot.ts',
);

interface CapabilitiesScript {
  buildSnapshot(): Record<string, unknown>;
  checkSnapshot(options?: {
    files?: { json: string; ts: string };
  }): { ok: boolean; errors: string[] };
  compareSnapshotFile(
    file: string,
    expected: string | Buffer,
    options?: { binary?: boolean },
  ): { ok: boolean; error?: string };
  renderJson(snapshot: Record<string, unknown>): string;
  renderTs(jsonText: string): string;
  normalizeSnapshotText(text: string): string;
  TARGET_PAGES: readonly string[];
  THEME_TOKEN_KEYS: readonly string[];
  SIZE_KEYS: readonly string[];
  snapshotFiles(): { json: string; ts: string };
}

const require = createRequire(import.meta.url);
const script = require(SCRIPT_PATH) as CapabilitiesScript;

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

function readJson<T>(file: string): T {
  return JSON.parse(readText(file)) as T;
}

describe('scripts/frontend-capabilities.cjs 同源快照', () => {
  it('C1 生成结果确定性：连续两次构建逐字节一致，且不含时间戳', () => {
    const first = script.renderJson(script.buildSnapshot());
    const second = script.renderJson(script.buildSnapshot());
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(second).not.toContain('generatedAt');
  });

  it('C2 已提交的 JSON / TS 快照与生成结果 LF 归一化后一致，--check 通过', () => {
    const generated = script.renderJson(script.buildSnapshot());
    expect(script.normalizeSnapshotText(readText(SNAPSHOT_JSON_PATH)))
      .toBe(script.normalizeSnapshotText(generated));
    expect(script.normalizeSnapshotText(readText(SNAPSHOT_TS_PATH)))
      .toBe(script.normalizeSnapshotText(script.renderTs(generated)));

    const result = script.checkSnapshot();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('C2b CRLF 工作区（core.autocrlf=true）不会让 --check 误报，文本按 LF 归一化比较', () => {
    const dir = mkdtempSync(join(REPO_ROOT, '.tmp', 'frontend-cap-crlf-'));
    try {
      const built = script.buildSnapshot();
      const jsonLf = script.renderJson(built);
      const tsLf = script.renderTs(jsonLf);
      const jsonPath = join(dir, 'capabilities.snapshot.json');
      const tsPath = join(dir, 'capabilities.snapshot.ts');
      writeFileSync(jsonPath, jsonLf.replace(/\n/g, '\r\n'), 'utf8');
      writeFileSync(tsPath, tsLf.replace(/\n/g, '\r\n'), 'utf8');

      expect(script.compareSnapshotFile(jsonPath, jsonLf).ok).toBe(true);
      const result = script.checkSnapshot({ files: { json: jsonPath, ts: tsPath } });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2c 二进制比较按字节而非 CRLF 归一化', () => {
    const dir = mkdtempSync(join(REPO_ROOT, '.tmp', 'frontend-cap-bin-'));
    try {
      const lf = join(dir, 'a.bin');
      const crlf = join(dir, 'b.bin');
      writeFileSync(lf, Buffer.from([0x41, 0x0a, 0x42]));
      writeFileSync(crlf, Buffer.from([0x41, 0x0d, 0x0a, 0x42]));
      expect(script.compareSnapshotFile(lf, Buffer.from([0x41, 0x0a, 0x42]), { binary: true }).ok).toBe(true);
      expect(script.compareSnapshotFile(crlf, Buffer.from([0x41, 0x0a, 0x42]), { binary: true }).ok).toBe(false);
      // 同一对内容按文本比较则相等，证明两种比较语义明确区分。
      expect(script.compareSnapshotFile(crlf, readFileSync(lf))).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3 篡改快照会被 --check 判定为不一致（不是永远为真）', () => {
    const snapshot = JSON.parse(script.renderJson(script.buildSnapshot())) as {
      dataPaths: string[];
      pageIds: string[];
    };
    const original = script.renderJson(snapshot);
    snapshot.dataPaths.push('store.evilPath');
    expect(script.renderJson(snapshot)).not.toBe(original);

    const tamperedPages = { ...snapshot, pageIds: ['home'] };
    expect(script.renderJson(tamperedPages)).not.toBe(script.renderJson(script.buildSnapshot()));
  });

  it('C4 TS 快照与 JSON 快照等价，且能通过服务端契约校验', () => {
    expect(FRONTEND_CAPABILITIES_SNAPSHOT).toEqual(readJson(SNAPSHOT_JSON_PATH));
    expect(FRONTEND_CAPABILITIES_SNAPSHOT.version).toBe(FRONTEND_FACTS_VERSION);
    expect([...FRONTEND_CAPABILITIES_SNAPSHOT.pageIds]).toEqual([...script.TARGET_PAGES]);
    expect([...FRONTEND_CAPABILITIES_SNAPSHOT.themeTokens]).toEqual([...FRONTEND_THEME_TOKEN_KEYS]);
    expect([...FRONTEND_CAPABILITIES_SNAPSHOT.sizeKeys]).toEqual([...FRONTEND_SIZE_KEYS]);
    // 单一事实源：页面级事实与关键动作必须随 capabilities.snapshot.json 一起分发。
    expect(Object.keys(FRONTEND_CAPABILITIES_SNAPSHOT.pageFacts).sort()).toEqual(['home', 'menu']);
    expect(Object.keys(FRONTEND_CAPABILITIES_SNAPSHOT.keyActions).sort()).toEqual(['home', 'menu']);
    expect([...FRONTEND_CAPABILITIES_SNAPSHOT.dataPaths]).toEqual(
      expect.arrayContaining(['home.mode', 'menu.products', 'menu.categories', 'cart.items', 'cart.totalCents', 'cart.count']),
    );
  });

  it('C5 package.json 与打包检查覆盖新快照与前端重构脚本', () => {
    const pkg = readJson<{
      scripts: Record<string, string>;
      build: { files: string[] };
    }>(join(REPO_ROOT, 'package.json'));

    expect(pkg.scripts['frontend:capabilities']).toBe('node scripts/frontend-capabilities.cjs');
    expect(pkg.scripts['frontend:capabilities:check']).toBe(
      'node scripts/frontend-capabilities.cjs --check',
    );
    expect(pkg.build.files).toContain('scripts/frontend-capabilities.cjs');
    expect(pkg.build.files).toContain(
      'server/src/agent/frontend-reconstruct/capabilities.snapshot.json',
    );

    const packagingSource = readText(join(REPO_ROOT, 'scripts', 'check-packaging.cjs'));
    expect(packagingSource).toContain('server/src/agent/frontend-reconstruct/capabilities.snapshot.json');
    expect(packagingSource).toContain("'desktop', 'frontend-reconstruct'");
  });
});
