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
import { TemplateReviseService } from './template-revise.service';
import type { TemplateReviseResponse } from './template-revise.service';

/**
 * POST /api/v1/agent/template-revise
 *
 * 路由前缀由 main.ts 的 setGlobalPrefix('api/v1') 统一添加。
 * 返回 200；错误体统一为 { code, message, requestId }。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class TemplateReviseController {
  constructor(@Inject(TemplateReviseService) private readonly templateReviseService: TemplateReviseService) {}

  @Post('template-revise')
  @HttpCode(200)
  async revise(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<TemplateReviseResponse> {
    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    return this.templateReviseService.revise(body, { requestId });
  }
}