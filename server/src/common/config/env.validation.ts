import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  TEST_DATABASE_URL?: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsIn(['auto', 'redis', 'memory'])
  CACHE_DRIVER = 'auto';

  @Type(() => Number)
  @IsInt()
  @Min(60)
  SESSION_TTL_SECONDS = 604800;

  @IsIn(['true', 'false'])
  ALLOW_DEMO_LOGIN = 'false';

  @IsIn(['true', 'false'])
  ALLOW_DEMO_PAYMENT = 'false';

  @IsOptional()
  @IsString()
  WECHAT_APP_ID?: string;

  @IsOptional()
  @IsString()
  WECHAT_APP_SECRET?: string;

  @IsOptional()
  @IsString()
  DESKTOP_ORIGIN?: string;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const instance = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(instance, { skipMissingProperties: false, whitelist: true });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .filter(Boolean)
      .join('; ');
    throw new Error(`环境变量配置无效：${detail}`);
  }

  if (instance.NODE_ENV === 'production') {
    if (instance.ALLOW_DEMO_LOGIN === 'true' || instance.ALLOW_DEMO_PAYMENT === 'true') {
      throw new Error('生产环境禁止开启 ALLOW_DEMO_LOGIN / ALLOW_DEMO_PAYMENT');
    }
    if (!instance.WECHAT_APP_ID || !instance.WECHAT_APP_SECRET) {
      throw new Error('生产环境必须配置 WECHAT_APP_ID / WECHAT_APP_SECRET');
    }
  }

  return config;
}