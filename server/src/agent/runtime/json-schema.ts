/**
 * 轻量 JSON Schema 子集：用于工具参数契约的声明与运行时校验。
 *
 * 设计取舍：
 * - 不引入 zod/ajv，避免为一个只服务于 function calling 的子集新增依赖；
 * - 只支持模型工具参数真正需要的关键字，未支持的关键字（如 $ref）在注册工具时直接报错，
 *   而不是静默忽略——静默忽略会让参数契约看起来比实际更严格；
 * - 校验失败返回结构化问题路径，路径会回传给模型，便于模型自行修正参数。
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export interface JsonSchema {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  title?: string;
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly JsonValue[];
  const?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: JsonValue;
}

export interface JsonSchemaIssue {
  /** 形如 $.patch.dishes[0].name 的稳定路径，可直接回显给模型。 */
  path: string;
  message: string;
}

const MAX_SCHEMA_DEPTH = 16;
const DEFAULT_MAX_ISSUES = 20;
const MAX_PATTERN_LENGTH = 200;

const JSON_SCHEMA_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'default',
]);

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
      if (!isJsonObject(value)) return false;
      return Object.values(value).every((item) => isJsonValue(item));
    }
    default:
      return false;
  }
}

/**
 * 检查 schema 本身是否合法（工具注册时调用）。返回值是面向开发者的配置错误描述。
 */
export function collectJsonSchemaProblems(
  schema: unknown,
  rootPath = '$.parameters',
): string[] {
  const problems: string[] = [];
  visitSchemaDefinition(schema, rootPath, problems, new WeakSet<object>(), 0);
  return problems;
}

/**
 * 工具参数 schema 的额外约束：根必须是 object，required 必须能在 properties 中声明。
 * 这些约束保证模型传参始终是可解析对象，避免出现“工具永远收不到参数”的隐性故障。
 */
export function collectToolParametersSchemaProblems(schema: unknown): string[] {
  const problems = collectJsonSchemaProblems(schema);
  if (problems.length > 0) return problems;

  const root = schema as JsonSchema;
  if (root.type !== 'object') {
    problems.push('$.parameters.type 必须是 "object"。');
  }

  const declared = new Set(Object.keys(root.properties ?? {}));
  for (const key of root.required ?? []) {
    if (!declared.has(key)) {
      problems.push(`$.parameters.required 中的 "${key}" 未在 properties 中声明。`);
    }
  }

  return problems;
}

function visitSchemaDefinition(
  schema: unknown,
  path: string,
  problems: string[],
  seen: WeakSet<object>,
  depth: number,
): void {
  if (!isJsonObject(schema)) {
    problems.push(`${path} 必须是对象。`);
    return;
  }
  if (seen.has(schema)) {
    problems.push(`${path} 存在循环引用。`);
    return;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`${path} 嵌套超过 ${MAX_SCHEMA_DEPTH} 层。`);
    return;
  }
  seen.add(schema);

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      problems.push(`${path}.${key} 不是受支持的 JSON Schema 关键字。`);
    }
  }

  if (schema.type !== undefined) {
    const declared = schema.type;
    const types: readonly unknown[] =
      typeof declared === 'string'
        ? [declared]
        : Array.isArray(declared)
          ? declared
          : [declared];
    if (types.length === 0) {
      problems.push(`${path}.type 不能是空数组。`);
    }
    for (const type of types) {
      if (!JSON_SCHEMA_TYPES.includes(type as JsonSchemaType)) {
        problems.push(`${path}.type 包含无效类型 "${String(type)}"。`);
      }
    }
  }

  if (schema.properties !== undefined) {
    if (!isJsonObject(schema.properties)) {
      problems.push(`${path}.properties 必须是对象。`);
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key.length === 0) problems.push(`${path}.properties 包含空字段名。`);
        visitSchemaDefinition(child, `${path}.properties.${key}`, problems, seen, depth + 1);
      }
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      problems.push(`${path}.required 必须是字符串数组。`);
    } else {
      const names = new Set<string>();
      for (const name of schema.required) {
        if (typeof name !== 'string' || name.length === 0) {
          problems.push(`${path}.required 包含无效字段名。`);
          continue;
        }
        if (names.has(name)) problems.push(`${path}.required 重复声明 "${name}"。`);
        names.add(name);
      }
    }
  }

  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    visitSchemaDefinition(
      schema.additionalProperties,
      `${path}.additionalProperties`,
      problems,
      seen,
      depth + 1,
    );
  }

  if (schema.items !== undefined) {
    visitSchemaDefinition(schema.items, `${path}.items`, problems, seen, depth + 1);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      problems.push(`${path}.enum 必须是至少包含一个值的数组。`);
    } else {
      for (const item of schema.enum) {
        if (!isJsonValue(item)) problems.push(`${path}.enum 包含非 JSON 值。`);
      }
    }
  }

  if (schema.const !== undefined && !isJsonValue(schema.const)) {
    problems.push(`${path}.const 必须是 JSON 值。`);
  }
  if (schema.default !== undefined && !isJsonValue(schema.default)) {
    problems.push(`${path}.default 必须是 JSON 值。`);
  }

  checkFiniteNumber(schema, 'minimum', path, problems);
  checkFiniteNumber(schema, 'maximum', path, problems);
  checkNonNegativeInteger(schema, 'minLength', path, problems);
  checkNonNegativeInteger(schema, 'maxLength', path, problems);
  checkNonNegativeInteger(schema, 'minItems', path, problems);
  checkNonNegativeInteger(schema, 'maxItems', path, problems);

  if (schema.title !== undefined && typeof schema.title !== 'string') {
    problems.push(`${path}.title 必须是字符串。`);
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    problems.push(`${path}.description 必须是字符串。`);
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') {
      problems.push(`${path}.pattern 必须是字符串。`);
    } else if (schema.pattern.length > MAX_PATTERN_LENGTH) {
      problems.push(`${path}.pattern 超过 ${MAX_PATTERN_LENGTH} 字符。`);
    } else {
      try {
        new RegExp(schema.pattern, 'u');
      } catch {
        problems.push(`${path}.pattern 不是合法正则表达式。`);
      }
    }
  }
}

function checkFiniteNumber(
  schema: JsonObject,
  key: 'minimum' | 'maximum',
  path: string,
  problems: string[],
): void {
  const value = schema[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${path}.${key} 必须是有限数字。`);
  }
}

function checkNonNegativeInteger(
  schema: JsonObject,
  key: 'minLength' | 'maxLength' | 'minItems' | 'maxItems',
  path: string,
  problems: string[],
): void {
  const value = schema[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${path}.${key} 必须是非负整数。`);
  }
}

/**
 * 校验一个 JSON 值，返回最多 maxIssues 条问题。schema 本身非法时应先用
 * collectToolParametersSchemaProblems 拦截，不要让非法 schema 进入校验路径。
 */
export function validateJsonValue(
  schema: JsonSchema,
  value: unknown,
  options: { path?: string; maxIssues?: number } = {},
): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  const maxIssues = Math.max(1, options.maxIssues ?? DEFAULT_MAX_ISSUES);
  walkValue(schema, value, options.path ?? '$', issues, maxIssues, 0);
  return issues;
}

function walkValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: JsonSchemaIssue[],
  maxIssues: number,
  depth: number,
): void {
  if (issues.length >= maxIssues) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    pushIssue(issues, maxIssues, { path, message: '数据嵌套过深，无法校验。' });
    return;
  }

  if (!matchesDeclaredType(schema.type, value)) {
    pushIssue(issues, maxIssues, {
      path,
      message: `期望 ${describeExpectedType(schema.type)}，实际是 ${describeValueType(value)}。`,
    });
    return;
  }

  if (schema.const !== undefined && !jsonEquals(schema.const, value)) {
    pushIssue(issues, maxIssues, {
      path,
      message: `取值必须是 ${previewJson(schema.const)}。`,
    });
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => jsonEquals(item, value))) {
    pushIssue(issues, maxIssues, {
      path,
      message: `取值必须是 ${previewJson(schema.enum)} 之一。`,
    });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      pushIssue(issues, maxIssues, {
        path,
        message: `不能小于 ${schema.minimum}。`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      pushIssue(issues, maxIssues, {
        path,
        message: `不能大于 ${schema.maximum}。`,
      });
    }
    return;
  }

  if (typeof value === 'string') {
    const length = countCharacters(value);
    if (schema.minLength !== undefined && length < schema.minLength) {
      pushIssue(issues, maxIssues, {
        path,
        message: `长度不能少于 ${schema.minLength} 个字符。`,
      });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      pushIssue(issues, maxIssues, {
        path,
        message: `长度不能超过 ${schema.maxLength} 个字符。`,
      });
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) {
          pushIssue(issues, maxIssues, {
            path,
            message: '格式不符合要求。',
          });
        }
      } catch {
        pushIssue(issues, maxIssues, {
          path,
          message: '参数契约中的 pattern 非法。',
        });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      pushIssue(issues, maxIssues, {
        path,
        message: `至少需要 ${schema.minItems} 项。`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      pushIssue(issues, maxIssues, {
        path,
        message: `最多允许 ${schema.maxItems} 项。`,
      });
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        if (issues.length >= maxIssues) return;
        walkValue(schema.items, value[index], `${path}[${index}]`, issues, maxIssues, depth + 1);
      }
    }
    return;
  }

  if (isJsonObject(value)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!hasOwn(value, key)) {
        pushIssue(issues, maxIssues, {
          path: `${path}.${key}`,
          message: '必填字段缺失。',
        });
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (issues.length >= maxIssues) return;
      if (!hasOwn(value, key)) continue;
      walkValue(childSchema, value[key], `${path}.${key}`, issues, maxIssues, depth + 1);
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (hasOwn(properties, key)) continue;
        pushIssue(issues, maxIssues, {
          path: `${path}.${key}`,
          message: '不允许的字段。',
        });
      }
    } else if (isJsonObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (hasOwn(properties, key)) continue;
        if (issues.length >= maxIssues) return;
        walkValue(
          schema.additionalProperties as JsonSchema,
          value[key],
          `${path}.${key}`,
          issues,
          maxIssues,
          depth + 1,
        );
      }
    }
  }
}

function matchesDeclaredType(
  declared: JsonSchemaType | readonly JsonSchemaType[] | undefined,
  value: unknown,
): boolean {
  if (declared === undefined) return true;
  return declaredTypeList(declared).some((type) => matchesType(type, value));
}

function declaredTypeList(
  declared: JsonSchemaType | readonly JsonSchemaType[],
): readonly JsonSchemaType[] {
  return typeof declared === 'string' ? [declared] : declared;
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describeExpectedType(
  declared: JsonSchemaType | readonly JsonSchemaType[] | undefined,
): string {
  if (declared === undefined) return '任意 JSON 值';
  return declaredTypeList(declared)
    .map((type) => TYPE_LABELS[type] ?? String(type))
    .join(' 或 ');
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  switch (typeof value) {
    case 'string':
      return '字符串';
    case 'number':
      return Number.isInteger(value) ? '整数' : '数字';
    case 'boolean':
      return '布尔值';
    case 'object':
      return '对象';
    case 'undefined':
      return 'undefined';
    default:
      return typeof value;
  }
}

const TYPE_LABELS: Readonly<Record<JsonSchemaType, string>> = {
  object: '对象',
  array: '数组',
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  null: 'null',
};

function pushIssue(
  issues: JsonSchemaIssue[],
  maxIssues: number,
  issue: JsonSchemaIssue,
): void {
  if (issues.length >= maxIssues) return;
  issues.push(issue);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function previewJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return String(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return String(value);
  }
}

export function jsonEquals(left: JsonValue, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => hasOwn(right, key) && jsonEquals(left[key] as JsonValue, right[key]),
    );
  }
  return false;
}
