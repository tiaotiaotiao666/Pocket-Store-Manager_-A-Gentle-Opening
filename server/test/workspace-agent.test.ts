import { HttpException, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { AgentModule } from '../src/agent/agent.module';
import { PrismaService } from '../src/database/prisma.service';
import { createWorkspaceTools, loadWorkspaceAgentContract, parseWorkspaceRequest, WorkspaceAgentController, WorkspaceAgentModule, WorkspaceAgentService } from '../src/agent/workspace';
import type {
  WorkspaceRpcCallContext,
  WorkspaceRpcProxy,
  WorkspaceRpcResult,
} from '../src/agent/workspace';
import type { ChatCompletionResult, ChatModel } from '../src/agent/runtime';

function completion(message: ChatCompletionResult['message'], finishReason = 'stop'): ChatCompletionResult {
  return {
    message,
    finishReason,
    model: 'fake-model',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    truncated: false,
  };
}

class ScriptedModel implements ChatModel {
  readonly name = 'fake-model';
  private index = 0;
  constructor(private readonly script: ChatCompletionResult[]) {}
  async complete(): Promise<ChatCompletionResult> {
    const next = this.script[this.index];
    this.index += 1;
    return next ?? completion({ role: 'assistant', content: 'done' });
  }
}

class FakeProxy implements WorkspaceRpcProxy {
  calls: Array<{ command: string; payload: Record<string, unknown>; context: WorkspaceRpcCallContext }> = [];
  constructor(private readonly handler: (command: string) => WorkspaceRpcResult = () => ({ ok: true, data: { ok: true } })) {}
  async invoke(command: string, payload: Record<string, unknown>, context: WorkspaceRpcCallContext): Promise<WorkspaceRpcResult> {
    this.calls.push({ command, payload, context });
    return this.handler(command);
  }
}

function serviceWith(model: ChatModel | null = null, proxy: WorkspaceRpcProxy | null = null): WorkspaceAgentService {
  return new WorkspaceAgentService(model, proxy);
}

async function expectHttpError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected HttpException');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).getResponse()).toMatchObject({ code });
  }
}

const READ_REQUEST = {
  contractVersion: 'workspace-agent.v1',
  projectId: 'project-1',
  runId: 'run-1',
  turnId: 'turn-1',
  operation: 'plan' as const,
  utterance: '看看菜单页现在有哪些文件',
  mock: true,
};

describe('workspace-agent.v1 契约', () => {
  it('从单一 JSON 契约加载 operations/tools/limits/错误码', () => {
    const contract = loadWorkspaceAgentContract();
    expect(contract.contractVersion).toBe('workspace-agent.v1');
    expect(contract.operations).toEqual(['plan', 'edit', 'repair', 'explain']);
    expect(contract.tools.map((tool) => tool.name)).toContain('get_context');
    expect(contract.tools.map((tool) => tool.name)).toContain('submit_candidate');
    expect(new Set(contract.tools.map((tool) => tool.rpc)).size).toBe(contract.tools.length);
    expect(contract.operationTools.plan).toEqual(['get_context', 'list_files', 'search_files', 'read_file', 'get_diff']);
    expect(contract.limits.maxImages).toBe(3);
    expect(contract.errorCodes).toContain('WORKSPACE_RPC_UNAVAILABLE');
    expect(contract.response.forbiddenKeys).toEqual(['applied', 'adopted', 'exported', 'verified']);
  });

  it('工具注册表：写工具串行、读工具可并行、超时来自契约', () => {
    const contract = loadWorkspaceAgentContract();
    const tools = createWorkspaceTools(new FakeProxy(), contract);
    const write = tools.find((tool) => tool.name === 'write_files');
    const read = tools.find((tool) => tool.name === 'read_file');
    expect(write?.sideEffect).toBe('write');
    expect(write?.concurrencySafe).toBe(false);
    expect(read?.sideEffect).toBe('read');
    expect(read?.concurrencySafe).toBe(true);
    expect(tools.every((tool) => tool.timeoutMs === contract.limits.toolTimeoutMs)).toBe(true);
    expect(tools.length).toBe(contract.tools.length);
  });

  it('请求校验：未知键 / 合约版本 / operation / utterance / 图片 / toolResults / 体积', async () => {
    const service = serviceWith();
    await expectHttpError(service.run({ ...READ_REQUEST, unknown: true }, { requestId: 'r1' }), 400, 'WORKSPACE_REQUEST_INVALID');
    await expectHttpError(service.run({ ...READ_REQUEST, contractVersion: 'x' }, { requestId: 'r2' }), 400, 'WORKSPACE_CONTRACT_MISMATCH');
    await expectHttpError(service.run({ ...READ_REQUEST, operation: 'delete' }, { requestId: 'r3' }), 400, 'WORKSPACE_OPERATION_UNSUPPORTED');
    await expectHttpError(service.run({ ...READ_REQUEST, utterance: '' }, { requestId: 'r4' }), 400, 'WORKSPACE_REQUEST_INVALID');
    await expectHttpError(service.run({ ...READ_REQUEST, utterance: 'x'.repeat(2001) }, { requestId: 'r5' }), 400, 'WORKSPACE_REQUEST_INVALID');
    await expectHttpError(service.run({ ...READ_REQUEST, images: Array.from({ length: 4 }, (_, i) => ({ assetId: 'asset-' + i })) }, { requestId: 'r6' }), 400, 'WORKSPACE_IMAGE_LIMIT');
    await expectHttpError(service.run({ ...READ_REQUEST, images: [{ assetId: 'https://evil.example/x.png' }] }, { requestId: 'r7' }), 400, 'WORKSPACE_REQUEST_INVALID');
    await expectHttpError(service.run({
      ...READ_REQUEST,
      toolResults: Array.from({ length: 9 }, (_, i) => ({ callId: 'c' + i, name: 'read_file', ok: true })),
    }, { requestId: 'r8' }), 400, 'WORKSPACE_TOOL_RESULT_LIMIT');
    await expectHttpError(service.run({
      ...READ_REQUEST,
      toolResults: [{ callId: 'c1', name: 'read_file', ok: true, dataRef: 'x'.repeat(3000) }],
    }, { requestId: 'r9' }), 400, 'WORKSPACE_TOOL_RESULT_LIMIT');
    await expectHttpError(service.run({ ...READ_REQUEST, pad: 'x'.repeat(300000) }, { requestId: 'r10' }), 413, 'WORKSPACE_BODY_TOO_LARGE');
    await expectHttpError(service.run({ ...READ_REQUEST, mock: 'yes' }, { requestId: 'r11' }), 400, 'WORKSPACE_REQUEST_INVALID');
  });

  it('mock:true 显式离线 plan：真实 runtime 工具循环 + mock 代理，不访问桌面', async () => {
    const service = serviceWith(null, null);
    const response = await service.run(READ_REQUEST, { requestId: 'req-mock-plan' });
    const contract = loadWorkspaceAgentContract();
    expect(response.meta.mock).toBe(true);
    expect(response.operation).toBe('plan');
    expect(response.trace.modelCalls).toBe(6);
    expect(response.trace.toolCalls.map((tool) => tool.name)).toEqual(contract.operationTools.plan);
    expect(response.stopReason).toBe('final_answer');
    expect(response.trace.degraded).toBe(false);
    expect(response.plan.steps.length).toBe(contract.operationTools.plan.length);
    for (const key of Object.keys(response)) expect(contract.response.allowedKeys).toContain(key);
    for (const key of contract.response.forbiddenKeys) expect(JSON.stringify(response)).not.toContain('"' + key + '"');
    expect(response.reply).toContain('Mock');
  });

  it('mock:true edit 覆盖 read→write→check→submit_candidate 形状，且不出现 adopted/exported/verified', async () => {
    const service = serviceWith();
    const response = await service.run({ ...READ_REQUEST, operation: 'edit' }, { requestId: 'req-mock-edit' });
    expect(response.trace.toolCalls.map((tool) => tool.name)).toEqual(loadWorkspaceAgentContract().operationTools.edit);
    expect(response.trace.toolCalls.find((tool) => tool.name === 'write_files')?.ok).toBe(true);
    expect(response.trace.toolCalls.find((tool) => tool.name === 'submit_candidate')?.ok).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/"adopted"|"exported"|"verified"|"applied"/);
    expect(response.reply).not.toMatch(/已应用|已采用|已导出|已验证/);
  });
});

describe('真实路径（注入 fake ChatModel + fake RPC proxy，不访问网络/磁盘）', () => {
  it('工具执行只经 RPC 代理，trace 只含元数据', async () => {
    const model = new ScriptedModel([
      completion({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'get_context', argumentsText: '{}' }],
      }, 'tool_calls'),
      completion({ role: 'assistant', content: '已读取项目上下文，请确认。' }),
    ]);
    const proxy = new FakeProxy(() => ({ ok: true, data: { currentVersionId: 'v1', targetPages: [{ id: 'menu', enabled: true }] } }));
    const response = await serviceWith(model, proxy).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-real' });
    expect(response.meta.mock).toBe(false);
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0].command).toBe('agent:get-context');
    expect(proxy.calls[0].context.projectId).toBe('project-1');
    expect(proxy.calls[0].context.operation).toBe('plan');
    expect(response.trace.toolCalls).toEqual([{ name: 'get_context', ok: true, latencyMs: expect.any(Number), attempts: 1, bytes: expect.any(Number), truncated: false }]);
    expect(response.plan.steps).toEqual([{ name: 'get_context', status: 'done' }]);
    expect(response.trace.modelCalls).toBe(2);
  });

  it('未注入代理时工具确定性失败，不伪造读盘结果', async () => {
    const model = new ScriptedModel([
      completion({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', argumentsText: '{"path":"pages/menu/index.wxml"}' }],
      }, 'tool_calls'),
      completion({ role: 'assistant', content: '当前没有连接桌面工作区。' }),
    ]);
    const response = await serviceWith(model, null).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-no-proxy' });
    expect(response.trace.toolCalls[0]).toMatchObject({ name: 'read_file', ok: false });
    expect(response.trace.degraded).toBe(true);
  });

  it('结果截断：代理返回超限内容时 trace.truncated=true', async () => {
    const model = new ScriptedModel([
      completion({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', argumentsText: '{"path":"a"}' }],
      }, 'tool_calls'),
      completion({ role: 'assistant', content: '读取完成。' }),
    ]);
    const proxy = new FakeProxy(() => ({ ok: true, data: { content: 'x'.repeat(40000) } }));
    const response = await serviceWith(model, proxy).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-truncate' });
    expect(response.trace.toolCalls[0].truncated).toBe(true);
  });

  it('重复调用触发 runtime loop_detected；取消返回 AGENT_ABORTED', async () => {
    const repeated = completion({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'get_context', argumentsText: '{}' }],
    }, 'tool_calls');
    const loopModel = new ScriptedModel([repeated, repeated, repeated, repeated]);
    const loopResponse = await serviceWith(loopModel, new FakeProxy()).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-loop' });
    expect(loopResponse.stopReason).toBe('loop_detected');
    expect(loopResponse.trace.degraded).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expectHttpError(
      serviceWith(new ScriptedModel([]), new FakeProxy()).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-abort', signal: controller.signal }),
      408,
      'AGENT_ABORTED',
    );
  });

  it('回复脱敏：不声称 applied/adopted/exported/verified，不泄漏本机绝对路径', async () => {
    const model = new ScriptedModel([
      completion({ role: 'assistant', content: '已采用并导出到 E:\\tmp\\secret\\index.wxml，已验证通过。' }),
    ]);
    const response = await serviceWith(model, new FakeProxy()).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-sanitize' });
    expect(response.reply).not.toMatch(/已采用|已导出|已验证/);
    expect(response.reply).not.toContain('E:\\tmp');
    expect(response.reply).toContain('待本地确认');
  });

  it('真实模型缺失时返回 503，不伪造真实调用', async () => {
    await expectHttpError(serviceWith(null, new FakeProxy()).run({ ...READ_REQUEST, mock: false }, { requestId: 'req-no-model' }), 503, 'DEEPSEEK_NOT_CONFIGURED');
  });
});

describe('controller 与路由边界', () => {
  it('AgentModule imports 元数据包含 WorkspaceAgentModule（不是只在测试里手搓 controller）', () => {
    const imports = Reflect.getMetadata('imports', AgentModule) as unknown[] | undefined;
    expect(Array.isArray(imports)).toBe(true);
    expect(imports).toContain(WorkspaceAgentModule);
    const controllers = Reflect.getMetadata('controllers', WorkspaceAgentModule) as unknown[] | undefined;
    expect(controllers).toContain(WorkspaceAgentController);
  });

  it('Nest module 图可自动构造 WorkspaceAgentController', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), WorkspaceAgentModule],
    }).compile();
    try {
      const controller = moduleRef.get(WorkspaceAgentController);
      const service = moduleRef.get(WorkspaceAgentService);
      expect(controller).toBeInstanceOf(WorkspaceAgentController);
      expect(service).toBeInstanceOf(WorkspaceAgentService);
    } finally {
      await moduleRef.close();
    }
  });

  it('Nest 路由元数据为 POST /agent/workspace（全局前缀 api/v1）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkspaceAgentController)).toBe('agent');
    expect(Reflect.getMetadata(PATH_METADATA, WorkspaceAgentController.prototype.run)).toBe('workspace');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkspaceAgentController.prototype.run)).toBe(RequestMethod.POST);
  });

  it('真实 HTTP 边界：POST /api/v1/agent/workspace（全局前缀 + mock 200）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        WorkspaceAgentModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const app: INestApplication = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/agent/workspace')
        .send({ ...READ_REQUEST, mock: true });
      expect(response.status).toBe(200);
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.body.contractVersion).toBe('workspace-agent.v1');
      expect(response.body.meta.mock).toBe(true);
      expect(response.body.trace.toolCalls.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(response.body);
      for (const key of loadWorkspaceAgentContract().response.forbiddenKeys) {
        expect(serialized).not.toContain('"' + key + '"');
      }

      const invalid = await request(app.getHttpServer())
        .post('/api/v1/agent/workspace')
        .send({ ...READ_REQUEST, unknown: true });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ code: 'WORKSPACE_REQUEST_INVALID' });
      expect(invalid.body.requestId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('controller 回写 X-Request-Id 并返回安全响应', async () => {
    const service = serviceWith();
    const controller = new WorkspaceAgentController(service);
    const response = {
      headers: {} as Record<string, string>,
      writableEnded: false,
      setHeader(name: string, value: string) { this.headers[name] = value; },
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const request = { headers: {}, requestId: undefined as string | undefined };
    const result = await controller.run({ ...READ_REQUEST, mock: true }, request as never, response as never);
    expect(response.headers['X-Request-Id']).toBeTruthy();
    expect(result.contractVersion).toBe('workspace-agent.v1');
    expect(result.meta.mock).toBe(true);
  });
});
