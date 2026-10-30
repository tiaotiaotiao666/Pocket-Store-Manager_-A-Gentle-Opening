import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  service: string;
  environment: string;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'smart-store-server',
      environment: process.env.NODE_ENV ?? 'development',
      timestamp: new Date().toISOString(),
    };
  }
}