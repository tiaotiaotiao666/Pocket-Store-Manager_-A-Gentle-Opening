import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GenerationModule } from '../src/generation/generation.module';

const evidenceDir = resolve(process.cwd(), '../docs/evidence/c1');
const backgroundFile = resolve(evidenceDir, 'home-background.png');
const markFile = resolve(evidenceDir, 'home-mark.svg');
const mediaFile = resolve(evidenceDir, 'media.json');
const resultFile = resolve(evidenceDir, 'generation-result.json');
const prompt = 'A warm editorial illustration for a neighborhood Chinese restaurant ordering mini-program homepage, welcoming wooden dining table with several freshly prepared dishes and subtle citrus accents, soft natural morning light, clean composition with generous negative space in the upper left for store name, refined flat illustration mixed with light paper texture, warm cream and muted green palette, no people, no logos, no brand marks, no text, no letters, no watermark, no UI mockup.';

function digest(data: Buffer): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeMark(): { bytes: number; sha256: string } {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
    '  <rect width="256" height="256" rx="64" fill="#F7F3EC"/>',
    '  <circle cx="128" cy="128" r="92" fill="#1F6F54"/>',
    '  <path d="M72 104h98v46c0 28-20 48-49 48s-49-20-49-48z" fill="#FFFDF9"/>',
    '  <path d="M170 114h12c18 0 26 10 26 24s-10 25-30 25h-14" fill="none" stroke="#FFFDF9" stroke-width="14" stroke-linecap="round"/>',
    '  <path d="M98 82c-8-14 8-18 0-32M128 82c-8-14 8-18 0-32M156 82c-8-14 8-18 0-32" fill="none" stroke="#F2C14E" stroke-width="10" stroke-linecap="round"/>',
    '  <path d="M82 202h92" fill="none" stroke="#FFFDF9" stroke-width="12" stroke-linecap="round"/>',
    '</svg>',
    '',
  ].join('\n');
  const data = Buffer.from(svg, 'utf8');
  writeFileSync(markFile, data);
  return { bytes: data.length, sha256: digest(data) };
}

function readCachedResult(): boolean {
  if (!existsSync(resultFile) || !existsSync(backgroundFile) || !existsSync(mediaFile)) return false;
  try {
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    return result.status === 'success';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  if (existsSync(resolve(process.cwd(), '.env')) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(resolve(process.cwd(), '.env'));
  }
  if (readCachedResult()) {
    writeMark();
    console.log('C1_MEDIA_REUSED');
    return;
  }

  const mark = writeMark();
  const result: Record<string, unknown> = {
    status: 'not-configured',
    route: '/api/v1/generation/images',
    attempts: 0,
    usage: null,
    svg: { status: 'agent-local-svg', ...mark },
  };
  let media: Record<string, unknown> = {
    homeMark: {
      file: 'home-mark.svg',
      mime: 'image/svg+xml',
      width: 256,
      height: 256,
      sha256: mark.sha256,
      source: { kind: 'agent-local-svg', provider: 'codearts' },
    },
  };

  if (!process.argv.includes('--generate-once')) {
    result.status = 'skipped-no-generate-flag';
    writeJson(resultFile, result);
    writeJson(mediaFile, media);
    console.log('C1_GENERATION_SKIPPED');
    return;
  }

  const app = await NestFactory.create(GenerationModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  try {
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();
    const healthResponse = await fetch(baseUrl + '/api/v1/generation/health');
    const health = await healthResponse.json() as { configured?: boolean; imageModel?: boolean; provider?: string; message?: string };
    result.health = { httpStatus: healthResponse.status, configured: Boolean(health.configured), imageModel: Boolean(health.imageModel), provider: health.provider || '', message: health.message || '' };
    if (!healthResponse.ok || !health.configured || !health.imageModel) {
      writeJson(resultFile, result);
      writeJson(mediaFile, media);
      console.log('C1_IMAGE_NOT_CONFIGURED');
      return;
    }

    result.attempts = 1;
    const startedAt = Date.now();
    const response = await fetch(baseUrl + '/api/v1/generation/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, size: '1024x1024' }),
    });
    result.httpStatus = response.status;
    result.durationMs = Date.now() - startedAt;
    const payload = await response.json() as { dataUrl?: string; provider?: string; code?: string; message?: string };
    if (!response.ok || typeof payload.dataUrl !== 'string') {
      result.status = 'failed';
      result.error = { code: payload.code || 'IMAGE_GENERATION_FAILED', message: payload.message || '生图接口未返回图片' };
      writeJson(resultFile, result);
      writeJson(mediaFile, media);
      console.log('C1_IMAGE_FAILED');
      return;
    }

    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(payload.dataUrl);
    if (!match) throw new Error('INVALID_PROJECT_IMAGE_RESPONSE');
    const data = Buffer.from(match[1], 'base64');
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    const sha256 = digest(data);
    writeFileSync(backgroundFile, data);
    const provider = payload.provider || health.provider || 'configured-image-api';
    media = {
      homeBackground: {
        file: 'home-background.png',
        mime: 'image/png',
        width,
        height,

        sha256,
        source: { kind: 'ai-generated', provider, model: process.env.IMAGE_MODEL_NAME || 'configured-image-model' },
      },
      ...media,
    };
    result.status = 'success';
    result.provider = provider;
    result.background = { width, height, bytes: data.length, sha256 };
    writeJson(resultFile, result);
    writeJson(mediaFile, media);
    console.log('C1_IMAGE_SUCCESS');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  if (existsSync(evidenceDir)) {
    writeJson(resultFile, {
      status: 'failed',
      route: '/api/v1/generation/images',
      attempts: 1,
      usage: null,
      error: { code: 'C1_GENERATION_HOST_FAILED', message: error instanceof Error ? error.name : 'UnknownError' },
    });
  }
  console.error('C1_GENERATION_HOST_FAILED');
  process.exitCode = 1;
});