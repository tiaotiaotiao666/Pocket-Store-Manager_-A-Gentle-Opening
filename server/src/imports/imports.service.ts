import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CatalogService } from '../catalog/catalog.service';
import { createId } from '../common/ids';
import { AppError, ErrorMessages } from '../common/http/app-error';
import type { AuthenticatedUser } from '../common/http/request-context';
import { PrismaService } from '../database/prisma.service';
import { digestOf, sha256Hex } from './import-canonical';
import {
  assertConfirmations,
  computeImportDiff,
  validateIdempotencyKey,
  validateImportPayload,
} from './import-diff';
import type { ExistingStore, ImportDiff, ImportPayload } from './import-diff';
import type { ImportRequestDto } from './imports.dto';

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface ImportMapping {
  categories: Record<string, string>;
  products: Record<string, string>;
  tables: Record<string, string>;
}

export interface PreviewResult {
  importId: string;
  mode: 'preview';
  previewToken: string;
  expiresAt: string;
  diff: ImportDiff;
  conflicts: string[];
  notImported: string[];
  summary: ImportDiff['summary'];
}

export interface ApplyResult {
  importId: string;
  mode: 'apply';
  status: 'APPLIED';
  replay: boolean;
  mapping: ImportMapping;
  configVersion: number;
  catalogVersion: number;
  cacheRefreshed: boolean;
  notImported: string[];
  conflicts: string[];
}

export interface ImportDetail {
  importId: string;
  status: string;
  createdAt: string;
  result: ApplyResult;
}

function toPayload(dto: ImportRequestDto): ImportPayload {
  const payload = dto.payload as unknown as ImportPayload;
  return {
    profile: {
      name: payload.profile.name,
      category: payload.profile.category,
      address: payload.profile.address,
      phone: payload.profile.phone,
      notes: payload.profile.notes,
      businessHours: payload.profile.businessHours,
    },
    categories: payload.categories,
    products: payload.products,
    tables: payload.tables,
    sourceDraftDigest: payload.sourceDraftDigest,
    unsupported: payload.unsupported,
    delivery: payload.delivery,
  };
}

@Injectable()
export class ImportsService {
  private readonly inflight = new Map<string, { requestHash: string; promise: Promise<ApplyResult> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async preview(user: AuthenticatedUser, storeId: string, dto: ImportRequestDto): Promise<PreviewResult> {
    const payload = toPayload(dto);
    this.assertPayload(payload);
    const existing = await this.loadExisting(storeId);
    const diff = computeImportDiff(payload, existing);
    const token = this.buildPreviewToken(storeId, user.id, payload);
    return {
      importId: createId('imp'),
      mode: 'preview',
      previewToken: token.token,
      expiresAt: token.expiresAt.toISOString(),
      diff,
      conflicts: diff.conflicts,
      notImported: diff.notImported,
      summary: diff.summary,
    };
  }

  async apply(
    user: AuthenticatedUser,
    storeId: string,
    dto: ImportRequestDto,
    idempotencyKey: string | undefined,
  ): Promise<ApplyResult> {
    const keyValidation = validateIdempotencyKey(idempotencyKey);
    if (!keyValidation.ok) {
      throw new AppError(keyValidation.status, keyValidation.code, keyValidation.message, keyValidation.details);
    }
    const key = idempotencyKey as string;
    const payload = toPayload(dto);
    this.assertPayload(payload);

    const normalizedConfirmations = [...(dto.confirmations || [])].sort();
    const requestHash = sha256Hex(JSON.stringify({
      mode: dto.mode,
      confirmations: normalizedConfirmations,
      payload: digestOf(payload),
    }));

    const lockKey = `${storeId}:${user.id}:${key}`;
    const running = this.inflight.get(lockKey);
    if (running) {
      if (running.requestHash !== requestHash) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', ErrorMessages.IDEMPOTENCY_CONFLICT);
      }
      return { ...(await running.promise), replay: true };
    }

    const tracked = this.applyOnce(user, storeId, dto, key, requestHash, payload, normalizedConfirmations)
      .finally(() => this.inflight.delete(lockKey));
    this.inflight.set(lockKey, { requestHash, promise: tracked });
    return tracked;
  }

  private async applyOnce(
    user: AuthenticatedUser,
    storeId: string,
    dto: ImportRequestDto,
    key: string,
    requestHash: string,
    payload: ImportPayload,
    normalizedConfirmations: string[],
  ): Promise<ApplyResult> {
    const existingImport = await this.prisma.storeImport.findUnique({
      where: { storeId_userId_idempotencyKey: { storeId, userId: user.id, idempotencyKey: key } },
    });
    if (existingImport) {
      if (existingImport.requestHash !== requestHash) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', ErrorMessages.IDEMPOTENCY_CONFLICT);
      }
      return { ...(existingImport.resultJson as unknown as ApplyResult), replay: true };
    }

    const verification = this.verifyPreviewToken(dto.previewToken, storeId, user.id, payload);
    if (!verification.ok) {
      throw new AppError(verification.status, verification.code, verification.message);
    }

    const existing = await this.loadExisting(storeId);
    const diff = computeImportDiff(payload, existing);
    const confirmations = assertConfirmations(diff, normalizedConfirmations);
    if (!confirmations.ok) {
      throw new AppError(confirmations.status, confirmations.code, confirmations.message, confirmations.details);
    }

    const importId = createId('imp');
    const now = new Date();

    try {
      const executed = await this.prisma.$transaction(async (tx) => {
        const mapping: ImportMapping = { categories: {}, products: {}, tables: {} };

        for (const category of diff.categories) {
          if (category.action === 'create') {
            const id = createId('cat');
            await tx.category.create({
              data: { id, storeId, name: category.name, sortOrder: category.sortOrder, createdAt: now },
            });
            mapping.categories[category.draftId] = id;
          } else {
            mapping.categories[category.draftId] = category.existingId as string;
          }
        }

        for (const product of diff.products) {
          const categoryId = mapping.categories[product.categoryDraftId];
          if (!categoryId) {
            throw new AppError(422, 'VALIDATION_ERROR', `菜品 ${product.name} 找不到分类映射。`);
          }
          if (product.action === 'create') {
            const id = createId('prd');
            await tx.product.create({
              data: {
                id,
                storeId,
                categoryId,
                name: product.name,
                description: product.description,
                priceCents: product.priceCents,
                imageUrl: '',
                available: product.available,
                sortOrder: diff.products.indexOf(product) + 1,
                createdAt: now,
                updatedAt: now,
              },
            });
            mapping.products[product.draftId] = id;
          } else if (product.action === 'conflict') {
            const id = product.existingId as string;
            await tx.product.update({
              where: { id },
              data: { priceCents: product.priceCents, available: product.available, updatedAt: now },
            });
            mapping.products[product.draftId] = id;
          } else {
            mapping.products[product.draftId] = product.existingId as string;
          }
        }

        for (const table of diff.tables) {
          if (table.action === 'create') {
            const id = createId('tbl');
            await tx.storeTable.create({
              data: { id, storeId, name: table.name, sortOrder: table.sortOrder, createdAt: now },
            });
            mapping.tables[table.draftId] = id;
          } else {
            mapping.tables[table.draftId] = table.existingId as string;
          }
        }

        const profileUpdates: Record<string, string> = {};
        diff.profile.forEach((item) => {
          if (item.action === 'conflict') profileUpdates[item.field] = item.incoming;
        });

        const store = await tx.store.update({
          where: { id: storeId },
          data: {
            ...(profileUpdates.name ? { name: profileUpdates.name } : {}),
            ...(profileUpdates.category ? { category: profileUpdates.category } : {}),
            ...(profileUpdates.address !== undefined ? { address: profileUpdates.address } : {}),
            ...(profileUpdates.phone !== undefined ? { phone: profileUpdates.phone } : {}),
            ...(profileUpdates.businessHours ? { businessHours: profileUpdates.businessHours } : {}),
            configVersion: { increment: 1 },
            catalogVersion: { increment: 1 },
            updatedAt: now,
          },
        });

        const result: ApplyResult = {
          importId,
          mode: 'apply',
          status: 'APPLIED',
          replay: false,
          mapping,
          configVersion: store.configVersion,
          catalogVersion: store.catalogVersion,
          cacheRefreshed: true,
          notImported: diff.notImported,
          conflicts: [],
        };

        await tx.storeImport.create({
          data: {
            id: importId,
            storeId,
            userId: user.id,
            idempotencyKey: key,
            requestHash,
            sourceDraftDigest: payload.sourceDraftDigest || digestOf(payload),
            status: 'APPLIED',
            previewToken: verification.digest,
            resultJson: result as unknown as Prisma.InputJsonValue,
            createdAt: now,
          },
        });

        return result;
      });

      let cacheRefreshed = true;
      try {
        await this.catalog.invalidate(storeId);
      } catch {
        cacheRefreshed = false;
      }

      if (!cacheRefreshed) {
        const updated = await this.prisma.storeImport.update({
          where: { id: importId },
          data: { resultJson: { ...executed, cacheRefreshed: false } as unknown as Prisma.InputJsonValue },
        });
        return { ...(updated.resultJson as unknown as ApplyResult), replay: false };
      }

      return executed;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const replay = await this.prisma.storeImport.findUnique({
            where: { storeId_userId_idempotencyKey: { storeId, userId: user.id, idempotencyKey: key } },
          });
          if (replay) {
            return { ...(replay.resultJson as unknown as ApplyResult), replay: true };
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      throw error;
    }
  }

  async getImport(user: AuthenticatedUser, storeId: string, importId: string): Promise<ImportDetail> {
    const record = await this.prisma.storeImport.findFirst({
      where: { id: importId, storeId },
    });
    if (!record) {
      throw new AppError(404, 'IMPORT_NOT_FOUND', '导入记录不存在。', { importId });
    }
    return {
      importId: record.id,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      result: record.resultJson as unknown as ApplyResult,
    };
  }

  private assertPayload(payload: ImportPayload): void {
    const validation = validateImportPayload(payload);
    if (!validation.ok) {
      throw new AppError(validation.status, validation.code, validation.message, validation.details);
    }
    for (const product of payload.products) {
      if (product.imageUrl || product.modifiers || product.specs) {
        throw new AppError(422, 'UNSUPPORTED_FIELD', '暂不支持导入菜品图片、加料或规格。', {
          product: product.name,
        });
      }
    }
  }

  private async loadExisting(storeId: string): Promise<ExistingStore> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        categories: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: { products: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
        },
        tables: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }
    return {
      name: store.name,
      category: store.category,
      address: store.address,
      phone: store.phone,
      businessHours: store.businessHours,
      categories: store.categories.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        products: category.products.map((product) => ({
          id: product.id,
          name: product.name,
          priceCents: product.priceCents,
          available: product.available,
        })),
      })),
      tables: store.tables.map((table) => ({ id: table.id, name: table.name, sortOrder: table.sortOrder })),
    };
  }

  private buildPreviewToken(
    storeId: string,
    userId: string,
    payload: ImportPayload,
  ): { token: string; expiresAt: Date; digest: string } {
    const expiresAtMs = Date.now() + PREVIEW_TTL_MS;
    const digest = digestOf({ storeId, userId, payload, expiresAtMs });
    return {
      token: `${expiresAtMs}.${digest}`,
      expiresAt: new Date(expiresAtMs),
      digest,
    };
  }

  private verifyPreviewToken(
    token: string | undefined,
    storeId: string,
    userId: string,
    payload: ImportPayload,
  ): { ok: true; digest: string } | { ok: false; status: number; code: string; message: string } {
    if (!token || typeof token !== 'string') {
      return { ok: false, status: 422, code: 'PREVIEW_STALE', message: '缺少 previewToken，请重新预览。' };
    }
    const separator = token.indexOf('.');
    if (separator <= 0) {
      return { ok: false, status: 422, code: 'PREVIEW_STALE', message: 'previewToken 格式不正确。' };
    }
    const expiresAtMs = Number(token.slice(0, separator));
    const digest = token.slice(separator + 1);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
      return { ok: false, status: 422, code: 'PREVIEW_STALE', message: '预览已过期，请重新预览。' };
    }
    const expected = digestOf({ storeId, userId, payload, expiresAtMs });
    if (expected !== digest) {
      return { ok: false, status: 422, code: 'PREVIEW_STALE', message: '预览内容已变化，请重新预览。' };
    }
    return { ok: true, digest };
  }
}