import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest, AuthenticatedUser } from '../http/request-context';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) {
      throw new Error('CurrentUser 必须在 SessionAuthGuard 之后使用');
    }
    return request.user;
  },
);