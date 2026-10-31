import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorMessages } from '../http/app-error';
import type { AppRequest } from '../http/request-context';
import { readStringParam } from '../http/request-context';

@Injectable()
export class StoreMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const storeId = readStringParam(request.params?.storeId);
    if (!storeId) {
      throw new AppError(400, 'BAD_REQUEST', '缺少 storeId。');
    }
    if (!request.user) {
      throw new AppError(401, 'AUTH_REQUIRED', ErrorMessages.AUTH_REQUIRED);
    }

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }

    const member = await this.prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId, userId: request.user.id } },
    });
    if (!member) {
      throw new AppError(403, 'FORBIDDEN', ErrorMessages.FORBIDDEN, { storeId });
    }

    request.storeMembership = { storeId: member.storeId, role: member.role };
    return true;
  }
}