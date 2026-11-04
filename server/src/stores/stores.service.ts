import { Injectable } from '@nestjs/common';
import { AppError, ErrorMessages } from '../common/http/app-error';
import { PrismaService } from '../database/prisma.service';

export interface PublicStoreView {
  id: string;
  name: string;
  address: string;
  phone: string;
  businessHours: string;
  fulfillment: { dineIn: boolean; takeaway: boolean };
  theme: { backgroundColor: string; textColor: string; primaryColor: string };
  configVersion: number;
  catalogVersion: number;
}

export interface PublicTableView {
  id: string;
  name: string;
  sortOrder: number;
}

export interface PublicTablesView {
  storeId: string;
  tables: PublicTableView[];
}

export interface PublicPosterView {
  id: string;
  productId: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  sortOrder: number;
  product: {
    id: string;
    name: string;
    description: string;
    priceCents: number;
    imageUrl: string;
    available: boolean;
  };
}

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublicStore(storeId: string): Promise<PublicStoreView> {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }
    return {
      id: store.id,
      name: store.name,
      address: store.address,
      phone: store.phone,
      businessHours: store.businessHours,
      fulfillment: {
        dineIn: store.dineInEnabled,
        takeaway: store.takeawayEnabled,
      },
      theme: {
        backgroundColor: store.backgroundColor,
        textColor: store.textColor,
        primaryColor: store.primaryColor,
      },
      configVersion: store.configVersion,
      catalogVersion: store.catalogVersion,
    };
  }

  async listTables(storeId: string): Promise<PublicTablesView> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }

    const tables = await this.prisma.storeTable.findMany({
      where: { storeId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, sortOrder: true },
    });

    return {
      storeId,
      tables: tables.map((table) => ({ id: table.id, name: table.name, sortOrder: table.sortOrder })),
    };
  }

  async listPublicPosters(storeId: string): Promise<PublicPosterView[]> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }
    const posters = await this.prisma.storePoster.findMany({
      where: { storeId, active: true, product: { available: true } },
      include: { product: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return posters.map((poster) => ({
      id: poster.id,
      productId: poster.productId,
      title: poster.title,
      subtitle: poster.subtitle,
      imageUrl: poster.imageUrl || poster.product.imageUrl,
      sortOrder: poster.sortOrder,
      product: {
        id: poster.product.id,
        name: poster.product.name,
        description: poster.product.description,
        priceCents: poster.product.priceCents,
        imageUrl: poster.product.imageUrl,
        available: poster.product.available,
      },
    }));
  }
}
