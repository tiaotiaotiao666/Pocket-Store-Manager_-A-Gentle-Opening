import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import type { AppRequest } from '../common/http/request-context';
import { ModelProviderService } from './model-provider.service';
import { PosterGenerationService } from './poster-generation.service';
import { buildPosterPrompt } from './poster-prompt';

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

interface ImageGenerationRequest {
  prompt?: string;
  size?: string;
}

interface PosterPromptRequest {
  storeName?: string;
  storeType?: string;
  styleLabel?: string;
  dishes?: string[];
  userHint?: string;
}

interface PosterGenerationRequest {
  prompt?: string;
  size?: string;
}

@Controller('generation')
export class GenerationController {
  constructor(
    @Inject(ModelProviderService) private readonly modelProvider: ModelProviderService,
    @Inject(PosterGenerationService) private readonly posterService: PosterGenerationService,
  ) {}

  @Get('health')
  status(): { provider: string; configured: boolean; imageModel: boolean; visionModel: boolean; disclaimer: string } {
    return this.modelProvider.status();
  }

  @Get('posters/status')
  posterStatus(): ReturnType<PosterGenerationService['status']> {
    return this.posterService.status();
  }

  @Post('posters/prompt')
  @UseGuards(SessionAuthGuard)
  buildPosterPrompt(@Body() request: PosterPromptRequest): { prompt: string } {
    return { prompt: buildPosterPrompt(request || {}) };
  }

  /**
   * 真实生图。要求本地会话鉴权：没有 Bearer Token 的匿名请求在这里就被挡住，
   * 一个字节的上游请求都不会发出，也就不会消耗第三方 Key。
   */
  @Post('posters')
  @UseGuards(SessionAuthGuard)
  async generatePoster(
    @Req() request: AppRequest & Request,
    @Body() body: PosterGenerationRequest,
  ): Promise<{
    mimeType: 'image/png';
    dataUrl: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
    provider: string;
    model: string;
    latencyMs: number;
    requestedSize: string;
    usage: { inputTokens: number; outputTokens: number } | null;
  }> {
    const result = await this.posterService.generate({
      prompt: body?.prompt,
      size: body?.size,
      sessionId: request.sessionId,
    });
    return {
      mimeType: result.mimeType,
      dataUrl: `data:image/png;base64,${result.base64}`,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      sha256: result.sha256,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      requestedSize: result.requestedSize,
      usage: result.usage,
    };
  }

  @Post('icons')
  generateIcon(@Body() request: IconGenerationRequest): Promise<{ dataUrl: string; provider: string; disclaimer: string }> {
    return this.modelProvider.generateIcon(request);
  }

  @Post('recommend-style')
  recommendStyle(@Body() request: StyleRecommendationRequest): Promise<{ templateId: string; reason: string; disclaimer: string }> {
    return this.modelProvider.recommendStyle(request);
  }

  @Post('images')
  generateImage(@Body() request: ImageGenerationRequest): Promise<{ dataUrl: string; provider: string; disclaimer: string }> {
    return this.modelProvider.generateImage(request);
  }
}
