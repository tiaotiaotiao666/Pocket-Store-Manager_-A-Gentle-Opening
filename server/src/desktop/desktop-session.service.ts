import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSharedDesktopStore, type VerifyResult } from './desktop-session.store';

/**
 * B2：桌面会话服务。
 *
 * 生命周期（与 README/启动脚本里的说明保持一致）：
 * - 申领：桌面主进程调 `POST /api/v1/desktop/session`，只在回环来源可用；
 * - 有效期：默认 900 秒（DESKTOP_SESSION_TTL_SECONDS），到期即 401，桌面自行重领；
 * - 失效：服务重启（内存态清空）、TTL 到期、被新 token 挤出的旧 token；
 * - 失效处理：模型接口 401 → 桌面明确提示「会话失效，需重新连接」并可重试，
 *   绝不静默回退匿名，也不把 401 说成「模型不可用」。
 */
@Injectable()
export class DesktopSessionService {
  private readonly store: ReturnType<typeof getSharedDesktopStore>;
  private readonly issueLimit: number;
  private readonly issueWindowMs = 60_000;
  private readonly issued = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const ttlSeconds = Number(config.get('DESKTOP_SESSION_TTL_SECONDS') ?? 900);
    const issueLimit = Number(config.get('DESKTOP_SESSION_ISSUE_PER_MINUTE') ?? 10);
    this.now = () => Date.now();
    // 进程内单例：守卫按同一张表校验桌面 token（见 desktop-session.store.ts）。
    this.store = getSharedDesktopStore({
      ttlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : 900,
      now: this.now,
    });
    this.issueLimit = Number.isFinite(issueLimit) ? Math.max(1, Math.min(120, issueLimit)) : 10;
  }

  get ttlSeconds(): number {
    return this.store.ttlSeconds;
  }

  /**
   * 申领配额：同一个本机来源每分钟最多 N 次。
   * 桌面只在启动/过期时申领一次，正常远低于上限；被刷时返回 429 而不是无限签发。
   */
  takeIssueSlot(clientKey: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const key = typeof clientKey === 'string' && clientKey ? clientKey : 'unknown';
    const bucket = this.issued.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.issued.set(key, { count: 1, resetAt: now + this.issueWindowMs });
      return { ok: true };
    }
    if (bucket.count >= this.issueLimit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true };
  }

  issue(): { token: string; expiresAt: string; ttlSeconds: number } {
    const { token, session } = this.store.issue();
    return {
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ttlSeconds: this.store.ttlSeconds,
    };
  }

  verify(token: unknown): VerifyResult {
    return this.store.verify(token);
  }

  /** 仅供测试与自检：不回传任何 token 内容。 */
  liveCount(): number {
    return this.store.size();
  }
}
