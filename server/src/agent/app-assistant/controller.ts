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
import {
  APP_ASSISTANT_CONTRACT_HEADER,
  APP_ASSISTANT_REQUEST_ID_HEADER,
} from './types';
import type { AppAssistantResponse } from './types';
import { AppAssistantService } from './service';

/**
 * `POST /api/v1/agent/app-assistant`（app-assistant.v1）。
 *
 * 与 `/agent/run`、`/agent/frontend-reconstruct` 同一组边界：
 * - `AgentAuthGuard`：生产/显式开关下必须店主身份；
 * - `X-Request-Id` 由 `resolveRequestId` 生成/透传并回写响应头；
 * - `AgentExceptionFilter`：统一 `{ code, message, requestId }`，不回堆栈/上游正文；
 * - 请求体上限沿用 `/api/v1/agent` 的 2 MiB（main.ts）。
 *
 * body.requestId 与 `X-Agent-Request-Id` 同时出现时必须一致（服务层校验）。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class AppAssistantController {
  constructor(
    @Inject(AppAssistantService) private readonly appAssistant: AppAssistantService,
  ) {}

  @Post('app-assistant')
  @HttpCode(200)
  async run(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<AppAssistantResponse> {
    const headers = request.headers as unknown as Record<string, unknown>;
    const requestId = resolveRequestId(headers, request.requestId);
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    const abort = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) abort.abort();
    };
    response.once('close', onClose);
    try {
      const result = await this.appAssistant.run(body, {
        requestId,
        agentRequestIdHeader: headers[APP_ASSISTANT_REQUEST_ID_HEADER],
        agentContractHeader: headers[APP_ASSISTANT_CONTRACT_HEADER],
        signal: abort.signal,
      });
      response.setHeader('X-Request-Id', result.requestId);
      return result;
    } finally {
      response.removeListener('close', onClose);
    }
  }
}