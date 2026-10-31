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
}