import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, Min, validateSync } from 'class-validator';

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

  // ---------------------------------------------------------------
  // DeepSeek Agent（真实 Provider，本轮唯一接入的模型）
  // 真实 API Key 只允许存在 server/.env 或云端密钥管理系统。
  // ---------------------------------------------------------------

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';

  /** 允许为空：开发环境没有 Key 时服务照常启动，接口返回 503 DEEPSEEK_NOT_CONFIGURED。 */
  @IsOptional()
  @IsString()
  DEEPSEEK_API_KEY?: string;

  @Matches(/^[A-Za-z0-9._:-]{1,64}$/)
  DEEPSEEK_MODEL = 'deepseek-chat';

  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(120000)
  DEEPSEEK_TIMEOUT_MS = 30000;

  /** 未认证联调开关：只允许 development/test 使用，production 必须为 true。 */
  @IsIn(['true', 'false'])
  AGENT_REQUIRE_AUTH = 'false';
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...config };

  // 空值/空白值回落到安全默认值，避免把空串当成合法 URL 或模型名。
  if (typeof normalized.DEEPSEEK_API_BASE_URL !== 'string' || !normalized.DEEPSEEK_API_BASE_URL.trim()) {
    normalized.DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
  }
  if (typeof normalized.DEEPSEEK_MODEL !== 'string' || !normalized.DEEPSEEK_MODEL.trim()) {
    normalized.DEEPSEEK_MODEL = 'deepseek-chat';
  }
  if (normalized.DEEPSEEK_TIMEOUT_MS === undefined || normalized.DEEPSEEK_TIMEOUT_MS === '') {
    normalized.DEEPSEEK_TIMEOUT_MS = 30000;
  }
  if (typeof normalized.AGENT_REQUIRE_AUTH !== 'string' || !normalized.AGENT_REQUIRE_AUTH.trim()) {
    normalized.AGENT_REQUIRE_AUTH = 'false';
  }

  const instance = plainToInstance(EnvironmentVariables, normalized, { enableImplicitConversion: true });
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
    // 未认证联调开关只属于本地开发；生产必须显式开启鉴权。
    if (instance.AGENT_REQUIRE_AUTH !== 'true') {
      throw new Error('生产环境必须配置 AGENT_REQUIRE_AUTH=true，禁止未认证调用开店助手');
    }
  }

  const baseUrl = String(instance.DEEPSEEK_API_BASE_URL);
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
  } catch {
    throw new Error('环境变量配置无效：DEEPSEEK_API_BASE_URL 必须是 http(s) URL');
  }

  return normalized;
}