import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { AppError } from '../common/http/app-error';
import { resolveRequestId } from '../common/request-id';

const AUTH_REQUIRED = '需要店主身份后才能使用开店助手，请先登录。';
const AUTH_INVALID = 'Authorization 头格式无效，请重新登录。';

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly sessionAuth: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();

    const requestId = resolveRequestId(
      request.headers as unknown as Record<string, unknown>,
      request.requestId,
    );
    request.requestId = requestId;
    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-Request-Id', requestId);
    }

    const authorization = request.headers?.authorization;
    if (typeof authorization === 'string' && authorization.trim()) {
      const [scheme, token] = authorization.trim().split(/\s+/, 2);
      if (!scheme || scheme.toLowerCase() !== 'bearer' || !token || !token.trim()) {
        throw new HttpException({ code: 'AUTH_INVALID', message: AUTH_INVALID }, HttpStatus.UNAUTHORIZED);
      }
      try {
        return await this.sessionAuth.canActivate(context);
      } catch (error) {
        if (error instanceof AppError) {
          throw new HttpException({ code: error.code, message: error.message }, error.status);
        }
        throw error;
      }
    }

    const nodeEnv = String(this.config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
    const requireAuth = String(this.config.get('AGENT_REQUIRE_AUTH') ?? 'false').toLowerCase() === 'true';

    if (nodeEnv === 'production' || requireAuth) {
      throw new HttpException({ code: 'AUTH_REQUIRED', message: AUTH_REQUIRED }, HttpStatus.UNAUTHORIZED);
    }

    return true;
  }
}
