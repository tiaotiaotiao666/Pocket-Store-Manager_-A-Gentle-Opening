import { Module } from '@nestjs/common';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AGENT_FETCH, AGENT_PROVIDER } from './agent.types';
import type { AgentFetch } from './provider/agent-provider.interface';
import { DeepseekAgentProvider } from './provider/deepseek-agent.provider';

/** 默认 fetch：真实运行走 Node 全局 fetch；测试通过 AGENT_FETCH 注入 stub。 */
const defaultAgentFetch: AgentFetch = (input, init) => fetch(input, init);

@Module({
  controllers: [AgentController],
  providers: [
    AgentService,
    DeepseekAgentProvider,
    SessionAuthGuard,
    AgentAuthGuard,
    { provide: AGENT_PROVIDER, useExisting: DeepseekAgentProvider },
    { provide: AGENT_FETCH, useValue: defaultAgentFetch },
  ],
  exports: [AgentService, DeepseekAgentProvider],
})
export class AgentModule {}