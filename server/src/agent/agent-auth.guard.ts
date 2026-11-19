import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { AppError } from '../common/http/app-error';
import { resolveRequestId } from '../common/request-id';
import { getSharedDesktopStore } from '../desktop/desktop-session.store';
import { isLoopbackAddress } from '../desktop/loopback';

const AUTH_REQUIRED = '需要店主身份或桌面会话后才能使用开店助手，请先登录或重新连接本地服务。';
const AUTH_INVALID = 'Authorization 头格式无效，请重新连接后再试。';
const AUTH_SESSION_EXPIRED = '本地会话已失效，请重新连接后再试（可以点重试）。';
const AUTH_REMOTE_REQUIRED = '该来源必须携带有效凭证才能调用模型接口。';

/** 请求上记录本次鉴权结论，供限流按会话/来源分桶，且不回传渲染层。 */
export interface AgentAuthContext {
  authKind?: 'desktop-session' | 'user-session' | 'anonymous-loopback';
  authKey?: string;
  sessionExpiresAt?: number;
}

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly sessionAuth: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<
      Request & { requestId?: string; sessionId?: string } & AgentAuthContext
    >();
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

      // 1) 桌面短期本地会话（B2）：主进程持有时可用，过期明确 401。
      // 桌面短期本地会话（B2）：与 DesktopSessionService 共用进程内 token 表。
      const desktop = getSharedDesktopStore().verify(token.trim());
      if (desktop.ok) {
        request.authKind = 'desktop-session';
        request.authKey = 'desktop:' + desktop.session.sessionId;
        request.sessionExpiresAt = desktop.session.expiresAt;
        return true;
      }
      if (desktop.reason === 'expired') {
        throw new HttpException(
          { code: 'AUTH_SESSION_EXPIRED', message: AUTH_SESSION_EXPIRED },
          HttpStatus.UNAUTHORIZED,
        );
      }

      // 2) 既有店主会话（微信/demo 登录）：复用同一套 SessionAuthGuard，不新造通道。
      try {
        const allowed = await this.sessionAuth.canActivate(context);
        if (allowed) {
          request.authKind = 'user-session';
          request.authKey = 'user:' + String(request.sessionId ?? requestId);
        }
        return allowed;
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

    // B2：development 的免登录联调只对「本机进程」有效。
    // 只要请求来自回环以外（局域网/公网），一律要求凭证 —— 不再有
    // 「非 production 就匿名」的远程通道。
    const remote = request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : '';
    if (!isLoopbackAddress(remote)) {
      throw new HttpException(
        { code: 'AUTH_REQUIRED', message: AUTH_REMOTE_REQUIRED },
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.authKind = 'anonymous-loopback';
    request.authKey = 'loopback:' + String(remote);
    return true;
  }
}
