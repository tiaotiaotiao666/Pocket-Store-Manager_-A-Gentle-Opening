#!/usr/bin/env node
'use strict';

/**
 * 组合解析器：白名单 → 版本 → 依赖 → 冲突 → 循环 → 页面 → 插槽 → props → 兼容 → 主题。
 *
 * 设计约束：
 * - 只按 Plan 的精确版本取资产，任何“最新版本”解析都被禁止。
 * - 不自动补依赖、不隐式删除资产；缺失即失败，除非 Plan 显式声明 degradations。
 * - 相同输入必须得到相同 graph（排序在输出时固定）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { getAsset } = require('./registry.cjs');
const {
  validatePlan,
  validateSlots,
  validatePath,
  normalizePresentationTokens,
  normalizeSlotOrder,
  presentationSlotDataKey,
  FRONTEND_PACK_PAGE_JSON_KEYS,
  fail,
  ok,
} = require('./schema.cjs');
const { assetDigest } = require('./digest.cjs');

function parseVersion(version) {
  return String(version).split('.').map((part) => Number(part));
}

function compareVersion(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function satisfiesBaseRange(baseVersion, range) {
  if (typeof range !== 'string' || !range.startsWith('^')) return false;
  const target = range.slice(1);
  const base = parseVersion(baseVersion);
  const wanted = parseVersion(target);
  return base[0] === wanted[0] && compareVersion(baseVersion, target) >= 0;
}

function toLinear(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  return 0.2126 * toLinear(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * toLinear(parseInt(hex.slice(3, 5), 16))
    + 0.0722 * toLinear(parseInt(hex.slice(5, 7), 16));
}

function contrastRatio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function resolvePlan(planInput, loaded, options) {
  const opts = options || {};
  const planValidation = validatePlan(planInput);
  if (!planValidation.ok) return planValidation;
  const role = opts.role === 'combined' ? undefined : opts.role;
  if (role !== undefined && role !== 'customer' && role !== 'merchant') {
    return fail('ROLE_INVALID', 'role', 'role 仅支持 customer、merchant 或 combined', { role: opts.role });
  }
  const plan = planInput;

  if (!loaded || !loaded.ok) {
    return fail('REGISTRY_NOT_LOADED', '$', '注册表未加载或校验失败', loaded && loaded.details);
  }
  if (plan.registryVersion !== loaded.registry.registryVersion) {
    return fail('REGISTRY_VERSION_MISMATCH', 'registryVersion', 'Plan 与注册表版本不一致', {
      plan: plan.registryVersion,
      registry: loaded.registry.registryVersion,
    });
  }

  const baseResult = getAsset(loaded, plan.baseTemplate.id, plan.baseTemplate.version);
  if (!baseResult.ok) return baseResult;
  const base = baseResult.asset;
  if (base.kind !== 'base') return fail('ASSET_KIND_MISMATCH', 'baseTemplate.id', 'Base 索引类型不正确');
  if (base.manifest.release.stage !== 'stable') {
    return fail('BASE_NOT_STABLE', 'baseTemplate.id', 'Base 不是 stable 状态：' + base.manifest.release.stage);
  }

  const degradations = new Map((plan.degradations || []).map((item) => [item.assetId, item.reason]));
  const degraded = [];
  const updatesAvailable = [];
  const requested = new Map();
  const order = [];

  function pushRequest(id, version, requiredBy, options) {
    const key = id + '@' + version;
    if (requested.has(key)) return requested.get(key);
    const result = getAsset(loaded, id, version);
    if (!result.ok) {
      if (degradations.has(id)) {
        degraded.push({ assetId: id, version, reason: degradations.get(id) });
        return null;
      }
      return result;
    }
    const asset = result.asset;
    if (asset.kind === 'recipe') {
      return fail('ASSET_KIND_MISMATCH', 'features', 'Recipe 不能作为组合资产：' + id);
    }
    requested.set(key, asset);
    order.push({ asset, requiredBy: requiredBy || 'plan', requestedVersion: version, options: options || {} });
    const sameId = loaded.assets.filter((item) => item.id === id && item.version !== version);
    if (sameId.length > 0) {
      sameId.forEach((item) => {
        if (compareVersion(item.version, version) > 0) {
          updatesAvailable.push({ id, current: version, available: item.version });
        }
      });
    }
    return asset;
  }

  const references = [];
  (plan.components || []).forEach((component) => references.push({ id: component.id, version: component.version, requiredBy: 'components' }));
  (plan.features || []).forEach((feature) => references.push({ id: feature.id, version: feature.version, requiredBy: 'features' }));

  // FrontendPack：受控视图包。只允许精确引用，不参与插槽落位，也不允许被静默降级。
  let frontendPackAsset = null;
  if (plan.frontendPack) {
    const pack = getAsset(loaded, plan.frontendPack.id, plan.frontendPack.version);
    if (!pack.ok) {
      return fail('FRONTEND_PACK_MISSING', 'frontendPack', 'FrontendPack 未登记：' + plan.frontendPack.id + '@' + plan.frontendPack.version, {
        id: plan.frontendPack.id,
        version: plan.frontendPack.version,
      });
    }
    if (pack.asset.kind !== 'frontend-pack') {
      return fail('ASSET_KIND_MISMATCH', 'frontendPack', 'frontendPack 引用的资产不是 frontend-pack', {
        id: plan.frontendPack.id,
        kind: pack.asset.kind,
      });
    }
    frontendPackAsset = pack.asset;
    requested.set(plan.frontendPack.id + '@' + plan.frontendPack.version, frontendPackAsset);
    order.push({
      asset: frontendPackAsset,
      requiredBy: 'frontendPack',
      requestedVersion: plan.frontendPack.version,
      options: {},
    });
  }

  for (const reference of references) {
    const asset = pushRequest(reference.id, reference.version, reference.requiredBy);
    if (asset && !asset.ok && asset.code) return asset;
  }

  const versionById = new Map();
  for (const asset of requested.values()) {
    if (versionById.has(asset.id) && versionById.get(asset.id) !== asset.version) {
      return fail('VERSION_CONFLICT', 'features', '同一资产出现多个版本：' + asset.id, {
        id: asset.id,
        versions: [versionById.get(asset.id), asset.version],
      });
    }
    versionById.set(asset.id, asset.version);
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const resolvedDependencies = [];
  let missingDependency = null;

  function visit(asset, requiredBy) {
    if (visiting.has(asset.id)) {
      const cycleStart = stack.indexOf(asset.id);
      return fail('DEPENDENCY_CYCLE', 'dependencies', '依赖存在环：' + [...stack.slice(cycleStart), asset.id].join(' -> '), {
        cycle: [...stack.slice(cycleStart), asset.id],
      });
    }
    if (visited.has(asset.id)) return null;
    visiting.add(asset.id);
    stack.push(asset.id);
    const dependencies = (asset.manifest && asset.manifest.dependencies) || [];
    for (const dependency of dependencies) {
      if (!missingDependency) {
        const resolved = getAsset(loaded, dependency.id, dependency.version);
        if (!resolved.ok) {
          if (degradations.has(dependency.id)) {
            degraded.push({ assetId: dependency.id, version: dependency.version, reason: degradations.get(dependency.id) });
            continue;
          }
          missingDependency = fail('DEPENDENCY_MISSING', 'dependencies', '缺少依赖 ' + dependency.id + '@' + dependency.version, {
            id: dependency.id,
            version: dependency.version,
            requiredBy: asset.id,
          });
          break;
        }
        if (resolved.asset.kind !== 'ui-block' && resolved.asset.kind !== 'feature-pack') {
          missingDependency = fail('DEPENDENCY_MISSING', 'dependencies', '依赖必须是 UI Block 或 Feature Pack', {
            id: dependency.id,
            requiredBy: asset.id,
          });
          break;
        }
        if (!requested.has(dependency.id + '@' + dependency.version)) {
          requested.set(dependency.id + '@' + dependency.version, resolved.asset);
          resolvedDependencies.push({ id: dependency.id, version: dependency.version, requiredBy: asset.id });
        }
        const nested = visit(resolved.asset, asset.id);
        if (nested) {
          missingDependency = nested;
          break;
        }
      }
    }
    stack.pop();
    visiting.delete(asset.id);
    visited.add(asset.id);
    return null;
  }

  for (const item of order) {
    const cycle = visit(item.asset, item.requiredBy);
    if (cycle) return cycle;
    if (missingDependency) return missingDependency;
  }

  const assets = [...requested.values()];
  for (let i = 0; i < assets.length; i += 1) {
    for (let j = i + 1; j < assets.length; j += 1) {
      const first = assets[i];
      const second = assets[j];
      const firstConflicts = (first.manifest && first.manifest.conflicts) || [];
      const secondConflicts = (second.manifest && second.manifest.conflicts) || [];
      if (firstConflicts.includes(second.id) || secondConflicts.includes(first.id)) {
        return fail('ASSET_CONFLICT', 'features', '资产冲突：' + first.id + ' 与 ' + second.id, {
          a: first.id,
          b: second.id,
          reason: firstConflicts.includes(second.id) ? 'declared-by-a' : 'declared-by-b',
        });
      }
    }
  }

  const basePages = new Map(base.manifest.pages.map((page) => [page.pageId, page]));
  const planPageIds = plan.pages.map((page) => page.pageId);
  for (const page of base.manifest.pages) {
    if (page.required && (role === undefined || page.audience === role) && !planPageIds.includes(page.pageId)) {
      return fail('BASE_REQUIRED_PAGE_MISSING', 'pages', '缺少 Base 必选页面：' + page.pageId, { pageId: page.pageId });
    }
  }
  for (const page of plan.pages) {
    if (!basePages.has(page.pageId)) {
      return fail('PAGE_NOT_IN_BASE', 'pages', 'Plan 页面未在 Base 声明：' + page.pageId, { pageId: page.pageId });
    }
  }

  if (frontendPackAsset) {
    const packPages = frontendPackAsset.manifest.pages || [];
    for (const pageId of packPages) {
      if (!planPageIds.includes(pageId)) {
        return fail('FRONTEND_PACK_PAGE_NOT_IN_PLAN', 'frontendPack', 'FrontendPack 页面未在 Plan 中启用：' + pageId, { pageId });
      }
      if (!basePages.has(pageId)) {
        return fail('FRONTEND_PACK_PAGE_NOT_IN_BASE', 'frontendPack', 'FrontendPack 页面未在 Base 声明：' + pageId, { pageId });
      }
    }
    for (const slotId of frontendPackAsset.manifest.requiresSlots || []) {
      const slot = base.manifest.slots.filter((item) => item.slotId === slotId)[0];
      if (!slot) {
        return fail('FRONTEND_PACK_SLOT_UNKNOWN', 'frontendPack', 'FrontendPack 依赖 Base 未声明的插槽：' + slotId, { slotId });
      }
      if (!packPages.includes(slot.pageId)) {
        return fail('FRONTEND_PACK_SLOT_PAGE_NOT_COVERED', 'frontendPack', 'FrontendPack 未覆盖插槽所在页面：' + slot.pageId, {
          slotId,
          pageId: slot.pageId,
        });
      }
    }

    const packRoot = path.join(frontendPackAsset.dir, frontendPackAsset.manifest.entry.path);
    for (const pageId of packPages) {
      const baseJsonPath = path.join(base.dir, base.manifest.entry.root, 'pages', pageId, 'index.json');
      let baseJson;
      try {
        baseJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
      } catch (error) {
        return fail('FRONTEND_PACK_BASE_PAGE_UNREADABLE', 'frontendPack', 'Base 页面配置无法读取：' + pageId, { pageId });
      }
      const packJsonPath = path.join(packRoot, 'pages', pageId, 'index.json');
      let packJson;
      try {
        packJson = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
      } catch (error) {
        return fail('FRONTEND_PACK_PAGE_JSON_INVALID', 'frontendPack', 'FrontendPack 页面 JSON 无法解析：' + pageId, { pageId, error: error.message });
      }
      const allowedJsonKeys = new Set(FRONTEND_PACK_PAGE_JSON_KEYS);
      for (const key of Object.keys(packJson)) {
        if (!allowedJsonKeys.has(key)) {
          return fail('FRONTEND_PACK_JSON_FIELD_FORBIDDEN', 'frontendPack', 'FrontendPack 页面 JSON 不允许字段：' + key, { pageId, key });
        }
      }
      const baseUsing = baseJson.usingComponents || {};
      const packUsing = packJson.usingComponents || {};
      for (const [tag, target] of Object.entries(packUsing)) {
        if (!Object.prototype.hasOwnProperty.call(baseUsing, tag)) {
          return fail('FRONTEND_PACK_COMPONENT_UNKNOWN', 'frontendPack', 'FrontendPack 不得新增 Base 未声明的组件：' + tag, { pageId, tag });
        }
        if (baseUsing[tag] !== target) {
          return fail('FRONTEND_PACK_COMPONENT_REMAP', 'frontendPack', 'FrontendPack 不得改绑 Base 组件路径：' + tag, { pageId, tag, base: baseUsing[tag], pack: target });
        }
      }

      const wxml = fs.readFileSync(path.join(packRoot, 'pages', pageId, 'index.wxml'), 'utf8');
      for (const slotId of frontendPackAsset.manifest.requiresSlots || []) {
        const slot = base.manifest.slots.filter((item) => item.slotId === slotId)[0];
        if (!slot || slot.pageId !== pageId) continue;
        for (const anchor of [
          '<!-- @slot:' + slotId + ' -->',
          '<!-- @slot-fallback:' + slotId + ' -->',
          '<!-- @slot-fallback:' + slotId + ':end -->',
          '<!-- @slot:' + slotId + ':end -->',
        ]) {
          if (wxml.split(anchor).length - 1 !== 1) {
            return fail('FRONTEND_PACK_SLOT_ANCHOR_MISSING', 'frontendPack', 'FrontendPack 页面缺少或重复插槽锚点：' + slotId, { pageId, slotId, anchor });
          }
        }
      }
    }
  }

  const slotsDoc = validateSlots({ schemaVersion: 'slots.v1', slots: base.manifest.slots });
  if (!slotsDoc.ok) return slotsDoc;

  const slotMap = new Map(base.manifest.slots.map((slot) => [slot.pageId + '#' + slot.slotId, slot]));

  // 展示声明（C-PLAN-PRESENTATION@1）：尺寸缺省按 md 补齐，落位缺省为空数组（沿用声明落位）。
  // 两者都只做视图层归一化，不回写 plan，也不改写 plan.features[].slots[]。
  const presentationTokens = normalizePresentationTokens(plan.presentationTokens);
  const slotOrder = normalizeSlotOrder(plan.slotOrder);
  const placementByFeature = new Map();
  for (const entry of slotOrder) {
    if (!placementByFeature.has(entry.featureId)) {
      placementByFeature.set(entry.featureId, entry);
    }
  }

  // 第一步：落位被 slotOrder 覆盖的 Feature，先按 Recipe 原始 features[].slots[] 校验
  // requiresSlots。落位由顶层 slotOrder 表达，但“是否提供了必需插槽”仍以声明为准；
  // 否则把 poster-carousel 移到 menu-hero 会误报 SLOT_REQUIRED_MISSING。
  // 未被覆盖的 Feature 保持既有校验顺序（先落位、后 requiresSlots），以免改变历史错误码优先级。
  for (const feature of plan.features) {
    if (!placementByFeature.has(feature.id)) continue;
    const asset = requested.get(feature.id + '@' + feature.version);
    if (!asset) continue;
    for (const requiredSlot of asset.manifest.requiresSlots || []) {
      if (!feature.slots.some((slot) => slot.slotId === requiredSlot)) {
        return fail('SLOT_REQUIRED_MISSING', 'features', '资产要求插槽未分配：' + requiredSlot, {
          assetId: asset.id,
          slotId: requiredSlot,
        });
      }
    }
  }

  // 第二步：落位映射。slotOrder 的目标 pageId+slotId 只作为 assignment key；
  // 目标插槽是否存在、accepts 是否匹配仍由 Base manifest 决定。
  const assignments = new Map();
  for (const feature of plan.features) {
    const asset = requested.get(feature.id + '@' + feature.version);
    if (!asset) continue;
    const placement = placementByFeature.get(feature.id) || null;
    for (let slotIndex = 0; slotIndex < feature.slots.length; slotIndex += 1) {
      const slot = feature.slots[slotIndex];
      // 一个 Feature 只对外暴露一个落位：仅首个插槽接受 slotOrder 覆盖。
      const override = slotIndex === 0 ? placement : null;
      let slotDecl = null;
      let slotPage = slot.pageId || '';
      let slotId = slot.slotId;
      let dataKey = slot.dataKey;
      if (override) {
        slotPage = override.pageId;
        slotId = override.slotId;
        // 配置键由目标插槽的固定映射决定（menu-hero → menuHero），否则沿用声明的 dataKey。
        dataKey = presentationSlotDataKey(slotId) || slot.dataKey;
        slotDecl = slotMap.get(slotPage + '#' + slotId) || null;
      } else if (slotPage) {
        slotDecl = slotMap.get(slotPage + '#' + slotId) || null;
      } else {
        const matches = base.manifest.slots.filter((candidate) => candidate.slotId === slotId);
        if (matches.length > 1) {
          return fail('SLOT_AMBIGUOUS', 'features', '插槽出现在多个页面，必须显式指定 pageId：' + slotId, {
            slotId,
            pages: matches.map((candidate) => candidate.pageId),
          });
        }
        if (matches.length === 1) {
          slotDecl = matches[0];
          slotPage = matches[0].pageId;
        }
      }
      const key = slotPage + '#' + slotId;
      if (!slotDecl) {
        return fail('SLOT_UNKNOWN', 'features', '插槽未在 Base 声明：' + slotId + (slotPage ? '@' + slotPage : ''), { slotId, pageId: slotPage || null });
      }
      if (!slotDecl.accepts.includes(asset.kind)) {
        return fail('SLOT_TYPE_REJECTED', 'features', '插槽 ' + slotId + ' 不接受 ' + asset.kind, {
          slotId,
          kind: asset.kind,
          accepts: slotDecl.accepts,
        });
      }
      const existing = assignments.get(key) || [];
      if (existing.some((item) => item.asset.id === asset.id)) {
        return fail('SLOT_DUPLICATED', 'features', '同一资产重复占用插槽：' + slotId, { slotId });
      }
      existing.push({
        asset,
        feature,
        slot,
        pageId: slotPage,
        slotId,
        // 导出侧配置键：T11 的 buildSlotsModule 必须用这个值，而不是再用 slotId 三元表达式。
        dataKey,
        placement: override ? 'slotOrder' : 'declared',
      });
      if (existing.length > slotDecl.maxItems) {
        return fail('SLOT_CAPACITY_EXCEEDED', 'features', '插槽容量超限：' + slotId, {
          slotId,
          maxItems: slotDecl.maxItems,
          actual: existing.length,
        });
      }
      assignments.set(key, existing);

      const propError = validateSlotProps(asset, slot.props || {});
      if (propError) return propError;
    }
    // 固有校验：requiresSlots 一律按 Recipe 原始声明判定（slotOrder 不改变“是否提供了必需插槽”）。
    for (const requiredSlot of asset.manifest.requiresSlots || []) {
      if (!feature.slots.some((slot) => slot.slotId === requiredSlot)) {
        return fail('SLOT_REQUIRED_MISSING', 'features', '资产要求插槽未分配：' + requiredSlot, {
          assetId: asset.id,
          slotId: requiredSlot,
        });
      }
    }
  }

  let minWechatLib = base.manifest.compatibility ? base.manifest.compatibility.minWechatLib : '3.0.0';
  for (const asset of assets) {
    const compatibility = asset.manifest.compatibility;
    if (!satisfiesBaseRange(base.manifest.identity.version, compatibility.baseRange)) {
      return fail('BASE_VERSION_INCOMPATIBLE', 'compatibility.baseRange', '资产不兼容当前 Base：' + asset.id, {
        assetId: asset.id,
        baseRange: compatibility.baseRange,
        baseVersion: base.manifest.identity.version,
      });
    }
    if (compatibility.apiContract !== plan.apiBinding.contract) {
      return fail('API_CONTRACT_INCOMPATIBLE', 'apiBinding.contract', '资产 API 契约不兼容：' + asset.id, {
        assetId: asset.id,
        declared: compatibility.apiContract,
        plan: plan.apiBinding.contract,
      });
    }
    if (compareVersion(compatibility.minWechatLib, minWechatLib) > 0) {
      minWechatLib = compatibility.minWechatLib;
    }
  }

  const themeResult = validateThemeTokens(plan.themeTokens, base.manifest.themeTokens);
  if (!themeResult.ok) return themeResult;

  const previewOnly = assets
    .filter((asset) => asset.kind !== 'frontend-pack' && asset.manifest.release.stage === 'preview-only')
    .map((asset) => asset.id)
    .sort();
  if (previewOnly.length > 0 && plan.previewOnlyAck !== true) {
    return fail('PREVIEW_ONLY_NOT_ACKNOWLEDGED', 'previewOnlyAck', '组合含 preview-only 资产，需显式确认', { assets: previewOnly });
  }
  if (previewOnly.length > 0 && opts.onlineRecipe === true) {
    return fail('PREVIEW_ONLY_IN_ONLINE_RECIPE', 'features', 'preview-only 资产不得进入 online Recipe', { assets: previewOnly });
  }

  const capabilitySet = assets.filter((asset) => asset.kind !== 'frontend-pack').map((asset) => asset.id).sort();
  const sourceDigests = [];
  const entryFiles = base.manifest.entry.files.map((file) => ({ assetId: base.manifest.identity.id, root: base.dir, relative: base.manifest.entry.root, file }));
  assets.forEach((asset) => {
    (asset.manifest.entry.files || []).forEach((file) => {
      sourceDigests.push({
        assetId: asset.id,
        file: file,
        digest: null,
      });
    });
  });
  entryFiles.forEach((entry) => {
    sourceDigests.push({ assetId: entry.assetId, file: entry.relative + '/' + entry.file, digest: null });
  });
  sourceDigests.sort((a, b) => (a.assetId === b.assetId ? a.file.localeCompare(b.file) : a.assetId.localeCompare(b.assetId)));

  return {
    ...ok(),
    plan,
    base,
    baseDir: base.dir,
    baseSrc: path.join(base.dir, base.manifest.entry.root),
    assets,
    assignments,
    slotMap,
    resolvedDependencies: resolvedDependencies.sort((a, b) => (a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id))),
    degraded,
    updatesAvailable: updatesAvailable.sort((a, b) => (a.id === b.id ? a.available.localeCompare(b.available) : a.id.localeCompare(b.id))),
    capabilitySet,
    previewOnly,
    onlineReady: capabilitySet.filter((id) => !previewOnly.includes(id)),
    minWechatLib,
    themeTokens: { ...plan.themeTokens },
    // 展示事实（C-PLAN-PRESENTATION@1）：归一化后的尺寸与落位，供 emit 输出 CSS 变量与插槽配置。
    presentationTokens,
    slotOrder,
    sourceDigests,
    pageIds: plan.pages.map((page) => page.pageId),
    manifestDigests: assets.map((asset) => ({ id: asset.id, version: asset.version, kind: asset.kind, digest: assetDigest(asset) })),
    // 受控视图包：Base 之上的页面视图覆盖层；没有则为 null。
    frontendPack: frontendPackAsset
      ? {
        asset: frontendPackAsset,
        manifest: frontendPackAsset.manifest,
        pages: [...(frontendPackAsset.manifest.pages || [])],
        root: path.join(frontendPackAsset.dir, frontendPackAsset.manifest.entry.path),
      }
      : null,
  };
}

function validateSlotProps(asset, props) {
  const declared = new Map((asset.manifest.interface.props || []).map((prop) => [prop.name, prop]));
  for (const key of Object.keys(props)) {
    if (!declared.has(key)) {
      return fail('PROP_UNKNOWN', 'props.' + key, '资产未声明 prop：' + key, { assetId: asset.id, prop: key });
    }
    const prop = declared.get(key);
    const value = props[key];
    const typeMatches = {
      string: typeof value === 'string',
      number: typeof value === 'number' && Number.isFinite(value),
      boolean: typeof value === 'boolean',
      array: Array.isArray(value),
      object: Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    }[prop.type];
    if (!typeMatches) {
      return fail('PROP_TYPE_MISMATCH', 'props.' + key, 'prop 类型不匹配：' + key, {
        assetId: asset.id,
        expected: prop.type,
        actual: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    if (prop.type === 'string' && value.length > 200) {
      return fail('PROP_LENGTH_EXCEEDED', 'props.' + key, 'prop 字符串超过 200 字符');
    }
  }
  for (const prop of declared.values()) {
    if (prop.required && !Object.prototype.hasOwnProperty.call(props, prop.name)) {
      return fail('PROP_REQUIRED_MISSING', 'props.' + prop.name, '缺少必填 prop：' + prop.name, { assetId: asset.id });
    }
  }
  return null;
}

function validateThemeTokens(tokens, declaredTokens) {
  const declared = new Set(declaredTokens.map((token) => token.key));
  for (const key of Object.keys(tokens)) {
    if (!declared.has(key)) {
      return fail('THEME_TOKEN_UNKNOWN', 'themeTokens.' + key, 'Base 未声明主题 Token：' + key);
    }
  }
  const required = declaredTokens.filter((token) => token.required).map((token) => token.key);
  for (const key of required) {
    if (typeof tokens[key] !== 'string') {
      return fail('THEME_TOKEN_MISSING', 'themeTokens.' + key, '缺少必需主题 Token：' + key);
    }
  }
  const background = tokens.pageBackground;
  const checks = [
    { token: 'textColor', minimum: 4.5 },
    { token: 'primaryColor', minimum: 3.0 },
    { token: 'accentColor', minimum: 3.0 },
  ];
  for (const check of checks) {
    if (!tokens[check.token]) continue;
    const ratio = contrastRatio(background, tokens[check.token]);
    if (ratio < check.minimum) {
      return fail('THEME_CONTRAST_LOW', 'themeTokens.' + check.token, '主题对比度不足', {
        token: check.token,
        background,
        foreground: tokens[check.token],
        ratio: Number(ratio.toFixed(2)),
        minimum: check.minimum,
      });
    }
  }
  return ok();
}

function fillThemeDefaults(tokens) {
  return {
    pageBackground: tokens.pageBackground,
    primaryColor: tokens.primaryColor,
    accentColor: tokens.accentColor,
    textColor: tokens.textColor,
    tabBarBackground: tokens.tabBarBackground || '#FFFDF9',
    tabBarColor: tokens.tabBarColor || '#8A8178',
    tabBarSelectedColor: tokens.tabBarSelectedColor || tokens.primaryColor,
  };
}

module.exports = {
  resolvePlan,
  validateSlotProps,
  validateThemeTokens,
  fillThemeDefaults,
  contrastRatio,
  compareVersion,
  satisfiesBaseRange,
  parseVersion,
};