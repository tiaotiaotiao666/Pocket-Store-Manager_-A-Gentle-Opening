import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard';
import { PrismaModule } from '../../database/prisma.module';
import { AGENT_CHAT_MODEL } from '../agent.types';
import { AgentAuthGuard } from '../agent-auth.guard';
import {
  AgentEntryQueue,
  AgentEntryQueueInterceptor,
  createScheduledFetch,
  ensureUpstreamFetchGuard,
  getSharedModelCallScheduler,
  readAgentEntryQueueOptions,
  type ModelCallScheduler,
} from '../model-scheduler';
import { DeepseekChatModel, readDeepseekChatSettings } from '../runtime';
import { WORKSPACE_AGENT_RPC_PROXY } from './workspace-agent.types';
import { WorkspaceAgentController } from './workspace-agent.controller';
import { WorkspaceAgentService } from './workspace-agent.service';
import { UnavailableWorkspaceRpcProxy } from './workspace-agent.rpc';

/**
 * 用当前 ConfigService 里的 MODEL_* 值初始化进程级共享调度器。
 *
 * 只读 `MODEL_MAX_CONCURRENT` / `MODEL_QUEUE_WAIT_MS`（+兼容别名）/ `MODEL_UPSTREAM_TOKEN_DIR`，
 * **不读** `AGENT_MAX_CONCURRENT`，也不读任何 Key。
 */
function sharedModelSchedulerFromConfig(config: ConfigService): ModelCallScheduler {
  const read = (key: string): string | undefined => {
    const raw = config.get(key);
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    return text ? text : undefined;
  };
  const scheduler = getSharedModelCallScheduler({
    env: {
      MODEL_MAX_CONCURRENT: read('MODEL_MAX_CONCURRENT'),
      MODEL_QUEUE_WAIT_MS: read('MODEL_QUEUE_WAIT_MS'),
      MODEL_QUEUE_TIMEOUT_MS: read('MODEL_QUEUE_TIMEOUT_MS'),
      MODEL_UPSTREAM_TOKEN_DIR: read('MODEL_UPSTREAM_TOKEN_DIR'),
    },
  });
  // 进程级兜底：把未显式接线的 `/chat/completions` 全局 fetch 也收进同一个调度器。
  ensureUpstreamFetchGuard(scheduler);
  return scheduler;
}

/**
 * Workspace Agent 服务模块。
 *
 * 当前 HTTP 进程没有桌面 RPC 桥，因此默认代理确定性返回 WORKSPACE_RPC_UNAVAILABLE；
 * 桌面 direct 通道/D2 接入时用 `{ provide: WORKSPACE_AGENT_RPC_PROXY, useValue: proxy }`
 * 覆盖即可。真实模型仍走既有 DeepseekChatModel + DEEPSEEK_* 配置（不是第二套 wire/loop）。
 *
 * 上游并发（E0-R1b / X12）：
 * - 模型请求经 `createScheduledFetch(...)` 注入，任何 `/chat/completions` 都过统一调度器
 *   （进程内 3 槽 + 跨进程全局令牌），HTTP 与 direct 不各算一套；
 * - 引导期（`APP_INTERCEPTOR` 工厂）就初始化调度器并装好进程级 fetch 兜底，
 *   令牌目录不可用的警告会打在启动日志里，而不是等到第一次模型请求。
 *
 * 入口保护（`AGENT_MAX_CONCURRENT`，默认 3）：
 * - 本模块注册入口排队闸门拦截器；超限先排队，排队预算耗尽才 429 `AGENT_BUSY`；
 * - 它不参与上游并发计算，也不替代 ModelCallScheduler。
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
      useFactory: (config: ConfigService) => {
        const scheduler = sharedModelSchedulerFromConfig(config);
        return new DeepseekChatModel({
          // 单一出口：fetch 注入点再包一层调度器（已在槽位内时自动透传，不会二次排队）。
          fetch: createScheduledFetch(
            (input: string, init?: RequestInit) => fetch(input, init),
            scheduler,
            'workspace-agent',
          ),
          settings: () => readDeepseekChatSettings((key) => config.get(key)),
          scheduler,
        });
      },
      inject: [ConfigService],
    },
    { provide: WORKSPACE_AGENT_RPC_PROXY, useClass: UnavailableWorkspaceRpcProxy },
    {
      provide: AgentEntryQueue,
      useFactory: (config: ConfigService) => {
        // 引导期初始化上游调度器 + 进程级兜底（早于第一个请求）。
        sharedModelSchedulerFromConfig(config);
        return new AgentEntryQueue(readAgentEntryQueueOptions(config));
      },
      inject: [ConfigService],
    },
    // 入口排队闸门：自己也是一个可解析的 provider（便于自检/测试），再挂到 APP_INTERCEPTOR 上。
    AgentEntryQueueInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: AgentEntryQueueInterceptor },
  ],
  exports: [WorkspaceAgentService, AgentEntryQueue],
})
export class WorkspaceAgentModule {}
