import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { resolveRequestId } from '../common/request-id';

const AUTH_REQUIRED = '需要店主身份后才能使用开店助手，请先登录。';
const AUTH_INVALID = 'Authorization 头格式无效，请重新登录。';

/**
 * 本轮临时鉴权边界（明确不是完整店主登录系统）：
 * - development / test 且 AGENT_REQUIRE_AUTH=false：允许无 Authorization 的本地联调；
 * - production 或 AGENT_REQUIRE_AUTH=true：没有 Authorization 一律 401；
 * - 有 Authorization 时只校验 Bearer 形式，不做真实身份解析（B1 auth 尚未实现）；
 * - DeepSeek API Key 不是客户端 Token，永远不会被当作 Authorization 校验依据。
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
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
      return true;
    }

    const nodeEnv = String(this.config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
    const requireAuth = String(this.config.get('AGENT_REQUIRE_AUTH') ?? 'false').toLowerCase() === 'true';

    if (nodeEnv === 'production' || requireAuth) {
      throw new HttpException({ code: 'AUTH_REQUIRED', message: AUTH_REQUIRED }, HttpStatus.UNAUTHORIZED);
    }

    return true;
  }
}
