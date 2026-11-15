import { describe, expect, it } from 'vitest';
import {
  collectJsonSchemaProblems,
  collectToolParametersSchemaProblems,
  jsonEquals,
  validateJsonValue,
  type JsonSchema,
} from '../src/agent/runtime/json-schema';

const DISH_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 4 },
    priceCents: { type: ['integer', 'null'], minimum: 1, maximum: 999_999 },
  },
  required: ['name'],
};

describe('JSON Schema 子集：配置检查', () => {
  it('接受受支持的关键字组合', () => {
    expect(collectJsonSchemaProblems(DISH_SCHEMA)).toEqual([]);
    expect(collectToolParametersSchemaProblems(DISH_SCHEMA)).toEqual([]);
  });

  it('拒绝 $ref 等未支持的关键字，而不是静默忽略', () => {
    const problems = collectJsonSchemaProblems({
      type: 'object',
      properties: { name: { $ref: '#/definitions/name' } },
    });
    expect(problems.join('\n')).toContain('$ref');
    expect(problems.join('\n')).toContain('不是受支持的 JSON Schema 关键字');
  });

  it('工具参数根 schema 必须是 object', () => {
    const problems = collectToolParametersSchemaProblems({ type: 'string' });
    expect(problems).toContain('$.parameters.type 必须是 "object"。');
  });

  it('required 必须已在 properties 中声明', () => {
    const problems = collectToolParametersSchemaProblems({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name', 'ghost'],
    });
    expect(problems.join('\n')).toContain('"ghost"');
    expect(problems.join('\n')).toContain('未在 properties 中声明');
  });
});

describe('JSON Schema 子集：值校验', () => {
  it('合法对象返回空问题列表', () => {
    expect(validateJsonValue(DISH_SCHEMA, { name: '鱼香肉丝', priceCents: 2800 })).toEqual([]);
    expect(validateJsonValue(DISH_SCHEMA, { name: '鱼香肉丝', priceCents: null })).toEqual([]);
  });

  it('必填字段缺失时给出稳定路径', () => {
    const issues = validateJsonValue(DISH_SCHEMA, { priceCents: 2800 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('$.name');
    expect(issues[0]?.message).toBe('必填字段缺失。');
  });

  it('additionalProperties: false 会拒绝未知字段', () => {
    const issues = validateJsonValue(DISH_SCHEMA, { name: '鱼香肉丝', extra: true });
    expect(issues.some((issue) => issue.path === '$.extra')).toBe(true);
    expect(issues.find((issue) => issue.path === '$.extra')?.message).toBe('不允许的字段。');
  });

  it('嵌套数组使用 [i] 路径，便于模型定位并修正参数', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        dishes: { type: 'array', minItems: 1, maxItems: 5, items: DISH_SCHEMA },
      },
      required: ['dishes'],
    };

    const issues = validateJsonValue(schema, { dishes: [{ name: '鱼', priceCents: 100 }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('$.dishes[0].name');
    expect(issues[0]?.message).toContain('长度不能少于 2 个字符');
  });

  it('type 数组允许 integer 或 null，但拒绝小数', () => {
    const nullIssues = validateJsonValue(DISH_SCHEMA, { name: '鱼香肉丝', priceCents: null });
    expect(nullIssues).toEqual([]);

    const decimalIssues = validateJsonValue(DISH_SCHEMA, {
      name: '鱼香肉丝',
      priceCents: 12.5,
    });
    expect(decimalIssues).toHaveLength(1);
    expect(decimalIssues[0]?.path).toBe('$.priceCents');
    expect(decimalIssues[0]?.message).toContain('期望 整数 或 null');
    expect(decimalIssues[0]?.message).toContain('实际是 数字');
  });

  it('数字上限与数组长度上限都会生效', () => {
    const issues = validateJsonValue(DISH_SCHEMA, {
      name: '鱼香肉丝',
      priceCents: 1_000_000,
    });
    expect(issues[0]?.message).toContain('不能大于 999999');

    const arrayIssues = validateJsonValue(
      {
        type: 'array',
        maxItems: 2,
        items: { type: 'integer' },
      },
      [1, 2, 3],
    );
    expect(arrayIssues[0]?.path).toBe('$');
    expect(arrayIssues[0]?.message).toBe('最多允许 2 项。');
  });

  it('jsonEquals 忽略对象键顺序', () => {
    expect(jsonEquals({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
  });
});
