import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { AppError, ErrorMessages } from '../common/http/app-error';
import { PrismaService } from '../database/prisma.service';

export interface CatalogProductView {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  available: boolean;
  sortOrder: number;
}

export interface CatalogCategoryView {
  id: string;
  name: string;
  sortOrder: number;
  products: CatalogProductView[];
}

export interface PublicCatalogView {
  storeId: string;
  version: number;
  updatedAt: string;
  categories: CatalogCategoryView[];
}

const CATALOG_TTL_SECONDS = 300;

export function catalogCacheKey(storeId: string): string {
  return `catalog:${storeId}`;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPublicCatalog(storeId: string): Promise<PublicCatalogView> {
    const cacheKey = catalogCacheKey(storeId);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PublicCatalogView;
      } catch {
        this.logger.warn(`目录缓存内容损坏，已丢弃 cacheKey=${cacheKey}`);
        await this.cache.del(cacheKey);
      }
    }

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        categories: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: {
            products: {
              where: { available: true },
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
    });

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }

    const view: PublicCatalogView = {
      storeId: store.id,
      version: store.catalogVersion,
      updatedAt: store.updatedAt.toISOString(),
      categories: store.categories.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        products: category.products.map((product) => ({
          id: product.id,
          name: product.name,
          description: product.description,
          priceCents: product.priceCents,
          imageUrl: product.imageUrl,
          available: product.available,
          sortOrder: product.sortOrder,
        })),
      })),
    };

    await this.cache.set(cacheKey, JSON.stringify(view), CATALOG_TTL_SECONDS);
    return view;
  }

  async invalidate(storeId: string): Promise<void> {
    await this.cache.del(catalogCacheKey(storeId));
  }
}