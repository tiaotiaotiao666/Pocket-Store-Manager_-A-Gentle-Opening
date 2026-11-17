import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_IMAGE_LIMITS } from '../src/agent/agent-image.validator';
import {
  FRONTEND_ERROR_DEFINITIONS,
  FrontendReconstructError,
} from '../src/agent/frontend-reconstruct/errors';
import {
  buildFrontendCapabilityIds,
  parseFrontendReconstructRequest,
  validateCapabilityCoverageReport,
  validateFrontendFacts,
  validateFrontendPackDraft,
  validateFrontendReconstructResponse,
  validateUiRequirement,
} from '../src/agent/frontend-reconstruct/schema';
import {
  FRONTEND_MAX_REPAIR_ROUNDS,
  beginFrontendRepair,
  canTransitionFrontendState,
  createFrontendRunState,
  isFrontendTerminalState,
  adoptFrontendCandidate,
  cancelFrontendRun,
  retryFrontendRun,
  transitionFrontendRun,
  undoAdoptedFrontend,
  validateFrontendRepairIssues,
} from '../src/agent/frontend-reconstruct/state';
import {
  FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
  FRONTEND_STATES,
  FRONTEND_TARGET_PAGES,
  type FrontendFacts,
  type FrontendPackDraft,
  type FrontendRunState,
  type UiRequirement,
} from '../src/agent/frontend-reconstruct/types';

/**
 * frontend-reconstruct.v1 契约测试（P0）。
 *
 * 约束：
 * - 全部用 fixture / 纯函数，不访问网络、不写文件、不启动 Nest；
 * - 负向用例必须断言稳定 FRONTEND_* 错误码，而不是自由文本；
 * - 图片 fixture 只有 70/160 字节，绝不内联大 base64。
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/frontend-reconstruct/', import.meta.url));

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

function readFixtureText(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function readFixtureBuffer(name: string): Buffer {
  return readFileSync(fixturePath(name));
}

function readFixtureJson<T>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}

const PNG_BYTES = readFixtureBuffer('reference-tiny.png');
const JPEG_BYTES = readFixtureBuffer('reference-tiny.jpg');
const PNG_BASE64 = PNG_BYTES.toString('base64');
const JPEG_BASE64 = JPEG_BYTES.toString('base64');

const FACTS = readFixtureJson<FrontendFacts>('facts.base.json');
const VALID_REQUIREMENT = readFixtureJson<UiRequirement>('requirement.valid.json');
const PARTIAL_REQUIREMENT = readFixtureJson<UiRequirement>('requirement.partial.json');
const INVALID_RECT_REQUIREMENT = readFixtureJson('requirement.invalid-rect.json');
const COVERED_COVERAGE = readFixtureJson('coverage.covered.json');
const PARTIAL_COVERAGE = readFixtureJson('coverage.partial.json');
const REJECTED_COVERAGE = readFixtureJson('coverage.rejected.json');
const VALID_DRAFT = readFixtureJson<FrontendPackDraft>('draft.valid.json');
const FORBIDDEN_DRAFT = readFixtureJson('draft.forbidden.json');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
    requestId: 'fr-001',
    utterance: '按截图重构首页，保留下单，整体更紧凑',
    images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 }],
    targetPages: ['home'],
    current: {
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
    ...overrides,
  };
}

function coveredReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...clone(COVERED_COVERAGE), ...overrides };
}

function partialReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...clone(PARTIAL_COVERAGE), ...overrides };
}

function validResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
    runId: 'frun-001',
    status: 'planned',
    requirement: clone(VALID_REQUIREMENT),
    coverage: coveredReport(),
    draft: clone(VALID_DRAFT),
    questions: [],
    trace: {
      modelCalls: 2,
      toolCalls: [
        { name: 'get_frontend_capabilities', ok: true },
        { name: 'propose_frontend_draft', ok: true },
      ],
      stopReason: 'final_answer',
      degraded: false,
    },
    meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 1200 },
    ...overrides,
  };
}

/** C2 正向：有视觉降级 → coverage partial + trace.degraded=true（桌面端需显式确认采用）。 */
function partialResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validResponse({
    requirement: clone(PARTIAL_REQUIREMENT),
    coverage: partialReport(),
    trace: {
      ...(validResponse().trace as Record<string, unknown>),
      degraded: true,
    },
    ...overrides,
  });
}

function captureError(fn: () => unknown): FrontendReconstructError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FrontendReconstructError) return error;
    throw error;
  }
  throw new Error('期望抛出 FrontendReconstructError，但函数正常返回');
}

function expectError(fn: () => unknown, code: string): FrontendReconstructError {
  const error = captureError(fn);
  expect(error.code).toBe(code);
  return error;
}

function planningState(): FrontendRunState {
  return transitionFrontendRun(
    transitionFrontendRun(createFrontendRunState('frun-state'), 'analyzing'),
    'planning',
  );
}

function validatingState(): FrontendRunState {
  return transitionFrontendRun(
    transitionFrontendRun(planningState(), 'generating'),
    'validating',
  );
}

describe('frontend-reconstruct.v1 请求契约', () => {
  it('R1 接受恰好一张 reference 的合法请求', () => {
    const parsed = parseFrontendReconstructRequest(validRequest());
    expect(parsed.contractVersion).toBe(FRONTEND_RECONSTRUCT_CONTRACT_VERSION);
    expect(parsed.requestId).toBe('fr-001');
    expect(parsed.image.mediaType).toBe('image/png');
    expect(parsed.image.bytes).toBe(PNG_BYTES.byteLength);
    expect(parsed.image.dataBase64).toBe(PNG_BASE64);
    expect(parsed.targetPages).toEqual(['home']);
    expect(parsed.projectId).toBeNull();
  });

  it('R2 允许只发图（空 utterance）', () => {
    const parsed = parseFrontendReconstructRequest(validRequest({ utterance: '' }));
    expect(parsed.utterance).toBe('');
  });

  it('R3 JPEG 参考图合法，fixture 是真实图片字节', () => {
    const parsed = parseFrontendReconstructRequest(validRequest({
      images: [{ kind: 'reference', mediaType: 'image/jpeg', dataBase64: JPEG_BASE64 }],
    }));
    expect(parsed.image.mediaType).toBe('image/jpeg');
    expect(PNG_BYTES.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(JPEG_BYTES.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(PNG_BYTES.byteLength).toBeLessThan(4096);
    expect(JPEG_BYTES.byteLength).toBeLessThan(4096);
  });

  it('R4 未知顶层字段整包拒绝 FRONTEND_REQUEST_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ script: 'eval("x")' })),
      'FRONTEND_REQUEST_INVALID',
    );
  });

  it('R5 嵌套未知字段（current / client / image）一律拒绝', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        current: { ...(validRequest().current as object), registry: { id: 'evil' } },
      })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        client: { surface: 'desktop', phase: 'template-pick', command: 'rm -rf /' },
      })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64, bytes: 1 }],
      })),
      'FRONTEND_REQUEST_INVALID',
    );
  });

  it('R6 缺少图片拒绝 FRONTEND_IMAGE_REQUIRED', () => {
    const body = validRequest();
    delete (body as Record<string, unknown>).images;
    expectError(() => parseFrontendReconstructRequest(body), 'FRONTEND_IMAGE_REQUIRED');
  });

  it('R7 多图拒绝 FRONTEND_IMAGE_COUNT_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
        ],
      })),
      'FRONTEND_IMAGE_COUNT_INVALID',
    );
  });

  it('R8 非 reference 图片拒绝 FRONTEND_IMAGE_KIND_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'menu', mediaType: 'image/png', dataBase64: PNG_BASE64 }],
      })),
      'FRONTEND_IMAGE_KIND_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [
          { kind: 'reference', mediaType: 'image/png', dataBase64: PNG_BASE64 },
          { kind: 'store', mediaType: 'image/png', dataBase64: PNG_BASE64 },
        ],
      })),
      'FRONTEND_IMAGE_KIND_INVALID',
    );
  });

  it('R9 非法 mediaType 拒绝 FRONTEND_IMAGE_TYPE_UNSUPPORTED（422）', () => {
    const error = expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/gif', dataBase64: PNG_BASE64 }],
      })),
      'FRONTEND_IMAGE_TYPE_UNSUPPORTED',
    );
    expect(error.httpStatus).toBe(422);
  });

  it('R9a WebP 正向：12+ 字节 RIFF/WEBP 头可解析，解码 bytes 正确', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WEBPVP8 ', 'ascii'),
    ]);
    expect(webp.byteLength).toBeGreaterThanOrEqual(12);
    expect(webp.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(webp.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const parsed = parseFrontendReconstructRequest(validRequest({
      images: [{ kind: 'reference', mediaType: 'image/webp', dataBase64: webp.toString('base64') }],
    }));
    expect(parsed.image.mediaType).toBe('image/webp');
    expect(parsed.image.bytes).toBe(webp.byteLength);
  });

  it('R9b WebP 负向：声明 webp 但字节不是 WebP、或 PNG 声明成 WebP 都拒绝', () => {
    // 声称 webp，实际是 PNG 字节 → magic 不符。
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/webp', dataBase64: PNG_BASE64 }],
      })),
      'FRONTEND_IMAGE_INVALID',
    );
    // 声称 png，实际是 RIFF/WEBP 头 → magic 不符。
    const riffWebp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
    ]).toString('base64');
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: riffWebp }],
      })),
      'FRONTEND_IMAGE_INVALID',
    );
    // 声称 webp，但 base64 解码后不足 12 字节 → 非法。
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/webp', dataBase64: 'AAAA' }],
      })),
      'FRONTEND_IMAGE_INVALID',
    );
  });

  it('R10 非法 base64 拒绝 FRONTEND_IMAGE_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: 'not-base64!!' }],
      })),
      'FRONTEND_IMAGE_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: 'AAAA' }],
      })),
      'FRONTEND_IMAGE_INVALID',
    );
  });

  it('R11 单图体积按解码后字节判定：恰好 409600 可接受，超出 1 字节拒绝 FRONTEND_IMAGE_TOO_LARGE（422）', () => {
    const maxBytes = AGENT_IMAGE_LIMITS.maxImageBytes;
    // 恰好等于上限：保留 PNG magic，让校验走到字节上限的判断而不是格式判断。
    const exact = Buffer.alloc(maxBytes, 0);
    PNG_BYTES.copy(exact, 0);
    const parsed = parseFrontendReconstructRequest(validRequest({
      images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: exact.toString('base64') }],
    }));
    expect(parsed.image.bytes).toBe(maxBytes);

    const oversized = Buffer.alloc(maxBytes + 1, 0xff);
    PNG_BYTES.copy(oversized, 0);
    const error = expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', dataBase64: oversized.toString('base64') }],
      })),
      'FRONTEND_IMAGE_TOO_LARGE',
    );
    expect(error.httpStatus).toBe(422);
    // 错误详情不得回填 base64 正文
    expect(JSON.stringify(error.details ?? {})).not.toContain(oversized.toString('base64').slice(0, 32));
  });

  it('R12 data 别名不进入 frontend-reconstruct 契约（只认 dataBase64）', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        images: [{ kind: 'reference', mediaType: 'image/png', data: PNG_BASE64 }],
      })),
      'FRONTEND_REQUEST_INVALID',
    );
  });

  it('R13 超长 utterance 拒绝 FRONTEND_UTTERANCE_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '改'.repeat(501) })),
      'FRONTEND_UTTERANCE_INVALID',
    );
  });

  it('R14 utterance 控制字符拒绝 FRONTEND_UTTERANCE_INVALID（C0 与 C1）', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '正常\u0000文本' })),
      'FRONTEND_UTTERANCE_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '正常\u0007文本' })),
      'FRONTEND_UTTERANCE_INVALID',
    );
    // C1：U+0080–U+009F 不能被当成普通文本。
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '正常\u0085文本' })),
      'FRONTEND_UTTERANCE_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ utterance: '正常\u009f文本' })),
      'FRONTEND_UTTERANCE_INVALID',
    );
  });

  it('R15 contractVersion 不匹配拒绝 FRONTEND_CONTRACT_MISMATCH', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ contractVersion: 'frontend-reconstruct.v2' })),
      'FRONTEND_CONTRACT_MISMATCH',
    );
  });

  it('R16 requestId 格式非法拒绝 FRONTEND_REQUEST_INVALID', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ requestId: 'abc' })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ requestId: 'fr-../escape' })),
      'FRONTEND_REQUEST_INVALID',
    );
  });

  it('R17 targetPages 只允许 home/menu，且至少一页、不得重复', () => {
    expect(FRONTEND_TARGET_PAGES).toEqual(['home', 'menu']);
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ targetPages: ['checkout'] })),
      'FRONTEND_TARGET_PAGES_UNSUPPORTED',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ targetPages: [] })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ targetPages: ['home', 'home'] })),
      'FRONTEND_REQUEST_INVALID',
    );
    const parsed = parseFrontendReconstructRequest(validRequest({ targetPages: ['home', 'menu'] }));
    expect(parsed.targetPages).toEqual(['home', 'menu']);
  });

  it('R18 client.surface/phase 与 projectId 严格校验', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ client: { surface: 'web', phase: 'template-pick' } })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ client: { surface: 'desktop', phase: 'publish' } })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({ projectId: '../escape' })),
      'FRONTEND_REQUEST_INVALID',
    );
    const parsed = parseFrontendReconstructRequest(validRequest({ projectId: 'proj-123' }));
    expect(parsed.projectId).toBe('proj-123');
  });

  it('R19 请求体超过 2MB 直接拒绝 FRONTEND_REQUEST_INVALID', () => {
    const body = validRequest({
      current: {
        baseTemplate: { id: 'ordering-base', version: '1.0.0' },
        frontendPack: null,
        presentationPatch: { blob: 'x'.repeat(3 * 1024 * 1024) },
      },
    });
    const error = expectError(() => parseFrontendReconstructRequest(body), 'FRONTEND_REQUEST_INVALID');
    // 证明是整体体积门禁先触发，而不是 presentationPatch 16KB 门禁。
    expect(error.details?.path).toBe('$');
  });

  it('R19b 2MB 上限按 UTF-8 字节计算（多字节文本不能被字符数放过）', () => {
    const body = validRequest({
      current: {
        baseTemplate: { id: 'ordering-base', version: '1.0.0' },
        frontendPack: null,
        // 75 万汉字 = 约 2.25MB UTF-8 字节，但字符数 < 2MiB。
        presentationPatch: { blob: '改'.repeat(750_000) },
      },
    });
    const error = expectError(() => parseFrontendReconstructRequest(body), 'FRONTEND_REQUEST_INVALID');
    expect(error.details?.path).toBe('$');
  });

  it('R20 presentationPatch 超过 16KB 拒绝 FRONTEND_REQUEST_INVALID', () => {
    const body = validRequest({
      current: {
        baseTemplate: { id: 'ordering-base', version: '1.0.0' },
        frontendPack: null,
        presentationPatch: { blob: 'x'.repeat(17000) },
      },
    });
    expectError(() => parseFrontendReconstructRequest(body), 'FRONTEND_REQUEST_INVALID');
  });

  it('R21 当前 baseTemplate / frontendPack 结构严格校验', () => {
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        current: {
          baseTemplate: { id: 'evil-base', version: '1.0.0' },
          frontendPack: null,
          presentationPatch: {},
        },
      })),
      'FRONTEND_REQUEST_INVALID',
    );
    expectError(
      () => parseFrontendReconstructRequest(validRequest({
        current: {
          baseTemplate: { id: 'ordering-base', version: '1.0.0' },
          frontendPack: { id: 'warm-home-menu', version: '1.0.0', path: '/tmp/evil' },
          presentationPatch: {},
        },
      })),
      'FRONTEND_REQUEST_INVALID',
    );
  });
});

describe('frontend-reconstruct.v1 UiRequirement / VisualSpec', () => {
  it('U1 正向 fixture：mustKeep、pages/regions/children、0–1 rect、bindings、未知项齐全且无降级', () => {
    const requirement = validateUiRequirement(clone(VALID_REQUIREMENT), FACTS, { targetPages: ['home'] });
    expect(requirement.mustKeep.map((item) => item.ref)).toContain('page:home');
    expect(requirement.pages).toHaveLength(1);
    expect(requirement.pages[0].regions[0].children[0].id).toBe('r-logo');
    expect(requirement.pages[0].regions[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.18 });
    expect(requirement.bindings.some((binding) => binding.status === 'unknown')).toBe(true);
    expect(requirement.unknownRegions).toHaveLength(1);
    expect(requirement.lowConfidence).toHaveLength(1);
    expect(requirement.inferredInteractions).toHaveLength(1);
    expect(requirement.unsupported).toHaveLength(1);
    // C2：covered 正向 fixture 不再携带视觉降级。
    expect(requirement.degradations).toHaveLength(0);
    expect(requirement.visual.density).toBe('compact');
  });

  it('U1b partial 正向 fixture 保留降级项（与 coverage.partial 配对）', () => {
    const requirement = validateUiRequirement(clone(PARTIAL_REQUIREMENT), FACTS, { targetPages: ['home'] });
    expect(requirement.degradations).toHaveLength(1);
    expect(requirement.degradations[0].regionId).toBe('r-hero');
    expect(requirement.degradations[0].severity).toBe('warn');
    expect(clone(VALID_REQUIREMENT).degradations).toHaveLength(0);
  });

  it('U2 颜色归一化为大写，声明缺省 density 时补 comfortable', () => {
    const raw = clone(VALID_REQUIREMENT);
    raw.visual.theme = { primaryColor: '#b34a0f' };
    delete (raw.visual as { density?: string }).density;
    const requirement = validateUiRequirement(raw, FACTS, { targetPages: ['home'] });
    expect(requirement.visual.theme.primaryColor).toBe('#B34A0F');
    expect(requirement.visual.density).toBe('comfortable');
  });

  it('U3 负向 fixture：rect 越界拒绝 FRONTEND_REQUIREMENT_INVALID', () => {
    expectError(
      () => validateUiRequirement(clone(INVALID_RECT_REQUIREMENT), FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('U4 rect 合计超过 1 拒绝', () => {
    const raw = clone(VALID_REQUIREMENT);
    raw.pages[0].regions[0].rect = { x: 0.5, y: 0.5, w: 0.8, h: 0.8 };
    expectError(
      () => validateUiRequirement(raw, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('U5 binding 只能引用注入事实：未知 dataPath / eventName / regionId 全部拒绝', () => {
    const unknownData = clone(VALID_REQUIREMENT);
    unknownData.bindings[0].dataPath = 'store.secretToken';
    expectError(() => validateUiRequirement(unknownData, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const unknownEvent = clone(VALID_REQUIREMENT);
    unknownEvent.bindings[1].eventName = 'home.payNow';
    expectError(() => validateUiRequirement(unknownEvent, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const unknownRegion = clone(VALID_REQUIREMENT);
    unknownRegion.bindings[0].regionId = 'r-not-exist';
    expectError(() => validateUiRequirement(unknownRegion, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });

  it('U6 status=unknown 不得携带 dataPath/eventName', () => {
    const raw = clone(VALID_REQUIREMENT);
    raw.bindings[3] = { regionId: 'r-hero', dataPath: 'store.name', status: 'unknown' };
    expectError(
      () => validateUiRequirement(raw, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('U7 主题 token / 颜色 / 尺寸档位 / size key 只允许白名单', () => {
    const unknownToken = clone(VALID_REQUIREMENT);
    (unknownToken.visual.theme as Record<string, string>).brandGradient = '#123456';
    expectError(() => validateUiRequirement(unknownToken, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badColor = clone(VALID_REQUIREMENT);
    badColor.visual.theme.primaryColor = 'red';
    expectError(() => validateUiRequirement(badColor, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badStep = clone(VALID_REQUIREMENT);
    badStep.visual.sizes.homeHero = 'xl' as 'lg';
    expectError(() => validateUiRequirement(badStep, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const unknownSizeKey = clone(VALID_REQUIREMENT);
    (unknownSizeKey.visual.sizes as Record<string, string>).poster = 'lg';
    expectError(() => validateUiRequirement(unknownSizeKey, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });

  it('U7b 主题 token 还必须命中注入事实，不能只过七类白名单', () => {
    const factsSubset = clone(FACTS);
    factsSubset.themeTokens = ['primaryColor'];
    // 事实只声明 primaryColor：fixture 还在用 pageBackground/accentColor → 拒绝。
    expectError(
      () => validateUiRequirement(clone(VALID_REQUIREMENT), factsSubset, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
    // 收敛到事实声明的 token 后通过。
    const requirement = clone(VALID_REQUIREMENT);
    requirement.visual.theme = { primaryColor: '#B34A0F' };
    expect(
      validateUiRequirement(requirement, factsSubset, { targetPages: ['home'] }).visual.theme,
    ).toEqual({ primaryColor: '#B34A0F' });
  });

  it('U8 pages 只能落在 targetPages 内', () => {
    const raw = clone(VALID_REQUIREMENT);
    raw.pages[0].pageId = 'menu';
    expectError(
      () => validateUiRequirement(raw, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('U9 mustKeep 必须覆盖 targetPages 的 page 事实，且 ref 必须真实存在', () => {
    const missingPage = clone(VALID_REQUIREMENT);
    missingPage.mustKeep = [{ kind: 'action', ref: 'action:home.goMenu' }];
    expectError(
      () => validateUiRequirement(missingPage, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const unknownRef = clone(VALID_REQUIREMENT);
    unknownRef.mustKeep = [{ kind: 'page', ref: 'page:checkout' }];
    expectError(
      () => validateUiRequirement(unknownRef, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );
  });

  it('U10 region id 重复、兄弟 order 非递增、depth 超限均拒绝', () => {
    const duplicate = clone(VALID_REQUIREMENT);
    duplicate.pages[0].regions[2].id = 'r-header';
    expectError(() => validateUiRequirement(duplicate, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badOrder = clone(VALID_REQUIREMENT);
    badOrder.pages[0].regions[2].order = 1;
    expectError(() => validateUiRequirement(badOrder, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const deep = clone(VALID_REQUIREMENT);
    let cursor = deep.pages[0].regions[0];
    for (let depth = 0; depth < 4; depth += 1) {
      const child = clone(cursor);
      child.id = `r-deep-${depth}`;
      child.children = [];
      cursor.children = [child];
      cursor = child;
    }
    expectError(() => validateUiRequirement(deep, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });

  it('U11 confidence 越界、恶意文本与 C1 控制字符拒绝', () => {
    const badConfidence = clone(VALID_REQUIREMENT);
    badConfidence.pages[0].regions[0].confidence = 1.2;
    expectError(() => validateUiRequirement(badConfidence, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const script = clone(VALID_REQUIREMENT);
    script.unsupported[0].reason = '<script>alert(1)</script>';
    expectError(() => validateUiRequirement(script, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const control = clone(VALID_REQUIREMENT);
    control.summary = '正常\u0000文本';
    expectError(() => validateUiRequirement(control, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    // C1 控制字符（U+0080–U+009F）同样不能进入需求文本。
    const c1 = clone(VALID_REQUIREMENT);
    c1.summary = '正常\u0085文本';
    expectError(() => validateUiRequirement(c1, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
    const c1End = clone(VALID_REQUIREMENT);
    c1End.unknownRegions[0].reason = '正常\u009f文本';
    expectError(() => validateUiRequirement(c1End, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });

  it('U13 unknownRegions/lowConfidence/inferredInteractions/degradations 只能引用已声明 regionId', () => {
    const badUnknown = clone(VALID_REQUIREMENT);
    badUnknown.unknownRegions = [{ regionId: 'r-nope', label: '未知区', reason: '无法识别' }];
    expectError(() => validateUiRequirement(badUnknown, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badLow = clone(VALID_REQUIREMENT);
    badLow.lowConfidence[0].regionId = 'r-nope';
    expectError(() => validateUiRequirement(badLow, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badInferred = clone(VALID_REQUIREMENT);
    badInferred.inferredInteractions[0].regionId = 'r-nope';
    expectError(() => validateUiRequirement(badInferred, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const badDegradation = clone(VALID_REQUIREMENT);
    badDegradation.degradations = [{ regionId: 'r-nope', label: '降级', reason: '占位', severity: 'info' }];
    expectError(
      () => validateUiRequirement(badDegradation, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const illegalId = clone(VALID_REQUIREMENT);
    illegalId.unknownRegions = [{ regionId: '../r', label: '未知区', reason: '无法识别' }];
    expectError(() => validateUiRequirement(illegalId, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });

  it('U14 inferredInteractions 只描述可观察交互，禁止动作名/能力前缀/路由', () => {
    const actionInLabel = clone(VALID_REQUIREMENT);
    actionInLabel.inferredInteractions[0].label = '点击 home.goMenu 进入点餐';
    expectError(
      () => validateUiRequirement(actionInLabel, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const actionPrefix = clone(VALID_REQUIREMENT);
    actionPrefix.inferredInteractions[0].reason = '推测绑定 action:home.goMenu';
    expectError(
      () => validateUiRequirement(actionPrefix, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const route = clone(VALID_REQUIREMENT);
    route.inferredInteractions[0].reason = '可能跳转 /pages/home/index';
    expectError(
      () => validateUiRequirement(route, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const routeToken = clone(VALID_REQUIREMENT);
    routeToken.inferredInteractions[0].label = 'route:home 入口';
    expectError(
      () => validateUiRequirement(routeToken, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    // 只描述“看到了什么交互”则合法（正向 fixture 已覆盖）。
    expect(
      validateUiRequirement(clone(VALID_REQUIREMENT), FACTS, { targetPages: ['home'] }).inferredInteractions,
    ).toHaveLength(1);
  });

  it('U12 未知键（根 / visual / region）一律拒绝', () => {
    const root = clone(VALID_REQUIREMENT) as UiRequirement & { screenshotSummary?: string };
    root.screenshotSummary = '额外字段';
    expectError(() => validateUiRequirement(root, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const visual = clone(VALID_REQUIREMENT) as UiRequirement & { visual: Record<string, unknown> };
    visual.visual.gradient = '#fff';
    expectError(() => validateUiRequirement(visual, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');

    const region = clone(VALID_REQUIREMENT) as UiRequirement & {
      pages: Array<{ regions: Array<Record<string, unknown>> }>;
    };
    region.pages[0].regions[0].html = '<view>';
    expectError(() => validateUiRequirement(region, FACTS, { targetPages: ['home'] }), 'FRONTEND_REQUIREMENT_INVALID');
  });
});

describe('frontend-reconstruct.v1 CapabilityCoverageReport', () => {
  it('C1 已存在能力全部 covered 被接受', () => {
    const report = validateCapabilityCoverageReport(coveredReport(), FACTS);
    expect(report.status).toBe('covered');
    expect(report.missingCapabilities).toEqual([]);
  });

  it('C2 partial 必须有降级项，且 required 全被事实覆盖', () => {
    const partial = coveredReport({
      status: 'partial',
      degradations: [{ label: '主视觉图', reason: '纯色占位', severity: 'info' }],
    });
    expect(validateCapabilityCoverageReport(partial, FACTS).status).toBe('partial');

    expectError(
      () => validateCapabilityCoverageReport(coveredReport({ status: 'partial' }), FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
  });

  it('C3 缺必需能力必须 rejected，且 missingCapabilities 不能为空', () => {
    const report = validateCapabilityCoverageReport(clone(REJECTED_COVERAGE), FACTS);
    expect(report.status).toBe('rejected');
    expect(report.missingCapabilities.length).toBeGreaterThan(0);
  });

  it('C4 模型不能伪造 covered：缺事实、缺 coveredBy 或映射到别的事实都拒绝', () => {
    const missingFact = coveredReport({
      requiredCapabilities: ['component:live-stream'],
      coveredBy: { 'component:live-stream': 'component:live-stream' },
    });
    expectError(() => validateCapabilityCoverageReport(missingFact, FACTS), 'FRONTEND_COVERAGE_INVALID');

    const incomplete = coveredReport();
    delete (incomplete.coveredBy as Record<string, string>)['action:home.goMenu'];
    expectError(() => validateCapabilityCoverageReport(incomplete, FACTS), 'FRONTEND_COVERAGE_INVALID');

    const aliased = coveredReport({
      requiredCapabilities: ['component:live-stream'],
      coveredBy: { 'component:live-stream': 'component:store-header' },
    });
    expectError(() => validateCapabilityCoverageReport(aliased, FACTS), 'FRONTEND_COVERAGE_INVALID');
  });

  it('C5 covered 却带 missingCapabilities / 降级项拒绝', () => {
    expectError(
      () => validateCapabilityCoverageReport(coveredReport({
        missingCapabilities: ['component:live-stream'],
      }), FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
    expectError(
      () => validateCapabilityCoverageReport(coveredReport({
        degradations: [{ label: '视觉降级', reason: '占位', severity: 'warn' }],
      }), FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
  });

  it('C6 missingCapabilities 必须是 requiredCapabilities 的子集，risks 只能引用 required', () => {
    const badSubset = clone(REJECTED_COVERAGE);
    badSubset.missingCapabilities.push('component:store-header');
    expectError(() => validateCapabilityCoverageReport(badSubset, FACTS), 'FRONTEND_COVERAGE_INVALID');

    const badRisk = coveredReport({
      risks: [{ capability: 'component:cart-bar', reason: '未声明必需' }],
    });
    expectError(() => validateCapabilityCoverageReport(badRisk, FACTS), 'FRONTEND_COVERAGE_INVALID');
  });

  it('C7 负向 fixture 之外的 rejected 空 missing 拒绝', () => {
    const emptyMissing = clone(REJECTED_COVERAGE);
    emptyMissing.missingCapabilities = [];
    expectError(() => validateCapabilityCoverageReport(emptyMissing, FACTS), 'FRONTEND_COVERAGE_INVALID');
  });

  it('C8 未知键 / 非法能力 token / 空 required 拒绝', () => {
    expectError(
      () => validateCapabilityCoverageReport({ ...coveredReport(), plan: {} }, FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
    expectError(
      () => validateCapabilityCoverageReport(coveredReport({ requiredCapabilities: [] }), FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
    expectError(
      () => validateCapabilityCoverageReport(coveredReport({
        requiredCapabilities: ['component:store header'],
        coveredBy: {},
      }), FACTS),
      'FRONTEND_COVERAGE_INVALID',
    );
  });
});

describe('frontend-reconstruct.v1 FrontendPackDraft DSL', () => {
  it('D1 正向 fixture：component/slot/container/text/button 五类节点通过', () => {
    const draft = validateFrontendPackDraft(clone(VALID_DRAFT), FACTS);
    expect(draft.schemaVersion).toBe('frontend-pack-draft.v1');
    expect(draft.pages).toHaveLength(1);
    expect(draft.pages[0].nodes.map((node) => node.type)).toEqual([
      'component',
      'slot',
      'container',
      'component',
    ]);
  });

  it('D2 literal prop 合法，data prop 必须命中 dataPaths', () => {
    const literal = clone(VALID_DRAFT);
    const node = literal.pages[0].nodes[0] as Extract<FrontendPackDraft['pages'][number]['nodes'][number], { type: 'component' }>;
    node.props.tableName = { kind: 'literal', value: 'A1' };
    expect(() => validateFrontendPackDraft(literal, FACTS)).not.toThrow();

    const unknownPath = clone(VALID_DRAFT);
    const badNode = unknownPath.pages[0].nodes[0] as typeof node;
    badNode.props.tableName = { kind: 'data', dataPath: 'store.secret' };
    expectError(() => validateFrontendPackDraft(unknownPath, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D3 负向 fixture：raw 节点 / WXML / JS / CSS 原文整包拒绝', () => {
    expectError(() => validateFrontendPackDraft(clone(FORBIDDEN_DRAFT), FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D4 未知 node type / component / slot / textToken / action 拒绝', () => {
    const unknownNode = clone(VALID_DRAFT) as unknown as Record<string, unknown>;
    (unknownNode.pages as Array<Record<string, unknown>>)[0].nodes = [{ type: 'html', html: '<view>' }];
    expectError(() => validateFrontendPackDraft(unknownNode, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownComponent = clone(VALID_DRAFT);
    (unknownComponent.pages[0].nodes[0] as { componentId: string }).componentId = 'live-stream';
    expectError(() => validateFrontendPackDraft(unknownComponent, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownSlot = clone(VALID_DRAFT);
    (unknownSlot.pages[0].nodes[1] as { slotId: string }).slotId = '/tmp/evil';
    expectError(() => validateFrontendPackDraft(unknownSlot, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownText = clone(VALID_DRAFT);
    const container = unknownText.pages[0].nodes[2] as { children: Array<{ type: string; textToken?: string }> };
    container.children[0].textToken = 'store.secretToken';
    expectError(() => validateFrontendPackDraft(unknownText, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownAction = clone(VALID_DRAFT);
    const button = (unknownAction.pages[0].nodes[2] as { children: Array<{ type: string; action?: string }> }).children[1];
    button.action = 'home.payNow';
    expectError(() => validateFrontendPackDraft(unknownAction, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D5 组件 prop 名 / event 名必须在事实白名单内', () => {
    const unknownProp = clone(VALID_DRAFT);
    const header = unknownProp.pages[0].nodes[0] as { props: Record<string, unknown> };
    header.props.style = { kind: 'literal', value: 'color:red' };
    expectError(() => validateFrontendPackDraft(unknownProp, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownEvent = clone(VALID_DRAFT);
    const cart = unknownEvent.pages[0].nodes[3] as { events: Record<string, string> };
    cart.events.pay = 'home.goMenu';
    expectError(() => validateFrontendPackDraft(unknownEvent, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownEventValue = clone(VALID_DRAFT);
    const cart2 = unknownEventValue.pages[0].nodes[3] as { events: Record<string, string> };
    cart2.events.checkout = 'home.payNow';
    expectError(() => validateFrontendPackDraft(unknownEventValue, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D6 style 只允许白名单布局/字号属性，禁止 CSS 原文与未知属性', () => {
    const rawCss = clone(VALID_DRAFT);
    (rawCss.pages[0].nodes[2] as { style: unknown }).style = 'position:fixed;top:0';
    expectError(() => validateFrontendPackDraft(rawCss, FACTS), 'FRONTEND_DRAFT_INVALID');

    const unknownStyleKey = clone(VALID_DRAFT);
    (unknownStyleKey.pages[0].nodes[2] as { style: Record<string, unknown> }).style.position = 'fixed';
    expectError(() => validateFrontendPackDraft(unknownStyleKey, FACTS), 'FRONTEND_DRAFT_INVALID');

    const badWeight = clone(VALID_DRAFT);
    const text = (badWeight.pages[0].nodes[2] as { children: Array<{ type: string; style?: Record<string, unknown> }> }).children[0];
    text.style = { weight: 300 };
    expectError(() => validateFrontendPackDraft(badWeight, FACTS), 'FRONTEND_DRAFT_INVALID');

    const badColorToken = clone(VALID_DRAFT);
    const button = (badColorToken.pages[0].nodes[2] as { children: Array<{ type: string; style?: Record<string, unknown> }> }).children[1];
    button.style = { colorToken: 'brandGradient' };
    expectError(() => validateFrontendPackDraft(badColorToken, FACTS), 'FRONTEND_DRAFT_INVALID');

    const badWidth = clone(VALID_DRAFT);
    (badWidth.pages[0].nodes[2] as { style: Record<string, unknown> }).style = { width: 2000 };
    expectError(() => validateFrontendPackDraft(badWidth, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D7 label / displayName 禁止脚本、URL、路径穿越与控制字符', () => {
    const scripts = ['<script>alert(1)</script>', 'javascript:alert(1)', 'https://evil.example/x', '/etc/passwd', '..\\evil'];
    for (const label of scripts) {
      const draft = clone(VALID_DRAFT);
      (draft.pages[0].nodes[2] as { children: Array<{ type: string; label?: string }> }).children[1].label = label;
      expectError(() => validateFrontendPackDraft(draft, FACTS), 'FRONTEND_DRAFT_INVALID');
    }

    const control = clone(VALID_DRAFT);
    control.displayName = '候选\u0000名称';
    expectError(() => validateFrontendPackDraft(control, FACTS), 'FRONTEND_DRAFT_INVALID');

    const c1Control = clone(VALID_DRAFT);
    (c1Control.pages[0].nodes[2] as { children: Array<{ type: string; label?: string }> }).children[1].label = '开始\u0085点餐';
    expectError(() => validateFrontendPackDraft(c1Control, FACTS), 'FRONTEND_DRAFT_INVALID');

    const traversal = clone(VALID_DRAFT);
    traversal.displayName = '../evil';
    expectError(() => validateFrontendPackDraft(traversal, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D8 styles 必须为空数组（渲染器本地生成 CSS），pageJson 只允许白名单键', () => {
    const styles = clone(VALID_DRAFT);
    (styles.pages[0] as { styles: unknown[] }).styles = [{ name: 'raw', css: '.x{color:red}' }];
    expectError(() => validateFrontendPackDraft(styles, FACTS), 'FRONTEND_DRAFT_INVALID');

    const pageJson = clone(VALID_DRAFT);
    (pageJson.pages[0].pageJson as Record<string, unknown>).usingComponents = { evil: '/tmp/evil' };
    expectError(() => validateFrontendPackDraft(pageJson, FACTS), 'FRONTEND_DRAFT_INVALID');

    const badge = clone(VALID_DRAFT);
    (badge.pages[0].pageJson as Record<string, unknown>).navigationBarTitleText = '<script>';
    expectError(() => validateFrontendPackDraft(badge, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D9 只允许 home/menu 页面，pageId 唯一', () => {
    const checkout = clone(VALID_DRAFT);
    checkout.pages[0].pageId = 'checkout' as 'home';
    expectError(() => validateFrontendPackDraft(checkout, FACTS), 'FRONTEND_DRAFT_INVALID');

    const duplicate = clone(VALID_DRAFT);
    duplicate.pages.push(clone(duplicate.pages[0]));
    expectError(() => validateFrontendPackDraft(duplicate, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D10 节点由服务端生成 id：草稿携带 id 视为未知字段', () => {
    const raw = clone(VALID_DRAFT);
    (raw.pages[0].nodes[1] as { id?: string }).id = 'node-1';
    expectError(() => validateFrontendPackDraft(raw, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D11 节点数量与嵌套深度有界', () => {
    const deep = clone(VALID_DRAFT);
    let cursor: { type: string; children?: unknown[] } = {
      type: 'container',
      style: { direction: 'column' },
      children: [],
    };
    const root = cursor;
    for (let depth = 0; depth < 5; depth += 1) {
      const child = { type: 'container', style: { direction: 'column' }, children: [] as unknown[] };
      cursor.children = [child];
      cursor = child;
    }
    (deep.pages[0].nodes as unknown[]).push(root as never);
    expectError(() => validateFrontendPackDraft(deep, FACTS), 'FRONTEND_DRAFT_INVALID');

    const many = clone(VALID_DRAFT);
    const nodes = many.pages[0].nodes as unknown[];
    const template = nodes[1];
    for (let index = 0; index < 49; index += 1) nodes.push(clone(template));
    expectError(() => validateFrontendPackDraft(many, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D12 容器必须有 children；schemaVersion / 空 pages 严格校验', () => {
    const emptyChildren = clone(VALID_DRAFT);
    (emptyChildren.pages[0].nodes[2] as { children: unknown[] }).children = [];
    expectError(() => validateFrontendPackDraft(emptyChildren, FACTS), 'FRONTEND_DRAFT_INVALID');

    const badVersion = clone(VALID_DRAFT);
    badVersion.schemaVersion = 'frontend-pack-draft.v2' as 'frontend-pack-draft.v1';
    expectError(() => validateFrontendPackDraft(badVersion, FACTS), 'FRONTEND_DRAFT_INVALID');

    const noPages = clone(VALID_DRAFT);
    noPages.pages = [];
    expectError(() => validateFrontendPackDraft(noPages, FACTS), 'FRONTEND_DRAFT_INVALID');
  });

  it('D13 注入事实本身非法时 fail closed（FRONTEND_FACTS_INVALID）', () => {
    expectError(() => validateFrontendFacts({ version: 'frontend-facts.v1' }), 'FRONTEND_FACTS_INVALID');
    const bad = clone(FACTS) as FrontendFacts & { registryRoot?: string };
    bad.registryRoot = '/tmp/evil';
    expectError(() => validateFrontendFacts(bad), 'FRONTEND_FACTS_INVALID');
    expect(buildFrontendCapabilityIds(FACTS)).toContain('component:store-header');
  });
});

describe('frontend-reconstruct.v1 响应契约', () => {
  it('P1 planned 响应携带 requirement / coverage / draft 通过', () => {
    const response = validateFrontendReconstructResponse(validResponse(), FACTS, { targetPages: ['home'] });
    expect(response.status).toBe('planned');
    expect(response.draft?.pages[0].pageId).toBe('home');
    expect(response.trace.toolCalls).toHaveLength(2);
  });

  it('P2 planned 必须有 draft，且 draft 页面与 requirement 页面一致', () => {
    expectError(
      () => validateFrontendReconstructResponse(validResponse({ draft: null }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    const mismatch = validResponse();
    (mismatch.draft as FrontendPackDraft).pages[0].pageId = 'menu' as 'home';
    expectError(
      () => validateFrontendReconstructResponse(mismatch, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P3 rejected 不返回 draft，且 coverage 必须 rejected + 有缺失能力', () => {
    const rejected = validResponse({
      status: 'rejected',
      coverage: clone(REJECTED_COVERAGE),
      draft: null,
    });
    expect(validateFrontendReconstructResponse(rejected, FACTS, { targetPages: ['home'] }).draft).toBeNull();

    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        status: 'rejected',
        coverage: clone(REJECTED_COVERAGE),
        draft: clone(VALID_DRAFT),
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        status: 'rejected',
        coverage: coveredReport(),
        draft: null,
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P4 needs-input 必须给出具体问题且不返回草案', () => {
    const needsInput = validResponse({
      status: 'needs-input',
      draft: null,
      questions: [{ field: 'targetPages', label: '目标页面', text: '截图中包含两个首页布局，请确认保留哪一种。' }],
    });
    expect(validateFrontendReconstructResponse(needsInput, FACTS, { targetPages: ['home'] }).status).toBe('needs-input');

    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        status: 'needs-input',
        draft: null,
        questions: [],
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        status: 'needs-input',
        questions: [],
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P5 planned 不允许 coverage=rejected', () => {
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        coverage: clone(REJECTED_COVERAGE),
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P6 trace 只允许四个工具名、上限 16 次、stopReason 白名单', () => {
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        trace: {
          modelCalls: 1,
          toolCalls: [{ name: 'run_shell', ok: true }],
          stopReason: 'final_answer',
          degraded: false,
        },
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    const tooMany = Array.from({ length: 17 }, () => ({ name: 'get_frontend_capabilities', ok: true }));
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        trace: { modelCalls: 1, toolCalls: tooMany, stopReason: 'final_answer', degraded: false },
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    const traceWithPrompt = validResponse();
    (traceWithPrompt.trace as Record<string, unknown>).prompt = '系统提示词';
    expectError(
      () => validateFrontendReconstructResponse(traceWithPrompt, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P7 meta 严格、runId 前缀固定、未知顶层键拒绝', () => {
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        meta: { provider: 'deepseek', model: null, mock: false, latencyMs: 1 },
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expectError(
      () => validateFrontendReconstructResponse(validResponse({ runId: 'turn-1' }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expectError(
      () => validateFrontendReconstructResponse(validResponse({ images: [] }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P8 问题项字段与长度有界，自由文本禁止控制字符', () => {
    const badQuestion = validResponse({
      status: 'needs-input',
      draft: null,
      questions: [{ field: 'BAD FIELD', label: '目标页面', text: '请确认。' }],
    });
    expectError(
      () => validateFrontendReconstructResponse(badQuestion, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    const longQuestion = validResponse({
      status: 'needs-input',
      draft: null,
      questions: [{ field: 'targetPages', label: '目标页面', text: '长'.repeat(201) }],
    });
    expectError(
      () => validateFrontendReconstructResponse(longQuestion, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );

    const c1Question = validResponse({
      status: 'needs-input',
      draft: null,
      questions: [{ field: 'targetPages', label: '目标页面', text: '确认\u0085文本' }],
    });
    expectError(
      () => validateFrontendReconstructResponse(c1Question, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P9 response 内嵌 requirement/coverage/draft 的错误仍报对应稳定错误码', () => {
    const badRequirement = validResponse();
    (badRequirement.requirement as UiRequirement).summary = '<script>';
    expectError(
      () => validateFrontendReconstructResponse(badRequirement, FACTS, { targetPages: ['home'] }),
      'FRONTEND_REQUIREMENT_INVALID',
    );

    const badDraft = clone(validResponse());
    ((badDraft.draft as FrontendPackDraft).pages[0].nodes[1] as { id?: string }).id = 'x';
    expectError(
      () => validateFrontendReconstructResponse(badDraft, FACTS, { targetPages: ['home'] }),
      'FRONTEND_DRAFT_INVALID',
    );
  });

  it('P10 C1：删掉 mustKeep 的“开始点餐”按钮后不能仍 planned/covered', () => {
    const body = validResponse();
    const draft = body.draft as FrontendPackDraft;
    const container = draft.pages[0].nodes[2] as { children: unknown[] };
    // 草稿不再含 button(action:home.goMenu)，但 mustKeep 与 coverage 仍要求它。
    expect(container.children).toHaveLength(3);
    container.children.pop();

    const error = expectError(
      () => validateFrontendReconstructResponse(body, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expect(error.httpStatus).toBe(502);
    expect(error.details?.path).toBe('$.draft');

    // 同样的 requirement/coverage 配完整草稿则通过，证明失败原因就是被删的按钮。
    expect(validateFrontendReconstructResponse(validResponse(), FACTS, { targetPages: ['home'] }).status).toBe(
      'planned',
    );
  });

  it('P11 C1：coverage.requiredCapabilities 未被 draft 使用时必须拒绝', () => {
    const body = validResponse();
    const coverage = body.coverage as Record<string, unknown>;
    const required = coverage.requiredCapabilities as string[];
    // action:menu.onExpandCart 是真实事实，但本 draft 使用 menu.onCheckout，未使用它。
    required.push('action:menu.onExpandCart');
    (coverage.coveredBy as Record<string, string>)['action:menu.onExpandCart'] = 'action:menu.onExpandCart';

    const error = expectError(
      () => validateFrontendReconstructResponse(body, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expect(error.httpStatus).toBe(502);
    expect(error.details?.path).toBe('$.draft');
  });

  it('P12 C2：covered 不得与 requirement.degradations 组合，即使 trace.degraded=true', () => {
    const body = validResponse();
    body.requirement = clone(PARTIAL_REQUIREMENT);
    body.coverage = coveredReport();
    body.trace = { ...(body.trace as Record<string, unknown>), degraded: true };

    const error = expectError(
      () => validateFrontendReconstructResponse(body, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expect(error.httpStatus).toBe(502);
    expect(error.details?.path).toBe('$.coverage.degradations');
  });

  it('P13 C2：有降级必须 partial + trace.degraded=true（不自动采用，需显式确认）', () => {
    const notMarked = partialResponse();
    (notMarked.trace as Record<string, unknown>).degraded = false;
    const error = expectError(
      () => validateFrontendReconstructResponse(notMarked, FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
    expect(error.details?.path).toBe('$.trace.degraded');

    const response = validateFrontendReconstructResponse(partialResponse(), FACTS, { targetPages: ['home'] });
    expect(response.status).toBe('planned');
    expect(response.coverage.status).toBe('partial');
    expect(response.coverage.degradations).toHaveLength(1);
    expect(response.trace.degraded).toBe(true);

    // 契约不额外发明字段：桌面端以 trace.degraded 要求二次确认，状态机 S8 再强制显式采用。
    let state = validatingState();
    state = transitionFrontendRun(state, 'verifying-runtime');
    state = transitionFrontendRun(state, 'partial');
    expectError(() => adoptFrontendCandidate(state), 'FRONTEND_STATE_TRANSITION_INVALID');
  });

  it('P14 fixture 已硬化：covered 正向无降级、partial 正向有降级，不再固化 covered+降级', () => {
    expect(VALID_REQUIREMENT.degradations).toHaveLength(0);
    expect(PARTIAL_REQUIREMENT.degradations.length).toBeGreaterThan(0);
    expect(COVERED_COVERAGE.degradations).toHaveLength(0);
    expect(PARTIAL_COVERAGE.degradations.length).toBeGreaterThan(0);
    expect(validateCapabilityCoverageReport(clone(COVERED_COVERAGE), FACTS).status).toBe('covered');
    expect(validateCapabilityCoverageReport(clone(PARTIAL_COVERAGE), FACTS).status).toBe('partial');
    expect(validateFrontendReconstructResponse(partialResponse(), FACTS, { targetPages: ['home'] }).status).toBe(
      'planned',
    );
    expectError(
      () => validateFrontendReconstructResponse(validResponse({
        requirement: clone(PARTIAL_REQUIREMENT),
        coverage: coveredReport(),
      }), FACTS, { targetPages: ['home'] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });

  it('P15 C1：coverage 漏掉 mustKeep/绑定的 action/data 时 502（不允许 planned/covered）', () => {
    // action:home.goMenu 与 data:store.name 来自 mustKeep；data:menu.products 只来自 binding。
    for (const capability of ['action:home.goMenu', 'data:store.name', 'data:menu.products']) {
      const body = validResponse();
      const coverage = body.coverage as {
        requiredCapabilities: string[];
        coveredBy: Record<string, string>;
      };
      coverage.requiredCapabilities = coverage.requiredCapabilities.filter((item) => item !== capability);
      delete coverage.coveredBy[capability];

      const error = expectError(
        () => validateFrontendReconstructResponse(body, FACTS, { targetPages: ['home'] }),
        'FRONTEND_RESPONSE_INVALID',
      );
      expect(error.httpStatus).toBe(502);
      expect(error.details?.path).toBe('$.coverage.requiredCapabilities');
    }

    // 未删除任何项时仍 planned（证明失败原因就是 coverage 漏项）。
    expect(validateFrontendReconstructResponse(validResponse(), FACTS, { targetPages: ['home'] }).status).toBe(
      'planned',
    );
  });

  it('P16 响应入口 targetPages 必填：缺省或空数组都 fail closed（502，不跳过 C1）', () => {
    expectError(
      () => validateFrontendReconstructResponse(validResponse(), FACTS),
      'FRONTEND_RESPONSE_INVALID',
    );
    expectError(
      () => validateFrontendReconstructResponse(validResponse(), FACTS, { targetPages: [] }),
      'FRONTEND_RESPONSE_INVALID',
    );
  });
});

describe('frontend-reconstruct.v1 状态机与 repair 上限', () => {
  it('S1 合法单向链路：idle → … → ready → adopted', () => {
    let state = createFrontendRunState('frun-state');
    const path = [
      'analyzing',
      'planning',
      'generating',
      'validating',
      'verifying-runtime',
      'ready',
    ] as const;
    for (const next of path) {
      state = transitionFrontendRun(state, next);
      expect(state.status).toBe(next);
    }
    expect(state.revision).toBe(path.length);
    state = adoptFrontendCandidate(state);
    expect(state.status).toBe('adopted');
  });

  it('S2 非法跳跃与终态离开一律拒绝 FRONTEND_STATE_TRANSITION_INVALID', () => {
    const idle = createFrontendRunState('frun-state');
    expect(canTransitionFrontendState('idle', 'ready')).toBe(false);
    expectError(() => transitionFrontendRun(idle, 'ready'), 'FRONTEND_STATE_TRANSITION_INVALID');

    const rejected = transitionFrontendRun(
      transitionFrontendRun(idle, 'analyzing'),
      'rejected',
    );
    expect(isFrontendTerminalState(rejected)).toBe(true);
    expectError(() => transitionFrontendRun(rejected, 'planning'), 'FRONTEND_STATE_TRANSITION_INVALID');
  });

  it('S3 cancelled 为终态，ready 可取消', () => {
    let state = validatingState();
    state = transitionFrontendRun(state, 'verifying-runtime');
    state = transitionFrontendRun(state, 'ready');
    state = cancelFrontendRun(state);
    expect(state.status).toBe('cancelled');
    expect(isFrontendTerminalState(state)).toBe(true);
    expectError(() => cancelFrontendRun(state), 'FRONTEND_STATE_TRANSITION_INVALID');
  });

  it('S4 validating → generating 必须通过结构化 repair，不能直接跳', () => {
    const state = validatingState();
    expectError(() => transitionFrontendRun(state, 'generating'), 'FRONTEND_STATE_TRANSITION_INVALID');
  });

  it('S5 最多 2 轮 repair，第 3 轮拒绝 FRONTEND_REPAIR_LIMIT_EXCEEDED', () => {
    expect(FRONTEND_MAX_REPAIR_ROUNDS).toBe(2);
    let state = validatingState();
    const issue = { path: '$.pages[0].nodes[2]', code: 'DRAFT_UNKNOWN_COMPONENT' as const };

    state = beginFrontendRepair(state, [issue]);
    expect(state.status).toBe('generating');
    expect(state.repairAttempts).toBe(1);

    state = transitionFrontendRun(state, 'validating');
    state = beginFrontendRepair(state, [issue]);
    expect(state.repairAttempts).toBe(2);

    state = transitionFrontendRun(state, 'validating');
    expectError(() => beginFrontendRepair(state, [issue]), 'FRONTEND_REPAIR_LIMIT_EXCEEDED');
    // 超限后仍允许如实置 failed，不伪造 ready
    expect(transitionFrontendRun(state, 'failed').status).toBe('failed');
  });

  it('S6 repair 只接受结构化 issues（path + code），自由文本/空/超限拒绝', () => {
    const state = validatingState();
    expectError(
      () => beginFrontendRepair(state, [{ path: '随便一段日志', code: 'DRY_RUN_FAILED' }]),
      'FRONTEND_REPAIR_ISSUES_INVALID',
    );
    expectError(
      () => beginFrontendRepair(state, [{ path: '$.pages[0]', code: 'DRY_RUN_FAILED', message: '完整日志' }]),
      'FRONTEND_REPAIR_ISSUES_INVALID',
    );
    expectError(() => beginFrontendRepair(state, []), 'FRONTEND_REPAIR_ISSUES_INVALID');
    expectError(
      () => beginFrontendRepair(state, [{ path: '$.pages[0]', code: 'SHELL_COMMAND' }]),
      'FRONTEND_REPAIR_ISSUES_INVALID',
    );

    const nine = Array.from({ length: 9 }, (_, index) => ({
      path: `$.pages[0].nodes[${index}]`,
      code: 'DRY_RUN_FAILED' as const,
    }));
    expectError(() => beginFrontendRepair(state, nine), 'FRONTEND_REPAIR_ISSUES_INVALID');
    expect(() => validateFrontendRepairIssues([nine[0]])).not.toThrow();
  });

  it('S7 repair 只能从 validating 触发', () => {
    expectError(
      () => beginFrontendRepair(planningState(), [{ path: '$.pages[0]', code: 'DRY_RUN_FAILED' }]),
      'FRONTEND_STATE_TRANSITION_INVALID',
    );
  });

  it('S8 partial 采用必须显式确认；ready 直接采用', () => {
    let state = validatingState();
    state = transitionFrontendRun(state, 'verifying-runtime');
    state = transitionFrontendRun(state, 'partial');
    expectError(() => adoptFrontendCandidate(state), 'FRONTEND_STATE_TRANSITION_INVALID');
    expect(adoptFrontendCandidate(state, { explicitPartialConfirmation: true }).status).toBe('adopted');

    let ready = validatingState();
    ready = transitionFrontendRun(ready, 'verifying-runtime');
    ready = transitionFrontendRun(ready, 'ready');
    expect(adoptFrontendCandidate(ready).status).toBe('adopted');
  });

  it('S9 adopted 可撤销回 idle；failed 可用新 runId 重试并清零 repair 次数', () => {
    let state = validatingState();
    state = transitionFrontendRun(state, 'verifying-runtime');
    state = transitionFrontendRun(state, 'ready');
    state = adoptFrontendCandidate(state);
    const undone = undoAdoptedFrontend(state);
    expect(undone.status).toBe('idle');

    let failed = validatingState();
    failed = beginFrontendRepair(failed, [{ path: '$.pages[0]', code: 'DRY_RUN_FAILED' }]);
    failed = transitionFrontendRun(failed, 'validating');
    failed = transitionFrontendRun(failed, 'failed');
    expectError(() => retryFrontendRun(failed, 'frun-state'), 'FRONTEND_STATE_TRANSITION_INVALID');
    const retried = retryFrontendRun(failed, 'frun-retry');
    expect(retried.status).toBe('analyzing');
    expect(retried.runId).toBe('frun-retry');
    expect(retried.repairAttempts).toBe(0);
  });

  it('S10 状态表自身完整：每个目标状态都属于 FRONTEND_STATES', () => {
    for (const state of FRONTEND_STATES) {
      for (const target of FRONTEND_STATES) {
        const allowed = canTransitionFrontendState(state, target);
        if (allowed) expect(FRONTEND_STATES).toContain(target);
      }
    }
    expect(FRONTEND_STATES).toHaveLength(13);
  });

  it('S11 adopted → idle 只能经 undo；直接 adopt 也只能走 adopt 入口', () => {
    let adopted = validatingState();
    adopted = transitionFrontendRun(adopted, 'verifying-runtime');
    adopted = transitionFrontendRun(adopted, 'ready');
    adopted = adoptFrontendCandidate(adopted);

    const error = expectError(
      () => transitionFrontendRun(adopted, 'idle'),
      'FRONTEND_STATE_TRANSITION_INVALID',
    );
    expect(error.details?.reason).toBe('undo-required');
    expect(undoAdoptedFrontend(adopted).status).toBe('idle');

    let ready = validatingState();
    ready = transitionFrontendRun(ready, 'verifying-runtime');
    ready = transitionFrontendRun(ready, 'ready');
    expectError(() => transitionFrontendRun(ready, 'adopted'), 'FRONTEND_STATE_TRANSITION_INVALID');
  });
});

describe('frontend-reconstruct.v1 错误码表', () => {
  it('E1 所有 FRONTEND_* 错误码都有 HTTP 状态、retryable 与固定文案', () => {
    const entries = Object.entries(FRONTEND_ERROR_DEFINITIONS);
    expect(entries.length).toBeGreaterThanOrEqual(20);
    for (const [code, definition] of entries) {
      expect(code.startsWith('FRONTEND_')).toBe(true);
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
      expect(definition.httpStatus).toBeLessThan(600);
      expect(typeof definition.retryable).toBe('boolean');
      expect(definition.message.length).toBeGreaterThan(0);
      // 固定文案不得包含调用方可回填的占位
      expect(definition.message).not.toContain('${');
    }
    for (const required of [
      'FRONTEND_REQUEST_INVALID',
      'FRONTEND_CONTRACT_MISMATCH',
      'FRONTEND_IMAGE_REQUIRED',
      'FRONTEND_IMAGE_COUNT_INVALID',
      'FRONTEND_IMAGE_KIND_INVALID',
      'FRONTEND_IMAGE_TYPE_UNSUPPORTED',
      'FRONTEND_IMAGE_INVALID',
      'FRONTEND_IMAGE_TOO_LARGE',
      'FRONTEND_UTTERANCE_INVALID',
      'FRONTEND_TARGET_PAGES_UNSUPPORTED',
      'FRONTEND_REQUIREMENT_INVALID',
      'FRONTEND_COVERAGE_INVALID',
      'FRONTEND_COVERAGE_REJECTED',
      'FRONTEND_DRAFT_INVALID',
      'FRONTEND_RESPONSE_INVALID',
      'FRONTEND_STATE_TRANSITION_INVALID',
      'FRONTEND_REPAIR_ISSUES_INVALID',
      'FRONTEND_REPAIR_LIMIT_EXCEEDED',
      'FRONTEND_FACTS_INVALID',
      'FRONTEND_ABORTED',
      'FRONTEND_TIME_LIMIT',
      'FRONTEND_MODEL_CALL_LIMIT',
      'FRONTEND_TOOL_CALL_LIMIT',
      'FRONTEND_MODEL_RESPONSE_INVALID',
      'FRONTEND_INTERNAL_ERROR',
    ]) {
      expect(FRONTEND_ERROR_DEFINITIONS).toHaveProperty(required);
    }
  });

  it('E2 错误对象与错误码表一致，且 details 不回声正文', () => {
    const error = captureError(() => parseFrontendReconstructRequest(validRequest({ requestId: 'x' })));
    const definition = FRONTEND_ERROR_DEFINITIONS[error.code];
    expect(error.message).toBe(definition.message);
    expect(error.httpStatus).toBe(definition.httpStatus);
    const http = error.toHttpException();
    expect(http.getStatus()).toBe(definition.httpStatus);
    expect(http.getResponse()).toEqual({ code: error.code, message: definition.message });
    expect(JSON.stringify(error)).not.toContain(PNG_BASE64.slice(0, 24));
  });
});
