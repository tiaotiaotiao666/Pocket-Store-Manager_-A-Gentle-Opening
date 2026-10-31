import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { RequestContextInterceptor } from './common/http/request-context.interceptor';
import { createValidationPipe } from './common/http/validation.pipe';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { GenerationModule } from './generation/generation.module';
import { HealthController } from './health.controller';
import { MerchantModule } from './merchant/merchant.module';
import { OrdersModule } from './orders/orders.module';
import { ReadyController } from './ready.controller';
import { StoresModule } from './stores/stores.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    PrismaModule,
    CacheModule,
    AuthModule,
    StoresModule,
    OrdersModule,
    MerchantModule,
    GenerationModule,
    AgentModule,
  ],
  controllers: [HealthController, ReadyController],
  providers: [
    { provide: APP_PIPE, useValue: createValidationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}