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
import type { WorkspaceAgentResponse } from './workspace-agent.types';
import { WorkspaceAgentService } from './workspace-agent.service';

/**
 * `POST /api/v1/agent/workspace`（workspace-agent.v1）。
 *
 * 与既有 `/agent/run`、`/agent/app-assistant` 同一鉴权/错误体/requestId 边界；
 * 全局前缀 `api/v1` 由 main.ts 统一添加。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class WorkspaceAgentController {
  constructor(
    @Inject(WorkspaceAgentService) private readonly workspaceAgent: WorkspaceAgentService,
  ) {}

  @Post('workspace')
  @HttpCode(200)
  async run(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkspaceAgentResponse> {
    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    const abort = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) abort.abort();
    };
    response.once('close', onClose);
    try {
      return await this.workspaceAgent.run(body, { requestId, signal: abort.signal });
    } finally {
      response.removeListener('close', onClose);
    }
  }
}
