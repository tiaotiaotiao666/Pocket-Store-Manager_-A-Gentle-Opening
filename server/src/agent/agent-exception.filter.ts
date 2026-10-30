import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveRequestId } from '../common/request-id';

/**
 * Agent 模块统一错误体：{ code, message, requestId }。
 * 刻意不返回堆栈、上游原始响应、Token 或任何经营信息。
 */
@Catch()
export class AgentExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AgentException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { requestId?: string }>();

    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let code = 'AGENT_INTERNAL_ERROR';
    let message = '开店助手暂时不可用，请稍后重试。';

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (typeof record.code === 'string') code = record.code;
        if (typeof record.message === 'string') {
          message = record.message;
        } else if (Array.isArray(record.message)) {
          message = record.message.filter((item) => typeof item === 'string').join('; ');
        }
      }
    }

    const detail = exception instanceof Error ? ` name=${exception.name}` : '';
    if (status >= 500) {
      this.logger.error(`agent turn failed requestId=${requestId} status=${status} code=${code}${detail}`);
    } else {
      this.logger.warn(`agent turn rejected requestId=${requestId} status=${status} code=${code}${detail}`);
    }

    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-Request-Id', requestId);
    }
    response.status(status).json({ code, message, requestId });
  }
}