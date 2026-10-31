import { Module } from '@nestjs/common';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WECHAT_FETCH } from './auth.tokens';
import type { WechatFetch } from './auth.tokens';
import { WechatAuthClient } from './wechat-auth.client';

const defaultWechatFetch: WechatFetch = (input, init) => fetch(input, init);

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    WechatAuthClient,
    SessionAuthGuard,
    { provide: WECHAT_FETCH, useValue: defaultWechatFetch },
  ],
  exports: [AuthService, WechatAuthClient],
})
export class AuthModule {}