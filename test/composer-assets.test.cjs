'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BASE_DIR = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const SRC_DIR = path.join(BASE_DIR, 'src');
const registryModule = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('Base 入口四件套与主题入口存在', () => {
  ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'theme.generated.wxss'].forEach((name) => {
    assert.ok(fs.existsSync(path.join(SRC_DIR, name)), '缺少 ' + name);
  });
  assert.ok(/@import\s+["']theme\.generated\.wxss["'];/.test(read(path.join(SRC_DIR, 'app.wxss'))));
  assert.ok(!/--store-[a-z-]+\s*:/.test(read(path.join(SRC_DIR, 'app.wxss'))), 'app.wxss 不得硬编码 --store-* Token');
});

test('app.json 页面与磁盘一致且覆盖 7 页闭环', () => {
  const appJson = readJson(path.join(SRC_DIR, 'app.json'));
  assert.strictEqual(appJson.pages.length, 7);
  appJson.pages.forEach((page) => {
    assert.ok(fs.existsSync(path.join(SRC_DIR, page + '.js')), page + ' 缺少 js');
    assert.ok(fs.existsSync(path.join(SRC_DIR, page + '.wxml')), page + ' 缺少 wxml');
    assert.ok(fs.existsSync(path.join(SRC_DIR, page + '.json')), page + ' 缺少 json');
  });
  const diskPages = fs.readdirSync(path.join(SRC_DIR, 'pages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => 'pages/' + entry.name + '/index');
  assert.deepStrictEqual([...appJson.pages].sort(), diskPages.sort());
});

test('Base Manifest 声明 7 页、7 个主题 Token 与 3 个插槽', () => {
  const manifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  assert.strictEqual(manifest.pages.length, 7);
  assert.ok(manifest.themeTokens.length >= 4);
  assert.ok(manifest.themeTokens.some((token) => token.key === 'textColor' && token.contrastWith === 'pageBackground'));
  assert.deepStrictEqual(manifest.slots.map((slot) => slot.slotId).sort(), ['home-hero', 'home-marketing', 'menu-aside']);
  assert.deepStrictEqual(manifest.excludedCapabilities.sort(), ['ad-slot', 'coupon', 'poster-carousel']);

  const theme = readJson(path.join(BASE_DIR, 'theme.tokens.json'));
  assert.ok(theme.presets.length >= 3);
  theme.presets.forEach((preset) => {
    ['pageBackground', 'primaryColor', 'accentColor', 'textColor'].forEach((key) => {
      assert.ok(/^#[0-9A-F]{6}$/.test(preset.tokens[key]), preset.id + ' 缺少合法 ' + key);
    });
  });
});

test('插槽锚点三段式完整且每段只出现一次', () => {
  const homeWxml = read(path.join(SRC_DIR, 'pages', 'home', 'index.wxml'));
  const menuWxml = read(path.join(SRC_DIR, 'pages', 'menu', 'index.wxml'));
  const pairs = [
    [homeWxml, 'home-hero'],
    [homeWxml, 'home-marketing'],
    [menuWxml, 'menu-aside'],
  ];
  pairs.forEach(([content, slotId]) => {
    const anchors = [
      '<!-- @slot:' + slotId + ' -->',
      '<!-- @slot-fallback:' + slotId + ' -->',
      '<!-- @slot-fallback:' + slotId + ':end -->',
      '<!-- @slot:' + slotId + ':end -->',
    ];
    anchors.forEach((anchor) => {
      const count = content.split(anchor).length - 1;
      assert.strictEqual(count, 1, slotId + ' 锚点出现 ' + count + ' 次：' + anchor);
    });
  });
});

test('fallback 保留改造前的真实标签', () => {
  const homeWxml = read(path.join(SRC_DIR, 'pages', 'home', 'index.wxml'));
  const fallback = homeWxml.split('<!-- @slot-fallback:home-hero -->')[1].split('<!-- @slot-fallback:home-hero:end -->')[0];
  assert.ok(/<store-header[\s\S]*store-name="\{\{store\.name\}\}"/.test(fallback));
});

test('Base 必备服务、状态组件与页面 JS 契约', () => {
  ['services/request.js', 'services/platform.js'].forEach((file) => {
    assert.ok(fs.existsSync(path.join(SRC_DIR, file)), '缺少 ' + file);
  });
  ['state-view', 'loading-block', 'error-banner'].forEach((name) => {
    assert.ok(fs.existsSync(path.join(SRC_DIR, 'components', name, 'index.js')), '缺少组件 ' + name);
  });
  ['home', 'menu', 'orders', 'mine'].forEach((page) => {
    const source = read(path.join(SRC_DIR, 'pages', page, 'index.js'));
    assert.ok(source.includes('config/env.js'), page + ' 页面必须通过 config/env.js 读取公开配置');
  });
  assert.ok(read(path.join(SRC_DIR, 'config', 'env.js')).includes("require('./store.generated.js')"));
  assert.ok(fs.existsSync(path.join(SRC_DIR, 'pages', 'merchant-orders', 'index.js')));
});

test('Base 不内置营销能力实现', () => {
  const manifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  manifest.excludedCapabilities.forEach((capability) => {
    assert.ok(!fs.existsSync(path.join(SRC_DIR, 'components', capability)), 'Base 不应包含 ' + capability);
  });
});

test('UI Block 资产边界四项必须为 false 且零越界调用', () => {
  const loaded = registryModule.loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.errors));
  const blocks = loaded.assets.filter((asset) => asset.kind === 'ui-block');
  blocks.forEach((asset) => {
    const boundary = asset.manifest.boundary;
    assert.deepStrictEqual(
      boundary,
      { allowNetwork: false, allowRoutes: false, allowGlobalState: false, allowServices: false },
      asset.id + ' 边界不合法',
    );
    const source = read(path.join(asset.dir, asset.manifest.entry.path, 'index.js'));
    assert.ok(!/wx\.request\s*\(/.test(source), asset.id + ' 不得触网');
    assert.ok(!/wx\.(navigateTo|redirectTo|switchTab|reLaunch)\s*\(/.test(source), asset.id + ' 不得固定路由');
    assert.ok(!/globalData/.test(source), asset.id + ' 不得读写 globalData');
    assert.ok(!/require\([^)]*services\//.test(source), asset.id + ' 不得依赖服务层');
  });
});

test('可删除性占位：无可选 Block 时 Plan 仍满足 Base 必需页', { todo: 'M7 注册表冻结后打开 order-poster 真实产物断言' }, () => {
  const manifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  const requiredPages = manifest.pages.filter((page) => page.required).map((page) => page.pageId);
  assert.ok(requiredPages.includes('home'));
  assert.ok(requiredPages.includes('menu'));
});

test('M7 首批资产目录完整：3 UI Block + 1 Feature Pack + 3 Recipe', () => {
  const componentsRoot = path.join(REPO, 'templates', 'components');
  const featuresRoot = path.join(REPO, 'templates', 'features');
  const recipesRoot = path.join(REPO, 'templates', 'recipes');

  const componentManifests = [];
  fs.readdirSync(componentsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((assetDir) => {
    fs.readdirSync(path.join(componentsRoot, assetDir.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((versionDir) => {
        componentManifests.push(path.join(componentsRoot, assetDir.name, versionDir.name, 'manifest.json'));
      });
  });
  assert.deepStrictEqual(
    componentManifests.map((file) => path.basename(path.dirname(path.dirname(file)))).sort(),
    ['cart-bar', 'product-card', 'store-header'],
  );

  const featureManifests = [];
  fs.readdirSync(featuresRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((assetDir) => {
    fs.readdirSync(path.join(featuresRoot, assetDir.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((versionDir) => {
        featureManifests.push(path.join(featuresRoot, assetDir.name, versionDir.name, 'manifest.json'));
      });
  });
  assert.deepStrictEqual(featureManifests.map((file) => path.basename(path.dirname(path.dirname(file)))), ['poster-carousel']);

  const recipeFiles = [];
  fs.readdirSync(recipesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((recipeDir) => {
    fs.readdirSync(path.join(recipesRoot, recipeDir.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((versionDir) => {
        recipeFiles.push(path.join(recipesRoot, recipeDir.name, versionDir.name, 'recipe.json'));
      });
  });
  assert.deepStrictEqual(
    recipeFiles.map((file) => path.basename(path.dirname(path.dirname(file)))).sort(),
    ['order-classic', 'order-classic-candidate', 'order-poster'],
  );
});

test('M7 每个资产：Manifest 合法、四类预览齐全、实现一致、边界合规', () => {
  const { validateManifest } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
  const { checkComponentImplementation } = require(path.join(REPO, 'scripts', 'composer', 'manifest-impl-check.cjs'));

  const assetDirs = [];
  ['components', 'features'].forEach((group) => {
    const root = path.join(REPO, 'templates', group);
    fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((assetDir) => {
      fs.readdirSync(path.join(root, assetDir.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((versionDir) => {
          assetDirs.push(path.join(root, assetDir.name, versionDir.name));
        });
    });
  });
  assert.ok(assetDirs.length >= 4);

  assetDirs.forEach((dir) => {
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const validation = validateManifest(manifest);
    assert.strictEqual(validation.ok, true, dir + '：' + JSON.stringify(validation));
    assert.strictEqual(path.basename(dir), manifest.identity.version);

    manifest.preview.kinds.forEach((kind) => {
      const file = path.join(dir, manifest.preview.dir, kind + '.json');
      assert.ok(fs.existsSync(file), dir + ' 缺少预览 ' + kind);
      JSON.parse(fs.readFileSync(file, 'utf8'));
    });

    const impl = checkComponentImplementation(manifest, path.join(dir, manifest.entry.path));
    assert.strictEqual(impl.ok, true, dir + ' 实现不一致：' + JSON.stringify(impl));

    if (manifest.kind === 'ui-block') {
      assert.deepStrictEqual(manifest.boundary, {
        allowNetwork: false,
        allowRoutes: false,
        allowGlobalState: false,
        allowServices: false,
      });
    } else {
      assert.strictEqual(manifest.boundary.allowNetwork, false, 'Feature Pack 不得在组件内触网');
      assert.strictEqual(manifest.boundary.allowRoutes, false);
      assert.deepStrictEqual(manifest.requiresSlots, ['home-hero']);
    }
  });
});

test('M7 Recipe 计划均可通过 Plan Schema 校验', () => {
  const { validatePlan } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
  const plans = [
    'templates/recipes/order-classic/1.0.0/plan.json',
    'templates/recipes/order-poster/1.0.0/plan.json',
    'templates/recipes/order-classic-candidate/0.1.0/plan.json',
  ];
  plans.forEach((relative) => {
    const plan = readJson(path.join(REPO, relative));
    const validation = validatePlan(plan);
    assert.strictEqual(validation.ok, true, relative + '：' + JSON.stringify(validation));
  });

  const posterPlan = readJson(path.join(REPO, 'templates/recipes/order-poster/1.0.0/plan.json'));
  assert.strictEqual(posterPlan.features.length, 1);
  assert.strictEqual(posterPlan.features[0].slots[0].slotId, 'home-hero');
  assert.ok(Array.isArray(posterPlan.features[0].slots[0].props.items));
});

test('M7 preview-only 四处呈现的代码入口存在', () => {
  const deploySource = read(path.join(REPO, 'src', 'components', 'build', 'DeployStep.jsx'));
  const resultSource = read(path.join(REPO, 'src', 'components', 'build', 'ExportResultCard.jsx'));
  const emitSource = read(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
  const validateSource = read(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
  assert.match(deploySource, /仅预览能力/);
  assert.match(resultSource, /仅预览/);
  assert.match(emitSource, /仅预览资产/);
  assert.match(emitSource, /previewOnly/);
  assert.match(validateSource, /仅预览能力/);
});