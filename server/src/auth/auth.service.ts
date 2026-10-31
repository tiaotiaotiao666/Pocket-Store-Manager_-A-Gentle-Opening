import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { createId } from '../common/ids';
import { AppError, ErrorMessages } from '../common/http/app-error';
import { hashSessionToken } from '../common/auth/session-auth.guard';
import { PrismaService } from '../database/prisma.service';
import type { WechatLoginDto } from './auth.dto';
import { WechatAuthClient } from './wechat-auth.client';

export interface MembershipView {
  storeId: string;
  role: Role;
}

export interface UserView {
  id: string;
  displayName: string;
  memberships: MembershipView[];
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: UserView;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly wechat: WechatAuthClient,
  ) {}

  isDemoLoginAllowed(): boolean {
    const environment = String(this.config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
    const enabled = String(this.config.get('ALLOW_DEMO_LOGIN') ?? 'false').toLowerCase() === 'true';
    return environment !== 'production' && enabled;
  }

  async login(dto: WechatLoginDto): Promise<LoginResult> {
    const demoOpenId = dto.demoOpenId?.trim();
    const code = dto.code?.trim();

    if (!demoOpenId && !code) {
      throw new AppError(422, 'VALIDATION_ERROR', '必须提供 code 或 demoOpenId。', {
        fields: ['code'],
      });
    }
    if (demoOpenId && code) {
      throw new AppError(422, 'VALIDATION_ERROR', 'code 与 demoOpenId 只能提供其一。', {
        fields: ['code', 'demoOpenId'],
      });
    }

    let openId: string;
    if (demoOpenId) {
      if (!this.isDemoLoginAllowed()) {
        throw new AppError(403, 'DEMO_LOGIN_DISABLED', ErrorMessages.DEMO_LOGIN_DISABLED);
      }
      openId = demoOpenId;
    } else {
      const resolved = await this.wechat.exchangeCode(code as string);
      if (!resolved) {
        throw new AppError(401, 'AUTH_INVALID', '微信登录凭证无效或已过期，请重新获取。');
      }
      openId = resolved;
    }

    const user = await this.findOrCreateUser(openId);
    const token = randomBytes(32).toString('base64url');
    const ttlSeconds = Number(this.config.get('SESSION_TTL_SECONDS') ?? 604800);
    const now = new Date();

    await this.prisma.session.create({
      data: {
        id: createId('ses'),
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        createdAt: now,
      },
    });

    const memberships = await this.findMemberships(user.id);
    return {
      token,
      expiresIn: ttlSeconds,
      user: { id: user.id, displayName: user.displayName, memberships },
    };
  }

  async buildMeView(userId: string): Promise<UserView & { serverTime: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(401, 'AUTH_INVALID', ErrorMessages.AUTH_INVALID);
    }
    const memberships = await this.findMemberships(user.id);
    return {
      id: user.id,
      displayName: user.displayName,
      memberships,
      serverTime: new Date().toISOString(),
    };
  }

  private async findMemberships(userId: string): Promise<MembershipView[]> {
    const memberships = await this.prisma.storeMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { storeId: true, role: true },
    });
    return memberships.map((item) => ({ storeId: item.storeId, role: item.role }));
  }

  private async findOrCreateUser(openId: string) {
    const existing = await this.prisma.user.findUnique({ where: { openId } });
    if (existing) return existing;

    const now = new Date();
    try {
      return await this.prisma.user.create({
        data: {
          id: createId('usr'),
          openId,
          displayName: '微信顾客',
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.user.findUnique({ where: { openId } });
        if (raced) return raced;
      }
      throw error;
    }
  }
}