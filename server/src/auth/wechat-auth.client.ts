import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../common/http/app-error';
import { WECHAT_FETCH } from './auth.tokens';
import type { WechatFetch } from './auth.tokens';

interface JsCodeSessionResponse {
  openid?: unknown;
  session_key?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

@Injectable()
export class WechatAuthClient {
  constructor(
    private readonly config: ConfigService,
    @Inject(WECHAT_FETCH) private readonly fetchImpl: WechatFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('WECHAT_APP_ID') && this.config.get<string>('WECHAT_APP_SECRET'));
  }

  async exchangeCode(code: string): Promise<string | null> {
    const appId = this.config.get<string>('WECHAT_APP_ID');
    const appSecret = this.config.get<string>('WECHAT_APP_SECRET');
    if (!appId || !appSecret) {
      throw new AppError(503, 'WECHAT_NOT_CONFIGURED', '服务端未配置微信小程序凭据，暂时无法使用微信登录。');
    }

    const query = new URLSearchParams({
      appid: appId,
      secret: appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    });

    let payload: JsCodeSessionResponse;
    try {
      const response = await this.fetchImpl(
        `https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`,
        { method: 'GET', headers: { accept: 'application/json' } },
      );
      if (!response.ok) return null;
      payload = (await response.json()) as JsCodeSessionResponse;
    } catch {
      throw new AppError(502, 'WECHAT_UPSTREAM_ERROR', '微信登录服务暂时不可用，请稍后重试。');
    }

    if (payload && typeof payload.errcode !== 'undefined' && Number(payload.errcode) !== 0) {
      return null;
    }
    if (typeof payload?.openid !== 'string' || !payload.openid.trim()) {
      return null;
    }
    return payload.openid.trim();
  }
}