'use strict';

/**
 * P6 结构门禁：四个 frontend-reconstruct 仓库级 skill + 既有 builder 边界 + 索引登记。
 *
 * 这个测试只校验“文档契约是否齐全、是否与真实工具/命令一致”，不执行任何 skill、
 * 不起服务、不写文件（除 node:test 自身外）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, '.codeartsdoer', 'skills');

const NEW_SKILLS = [
  'wechat-visual-spec',
  'wechat-capability-coverage',
  'wechat-frontend-pack-authoring',
  'wechat-frontend-verification',
];

const REQUIRED_SECTIONS = [
  '## 触发条件',
  '## 必读文件',
  '## 输入',
  '## 输出（含 schema 示例）',
  '## 禁止项',
  '## 验收',
  '## 失败退出',
];

const KEYWORDS = {
  'wechat-visual-spec': [
    'needs-input',
    'rejected',
    '"kind": "reference"',
    '409600',
    'unknownRegions',
    'lowConfidence',
    'inferredInteractions',
    'FRONTEND_IMAGE_',
    'UiRequirement',
    'VisualSpec',
    'planned',
  ],
  'wechat-capability-coverage': [
    'covered',
    'partial',
    'rejected',
    'base-page-fixed',
    'registry-validation',
    'slot-injection',
    'coveredBy',
    'requestedCapabilities',
    'frontend-capabilities.cjs',
    'FRONTEND_COVERAGE_INVALID',
    'missingCapabilities',
  ],
  'wechat-frontend-pack-authoring': [
    'frontend-pack-draft.v1',
    'frontend-pack.v1',
    '"component"',
    '"slot"',
    '"container"',
    '"text"',
    '"button"',
    'SLOT_ANCHOR_MISSING',
    'DRAFT_UNKNOWN_DATA_PATH',
    'preview/{normal,empty,error,long}.json',
    'overlay',
    'templates/',
    'WXML',
    'WXSS',
    'Registry',
    'workspace',
  ],
  'wechat-frontend-verification': [
    'PASS',
    'FAIL',
    'BLOCKED',
    'NOT_RUN',
    'mini:check',
    'output-consistency',
    'frontend-verify.cjs',
    'REPAIR_LIMIT_EXCEEDED',
    "adoption:'none'",
    '2 轮',
    'RUNTIME_BLOCKED',
    'not_checked',
    'wechat-devtools-run.cjs',
  ],
};

function skillPath(name) {
  return path.join(SKILLS_DIR, name, 'SKILL.md');
}

function readSkill(name) {
  return fs.readFileSync(skillPath(name), 'utf8');
}

const sources = Object.fromEntries(NEW_SKILLS.map((name) => [name, readSkill(name)]));
const combined = NEW_SKILLS.map((name) => sources[name]).join('\n');

function frontmatter(text) {
  const matched = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(matched, '缺少 YAML frontmatter');
  const fields = {};
  for (const line of matched[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  return fields;
}

function jsonExamples(text) {
  return [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test('四个 P6 skill 与既有 builder 都存在且非空', () => {
  for (const name of [...NEW_SKILLS, 'wechat-template-builder']) {
    const file = skillPath(name);
    assert.ok(fs.existsSync(file), '缺少 skill：' + name + '/SKILL.md');
    const stat = fs.statSync(file);
    assert.ok(stat.isFile(), name + '/SKILL.md 不是文件');
    assert.ok(stat.size > 2000, name + '/SKILL.md 内容过短（' + stat.size + ' 字节）');
  }
});

test('每个新 skill 的 frontmatter name 与目录一致，description 说明触发场景', () => {
  for (const name of NEW_SKILLS) {
    const fields = frontmatter(sources[name]);
    assert.equal(fields.name, name, name + ' frontmatter name 必须等于目录名');
    assert.ok(fields.description && fields.description.length >= 40, name + ' description 过短');
    assert.match(fields.description, /时使用|使用。|用于/, name + ' description 应说明何时使用');
  }
});

test('每个新 skill 都含必备章节：触发条件/必读文件/输入/输出/禁止项/验收/失败退出', () => {
  for (const name of NEW_SKILLS) {
    for (const section of REQUIRED_SECTIONS) {
      assert.match(
        sources[name],
        new RegExp('^' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'),
        name + ' 缺少章节：' + section,
      );
    }
  }
});

test('每个新 skill 至少含两个 JSON schema 示例且至少一个可被 JSON.parse', () => {
  for (const name of NEW_SKILLS) {
    const blocks = jsonExamples(sources[name]);
    assert.ok(blocks.length >= 2, name + ' 的 JSON 示例少于 2 段');
    let parsed = 0;
    for (const block of blocks) {
      try {
        JSON.parse(block.replace(/\r\n/g, '\n'));
        parsed += 1;
      } catch (error) {
        // 示例允许带“…”占位符；只要同一 skill 里至少一段可解析即可。
      }
    }
    assert.ok(parsed >= 1, name + ' 没有任何可解析的 JSON 示例');
  }
});

test('每个新 skill 覆盖其职责内的关键约束与真实工具/命令', () => {
  for (const name of NEW_SKILLS) {
    for (const keyword of KEYWORDS[name]) {
      assert.ok(
        sources[name].includes(keyword),
        name + ' 缺少关键约束/命令：' + keyword,
      );
    }
  }
});

test('组合约束：只产出有界 DSL、禁止任意源码/命令、候选不写正式资产、不可推断交互须拒绝或降级', () => {
  // 有界 DSL 与禁止任意源码/命令。
  assert.match(combined, /frontend-pack-draft\.v1/);
  for (const token of ['WXML', 'WXSS', 'JS', 'WXS', '命令', '绝对路径', '外部 URL']) {
    assert.ok(combined.includes(token), '组合内容缺少禁止项关键词：' + token);
  }
  assert.match(combined, /只(?:产出|产生|接受|允许).{0,20}(?:有界|受控)/s);

  // 候选不得写正式 templates / 重冻结全局 Registry。
  assert.match(combined, /不写(?:仓库内)?\s*`?templates\//);
  assert.match(combined, /不重冻结|不得重冻结|不重算全局|不写全局/);
  assert.match(combined, /Registry/);

  // 不可推断交互必须拒绝/降级，不能编造。
  assert.match(combined, /未知区域|unknownRegions/);
  assert.match(combined, /不可推断|不能推断|禁止.*推断|不推断/);
  assert.match(combined, /needs-input/);
  assert.match(combined, /unsupported|degradations/);
});

test('builder 保留正式资产入库流程，并清楚区分用户私有候选重构', () => {
  const builder = readSkill('wechat-template-builder');

  // 正式流程仍完整。
  assert.match(builder, /正式资产入库/);
  for (const token of [
    'registry-check.cjs --write',
    'templates/components/',
    'templates/features/',
    'templates/frontend-packs/',
    'frontend-pack.v1',
    'composer:build',
    'composer:verify',
  ]) {
    assert.ok(builder.includes(token), 'builder 丢失正式入库流程关键项：' + token);
  }

  // 新增私有候选边界。
  assert.match(builder, /用户私有候选重构/);
  assert.match(builder, /正式资产入库 vs 用户私有候选重构/);
  assert.match(builder, /不得运行\s*`?registry-check --write`?/);
  assert.match(builder, /不得[^\n]{0,12}写\s*`templates\/\*\*`/);
  assert.match(builder, /全局 Registry/);
  assert.match(builder, /wechat-frontend-pack-authoring/);
});

test('索引/状态登记包含五个 skill', () => {
  const status = fs.readFileSync(path.join(SKILLS_DIR, 'ProjectSkillStatus.txt'), 'utf8');
  for (const name of [...NEW_SKILLS, 'wechat-template-builder']) {
    assert.match(status, new RegExp('^' + name + '=true$', 'm'), 'ProjectSkillStatus.txt 缺少 ' + name);
  }

  const index = fs.readFileSync(path.join(SKILLS_DIR, 'README.md'), 'utf8');
  for (const name of [...NEW_SKILLS, 'wechat-template-builder']) {
    assert.ok(index.includes(name), 'skills/README.md 索引缺少 ' + name);
  }
  assert.match(index, /共同红线/);
});

test('skill 引用的固定脚本/文档/测试入口都真实存在', () => {
  const referenced = [
    'scripts/frontend-verify.cjs',
    'scripts/frontend-capabilities.cjs',
    'scripts/wechat-devtools-run.cjs',
    'scripts/validate-miniprogram.cjs',
    'scripts/composer/index.cjs',
    'desktop/output-consistency.cjs',
    'desktop/frontend-reconstruct-ipc.cjs',
    'desktop/frontend-reconstruct/index.cjs',
    'desktop/frontend-reconstruct/schema.cjs',
    'desktop/frontend-reconstruct/render.cjs',
    'desktop/frontend-reconstruct/materialize.cjs',
    'desktop/frontend-reconstruct/registry-overlay.cjs',
    'desktop/frontend-reconstruct/workspace.cjs',
    'desktop/frontend-reconstruct/dry-run.cjs',
    'desktop/frontend-reconstruct/compare.cjs',
    'desktop/frontend-reconstruct/repair.cjs',
    'desktop/frontend-reconstruct/verify-runtime.cjs',
    'server/src/agent/frontend-reconstruct/types.ts',
    'server/src/agent/frontend-reconstruct/schema.ts',
    'server/src/agent/frontend-reconstruct/tools.ts',
    'server/src/agent/frontend-reconstruct/capabilities.ts',
    'server/src/agent/frontend-reconstruct/errors.ts',
    'server/src/agent/frontend-reconstruct/prompt.ts',
    'server/src/agent/frontend-reconstruct/capabilities.snapshot.json',
    'server/test/frontend-reconstruct.contract.test.ts',
    'server/test/frontend-reconstruct.service.test.ts',
    'server/test/frontend-reconstruct.capabilities.test.ts',
    'server/test/frontend-reconstruct.capabilities-script.test.ts',
    'test/frontend-reconstruct.renderer.test.cjs',
    'test/frontend-reconstruct.workspace.test.cjs',
    'test/frontend-reconstruct.materialize.test.cjs',
    'test/frontend-reconstruct.dryrun.test.cjs',
    'test/frontend-reconstruct.repair.test.cjs',
    'test/frontend-reconstruct.verify-runtime.test.cjs',
    'docs/frontend-reconstruct-contract.md',
    'docs/handoff/图片驱动前端重构-Flash实施计划.md',
    'docs/模板库/FrontendPack视图包标准与范例.md',
    'docs/agent-runtime.md',
    'templates/base/ordering-base/1.0.0/manifest.json',
    'templates/base/ordering-base/1.0.0/slots.json',
    'templates/base/ordering-base/1.0.0/theme.tokens.json',
  ];
  for (const relative of referenced) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), 'skill 引用了不存在的路径：' + relative);
  }
});

test('skill 中的硬边界数字与真实契约常量一致', () => {
  // 唯一事实源是 contracts/frontend-reconstruct.v1.json（types.ts 只做类型投影）。
  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'contracts', 'frontend-reconstruct.v1.json'), 'utf8'),
  );
  assert.strictEqual(contract.limits.maxBodyBytes, 2 * 1024 * 1024);
  assert.strictEqual(contract.limits.maxUtteranceChars, 500);
  assert.strictEqual(contract.limits.maxDraftNodesPerPage, 48);
  assert.strictEqual(contract.limits.maxRepairRounds, 2);

  const typesSource = fs.readFileSync(
    path.join(ROOT, 'server', 'src', 'agent', 'frontend-reconstruct', 'types.ts'),
    'utf8',
  );
  assert.doesNotMatch(typesSource, /maxBodyBytes: 2 \* 1024 \* 1024/);

  const imageValidator = fs.readFileSync(
    path.join(ROOT, 'server', 'src', 'agent', 'agent-image.validator.ts'),
    'utf8',
  );
  assert.match(imageValidator, /maxImageBytes: 409600/);

  for (const token of ['409600', '2 MiB', '500', '48', '2 轮']) {
    assert.ok(combined.includes(token), 'skill 未复用真实契约数字：' + token);
  }
});

test('AGENTS.md 提供新命令与技能入口，且不泄露绝对路径/图片正文', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  for (const token of [
    'frontend:capabilities:check',
    'scripts/frontend-verify.cjs',
    '.codeartsdoer/skills/README.md',
    'frontend-pack-draft.v1',
    'templates/**',
  ]) {
    assert.ok(agents.includes(token), 'AGENTS.md 缺少入口/边界：' + token);
  }

  // 文档不得写入真实图片 base64、密钥或本机绝对路径。
  for (const [name, text] of Object.entries(sources)) {
    assert.doesNotMatch(text, /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]{40,}/, name + ' 含图片 base64 正文');
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{16,}/, name + ' 疑似含密钥');
    assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\/, name + ' 含本机绝对路径');
  }
});
