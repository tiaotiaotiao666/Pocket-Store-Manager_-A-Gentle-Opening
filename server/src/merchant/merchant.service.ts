import { Injectable } from '@nestjs/common';
import { ActorType, OrderStatus } from '@prisma/client';
import { CatalogService } from '../catalog/catalog.service';
import { createId } from '../common/ids';
import { AppError, ErrorMessages } from '../common/http/app-error';
import type { AuthenticatedUser } from '../common/http/request-context';
import { PrismaService } from '../database/prisma.service';
import { orderBaseInclude, toOrderView } from '../orders/order.mapper';
import type { OrderView, PaginatedOrders } from '../orders/order.mapper';
import { MERCHANT_DEFAULT_STATUSES, assertTransition, parseStatusList } from '../orders/order-state';
import type {
  CreateCategoryDto,
  CreateProductDto,
  MerchantOrdersQueryDto,
  UpdateCategoryDto,
  UpdateOrderStatusDto,
  UpdateProductAvailabilityDto,
  UpdateProductPriceDto,
} from './merchant.dto';

export interface MerchantCategoryView {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MerchantProductView {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  available: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface MerchantCatalogView {
  storeId: string;
  categories: Array<{
    id: string;
    name: string;
    sortOrder: number;
    products: MerchantProductView[];
  }>;
}

@Injectable()
export class MerchantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async listOrders(
    user: AuthenticatedUser,
    storeId: string,
    query: MerchantOrdersQueryDto,
  ): Promise<PaginatedOrders> {
    await this.assertMember(user.id, storeId);

    const requested = parseStatusList(query.status);
    const statuses = requested.length > 0 ? requested : [...MERCHANT_DEFAULT_STATUSES];

    const where = { storeId, status: { in: statuses } };
    const order = query.order || 'asc';
    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: orderBaseInclude,
        orderBy: [{ createdAt: order }, { id: order }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: items.map((order) => toOrderView(order)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async updateOrderStatus(
    user: AuthenticatedUser,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderBaseInclude,
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }

    await this.assertMember(user.id, order.storeId);

    if (order.status === OrderStatus.PENDING_PAYMENT) {
      throw new AppError(
        409,
        'MERCHANT_CANNOT_HANDLE_UNPAID',
        ErrorMessages.MERCHANT_CANNOT_HANDLE_UNPAID,
      );
    }

    if (dto.expectedStatus && dto.expectedStatus !== order.status) {
      throw new AppError(409, 'STATUS_CONFLICT', ErrorMessages.STATUS_CONFLICT, {
        expectedStatus: dto.expectedStatus,
        currentStatus: order.status,
      });
    }

    assertTransition('MERCHANT', order.status, dto.toStatus);

    const isCancel = dto.toStatus === OrderStatus.CANCELLED;
    const reason = (dto.reason ?? '').trim();
    if (isCancel && !reason) {
      throw new AppError(422, 'VALIDATION_ERROR', '取消订单必须填写 reason。', {
        fields: ['reason'],
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status: dto.toStatus, updatedAt: now },
      });
      if (result.count === 0) return null;

      await tx.orderStatusLog.create({
        data: {
          id: createId('log'),
          orderId: order.id,
          fromStatus: order.status,
          toStatus: dto.toStatus,
          actorType: ActorType.MERCHANT,
          actorId: user.id,
          reason: reason || null,
          createdAt: now,
        },
      });

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderBaseInclude });
    });

    if (!updated) {
      throw new AppError(409, 'STATUS_CONFLICT', ErrorMessages.STATUS_CONFLICT);
    }
    return toOrderView(updated);
  }

  async updateProductAvailability(
    user: AuthenticatedUser,
    productId: string,
    dto: UpdateProductAvailabilityDto,
  ): Promise<MerchantProductView> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', ErrorMessages.PRODUCT_NOT_FOUND, { productId });
    }

    await this.assertMember(user.id, product.storeId);

    const now = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.product.update({
        where: { id: product.id },
        data: { available: dto.available, updatedAt: now },
      });
      await tx.store.update({
        where: { id: product.storeId },
        data: { catalogVersion: { increment: 1 }, updatedAt: now },
      });
      return updatedProduct;
    });

    await this.catalog.invalidate(product.storeId);
    return this.toProductView(saved);
  }

  async createProduct(
    user: AuthenticatedUser,
    storeId: string,
    dto: CreateProductDto,
  ): Promise<MerchantProductView> {
    await this.assertOwner(user.id, storeId);

    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, storeId },
      select: { id: true },
    });
    if (!category) {
      throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在。', {
        categoryId: dto.categoryId,
      });
    }

    const now = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const createdProduct = await tx.product.create({
        data: {
          id: createId('prd'),
          storeId,
          categoryId: category.id,
          name: dto.name,
          description: dto.description ?? '',
          priceCents: dto.priceCents,
          imageUrl: '',
          available: dto.available ?? true,
          sortOrder: dto.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.store.update({
        where: { id: storeId },
        data: { catalogVersion: { increment: 1 }, updatedAt: now },
      });
      return createdProduct;
    });

    await this.catalog.invalidate(storeId);
    return this.toProductView(saved);
  }

  async updateProductPrice(
    user: AuthenticatedUser,
    productId: string,
    dto: UpdateProductPriceDto,
  ): Promise<MerchantProductView> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', ErrorMessages.PRODUCT_NOT_FOUND, { productId });
    }

    await this.assertOwner(user.id, product.storeId);

    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    if (product.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new AppError(409, 'PRODUCT_CONFLICT', '商品已被其他操作更新，请刷新后重试。', {
        expectedUpdatedAt: dto.expectedUpdatedAt,
        currentUpdatedAt: product.updatedAt.toISOString(),
      });
    }

    const now = new Date(Math.max(Date.now(), product.updatedAt.getTime() + 1));
    const saved = await this.prisma.$transaction(async (tx) => {
      const result = await tx.product.updateMany({
        where: { id: product.id, updatedAt: product.updatedAt },
        data: { priceCents: dto.priceCents, updatedAt: now },
      });
      if (result.count === 0) return null;

      await tx.store.update({
        where: { id: product.storeId },
        data: { catalogVersion: { increment: 1 }, updatedAt: now },
      });
      return tx.product.findUniqueOrThrow({ where: { id: product.id } });
    });

    if (!saved) {
      throw new AppError(409, 'PRODUCT_CONFLICT', '商品已被其他操作更新，请刷新后重试。');
    }

    await this.catalog.invalidate(product.storeId);
    return this.toProductView(saved);
  }

  async createCategory(
    user: AuthenticatedUser,
    storeId: string,
    dto: CreateCategoryDto,
  ): Promise<MerchantCategoryView> {
    await this.assertOwner(user.id, storeId);

    const now = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const createdCategory = await tx.category.create({
        data: {
          id: createId('cat'),
          storeId,
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          createdAt: now,
        },
      });
      await tx.store.update({
        where: { id: storeId },
        data: { catalogVersion: { increment: 1 }, updatedAt: now },
      });
      return createdCategory;
    });

    await this.catalog.invalidate(storeId);
    return this.toCategoryView(saved);
  }

  async updateCategory(
    user: AuthenticatedUser,
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<MerchantCategoryView> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在。', { categoryId });
    }

    await this.assertOwner(user.id, category.storeId);
    if (dto.name === undefined && dto.sortOrder === undefined) {
      throw new AppError(422, 'VALIDATION_ERROR', '至少提供分类名称或排序。');
    }

    const now = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const updatedCategory = await tx.category.update({
        where: { id: category.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
      await tx.store.update({
        where: { id: category.storeId },
        data: { catalogVersion: { increment: 1 }, updatedAt: now },
      });
      return updatedCategory;
    });

    await this.catalog.invalidate(category.storeId);
    return this.toCategoryView(saved);
  }

  async listProducts(user: AuthenticatedUser, storeId: string): Promise<MerchantCatalogView> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, { storeId });
    }

    await this.assertMember(user.id, storeId);

    const categories = await this.prisma.category.findMany({
      where: { storeId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        products: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
    });

    return {
      storeId,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        products: category.products.map((product) => this.toProductView(product)),
      })),
    };
  }

  private async assertOwner(userId: string, storeId: string): Promise<void> {
    const member = await this.prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId, userId } },
      select: { role: true },
    });
    if (!member || member.role !== 'OWNER') {
      throw new AppError(403, 'FORBIDDEN', ErrorMessages.FORBIDDEN, { storeId });
    }
  }

  private async assertMember(userId: string, storeId: string): Promise<void> {
    const member = await this.prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new AppError(403, 'FORBIDDEN', ErrorMessages.FORBIDDEN, { storeId });
    }
  }

  private toCategoryView(category: {
    id: string;
    name: string;
    sortOrder: number;
  }): MerchantCategoryView {
    return {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
    };
  }

  private toProductView(product: {
    id: string;
    name: string;
    description: string;
    priceCents: number;
    imageUrl: string;
    available: boolean;
    sortOrder: number;
    updatedAt: Date;
  }): MerchantProductView {
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      priceCents: product.priceCents,
      imageUrl: product.imageUrl,
      available: product.available,
      sortOrder: product.sortOrder,
      updatedAt: product.updatedAt.toISOString(),
    };
  }
}