import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { ModelProviderService } from './model-provider.service';

@Module({ controllers: [GenerationController], providers: [ModelProviderService] })
export class GenerationModule {}
