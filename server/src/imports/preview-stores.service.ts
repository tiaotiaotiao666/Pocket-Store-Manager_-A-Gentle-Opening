import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createId } from '../common/ids';
import { AppError } from '../common/http/app-error';
import type { AuthenticatedUser } from '../common/http/request-context';
import { PrismaService } from '../database/prisma.service';

const PREVIEW_STORE_NAME = '项目预览门店';

export interface PreviewStoreResult {
  storeId: string;
  created: boolean;
  configVersion: number;
  catalogVersion: number;
}

@Injectable()
export class PreviewStoresService {
  constructor(private readonly prisma: PrismaService) {}

  async ensure(user: AuthenticatedUser, bindingKey: string): Promise<PreviewStoreResult> {
    const digest = createHash('sha256').update(`${user.id}:${bindingKey}`, 'utf8').digest('hex');
    const storeId = `store-preview-${digest.slice(0, 32)}`;
    return this.ensureStore(user.id, storeId, true);
  }

  private async ensureStore(userId: string, storeId: string, retryOnRace: boolean): Promise<PreviewStoreResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.store.findUnique({ where: { id: storeId } });
        if (existing) {
          const membership = await tx.storeMember.findUnique({
            where: { storeId_userId: { storeId, userId } },
          });
          if (membership?.role !== Role.OWNER) {
            throw new AppError(409, 'PREVIEW_STORE_CONFLICT', '预览门店与当前用户不匹配。', { storeId });
          }
          return {
            storeId: existing.id,
            created: false,
            configVersion: existing.configVersion,
            catalogVersion: existing.catalogVersion,
          };
        }

        const now = new Date();
        const store = await tx.store.create({
          data: {
            id: storeId,
            name: PREVIEW_STORE_NAME,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.storeMember.create({
          data: {
            id: createId('mem'),
            storeId,
            userId,
            role: Role.OWNER,
            createdAt: now,
          },
        });
        return {
          storeId: store.id,
          created: true,
          configVersion: store.configVersion,
          catalogVersion: store.catalogVersion,
        };
      });
    } catch (error) {
      if (
        retryOnRace
        && error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
      ) {
        return this.ensureStore(userId, storeId, false);
      }
      throw error;
    }
  }
}