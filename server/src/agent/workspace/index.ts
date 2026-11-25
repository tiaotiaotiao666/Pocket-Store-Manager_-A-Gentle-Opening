export { WorkspaceAgentModule } from './workspace-agent.module';
export { WorkspaceAgentController } from './workspace-agent.controller';
export { WorkspaceAgentService, parseWorkspaceRequest } from './workspace-agent.service';
export { loadWorkspaceAgentContract, resetWorkspaceAgentContractForTests } from './workspace-agent.contract';
export { createWorkspaceTools, createWorkspaceToolRegistry } from './workspace-agent.tools';
export { UnavailableWorkspaceRpcProxy } from './workspace-agent.rpc';
export { MockWorkspaceChatModel, MockWorkspaceRpcProxy } from './workspace-agent.mock';
export * from './workspace-agent.types';
