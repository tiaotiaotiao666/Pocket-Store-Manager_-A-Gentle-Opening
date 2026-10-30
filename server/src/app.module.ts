import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GenerationModule } from './generation/generation.module';

@Module({
  controllers: [HealthController],
  imports: [GenerationModule],
})
export class AppModule {}
