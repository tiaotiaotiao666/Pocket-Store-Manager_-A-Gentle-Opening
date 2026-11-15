import { Logger } from '@nestjs/common';
import type { AgentLogEvent, AgentLogSink } from './runtime/runtime.types';

/**
 * 把 runtime 的结构化日志折叠成一行 Nest 日志。
 *
 * 只输出标量字段：runtime 本身不记录用户原文、工具参数或工具结果，
 * 这里再做一次防御，避免将来新增的嵌套字段把大对象打进日志。
 */
export function formatAgentLogEvent(event: AgentLogEvent): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(' ');
}

export function createAgentLogSink(
  logger: Pick<Logger, 'log' | 'warn' | 'debug' | 'error'>,
): AgentLogSink {
  return {
    log(event: AgentLogEvent): void {
      const text = formatAgentLogEvent(event);
      const level = event.level ?? 'info';
      if (level === 'error') {
        logger.error(text);
      } else if (level === 'warn') {
        logger.warn(text);
      } else if (level === 'debug') {
        logger.debug(text);
      } else {
        logger.log(text);
      }
    },
  };
}
