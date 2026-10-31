import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError, ErrorMessages } from './app-error';
import { applyRequestId } from './request-context';
import type { AppRequest } from './request-context';

const STATUS_DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<AppRequest>();
    const requestId = applyRequestId(request, response);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string = ErrorMessages.INTERNAL_ERROR;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (typeof record.code === 'string') {
          code = record.code;
        }
        if (typeof record.message === 'string') {
          message = record.message;
        } else if (Array.isArray(record.message)) {
          message = record.message.filter((item) => typeof item === 'string').join('; ');
        }
      }
      if (code === 'INTERNAL_ERROR') {
        code = STATUS_DEFAULT_CODES[status] ?? code;
      }
      if (!message.trim()) {
        message = ErrorMessages[code as keyof typeof ErrorMessages] ?? ErrorMessages.INTERNAL_ERROR;
      }
    }

    if (status >= 500) {
      const name = exception instanceof Error ? exception.name : 'UnknownError';
      this.logger.error(`requestId=${requestId} status=${status} code=${code} error=${name}`);
    } else {
      this.logger.warn(`requestId=${requestId} status=${status} code=${code}`);
    }

    const body: Record<string, unknown> = { code, message, requestId };
    if (details && Object.keys(details).length > 0) {
      body.details = details;
    }
    response.status(status).json(body);
  }
}