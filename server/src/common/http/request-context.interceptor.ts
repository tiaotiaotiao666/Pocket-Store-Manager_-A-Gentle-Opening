import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { applyRequestId } from './request-context';
import type { AppRequest } from './request-context';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    applyRequestId(http.getRequest<AppRequest>(), http.getResponse<Response>());
    return next.handle();
  }
}