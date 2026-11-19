/**
 * 只读能力快照加载器。
 *
 * 快照是 `scripts/app-capabilities.cjs --write` 的生成物，服务端只读，不手抄第二份字段限制。
 * catalogVersion 与契约不一致时直接抛配置错误（fail closed），避免旧客户端拿新字段写错值。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigurationError } from '../runtime';
import {
  APP_ASSISTANT_CATALOG_VERSION,
  APP_ASSISTANT_SNAPSHOT_VERSION,
} from './types';
import type {
  AppCapabilityCatalog,
  CapabilitySnapshot,
  CatalogAction,
  CatalogField,
} from './types';

const SNAPSHOT_FILE = 'capabilities.snapshot.json';

/**
 * 读取只读快照（不依赖 tsconfig 的 resolveJsonModule，也不把快照内容抄进源码）。
 *
 * 候选顺序：模块目录（nest 构建产物旁）→ 仓库 server/src 真源。
 * 生产构建若未把 JSON 作为 asset 拷贝，需要保证进程从 server/ 目录启动。
 */
function readSnapshotFile(): unknown {
  const moduleDir = typeof __dirname === 'string' ? __dirname : '';
  const candidates = [
    moduleDir ? join(moduleDir, SNAPSHOT_FILE) : '',
    // dist/agent/app-assistant → server/src/agent/app-assistant（源码真源）
    moduleDir ? join(moduleDir, '..', '..', '..', 'src', 'agent', 'app-assistant', SNAPSHOT_FILE) : '',
    join(process.cwd(), 'src', 'agent', 'app-assistant', SNAPSHOT_FILE),
    join(process.cwd(), 'server', 'src', 'agent', 'app-assistant', SNAPSHOT_FILE),
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, 'utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AgentConfigurationError('能力快照不是合法 JSON。');
    }
  }
  throw new AgentConfigurationError(
    '能力快照 capabilities.snapshot.json 缺失，无法校验能力目录。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new AgentConfigurationError(`能力快照字段 ${label} 非法。`);
  }
  return value;
}

function validateCatalog(raw: unknown): AppCapabilityCatalog {
  if (!isPlainObject(raw)) {
    throw new AgentConfigurationError('能力快照 catalog 必须是对象。');
  }
  if (raw.catalogVersion !== APP_ASSISTANT_CATALOG_VERSION) {
    throw new AgentConfigurationError('能力快照 catalogVersion 与契约不一致。');
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new AgentConfigurationError('能力快照缺少 fields。');
  }
  if (!Array.isArray(raw.actions)) {
    throw new AgentConfigurationError('能力快照缺少 actions。');
  }
  if (!Array.isArray(raw.attachmentPurposes)) {
    throw new AgentConfigurationError('能力快照缺少 attachmentPurposes。');
  }

  const fields: CatalogField[] = raw.fields.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new AgentConfigurationError(`能力快照 fields[${index}] 必须是对象。`);
    }
    const field: CatalogField = {
      fieldId: assertString(item.fieldId, `fields[${index}].fieldId`, 80),
      label: assertString(item.label, `fields[${index}].label`, 40),
      type: assertString(item.type, `fields[${index}].type`, 40),
      writeMode: assertString(item.writeMode, `fields[${index}].writeMode`, 40),
      writable: item.writable === true,
      risk: assertString(item.risk, `fields[${index}].risk`, 20),
    };
    if (isPlainObject(item.limits)) field.limits = item.limits;
    if (Array.isArray(item.options)) field.options = item.options.filter((v): v is string => typeof v === 'string');
    if (Array.isArray(item.required)) field.required = item.required.filter((v): v is string => typeof v === 'string');
    if (Array.isArray(item.ops)) field.ops = item.ops.filter((v): v is string => typeof v === 'string');
    if (Array.isArray(item.actions)) field.actions = item.actions.filter((v): v is string => typeof v === 'string');
    if (isPlainObject(item.writeback)) {
      field.writeback = Object.fromEntries(
        Object.entries(item.writeback).filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
      );
    }
    if (typeof item.note === 'string') field.note = item.note;
    if (item.confirmWhenEmpty === true) field.confirmWhenEmpty = true;
    return field;
  });

  const fieldIds = new Set(fields.map((field) => field.fieldId));
  if (fieldIds.size !== fields.length) {
    throw new AgentConfigurationError('能力快照 fields 存在重复 fieldId。');
  }

  const actions: CatalogAction[] = raw.actions.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new AgentConfigurationError(`能力快照 actions[${index}] 必须是对象。`);
    }
    const action: CatalogAction = {
      actionId: assertString(item.actionId, `actions[${index}].actionId`, 80),
      label: assertString(item.label, `actions[${index}].label`, 40),
      risk: assertString(item.risk, `actions[${index}].risk`, 20),
    };
    if (isPlainObject(item.params)) {
      action.params = Object.fromEntries(
        Object.entries(item.params).filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
      );
    }
    return action;
  });

  return {
    catalogVersion: APP_ASSISTANT_CATALOG_VERSION,
    fields,
    actions,
    attachmentPurposes: raw.attachmentPurposes.filter((v): v is string => typeof v === 'string'),
    deniedFieldIdPrefixes: Array.isArray(raw.deniedFieldIdPrefixes)
      ? raw.deniedFieldIdPrefixes.filter((v): v is string => typeof v === 'string')
      : [],
    readOnlyFieldIds: Array.isArray(raw.readOnlyFieldIds)
      ? raw.readOnlyFieldIds.filter((v): v is string => typeof v === 'string')
      : [],
    riskPolicy: typeof raw.riskPolicy === 'string' ? raw.riskPolicy : '',
  };
}

function validateSnapshot(raw: unknown): CapabilitySnapshot {
  if (!isPlainObject(raw)) {
    throw new AgentConfigurationError('能力快照必须是 JSON 对象。');
  }
  if (raw.contractVersion !== APP_ASSISTANT_SNAPSHOT_VERSION) {
    throw new AgentConfigurationError('能力快照 contractVersion 非法。');
  }
  if (raw.catalogVersion !== APP_ASSISTANT_CATALOG_VERSION) {
    throw new AgentConfigurationError('能力快照 catalogVersion 与契约不一致。');
  }
  return {
    contractVersion: APP_ASSISTANT_SNAPSHOT_VERSION,
    catalogVersion: APP_ASSISTANT_CATALOG_VERSION,
    digest: typeof raw.digest === 'string' ? raw.digest : '',
    catalog: validateCatalog(raw.catalog),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const APP_CAPABILITY_SNAPSHOT: CapabilitySnapshot = deepFreeze(
  validateSnapshot(readSnapshotFile()),
);

export const APP_CATALOG: AppCapabilityCatalog = APP_CAPABILITY_SNAPSHOT.catalog;

const FIELD_BY_ID = new Map(APP_CATALOG.fields.map((field) => [field.fieldId, field]));
const ACTION_BY_ID = new Map(APP_CATALOG.actions.map((action) => [action.actionId, action]));

export function findCatalogField(fieldId: string): CatalogField | undefined {
  return FIELD_BY_ID.get(fieldId);
}

export function findCatalogAction(actionId: string): CatalogAction | undefined {
  return ACTION_BY_ID.get(actionId);
}

export function catalogLimitNumber(field: CatalogField, key: string): number | undefined {
  const value = field.limits?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function catalogLimitString(field: CatalogField, key: string): string | undefined {
  const value = field.limits?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** 紧凑能力摘要（只含目录事实，不含项目数据），供系统提示词使用。 */
export function describeCatalogForPrompt(): string {
  const lines: string[] = [];
  for (const field of APP_CATALOG.fields) {
    const parts = [
      `${field.fieldId}（${field.label}）`,
      `type=${field.type}`,
      `risk=${field.risk}`,
      field.writable ? `writeMode=${field.writeMode}` : '只读/需走操作',
    ];
    if (field.options?.length) parts.push(`options=${field.options.join('|')}`);
    if (field.required?.length) parts.push(`required=${field.required.join('|')}`);
    if (field.ops?.length) parts.push(`ops=${field.ops.join('|')}`);
    if (field.limits) parts.push(`limits=${JSON.stringify(field.limits)}`);
    if (field.note) parts.push(field.note);
    lines.push(`- ${parts.join('；')}`);
  }
  lines.push('业务动作：');
  for (const action of APP_CATALOG.actions) {
    const params = Object.entries(action.params ?? {})
      .map(([key, type]) => `${key}:${type}`)
      .join('，');
    lines.push(`- ${action.actionId}（${action.label}）：risk=${action.risk}；params=${params || '无'}`);
  }
  return lines.join('\n');
}