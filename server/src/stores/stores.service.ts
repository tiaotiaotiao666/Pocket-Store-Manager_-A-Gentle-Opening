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
    };
  }
}