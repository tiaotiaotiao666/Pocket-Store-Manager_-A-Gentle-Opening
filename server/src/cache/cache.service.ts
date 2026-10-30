import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

type CacheMode = 'redis' | 'memory';

const CONNECT_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1000;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();
  private redis: Redis | null = null;
  private mode: CacheMode = 'memory';

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const driver = this.config.get<string>('CACHE_DRIVER') ?? 'auto';
    if (driver === 'memory') {
      this.mode = 'memory';
      return;
    }

    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.mode = 'memory';
      return;
    }

    this.logger.log(`Redis target: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        connectTimeout: 3000,
      });
      client.on('error', () => undefined);

      try {
        await client.connect();
        await client.ping();
        this.redis = client;
        this.mode = 'redis';
        this.logger.log(`Redis cache connected (attempt ${attempt})`);
        return;
      } catch (error) {
        await client.quit().catch(() => undefined);
        this.logger.warn(`Redis connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed: ${(error as Error).message}`);
        if (attempt < CONNECT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    this.redis = null;
    this.mode = 'memory';
    if (driver === 'redis') {
      throw new Error('CACHE_DRIVER=redis 但 Redis 不可用');
    }
    this.logger.warn('Redis unavailable; falling back to in-memory cache');
  }

  getMode(): CacheMode {
    return this.mode;
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) {
      return this.redis.get(key);
    }
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
      return;
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(key);
      return;
    }
    this.memory.delete(key);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }
}