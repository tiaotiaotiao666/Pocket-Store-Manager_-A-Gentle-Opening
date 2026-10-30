import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CacheService } from './cache/cache.service';
import { PrismaService } from './database/prisma.service';

@Controller('readyz')
export class ReadyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get()
  async check(@Res() response: Response): Promise<void> {
    const timestamp = new Date().toISOString();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      response.status(503).json({
        status: 'error',
        database: 'unavailable',
        cache: this.cache.getMode(),
        timestamp,
      });
      return;
    }

    response.json({
      status: 'ok',
      database: 'ok',
      cache: this.cache.getMode(),
      timestamp,
    });
  }
}