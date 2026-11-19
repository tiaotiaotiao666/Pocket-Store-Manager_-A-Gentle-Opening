import { Controller, HttpException, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DESKTOP_SESSION_CONTRACT } from './desktop-session.store';
import { DesktopSessionService } from './desktop-session.service';
import { isLoopbackAddress } from './loopback';

const LOOPBACK_ONLY = '桌面会话只允许本机进程申领。';
const ISSUE_LIMITED = '申领会话太频繁了，请稍后再试。';

interface IssueResponse {
  contract: typeof DESKTOP_SESSION_CONTRACT;
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

/**
 * B2：桌面端凭据申领入口。
 *
 * - 只对回环来源开放（`req.socket.remoteAddress` 必须是 127.0.0.0/8 或 ::1）；
 * - 不需要也不接受任何用户输入（不读 body），不接受自定义有效期；
 * - 返回的是短期 bearer token，桌面主进程自己持有，不进渲染进程/日志/证据。
 *
 * 说明：这不是「匿名通道」。模型接口仍然一律要求 Bearer × 有效会话，
 * 这里只解决「桌面没有微信登录态」这一件事。
 */
@Controller('desktop')
export class DesktopSessionController {
  constructor(@Inject(DesktopSessionService) private readonly sessions: DesktopSessionService) {}

  @Post('session')
  issue(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): IssueResponse {
    const remote = request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : '';
    if (!isLoopbackAddress(remote)) {
      throw new HttpException(
        { code: 'DESKTOP_SESSION_LOOPBACK_ONLY', message: LOOPBACK_ONLY },
        HttpStatus.FORBIDDEN,
      );
    }

    const slot = this.sessions.takeIssueSlot(remote);
    if (!slot.ok) {
      if (response && typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', String(slot.retryAfterSeconds));
      }
      throw new HttpException(
        { code: 'DESKTOP_SESSION_RATE_LIMITED', message: ISSUE_LIMITED },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const issued = this.sessions.issue();
    if (response && typeof response.setHeader === 'function') {
      // 会话响应不缓存：避免中间层缓存 token。
      response.setHeader('Cache-Control', 'no-store');
    }
    return {
      contract: DESKTOP_SESSION_CONTRACT,
      token: issued.token,
      expiresAt: issued.expiresAt,
      ttlSeconds: issued.ttlSeconds,
    };
  }
}
