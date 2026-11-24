import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard';
import { PrismaModule } from '../../database/prisma.module';
import { AGENT_CHAT_MODEL } from '../agent.types';
import { AgentAuthGuard } from '../agent-auth.guard';
import { DeepseekChatModel, readDeepseekChatSettings } from '../runtime';
import { WORKSPACE_AGENT_RPC_PROXY } from './workspace-agent.types';
import { WorkspaceAgentController } from './workspace-agent.controller';
import { WorkspaceAgentService } from './workspace-agent.service';
import { UnavailableWorkspaceRpcProxy } from './workspace-agent.rpc';

/**
 * Workspace Agent 服务模块。
 *
 * 当前 HTTP 进程没有桌面 RPC 桥，因此默认代理确定性返回 WORKSPACE_RPC_UNAVAILABLE；
 * 桌面 direct 通道/D2 接入时用 `{ provide: WORKSPACE_AGENT_RPC_PROXY, useValue: proxy }`
 * 覆盖即可。真实模型仍走既有 DeepseekChatModel + DEEPSEEK_* 配置（不是第二套 wire/loop）。
 *
 * 注：把本模块挂到 Nest 应用根图需要一行 import；该行由 Captain 在边界外统一接线。
 */
@Module({
  imports: [PrismaModule],
  controllers: [WorkspaceAgentController],
  providers: [
    WorkspaceAgentService,
    SessionAuthGuard,
    AgentAuthGuard,
    {
      provide: AGENT_CHAT_MODEL,
      useFactory: (config: ConfigService) =>
        new DeepseekChatModel({
          fetch: (input, init) => fetch(input, init),
          settings: () => readDeepseekChatSettings((key) => config.get(key)),
        }),
      inject: [ConfigService],
    },
    { provide: WORKSPACE_AGENT_RPC_PROXY, useClass: UnavailableWorkspaceRpcProxy },
  ],
  exports: [WorkspaceAgentService],
})
export class WorkspaceAgentModule {}
