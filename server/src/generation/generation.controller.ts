import { Body, Controller, Get, Post } from '@nestjs/common';
import { ModelProviderService } from './model-provider.service';

interface IconGenerationRequest {
  name?: string;
  theme?: string;
  seed?: number;
  referenceImages?: string[];
}

interface StyleRecommendationRequest {
  storeName?: string;
  storeType?: string;
  notes?: string;
  referenceImages?: string[];
}

@Controller('generation')
export class GenerationController {
  constructor(private readonly modelProvider: ModelProviderService) {}

  @Get('health')
  status(): { provider: string; configured: boolean; imageModel: boolean; visionModel: boolean; disclaimer: string } {
    return this.modelProvider.status();
  }

  @Post('icons')
  generateIcon(@Body() request: IconGenerationRequest): Promise<{ dataUrl: string; provider: string; disclaimer: string }> {
    return this.modelProvider.generateIcon(request);
  }

  @Post('recommend-style')
  recommendStyle(@Body() request: StyleRecommendationRequest): Promise<{ templateId: string; reason: string; disclaimer: string }> {
    return this.modelProvider.recommendStyle(request);
  }
}
