import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveRequestId } from '../../common/request-id';
import { AgentAuthGuard } from '../agent-auth.guard';
import { AgentExceptionFilter } from '../agent-exception.filter';
import type { AgentTurnContext } from '../agent.types';
import type { StoreSetupRunResponse } from './store-setup.types';
import { StoreSetupAgentService } from './store-setup.service';

/**
 * POST /api/v1/agent/run
 *
 * 多轮 function calling 入口；鉴权、错误体、requestId 回写与 /agent/turn 完全一致。
 * 路由前缀由 main.ts 的 setGlobalPrefix('api/v1') 统一添加。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class StoreSetupAgentController {
  constructor(
    @Inject(StoreSetupAgentService) private readonly storeSetupAgent: StoreSetupAgentService,
  ) {}

  @Post('run')
  @HttpCode(200)
  async run(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreSetupRunResponse> {
    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    const context: AgentTurnContext = { requestId };
    return this.storeSetupAgent.run(body, context);
  }
}
