import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from './cache/cache.module';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { GenerationModule } from './generation/generation.module';
import { HealthController } from './health.controller';
import { ReadyController } from './ready.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    PrismaModule,
    CacheModule,
    GenerationModule,
  ],
  controllers: [HealthController, ReadyController],
})
export class AppModule {}