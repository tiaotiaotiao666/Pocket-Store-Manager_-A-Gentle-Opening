import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { ModelProviderService } from './model-provider.service';
import { PosterGenerationService } from './poster-generation.service';

@Module({
  controllers: [GenerationController],
  providers: [ModelProviderService, PosterGenerationService],
})
export class GenerationModule {}
