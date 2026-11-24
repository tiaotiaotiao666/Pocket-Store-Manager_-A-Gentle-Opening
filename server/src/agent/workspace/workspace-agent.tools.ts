/**
 * workspace-agent.v1 工具集：全部执行经注入的 RPC 代理，服务端不读本机磁盘。
 *
 * 工具名、RPC 命令、参数 schema、sideEffect 全部来自契约 JSON；
 * 本文件只做「AgentTool 定义 → 代理调用」的桥接，不复制工具清单。
 */

import { AgentToolError, defineTool, ToolRegistry } from '../runtime';
import type { AgentTool, JsonObject, JsonValue } from '../runtime';
import type { WorkspaceAgentContract, WorkspaceOperation, WorkspaceRpcProxy } from './workspace-agent.types';

function metadataString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : '工作区代理调用失败。';
  return Array.from(text).slice(0, 180).join('');
}

export function createWorkspaceTools(proxy: WorkspaceRpcProxy, contract: WorkspaceAgentContract): AgentTool[] {
  return contract.tools.map((tool) => defineTool<JsonObject>({
    name: tool.name,
    title: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sideEffect: tool.sideEffect,
    ...(tool.sideEffect === 'write' ? { concurrencySafe: false } : { concurrencySafe: true }),
    timeoutMs: contract.limits.toolTimeoutMs,
    execute: async (args, context) => {
      const result = await proxy.invoke(tool.rpc, args, {
        projectId: metadataString(context.metadata.projectId),
        runId: context.runId,
        turnId: metadataString(context.metadata.turnId) || null,
        operation: metadataString(context.metadata.operation) as WorkspaceOperation,
        signal: context.signal,
        timeoutMs: contract.limits.toolTimeoutMs,
      });
      if (result.ok !== true) {
        const code = typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(result.code)
          ? result.code
          : 'WORKSPACE_RPC_FAILED';
        throw new AgentToolError(code, safeMessage(result.message), { retryable: false });
      }
      return (result.data === undefined ? null : result.data) as JsonValue;
    },
  }));
}

export function createWorkspaceToolRegistry(proxy: WorkspaceRpcProxy, contract: WorkspaceAgentContract): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(createWorkspaceTools(proxy, contract));
  return registry;
}
