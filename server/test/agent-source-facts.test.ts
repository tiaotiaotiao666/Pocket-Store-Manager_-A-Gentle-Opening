import { describe, expect, it } from 'vitest';

import {
  SOURCE_FACTS_PAGE_IDS,
  SourceFactsError,
  getPageSourceFacts,
  listSourceFactsTargetPages,
  loadSourceFacts,
  resetSourceFactsCacheForTests,
  summarizeSourceFacts,
  validateSourceFactsSnapshot,
} from '../src/agent/workspace/source-facts';
import { SOURCE_FACTS_SNAPSHOT } from '../src/agent/workspace/source-facts.snapshot';

function cloneSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(SOURCE_FACTS_SNAPSHOT)) as Record<string, unknown>;
}

describe('source-facts.v2 服务端只读事实', () => {
  it('加载 8 页事实、15 个组件与 page-contract', () => {
    resetSourceFactsCacheForTests();
    const snapshot = loadSourceFacts();
    expect(snapshot.version).toBe('source-facts.v2');
    expect(Object.keys(snapshot.pages).sort()).toEqual([...SOURCE_FACTS_PAGE_IDS].sort());
    expect(Object.keys(snapshot.components).length).toBeGreaterThanOrEqual(15);
    expect(snapshot.checkIds.map((check) => check.id)).toContain('source.check');
    for (const pageId of SOURCE_FACTS_PAGE_IDS) {
      const page = getPageSourceFacts(pageId);
      expect(page.pageContract.pageId).toBe(pageId);
      expect(page.pageContract.availableCheckIds.length).toBeGreaterThan(0);
      expect(page.uiStates.some((state) => state.key === 'loading')).toBe(true);
      expect(page.uiStates.some((state) => state.key === 'error')).toBe(true);
      expect(page.source.wxml).toContain('/pages/' + pageId + '/index.wxml');
    }
  });

  it('保留 WXML 未使用但 data 真实的字段（menu.storeId / menu.slotProps）', () => {
    const page = getPageSourceFacts('menu');
    expect(page.data.initial.storeId).toBeDefined();
    expect(page.data.initial.slotProps).toBeDefined();
    expect(Object.keys(page.data.initial)).toContain('products');
    expect(page.uiStates.some((state) => state.key === 'loading' && state.usedInWxml)).toBe(true);
  });

  it('checkout 具备 submitting 状态，merchant-orders 具备轮询/检查状态', () => {
    const checkout = getPageSourceFacts('checkout');
    expect(checkout.uiStates.find((state) => state.key === 'submitting')?.kind).toBe('loading');
    const merchant = getPageSourceFacts('merchant-orders');
    for (const key of ['checking', 'polling', 'ordersLoading', 'productsLoading']) {
      expect(merchant.uiStates.some((state) => state.key === key)).toBe(true);
    }
  });

  it('组件事实包含四件套路径、props/events/示例/限制', () => {
    const snapshot = loadSourceFacts();
    const productCard = snapshot.components['product-card'];
    expect(productCard.files).toEqual(['index.js', 'index.json', 'index.wxml', 'index.wxss']);
    expect(productCard.props.map((prop) => prop[0])).toEqual(['disabled', 'product', 'quantity']);
    expect(productCard.events.map((event) => event[0])).toEqual(['add', 'openDetail', 'remove']);
    expect(productCard.example).toContain('<product-card');
    expect(productCard.limits.length).toBeGreaterThan(0);
    expect(snapshot.components['poster-carousel'].kind).toBe('feature-pack');
  });

  it('目标页可用性由事实推导（8 页全部 enabled）', () => {
    const targets = listSourceFactsTargetPages();
    expect(targets.map((target) => target.id)).toEqual([...SOURCE_FACTS_PAGE_IDS]);
    expect(targets.every((target) => target.enabled && target.reasons.includes('page-contract'))).toBe(true);
    const summary = summarizeSourceFacts();
    expect(summary.pageCount).toBe(8);
    expect(summary.checkIds).toContain('wechat.verify');
    expect(summary.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('fail closed：缺页、绝对路径、摘要篡改、未知 checkId 都拒绝', () => {
    const missingPage = cloneSnapshot();
    delete (missingPage.pages as Record<string, unknown>).menu;
    expect(() => validateSourceFactsSnapshot(missingPage)).toThrow(SourceFactsError);

    const absolutePath = cloneSnapshot();
    (absolutePath.pages as Record<string, Record<string, unknown>>).menu.source.wxml = 'E:\\secret\\pages\\menu\\index.wxml';
    expect(() => validateSourceFactsSnapshot(absolutePath)).toThrow(SourceFactsError);

    const tampered = cloneSnapshot();
    tampered.digest = 'sha256:' + '0'.repeat(64);
    expect(() => validateSourceFactsSnapshot(tampered)).toThrow(SourceFactsError);

    const unknownCheck = cloneSnapshot();
    (unknownCheck.checkIds as Array<{ id: string }>)[0].id = 'shell.exec';
    expect(() => validateSourceFactsSnapshot(unknownCheck)).toThrow(SourceFactsError);

    const badContract = cloneSnapshot();
    (badContract.pages as Record<string, Record<string, unknown>>).menu.pageContract = {
      ...(badContract.pages as Record<string, Record<string, Record<string, unknown>>>).menu.pageContract,
      requiredHandlers: ['onNotExist'],
    };
    expect(() => validateSourceFactsSnapshot(badContract)).toThrow(SourceFactsError);
  });

  it('未知页面抛出稳定错误码', () => {
    expect(() => getPageSourceFacts('unknown-page')).toThrowError(SourceFactsError);
  });
});
