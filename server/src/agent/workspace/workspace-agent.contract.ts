/**
 * workspace-agent.v1 契约加载/校验（单一事实源）。
 *
 * 服务端的 operations、工具名、RPC 名称、参数 schema、上限与错误码全部来自
 * `contracts/workspace-agent.v1.json`；本文件不做第二份同义常量。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { WorkspaceAgentContract, WorkspaceAgentLimits, WorkspaceOperation, WorkspaceToolContract } from './workspace-agent.types';

const CONTRACT_BASENAME = 'workspace-agent.v1.json';
const CONTRACT_RELATIVE = join('contracts', CONTRACT_BASENAME);

let cachedContract: WorkspaceAgentContract | null = null;

function fail(message: string): never {
  throw new Error('[workspace-agent] ' + message);
}

function candidatePaths(): string[] {
  const cwd = process.cwd();
  const serverDir = resolve(__dirname, '..', '..', '..');
  return [
    resolve(cwd, CONTRACT_RELATIVE),
    resolve(cwd, '..', CONTRACT_RELATIVE),
    resolve(serverDir, '..', CONTRACT_RELATIVE),
    resolve(__dirname, '..', '..', '..', '..', CONTRACT_RELATIVE),
    resolve(__dirname, '..', '..', '..', '..', '..', CONTRACT_RELATIVE),
  ];
}

function readContractText(): string {
  for (const file of candidatePaths()) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      // 继续尝试下一个候选路径
    }
  }
  fail('找不到 contracts/workspace-agent.v1.json（单一路径事实源缺失）');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateLimits(raw: unknown): WorkspaceAgentLimits {
  if (!isPlainObject(raw)) fail('contract.limits 必须是对象');
  const keys: Array<keyof WorkspaceAgentLimits> = [
    'maxRequestBytes', 'maxUtteranceCharacters', 'maxImages', 'maxImageCaptionCharacters',
    'maxToolResults', 'maxToolResultReferenceBytes', 'maxModelCalls', 'maxToolCalls',
    'maxWallClockMs', 'maxParallelToolCalls', 'maxReplyCharacters', 'maxToolResultBytes',
    'toolTimeoutMs', 'modelMaxAttempts', 'modelRetryBackoffMs', 'maxFileChanges', 'maxFileContentBytes',
  ];
  const limits = {} as WorkspaceAgentLimits;
  for (const key of keys) {
    if (!isPositiveInteger(raw[key])) fail('contract.limits.' + key + ' 必须是正整数');
    limits[key] = raw[key] as number;
  }
  if (limits.maxModelCalls > 12) fail('maxModelCalls 不得超过 runtime 硬上限 12');
  if (limits.maxToolCalls > 50) fail('maxToolCalls 不得超过 runtime 硬上限 50');
  if (limits.maxWallClockMs > 300_000) fail('maxWallClockMs 不得超过 runtime 硬上限 300000');
  if (limits.maxParallelToolCalls > 8) fail('maxParallelToolCalls 不得超过 runtime 硬上限 8');
  if (limits.maxReplyCharacters > 20_000) fail('maxReplyCharacters 不得超过 runtime 硬上限 20000');
  if (limits.maxToolResultBytes > 262_144) fail('maxToolResultBytes 不得超过 runtime 硬上限 262144');
  if (limits.toolTimeoutMs > 120_000) fail('toolTimeoutMs 不得超过 runtime 硬上限 120000');
  return limits;
}

function validateTools(raw: unknown): WorkspaceToolContract[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) fail('contract.tools 必须是 1–32 个工具');
  const names = new Set<string>();
  const commands = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) fail('contract.tools[' + index + '] 必须是对象');
    const name = typeof item.name === 'string' ? item.name : '';
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(name)) fail('contract.tools[' + index + '].name 非法');
    if (names.has(name)) fail('工具名重复：' + name);
    names.add(name);
    const rpc = typeof item.rpc === 'string' ? item.rpc : '';
    if (!/^agent:[a-z0-9-]+$/.test(rpc)) fail('工具 ' + name + ' 的 rpc 命令非法');
    if (commands.has(rpc)) fail('RPC 命令重复：' + rpc);
    commands.add(rpc);
    if (typeof item.description !== 'string' || item.description.length < 4 || item.description.length > 2_000) {
      fail('工具 ' + name + ' 的 description 长度非法');
    }
    if (item.sideEffect !== 'read' && item.sideEffect !== 'write') fail('工具 ' + name + ' 的 sideEffect 非法');
    if (!isPlainObject(item.parameters) || item.parameters.type !== 'object') fail('工具 ' + name + ' 的 parameters 必须是 object schema');
    return {
      name,
      rpc,
      description: item.description,
      sideEffect: item.sideEffect,
      parameters: item.parameters as unknown as WorkspaceToolContract['parameters'],
    };
  });
}

function validateContract(raw: unknown): WorkspaceAgentContract {
  if (!isPlainObject(raw)) fail('契约根必须是对象');
  if (raw.schemaVersion !== 'workspace-agent.contract.v1') fail('schemaVersion 非法');
  if (raw.contractVersion !== 'workspace-agent.v1') fail('contractVersion 非法');
  if (raw.endpoint !== 'POST /api/v1/agent/workspace') fail('endpoint 非法');
  const operations = raw.operations;
  if (!Array.isArray(operations) || operations.length === 0) fail('operations 不能为空');
  const operationNames = new Set<string>();
  for (const operation of operations) {
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(operation)) fail('operation 非法：' + String(operation));
    if (operationNames.has(operation)) fail('operation 重复：' + operation);
    operationNames.add(operation);
  }
  const request = raw.request;
  if (!isPlainObject(request)) fail('request 必须是对象');
  if (!Array.isArray(request.allowedKeys) || !Array.isArray(request.requiredKeys)) fail('request.allowedKeys/requiredKeys 非法');
  if (!isPlainObject(request.properties)) fail('request.properties 非法');
  const response = raw.response;
  if (!isPlainObject(response)) fail('response 必须是对象');
  if (!Array.isArray(response.allowedKeys) || !Array.isArray(response.forbiddenKeys)) fail('response.allowedKeys/forbiddenKeys 非法');
  const tools = validateTools(raw.tools);
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (!isPlainObject(raw.operationTools)) fail('operationTools 必须是对象');
  const operationToolKeys = Object.keys(raw.operationTools).sort();
  const expectedOperationKeys = [...operationNames].sort();
  if (JSON.stringify(operationToolKeys) !== JSON.stringify(expectedOperationKeys)) {
    fail('operationTools 键必须与 operations 完全一致');
  }
  const operationTools = {} as Record<WorkspaceOperation, string[]>;
  for (const operation of operations as WorkspaceOperation[]) {
    const list = raw.operationTools[operation];
    if (!Array.isArray(list) || list.length === 0) fail('operationTools.' + operation + ' 不能为空');
    for (const name of list) {
      if (!toolNames.has(name)) fail('operationTools.' + operation + ' 引用了未知工具：' + String(name));
    }
    operationTools[operation] = list as string[];
  }
  const limits = validateLimits(raw.limits);
  if (!Array.isArray(raw.errorCodes) || raw.errorCodes.length === 0) fail('errorCodes 不能为空');
  for (const code of raw.errorCodes) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) fail('errorCode 非法：' + String(code));
  }
  if (!isPlainObject(raw.mock)) fail('mock 配置缺失');
  if (!Array.isArray(raw.mock.tools)) fail('mock.tools 缺失');
  for (const name of raw.mock.tools) {
    if (!toolNames.has(name)) fail('mock.tools 引用了未知工具：' + String(name));
  }

  return {
    schemaVersion: raw.schemaVersion as string,
    contractVersion: raw.contractVersion as string,
    endpoint: raw.endpoint as string,
    operations: operations as WorkspaceOperation[],
    request: {
      allowedKeys: request.allowedKeys as string[],
      requiredKeys: request.requiredKeys as string[],
      properties: request.properties as Record<string, unknown>,
    },
    response: {
      allowedKeys: response.allowedKeys as string[],
      forbiddenKeys: response.forbiddenKeys as string[],
      properties: response.properties as Record<string, unknown>,
    },
    tools,
    operationTools,
    limits,
    errorCodes: raw.errorCodes as string[],
    mock: raw.mock as WorkspaceAgentContract['mock'],
  };
}

export function loadWorkspaceAgentContract(): WorkspaceAgentContract {
  if (cachedContract !== null) return cachedContract;
  const text = readContractText();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('契约 JSON 解析失败：' + (error instanceof Error ? error.message : String(error)));
  }
  cachedContract = validateContract(parsed);
  return cachedContract;
}

/** 仅测试使用。 */
export function resetWorkspaceAgentContractForTests(): void {
  cachedContract = null;
}
