import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AgentModule } from './agent/agent.module';
import { AgentConcurrencyInterceptor, AgentRateLimitGuard, AgentRailsStore, readAgentRailsOptions } from './agent/agent-guard-rails';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { RequestContextInterceptor } from './common/http/request-context.interceptor';
import { createValidationPipe } from './common/http/validation.pipe';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { DesktopModule } from './desktop/desktop.module';
import { GenerationModule } from './generation/generation.module';
import { HealthController } from './health.controller';
import { ImportsModule } from './imports/imports.module';
import { MerchantModule } from './merchant/merchant.module';
import { MediaModule } from './media/media.module';
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
    DesktopModule,
    AuthModule,
    StoresModule,
    OrdersModule,
    MerchantModule,
    MediaModule,
    ImportsModule,
    GenerationModule,
    AgentModule,
  ],
  controllers: [HealthController, ReadyController],
  providers: [
    { provide: APP_PIPE, useValue: createValidationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    // B2：模型额度护栏。只对 /api/v1/agent/** 生效，健康检查不受影响。
    {
      provide: AgentRailsStore,
      useFactory: (config: ConfigService) => new AgentRailsStore(readAgentRailsOptions(config)),
      inject: [ConfigService],
    },
    { provide: APP_GUARD, useClass: AgentRateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: AgentConcurrencyInterceptor },
  ],
})
export class AppModule {}
