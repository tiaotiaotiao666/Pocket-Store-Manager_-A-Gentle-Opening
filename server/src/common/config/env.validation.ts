import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, Min, validateSync } from 'class-validator';
import { isLoopbackHost } from '../../desktop/loopback';

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

  /**
   * 视觉模型：agent v2 请求携带图片时使用，纯文本请求仍走 DEEPSEEK_MODEL。
   * 默认值与 C-SERVER-ENV@1 一致；留空回落到 deepseek-flash。
   */
  @Matches(/^[A-Za-z0-9._:-]{1,64}$/)
  DEEPSEEK_VISION_MODEL = 'deepseek-flash';

  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(120000)
  DEEPSEEK_TIMEOUT_MS = 30000;

  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'max'])
  DEEPSEEK_REASONING_EFFORT?: string;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(4000)
  DEEPSEEK_MAX_TOKENS = 1200;

  /** 未认证联调开关：只允许 development/test 使用，production 必须为 true。 */
  @IsIn(['true', 'false'])
  AGENT_REQUIRE_AUTH = 'false';

  // ---------------------------------------------------------------
  // B2：监听来源 / CORS 白名单 / 桌面会话 / 模型额度护栏
  // ---------------------------------------------------------------

  /** 监听地址：默认只对本机开放。改成 0.0.0.0 等非回环地址时必须强制鉴权。 */
  @Matches(/^[A-Za-z0-9._:-]{1,64}$/)
  SERVER_HOST = '127.0.0.1';

  /** 额外允许的浏览器来源（逗号分隔）；与 DESKTOP_ORIGIN 合并成 CORS 白名单。 */
  @IsOptional()
  @IsString()
  CORS_ALLOWED_ORIGINS?: string;

  /** 桌面短期本地会话有效期（秒）：到期即 401，桌面自行重领。 */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86400)
  DESKTOP_SESSION_TTL_SECONDS = 900;

  /** 同一个本机来源每分钟最多申领几次桌面会话。 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  DESKTOP_SESSION_ISSUE_PER_MINUTE = 10;

  /** 模型接口每个来源每分钟最多请求数；0 = 关闭（仅本地联调建议）。 */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  AGENT_RATE_LIMIT_PER_MINUTE = 120;

  /**
   * Agent HTTP 入口同时进行中的请求上限；0 = 关闭。
   *
   * 只保护 `/api/v1/agent/**` 入口（超限先排队，排队预算耗尽才 429），
   * **不参与**上游模型并发计算：真实上游并发由 ModelCallScheduler 负责
   * （`MODEL_MAX_CONCURRENT`，进程内 3 槽 + 跨进程全局令牌），两者互不替代。
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(16)
  AGENT_MAX_CONCURRENT = 3;

  // ---------------------------------------------------------------
  // 上游模型并发（ModelCallScheduler）：与 AGENT_MAX_CONCURRENT 严格分离
  // 口径统一为「最多同时 3 次模型请求」，>3 由调度器 clamp 到 3 并打可见警告。
  // ---------------------------------------------------------------

  /** 上游模型并发上限（只允许 1–3；>3 或非法值由调度器收敛到 3 + 可见警告）。 */
  @IsOptional()
  @IsString()
  MODEL_MAX_CONCURRENT?: string;

  /** 模型请求排队预算（毫秒，30s–600s），排队超时抛 MODEL_QUEUE_TIMEOUT。 */
  @IsOptional()
  @IsString()
  MODEL_QUEUE_WAIT_MS?: string;

  /**
   * 跨进程全局令牌目录：桌面 direct 与 Nest HTTP 共用同一批令牌，
   * 保证两边合计上游并发 ≤3。留空 = 系统临时目录下的 smart-store-model-slots。
   */
  @IsOptional()
  @IsString()
  MODEL_UPSTREAM_TOKEN_DIR?: string;

  /** 测试环境默认关闭额度护栏，需要验证 429 时显式设 1。 */
  @IsOptional()
  @IsIn(['0', '1'])
  AGENT_RAILS_ENFORCE?: string;

  /**
   * Agent JSON 请求体上限（字节），只对 /api/v1/agent 前缀生效。
   * v2 图片以 base64 传输，express 默认 100kb 不够用；默认 2 MiB。
   */
  @Type(() => Number)
  @IsInt()
  @Min(262144)
  @Max(8388608)
  AGENT_MAX_BODY_BYTES = 2097152;

  // ---------------------------------------------------------------
  // 多轮 Agent（agent-run.v1，POST /api/v1/agent/run）
  // 与单轮抽取的 DEEPSEEK_* 配置共用模型，但运行上限独立。
  // ---------------------------------------------------------------

  /** 单次 run 最多调用模型次数（也即最多轮次）。 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  AGENT_RUN_MAX_STEPS = 6;

  /** 单次 run 最多执行工具次数（按 tool_call 个数计）。 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  AGENT_RUN_MAX_TOOL_CALLS = 12;

  /** 单次 run 的墙钟时间上限，毫秒。 */
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300000)
  AGENT_RUN_TIMEOUT_MS = 60000;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  // 真实环境变量（容器/CI/测试注入）优先于 .env 文件，符合 dotenv 默认语义。
  // 否则部署平台注入的 CACHE_DRIVER、NODE_ENV 会被仓库里的 .env 静默覆盖。
  const processOverrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') {
      processOverrides[key] = value;
    }
  }
  const normalized: Record<string, unknown> = { ...config, ...processOverrides };

  // 空值/空白值回落到安全默认值，避免把空串当成合法 URL 或模型名。
  if (typeof normalized.DEEPSEEK_API_BASE_URL !== 'string' || !normalized.DEEPSEEK_API_BASE_URL.trim()) {
    normalized.DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
  }
  if (typeof normalized.DEEPSEEK_MODEL !== 'string' || !normalized.DEEPSEEK_MODEL.trim()) {
    normalized.DEEPSEEK_MODEL = 'deepseek-chat';
  }
  if (
    typeof normalized.DEEPSEEK_VISION_MODEL !== 'string' ||
    !normalized.DEEPSEEK_VISION_MODEL.trim()
  ) {
    normalized.DEEPSEEK_VISION_MODEL = 'deepseek-flash';
  }
  if (normalized.AGENT_MAX_BODY_BYTES === undefined || normalized.AGENT_MAX_BODY_BYTES === '') {
    normalized.AGENT_MAX_BODY_BYTES = 2097152;
  }
  if (normalized.DEEPSEEK_TIMEOUT_MS === undefined || normalized.DEEPSEEK_TIMEOUT_MS === '') {
    normalized.DEEPSEEK_TIMEOUT_MS = 30000;
  }
  if (typeof normalized.AGENT_REQUIRE_AUTH !== 'string' || !normalized.AGENT_REQUIRE_AUTH.trim()) {
    normalized.AGENT_REQUIRE_AUTH = 'false';
  }
  if (
    normalized.AGENT_RUN_MAX_STEPS === undefined ||
    normalized.AGENT_RUN_MAX_STEPS === '' ||
    (typeof normalized.AGENT_RUN_MAX_STEPS === 'string' && !normalized.AGENT_RUN_MAX_STEPS.trim())
  ) {
    normalized.AGENT_RUN_MAX_STEPS = 6;
  }
  if (
    normalized.AGENT_RUN_MAX_TOOL_CALLS === undefined ||
    normalized.AGENT_RUN_MAX_TOOL_CALLS === '' ||
    (typeof normalized.AGENT_RUN_MAX_TOOL_CALLS === 'string' &&
      !normalized.AGENT_RUN_MAX_TOOL_CALLS.trim())
  ) {
    normalized.AGENT_RUN_MAX_TOOL_CALLS = 12;
  }
  if (
    normalized.AGENT_RUN_TIMEOUT_MS === undefined ||
    normalized.AGENT_RUN_TIMEOUT_MS === '' ||
    (typeof normalized.AGENT_RUN_TIMEOUT_MS === 'string' && !normalized.AGENT_RUN_TIMEOUT_MS.trim())
  ) {
    normalized.AGENT_RUN_TIMEOUT_MS = 60000;
  }

  // B2：监听地址为空/空白时回落到本机回环，不留 0.0.0.0 隐患。
  if (typeof normalized.SERVER_HOST !== 'string' || !normalized.SERVER_HOST.trim()) {
    normalized.SERVER_HOST = '127.0.0.1';
  }

  // B2：护栏与会话默认值同样落进 normalized，
  // 让 ConfigService.get 拿到确定值（各消费方仍保留同名兜底，双保险）。
  const numericDefaults: Record<string, number> = {
    DESKTOP_SESSION_TTL_SECONDS: 900,
    DESKTOP_SESSION_ISSUE_PER_MINUTE: 10,
    AGENT_RATE_LIMIT_PER_MINUTE: 120,
    AGENT_MAX_CONCURRENT: 3,
  };
  for (const [key, fallback] of Object.entries(numericDefaults)) {
    const raw = (normalized as Record<string, unknown>)[key];
    if (raw === undefined || raw === null || (typeof raw === 'string' && !String(raw).trim())) {
      (normalized as Record<string, unknown>)[key] = fallback;
    }
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

  // B2：非回环监听（局域网/公网可达）必须强制鉴权，
  // 禁止「非 production 所以匿名」的远程模型通道。
  if (!isLoopbackHost(instance.SERVER_HOST) && instance.AGENT_REQUIRE_AUTH !== 'true') {
    throw new Error(
      'SERVER_HOST 不是回环地址时必须配置 AGENT_REQUIRE_AUTH=true（局域网/公网禁止匿名调用模型接口）',
    );
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