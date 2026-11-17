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
import type { FrontendReconstructResponse } from './types';
import { FrontendReconstructService } from './service';

/**
 * `POST /api/v1/agent/frontend-reconstruct`（frontend-reconstruct.v1）。
 *
 * 与 `/agent/run`、`/agent/turn` 完全一致的边界：
 * - `AgentAuthGuard`：生产/显式开关下必须店主身份；
 * - `X-Request-Id` 由 `resolveRequestId` 生成/透传并回写响应头；
 * - `AgentExceptionFilter`：统一 `{ code, message, requestId }`，不回堆栈/上游正文；
 * - 请求体上限由 `main.ts` 对 `/api/v1/agent` 统一配置（2 MiB）。
 *
 * 取消：客户端提前断开时 abort 信号贯穿 Runtime；成功的响应仍是普通 JSON。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class FrontendReconstructController {
  constructor(
    @Inject(FrontendReconstructService)
    private readonly frontendReconstruct: FrontendReconstructService,
  ) {}

  @Post('frontend-reconstruct')
  @HttpCode(200)
  async reconstruct(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<FrontendReconstructResponse> {
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
      return await this.frontendReconstruct.run(body, {
        requestId,
        signal: abort.signal,
      });
    } finally {
      response.removeListener('close', onClose);
    }
  }
}
