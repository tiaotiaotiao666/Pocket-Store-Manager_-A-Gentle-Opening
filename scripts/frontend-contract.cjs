'use strict';

/**
 * frontend-reconstruct.v1 契约生成器 / 漂移检查器。
 *
 * 单一事实源是 `contracts/frontend-reconstruct.v1.json`；本脚本把它渲染成两份**生成模块**：
 * - `server/src/agent/frontend-reconstruct/contract.generated.ts`（NestJS / vitest 侧）
 * - `desktop/frontend-reconstruct/contract.generated.cjs`（Electron 主进程 + scripts 侧，纯 CJS）
 *
 * 两侧校验器都只从生成模块取常量，不再各自维护同义常量；`--check` 会在 CI/测试里
 * 逐字节比对生成结果，任何“改了 JSON 忘了重新生成”或“绕过契约手改常量”都会被判定漂移。
 *
 * 用法：
 *   node scripts/frontend-contract.cjs            # 打印契约摘要
 *   node scripts/frontend-contract.cjs --write    # 重新生成两份模块
 *   node scripts/frontend-contract.cjs --check    # 漂移检查（exit 1 = 有漂移）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CONTRACT_RELATIVE = path.join('contracts', 'frontend-reconstruct.v1.json');
const CONTRACT_PATH = path.join(REPO, CONTRACT_RELATIVE);
const DESKTOP_MODULE_RELATIVE = path.join('desktop', 'frontend-reconstruct', 'contract.generated.cjs');
const SERVER_MODULE_RELATIVE = path.join('server', 'src', 'agent', 'frontend-reconstruct', 'contract.generated.ts');

const REQUIRED_TOP_KEYS = [
  'contractVersion',
  'draftSchemaVersion',
  'factsVersion',
  'pageFactsVersion',
  'enums',
  'limits',
  'patterns',
  'forbiddenTextPatterns',
  'inferredForbiddenTokens',
  'keys',
];

const REQUIRED_ENUMS = [
  'targetPages',
  'clientSurfaces',
  'clientPhases',
  'themeTokenKeys',
  'sizeSteps',
  'sizeKeys',
  'regionTypes',
  'layoutKinds',
  'draftNodeTypes',
  'toolNames',
  'stopReasons',
  'responseStatuses',
  'states',
  'repairIssueCodes',
  'draftErrorCodes',
];

const REQUIRED_KEYS = [
  'draft',
  'draftPage',
  'component',
  'slot',
  'container',
  'text',
  'button',
  'dataProp',
  'literalProp',
  'layoutStyle',
  'textStyle',
  'draftPageJson',
  'packPageJson',
  'packPageJsonEmitted',
];

/** 校验器实际引用到的 pattern；漏一个就会让生成模块在 require 时缺常量。 */
const REQUIRED_PATTERNS = [
  'requestId',
  'runId',
  'projectId',
  'packId',
  'version',
  'regionId',
  'lowercaseId',
  'propId',
  'eventId',
  'action',
  'dataPath',
  'capability',
  'questionField',
  'provider',
  'model',
  'hexColor',
  'controlChar',
  'controlCharNarrow',
];

function fail(message) {
  const error = new Error(message);
  error.code = 'FRONTEND_CONTRACT_INVALID';
  throw error;
}

/** 读取并校验契约 JSON 自身形状；坏契约必须在这里就炸，而不是等校验器跑起来。 */
function loadContract(filePath) {
  const target = filePath || CONTRACT_PATH;
  const text = fs.readFileSync(target, 'utf8');
  let contract;
  try {
    contract = JSON.parse(text);
  } catch (error) {
    fail(`${CONTRACT_RELATIVE} 不是合法 JSON：${error.message}`);
  }
  for (const key of REQUIRED_TOP_KEYS) {
    if (contract[key] === undefined) fail(`${CONTRACT_RELATIVE} 缺少顶层字段 ${key}`);
  }
  for (const key of REQUIRED_ENUMS) {
    const value = contract.enums[key];
    if (key === 'draftErrorCodes') {
      if (!value || typeof value !== 'object') fail(`enums.${key} 必须是对象`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) fail(`enums.${key} 必须是非空数组`);
    if (new Set(value).size !== value.length) fail(`enums.${key} 含重复项`);
  }
  for (const key of REQUIRED_KEYS) {
    const value = contract.keys[key];
    if (!Array.isArray(value) || value.length === 0) fail(`keys.${key} 必须是非空数组`);
  }
  for (const key of REQUIRED_PATTERNS) {
    if (typeof contract.patterns[key] !== 'string' || contract.patterns[key] === '') {
      fail(`patterns.${key} 必须是非空字符串`);
    }
    try {
      new RegExp(contract.patterns[key]);
    } catch (error) {
      fail(`patterns.${key} 不是合法正则：${error.message}`);
    }
  }
  if (!Array.isArray(contract.forbiddenTextPatterns) || contract.forbiddenTextPatterns.length === 0) {
    fail('forbiddenTextPatterns 必须是非空数组');
  }
  for (const entry of contract.forbiddenTextPatterns) {
    if (!entry || typeof entry.source !== 'string' || entry.source === '') {
      fail('forbiddenTextPatterns 每项必须有非空 source');
    }
    try {
      new RegExp(entry.source, entry.flags || '');
    } catch (error) {
      fail(`forbiddenTextPatterns 含非法正则：${error.message}`);
    }
  }
  const missingLimit = ['maxDraftPages', 'maxDraftNodesPerPage', 'maxDraftDepth', 'maxFactsEntries']
    .filter((key) => typeof contract.limits[key] !== 'number');
  if (missingLimit.length > 0) fail(`limits 缺少必需数值：${missingLimit.join(', ')}`);
  return { contract, text };
}

function contractHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function banner(contract, hash, surface) {
  return [
    '/**',
    ' * 由 `scripts/frontend-contract.cjs` 从 `contracts/frontend-reconstruct.v1.json` 生成，**不要手改**。',
    ` * 使用者：${surface}`,
    ` * 契约版本：${contract.contractVersion} / draft：${contract.draftSchemaVersion}`,
    ` * 契约摘要：sha256:${hash}`,
    ' * 重新生成：node scripts/frontend-contract.cjs --write',
    ' */',
  ];
}

function listLiteral(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function regexLiteral(entry) {
  return `new RegExp(${JSON.stringify(entry.source)}${entry.flags ? `, ${JSON.stringify(entry.flags)}` : ''})`;
}

function namedPatterns(contract) {
  const p = contract.patterns;
  return [
    ['REQUEST_ID_PATTERN', p.requestId, ''],
    ['RUN_ID_PATTERN', p.runId, ''],
    ['PROJECT_ID_PATTERN', p.projectId, ''],
    ['PACK_ID_PATTERN', p.packId, ''],
    ['VERSION_PATTERN', p.version, ''],
    ['REGION_ID_PATTERN', p.regionId, ''],
    ['LOWERCASE_ID_PATTERN', p.lowercaseId, ''],
    ['PROP_ID_PATTERN', p.propId, ''],
    ['EVENT_ID_PATTERN', p.eventId, ''],
    ['ACTION_PATTERN', p.action, ''],
    ['DATA_PATH_PATTERN', p.dataPath, ''],
    ['CAPABILITY_PATTERN', p.capability, ''],
    ['QUESTION_FIELD_PATTERN', p.questionField, ''],
    ['PROVIDER_PATTERN', p.provider, ''],
    ['MODEL_PATTERN', p.model, ''],
    ['HEX_COLOR_PATTERN', p.hexColor, ''],
    ['CONTROL_CHAR_PATTERN', p.controlChar, ''],
    ['CONTROL_CHAR_NARROW_PATTERN', p.controlCharNarrow, ''],
  ];
}

/** server 侧生成模块：`as const` 元组 + 冻结 limits + 命名正则 + 键白名单。 */
function renderServerModule(contract, hash) {
  const lines = [...banner(contract, hash, 'server/src/agent/frontend-reconstruct（NestJS 契约与校验）'), ''];
  lines.push(`export const FRONTEND_RECONSTRUCT_CONTRACT_VERSION = ${JSON.stringify(contract.contractVersion)};`);
  lines.push(`export const FRONTEND_PACK_DRAFT_SCHEMA_VERSION = ${JSON.stringify(contract.draftSchemaVersion)};`);
  lines.push(`export const FRONTEND_FACTS_VERSION = ${JSON.stringify(contract.factsVersion)};`);
  lines.push(`export const FRONTEND_PAGE_FACTS_VERSION = ${JSON.stringify(contract.pageFactsVersion)};`);
  lines.push('');
  const enumNames = {
    targetPages: 'FRONTEND_TARGET_PAGES',
    clientSurfaces: 'FRONTEND_CLIENT_SURFACES',
    clientPhases: 'FRONTEND_CLIENT_PHASES',
    themeTokenKeys: 'FRONTEND_THEME_TOKEN_KEYS',
    sizeSteps: 'FRONTEND_SIZE_STEPS',
    sizeKeys: 'FRONTEND_SIZE_KEYS',
    regionTypes: 'FRONTEND_REGION_TYPES',
    layoutKinds: 'FRONTEND_LAYOUT_KINDS',
    draftNodeTypes: 'FRONTEND_DRAFT_NODE_TYPES',
    toolNames: 'FRONTEND_TOOL_NAMES',
    stopReasons: 'FRONTEND_STOP_REASONS',
    responseStatuses: 'FRONTEND_RESPONSE_STATUSES',
    states: 'FRONTEND_STATES',
    repairIssueCodes: 'FRONTEND_REPAIR_ISSUE_CODES',
  };
  for (const [key, name] of Object.entries(enumNames)) {
    lines.push(`export const ${name} = ${listLiteral(contract.enums[key])} as const;`);
  }
  lines.push('');
  lines.push('/** 本地结构化错误码（与 enums.draftErrorCodes 同源）。 */');
  lines.push('export const FRONTEND_DRAFT_ERROR_CODES = Object.freeze({');
  for (const [key, value] of Object.entries(contract.enums.draftErrorCodes)) {
    lines.push(`  ${key}: ${JSON.stringify(value)},`);
  }
  lines.push('});');
  lines.push('');
  lines.push('/** 所有硬边界集中在这里；服务端与此契约共用同一组数字。 */');
  lines.push('export const FRONTEND_LIMITS = Object.freeze({');
  for (const [key, value] of Object.entries(contract.limits)) {
    lines.push(`  ${key}: ${value},`);
  }
  lines.push('} as const);');
  lines.push('');
  lines.push('/** 标识符/文本正则；全部来自契约 patterns。 */');
  for (const [name, source, flags] of namedPatterns(contract)) {
    lines.push(`export const ${name} = new RegExp(${JSON.stringify(source)}${flags ? `, ${JSON.stringify(flags)}` : ''});`);
  }
  lines.push('');
  lines.push('/** inferredInteractions 不得携带的动作/路由能力名。 */');
  lines.push(`export const INFERRED_FORBIDDEN_TOKENS: readonly string[] = Object.freeze(${listLiteral(contract.inferredForbiddenTokens)});`);
  lines.push('');
  lines.push('/** 纯文本黑名单：模板/脚本 scheme/URL/绝对路径/反斜杠/路径穿越。 */');
  lines.push('export const FORBIDDEN_TEXT_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([');
  for (const entry of contract.forbiddenTextPatterns) {
    lines.push(`  ${regexLiteral(entry)},`);
  }
  lines.push(']);');
  lines.push('');
  const keyNames = {
    draft: 'FRONTEND_DRAFT_KEYS',
    draftPage: 'FRONTEND_DRAFT_PAGE_KEYS',
    component: 'FRONTEND_COMPONENT_KEYS',
    slot: 'FRONTEND_SLOT_KEYS',
    container: 'FRONTEND_CONTAINER_KEYS',
    text: 'FRONTEND_TEXT_KEYS',
    button: 'FRONTEND_BUTTON_KEYS',
    dataProp: 'FRONTEND_DATA_PROP_KEYS',
    literalProp: 'FRONTEND_LITERAL_PROP_KEYS',
    layoutStyle: 'FRONTEND_LAYOUT_STYLE_KEYS',
    textStyle: 'FRONTEND_TEXT_STYLE_KEYS',
    draftPageJson: 'FRONTEND_DRAFT_PAGE_JSON_KEYS',
    packPageJson: 'FRONTEND_PACK_PAGE_JSON_KEYS',
    packPageJsonEmitted: 'FRONTEND_PACK_PAGE_JSON_EMIT_KEYS',
  };
  lines.push('/** 严格对象键白名单（未知键一律拒绝）。 */');
  for (const [key, name] of Object.entries(keyNames)) {
    lines.push(`export const ${name} = ${listLiteral(contract.keys[key])} as const;`);
  }
  lines.push('');
  return lines.join('\n');
}

/** desktop/scripts 侧生成模块：同源常量，CommonJS 形态。 */
function renderDesktopModule(contract, hash) {
  const lines = [...banner(contract, hash, 'desktop/frontend-reconstruct（Electron 主进程）与 scripts（Composer/能力快照）')];
  lines.push("'use strict';", '');
  lines.push(`const CONTRACT_VERSION = ${JSON.stringify(contract.contractVersion)};`);
  lines.push(`const DRAFT_SCHEMA_VERSION = ${JSON.stringify(contract.draftSchemaVersion)};`);
  lines.push(`const FACTS_VERSION = ${JSON.stringify(contract.factsVersion)};`);
  lines.push(`const PAGE_FACTS_VERSION = ${JSON.stringify(contract.pageFactsVersion)};`);
  lines.push('');
  lines.push(`const TARGET_PAGES = Object.freeze(${listLiteral(contract.enums.targetPages)});`);
  lines.push(`const DRAFT_NODE_TYPES = Object.freeze(${listLiteral(contract.enums.draftNodeTypes)});`);
  lines.push(`const THEME_TOKEN_KEYS = Object.freeze(${listLiteral(contract.enums.themeTokenKeys)});`);
  lines.push(`const SIZE_STEPS = Object.freeze(${listLiteral(contract.enums.sizeSteps)});`);
  lines.push(`const SIZE_KEYS = Object.freeze(${listLiteral(contract.enums.sizeKeys)});`);
  lines.push(`const REPAIR_ISSUE_CODES = Object.freeze(${listLiteral(contract.enums.repairIssueCodes)});`);
  lines.push('');
  lines.push('const LIMITS = Object.freeze({');
  for (const [key, value] of Object.entries(contract.limits)) {
    lines.push(`  ${key}: ${value},`);
  }
  lines.push('});');
  lines.push('');
  lines.push('const DRAFT_ERROR_CODES = Object.freeze({');
  for (const [key, value] of Object.entries(contract.enums.draftErrorCodes)) {
    const upper = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    lines.push(`  ${upper}: ${JSON.stringify(value)},`);
  }
  lines.push('});');
  lines.push('');
  for (const [name, source, flags] of namedPatterns(contract)) {
    lines.push(`const ${name} = new RegExp(${JSON.stringify(source)}${flags ? `, ${JSON.stringify(flags)}` : ''});`);
  }
  lines.push('');
  lines.push('const INFERRED_FORBIDDEN_TOKENS = Object.freeze(' + listLiteral(contract.inferredForbiddenTokens) + ');');
  lines.push('');
  lines.push('const FORBIDDEN_TEXT_PATTERNS = Object.freeze([');
  for (const entry of contract.forbiddenTextPatterns) {
    lines.push(`  ${regexLiteral(entry)},`);
  }
  lines.push(']);');
  lines.push('');
  const keyNames = {
    draft: 'DRAFT_KEYS',
    draftPage: 'DRAFT_PAGE_KEYS',
    component: 'COMPONENT_KEYS',
    slot: 'SLOT_KEYS',
    container: 'CONTAINER_KEYS',
    text: 'TEXT_KEYS',
    button: 'BUTTON_KEYS',
    dataProp: 'DATA_PROP_KEYS',
    literalProp: 'LITERAL_PROP_KEYS',
    layoutStyle: 'LAYOUT_STYLE_KEYS',
    textStyle: 'TEXT_STYLE_KEYS',
    draftPageJson: 'PAGE_JSON_KEYS',
    packPageJson: 'PACK_PAGE_JSON_KEYS',
    packPageJsonEmitted: 'PACK_PAGE_JSON_EMIT_KEYS',
  };
  for (const [key, name] of Object.entries(keyNames)) {
    lines.push(`const ${name} = Object.freeze(${listLiteral(contract.keys[key])});`);
  }
  lines.push('');
  lines.push('module.exports = {');
  lines.push('  CONTRACT_VERSION,');
  lines.push('  DRAFT_SCHEMA_VERSION,');
  lines.push('  FACTS_VERSION,');
  lines.push('  PAGE_FACTS_VERSION,');
  lines.push('  TARGET_PAGES,');
  lines.push('  DRAFT_NODE_TYPES,');
  lines.push('  THEME_TOKEN_KEYS,');
  lines.push('  SIZE_STEPS,');
  lines.push('  SIZE_KEYS,');
  lines.push('  REPAIR_ISSUE_CODES,');
  lines.push('  LIMITS,');
  lines.push('  DRAFT_ERROR_CODES,');
  lines.push('  INFERRED_FORBIDDEN_TOKENS,');
  lines.push('  FORBIDDEN_TEXT_PATTERNS,');
  for (const [name] of namedPatterns(contract)) lines.push(`  ${name},`);
  for (const [, name] of Object.entries(keyNames)) lines.push(`  ${name},`);
  lines.push("  CONTRACT_HASH: " + JSON.stringify('sha256:' + hash) + ',');
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

/** 计算两份模块应有的内容；不做任何写盘。 */
function renderAll(contract, text) {
  const hash = contractHash(text);
  return {
    hash,
    files: [
      { relative: DESKTOP_MODULE_RELATIVE, content: renderDesktopModule(contract, hash) },
      { relative: SERVER_MODULE_RELATIVE, content: renderServerModule(contract, hash) },
    ],
  };
}

/** 漂移检查：生成值与磁盘值逐字节比对。 */
function checkGenerated() {
  const { contract, text } = loadContract();
  const rendered = renderAll(contract, text);
  const drifted = [];
  for (const file of rendered.files) {
    const absolute = path.join(REPO, file.relative);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    if (current !== file.content) drifted.push(file.relative.split(path.sep).join('/'));
  }
  return { ok: drifted.length === 0, hash: rendered.hash, drifted };
}

function writeGenerated() {
  const { contract, text } = loadContract();
  const rendered = renderAll(contract, text);
  for (const file of rendered.files) {
    const absolute = path.join(REPO, file.relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.content, 'utf8');
  }
  return { hash: rendered.hash, written: rendered.files.map((file) => file.relative.split(path.sep).join('/')) };
}

function main(argv) {
  const command = argv[0] || '';
  if (command === '--write') {
    const result = writeGenerated();
    console.log('已生成：' + result.written.join(', '));
    console.log('契约摘要：sha256:' + result.hash);
    return 0;
  }
  if (command === '--check') {
    const result = checkGenerated();
    if (result.ok) {
      console.log('契约无漂移：sha256:' + result.hash);
      return 0;
    }
    console.error('契约生成模块已漂移（先跑 node scripts/frontend-contract.cjs --write）：');
    for (const file of result.drifted) console.error('  - ' + file);
    return 1;
  }
  const { contract } = loadContract();
  console.log('契约：' + contract.contractVersion);
  console.log('draft：' + contract.draftSchemaVersion + ' / facts：' + contract.factsVersion);
  console.log('枚举：' + Object.keys(contract.enums).length + ' 组；限制：' + Object.keys(contract.limits).length + ' 项');
  console.log('用法：--write 生成 / --check 漂移检查');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  REPO,
  CONTRACT_PATH,
  CONTRACT_RELATIVE,
  DESKTOP_MODULE_RELATIVE,
  SERVER_MODULE_RELATIVE,
  loadContract,
  renderAll,
  checkGenerated,
  writeGenerated,
  contractHash,
};
