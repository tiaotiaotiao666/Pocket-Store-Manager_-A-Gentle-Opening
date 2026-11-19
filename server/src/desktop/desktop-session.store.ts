import { createHash, randomBytes } from 'node:crypto';

/**
 * B2：桌面端短期本地会话。
 *
 * 为什么不是账号系统：桌面本地生成器没有微信登录态，也不该为它造一套账号。
 * 所以只发一个「只在本机、短期、可失效」的会话凭证：
 * - 只有本机回环来源才允许申领（controller 侧校验）；
 * - 内存态保存，只存 token 的 sha256，重启即全失效；
 * - TTL 默认 900 秒（DESKTOP_SESSION_TTL_SECONDS，60~86400）；
 * - 同时在世 token 有上限，超出淘汰最早的一个，避免本地进程刷爆内存；
 * - 过期/未知一律视为无效（401），不做「过期后自动匿名」。
 */

export const DESKTOP_SESSION_CONTRACT = 'desktop-session.v1';
export const DESKTOP_SESSION_TOKEN_PREFIX = 'ds_';
const TOKEN_BYTES = 24;
const MAX_LIVE_DEFAULT = 32;

export interface DesktopSession {
  sessionId: string;
  expiresAt: number;
}

export type VerifyResult =
  | { ok: true; session: DesktopSession }
  | { ok: false; reason: 'unknown' | 'expired' };

export function hashDesktopToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface DesktopSessionStoreOptions {
  ttlSeconds?: number;
  maxLive?: number;
  now?: () => number;
}

/**
 * 内存态 token 表。不接 Redis：桌面会话只属于本机一次运行，
 * 跨进程共享没有意义，接入缓存反而扩大凭据扩散面。
 */
export class DesktopSessionStore {
  private readonly ttlMs: number;
  private readonly maxLive: number;
  private readonly now: () => number;
  private readonly byHash = new Map<string, DesktopSession>();
  private counter = 0;

  constructor(options: DesktopSessionStoreOptions = {}) {
    const ttlSeconds = Number.isFinite(options.ttlSeconds) ? Number(options.ttlSeconds) : 900;
    this.ttlMs = Math.max(60, Math.min(86400, Math.trunc(ttlSeconds))) * 1000;
    this.maxLive = Math.max(1, Math.trunc(options.maxLive ?? MAX_LIVE_DEFAULT));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }

  issue(): { token: string; session: DesktopSession } {
    this.prune();
    this.counter += 1;
    const token = DESKTOP_SESSION_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
    const session: DesktopSession = {
      sessionId: 'dsess-' + this.now().toString(36) + '-' + this.counter.toString(36),
      expiresAt: this.now() + this.ttlMs,
    };
    this.byHash.set(hashDesktopToken(token), session);
    while (this.byHash.size > this.maxLive) {
      const oldest = this.byHash.keys().next();
      if (oldest.done) break;
      this.byHash.delete(oldest.value);
    }
    return { token, session };
  }

  verify(token: unknown): VerifyResult {
    if (typeof token !== 'string' || !token.trim()) return { ok: false, reason: 'unknown' };
    const hash = hashDesktopToken(token.trim());
    const record = this.byHash.get(hash);
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.expiresAt <= this.now()) {
      this.byHash.delete(hash);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, session: record };
  }

  revoke(token: unknown): boolean {
    if (typeof token !== 'string' || !token.trim()) return false;
    return this.byHash.delete(hashDesktopToken(token.trim()));
  }

  /** 惰性清理：只在申领/校验时扫一遍，不做常驻定时器。 */
  prune(): void {
    const now = this.now();
    for (const [hash, record] of this.byHash) {
      if (record.expiresAt <= now) this.byHash.delete(hash);
    }
  }

  size(): number {
    this.prune();
    return this.byHash.size;
  }
}

/**
 * 进程内单例。
 *
 * 为什么不用 Nest DI：鉴权守卫（AgentAuthGuard）在多个轻量测试模块里被直接构造，
 * 若把 DesktopSessionService 做成守卫的构造依赖，所有既有测试模块都得跟着改。
 * 桌面 token 表本身就是「一个进程一张表」，用模块级单例更贴合语义：
 * - 服务启动时由 DesktopSessionService 用配置的 TTL 初始化；
 * - 守卫按同一张表校验，未初始化时是空表 → 一律 401（fail-closed）。
 */
let sharedStore: DesktopSessionStore | null = null;

export function getSharedDesktopStore(options?: DesktopSessionStoreOptions): DesktopSessionStore {
  if (!sharedStore) sharedStore = new DesktopSessionStore(options);
  return sharedStore;
}

/** 仅供测试：丢弃进程内单例（等价于进程重启）。 */
export function resetSharedDesktopStore(): void {
  sharedStore = null;
}
