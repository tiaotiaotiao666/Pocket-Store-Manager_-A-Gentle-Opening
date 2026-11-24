/**
 * RPC 代理接口的默认实现：HTTP 服务端没有桌面代理时确定性失败。
 *
 * 服务端永远不读本机磁盘；所有项目文件读写/检查/验证都必须经注入代理。
 */

import type {
  WorkspaceRpcCallContext,
  WorkspaceRpcProxy,
  WorkspaceRpcResult,
} from './workspace-agent.types';

export class UnavailableWorkspaceRpcProxy implements WorkspaceRpcProxy {
  async invoke(
    _command: string,
    _payload: Record<string, unknown>,
    _context: WorkspaceRpcCallContext,
  ): Promise<WorkspaceRpcResult> {
    return {
      ok: false,
      code: 'WORKSPACE_RPC_UNAVAILABLE',
      message: '桌面工作区代理未连接，当前只能生成计划或说明。',
    };
  }
}

export function isWorkspaceRpcProxy(value: unknown): value is WorkspaceRpcProxy {
  return Boolean(value) && typeof value === 'object' && typeof (value as WorkspaceRpcProxy).invoke === 'function';
}
