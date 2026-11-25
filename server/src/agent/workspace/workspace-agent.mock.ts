/**
 * mock 模式：显式 `mock:true` 时使用的确定性离线模型与 RPC 代理。
 *
 * - 不访问网络/文件系统；只模拟 plan → read → write → check → submit 的形状；
 * - 响应 meta.mock=true；绝不声明 adopted/exported/verified；
 * - 真实模式不会使用本文件。
 */

import type { ChatCompletionResult, ChatModel, ChatToolCall } from '../runtime';
import type {
  WorkspaceAgentContract,
  WorkspaceOperation,
  WorkspaceRpcCallContext,
  WorkspaceRpcProxy,
  WorkspaceRpcResult,
} from './workspace-agent.types';

function toolCall(index: number, name: string, args: Record<string, unknown>): ChatToolCall {
  return { id: 'call_mock_' + index, name, argumentsText: JSON.stringify(args) };
}

function argsForTool(name: string): Record<string, unknown> {
  switch (name) {
    case 'get_context':
      return {};
    case 'list_files':
      return { maxResults: 20 };
    case 'search_files':
      return { query: 'menu', mode: 'name', maxResults: 10 };
    case 'read_file':
      return { path: 'pages/menu/index.wxml' };
    case 'get_diff':
      return { comparedTo: 'v1' };
    case 'write_files':
      return { baseVersionId: 'v1', changes: [{ path: 'pages/menu/index.wxss', content: '/* mock */' }] };
    case 'delete_files':
      return { baseVersionId: 'v1', paths: [{ path: 'pages/menu/old.wxml' }] };
    case 'run_check':
      return { checkId: 'source.check' };
    case 'read_verification':
      return { source: 'attempt' };
    case 'verify_wechat':
      return { timeoutMs: 5000 };
    case 'submit_candidate':
      return { targetPage: 'menu', summary: 'mock candidate' };
    default:
      return {};
  }
}

export class MockWorkspaceChatModel implements ChatModel {
  readonly name = 'workspace-mock';

  private readonly sequence: string[];
  private step = 0;

  constructor(operation: WorkspaceOperation, contract: WorkspaceAgentContract) {
    this.sequence = contract.operationTools[operation] || [];
  }

  async complete(): Promise<ChatCompletionResult> {
    const index = this.step;
    this.step += 1;
    const base = { model: this.name, latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    if (index < this.sequence.length) {
      const name = this.sequence[index];
      return {
        ...base,
        message: { role: 'assistant', content: null, toolCalls: [toolCall(index + 1, name, argsForTool(name))] },
        finishReason: 'tool_calls',
        truncated: false,
      };
    }
    return {
      ...base,
      message: { role: 'assistant', content: 'Mock 模式：已完成离线模拟；状态以本地事实为准。', toolCalls: [] },
      finishReason: 'stop',
      truncated: false,
    };
  }
}

export class MockWorkspaceRpcProxy implements WorkspaceRpcProxy {
  async invoke(command: string, _payload: Record<string, unknown>, _context: WorkspaceRpcCallContext): Promise<WorkspaceRpcResult> {
    const data = mockData(command);
    return { ok: true, data };
  }
}

function mockData(command: string): Record<string, unknown> {
  switch (command) {
    case 'agent:get-context':
      return {
        projectId: 'mock-project',
        currentVersionId: 'v1',
        targetPages: [{ id: 'menu', enabled: true, reasons: ['mock'] }],
        checkIds: ['source.check', 'mini.check', 'composer.dry-run'],
      };
    case 'agent:list-files':
      return { files: [{ path: 'pages/menu/index.wxml', bytes: 42 }, { path: 'pages/menu/index.wxss', bytes: 24 }], truncated: false };
    case 'agent:read-file':
      return { path: 'pages/menu/index.wxml', content: '<view>mock</view>', bytes: 19, sha256: 'mock', totalBytes: 19, nextOffset: null };
    case 'agent:search-files':
      return { files: [{ path: 'pages/menu/index.wxml', line: 1, preview: 'mock' }], truncated: false };
    case 'agent:get-diff':
      return { files: [{ path: 'pages/menu/index.wxss', status: 'modified', additions: 1, deletions: 0, sha256: 'mock' }], truncated: false };
    case 'agent:write-files':
      return { transactionId: 'tx_mock', files: [{ path: 'pages/menu/index.wxss', status: 'modified', sha256: 'mock' }], revision: 2, treeDigest: 'mock' };
    case 'agent:delete-files':
      return { transactionId: 'tx_mock_delete', files: [{ path: 'pages/menu/old.wxml', status: 'deleted' }], revision: 2, treeDigest: 'mock' };
    case 'agent:run-check':
      return { checkId: 'source.check', status: 'PASS', durationMs: 1, issues: [] };
    case 'agent:read-verification':
      return { status: 'NOT_RUN', issues: [], screenshots: [] };
    case 'agent:verify-wechat':
      return { status: 'BLOCKED', pages: [], interactions: [], screenshots: [] };
    case 'agent:submit-candidate':
      return { candidateId: 'candidate_mock', revision: 3, treeDigest: 'mock', targetPage: 'menu', status: 'submitted' };
    default:
      return { status: 'NOT_RUN' };
  }
}
