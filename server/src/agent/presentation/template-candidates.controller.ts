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
import { TemplateCandidatesService } from './template-candidates.service';
import type { TemplateCandidatesResponse } from './template-candidates.service';

/**
 * POST /api/v1/agent/template-candidates
 *
 * 路由前缀由 main.ts 的 setGlobalPrefix('api/v1') 统一添加。
 * 返回 200；错误体统一为 { code, message, requestId }。
 */
@Controller('agent')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentExceptionFilter)
export class TemplateCandidatesController {
  constructor(@Inject(TemplateCandidatesService) private readonly templateCandidatesService: TemplateCandidatesService) {}

  @Post('template-candidates')
  @HttpCode(200)
  async recommend(
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<TemplateCandidatesResponse> {
    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    return this.templateCandidatesService.recommend(body, { requestId });
  }
}