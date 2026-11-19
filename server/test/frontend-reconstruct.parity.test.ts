/**
 * B6-3：同一组合法/非法/边界 fixture 在服务端与桌面端双跑，结论必须一致。
 *
 * 服务端校验器抛 `FrontendReconstructError`（外层 code 固定 `FRONTEND_DRAFT_INVALID`，
 * 明细在 `details.path`），桌面端返回 `{ ok, path }`。本测试把两侧归一成
 * `{ accepted, path }` 再比对：接受/拒绝必须相同，拒绝位置也必须相同。
 *
 * 同时在服务端侧再跑一次契约漂移检查，保证 `src/agent/frontend-reconstruct/contract.generated.ts`
 * 与 `contracts/frontend-reconstruct.v1.json` 没有分叉。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateFrontendPackDraft } from '../src/agent/frontend-reconstruct/schema';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const contractTool = require(path.join(repoRoot, 'scripts', 'frontend-contract.cjs'));
const caseLoader = require(path.join(repoRoot, 'scripts', 'frontend-contract-cases.cjs'));
const desktopSchema = require(path.join(repoRoot, 'desktop', 'frontend-reconstruct', 'schema.cjs'));

type Verdict = { accepted: boolean; path?: string };

function runServer(draft: unknown, facts: unknown, pageFacts: unknown): Verdict {
  try {
    validateFrontendPackDraft(draft, facts as never, pageFacts as never);
    return { accepted: true };
  } catch (error) {
    const details = (error as { details?: { path?: string } }).details;
    return { accepted: false, path: details?.path ?? '<no-path>' };
  }
}

function runDesktop(draft: unknown, facts: unknown, pageFacts: unknown): Verdict {
  const result = desktopSchema.validateDraft(draft, facts, pageFacts);
  return result.ok ? { accepted: true } : { accepted: false, path: result.path };
}

describe('frontend-reconstruct 契约双侧一致', () => {
  const { facts, pageFacts, cases } = caseLoader.loadCases();

  it('生成契约与契约源零漂移', () => {
    const result = contractTool.checkGenerated();
    expect(result.drifted).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fixture 覆盖合法/非法/边界三类', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const accepted = cases.filter((entry: { expect: { ok: boolean } }) => entry.expect.ok);
    const rejected = cases.filter((entry: { expect: { ok: boolean } }) => !entry.expect.ok);
    expect(accepted.length).toBeGreaterThanOrEqual(6);
    expect(rejected.length).toBeGreaterThanOrEqual(20);
  });

  it('每个 fixture 用例两侧结论与拒绝位置完全一致', () => {
    const divergences: string[] = [];
    for (const entry of cases) {
      const server = runServer(entry.draft, facts, pageFacts);
      const desktop = runDesktop(entry.draft, facts, pageFacts);
      if (server.accepted !== desktop.accepted) {
        divergences.push(
          `${entry.name}: 服务端 ${server.accepted ? '接受' : '拒绝(' + server.path + ')'} `
          + `vs 桌面端 ${desktop.accepted ? '接受' : '拒绝(' + desktop.path + ')'}`,
        );
        continue;
      }
      if (!server.accepted && server.path !== desktop.path) {
        divergences.push(`${entry.name}: 拒绝位置不同 服务端 ${server.path} vs 桌面端 ${desktop.path}`);
      }
      expect(server.accepted).toBe(entry.expect.ok);
      if (!entry.expect.ok && entry.expect.path !== undefined) {
        expect(server.path).toBe(entry.expect.path);
      }
    }
    expect(divergences).toEqual([]);
  });

  it('服务端与桌面端共享同一份契约常量（上限/键白名单/错误码）', () => {
    const desktopContract = require(path.join(repoRoot, 'desktop', 'frontend-reconstruct', 'contract.generated.cjs'));
    const contract = contractTool.loadContract().contract;
    expect(desktopContract.LIMITS).toEqual(contract.limits);
    expect(Object.values(desktopContract.DRAFT_ERROR_CODES).sort())
      .toEqual(Object.values(contract.enums.draftErrorCodes).sort());
    expect(desktopContract.THEME_TOKEN_KEYS).toEqual(contract.enums.themeTokenKeys);
    expect(desktopContract.PACK_PAGE_JSON_KEYS).toEqual(contract.keys.packPageJson);
  });
});
