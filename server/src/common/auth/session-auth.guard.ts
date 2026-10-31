import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorMessages } from '../http/app-error';
import { applyRequestId } from '../http/request-context';
import type { AppRequest } from '../http/request-context';

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(parts[1])) return null;
  return parts[1];
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const response = http.getResponse<Response>();
    applyRequestId(request, response);

    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.trim()) {
      throw new AppError(401, 'AUTH_REQUIRED', ErrorMessages.AUTH_REQUIRED);
    }

    const token = readBearerToken(authorization);
    if (!token) {
      throw new AppError(401, 'AUTH_INVALID', 'Authorization 头格式无效，请重新登录。');
    }

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, 'AUTH_INVALID', ErrorMessages.AUTH_INVALID);
    }

    request.user = {
      id: session.user.id,
      displayName: session.user.displayName,
    };
    request.sessionId = session.id;
    return true;
  }
}