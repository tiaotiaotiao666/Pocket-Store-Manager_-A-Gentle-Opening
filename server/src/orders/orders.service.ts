import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, FulfillmentType, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createId } from '../common/ids';
import { AppError, ErrorMessages } from '../common/http/app-error';
import type { AuthenticatedUser } from '../common/http/request-context';
import { PrismaService } from '../database/prisma.service';
import { orderBaseInclude, orderDetailInclude, toOrderView } from './order.mapper';
import type { OrderBaseRecord, OrderView, PaginatedOrders } from './order.mapper';
import { ACTIVE_STATUSES, assertTransition, parseStatusList } from './order-state';
import type { CancelOrderDto, CreateOrderDto, ListOrdersQueryDto } from './orders.dto';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

interface NormalizedItem {
  productId: string;
  quantity: number;
}

export interface CreateOrderResult {
  order: OrderView;
  replayed: boolean;
}

export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      '请求头 Idempotency-Key 必须是 8–128 个可见 ASCII 字符。',
      { fields: ['Idempotency-Key'] },
    );
  }
  return value;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  isDemoPaymentAllowed(): boolean {
    const environment = String(this.config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development').toLowerCase();
    const enabled = String(this.config.get('ALLOW_DEMO_PAYMENT') ?? 'false').toLowerCase() === 'true';
    return environment !== 'production' && enabled;
  }

  async createOrder(
    user: AuthenticatedUser,
    dto: CreateOrderDto,
    idempotencyKey: string,
  ): Promise<CreateOrderResult> {
    assertIdempotencyKey(idempotencyKey);
    const items = this.mergeItems(dto.items);
    const requestHash = this.buildRequestHash(dto, items);
    const now = new Date();

    const existing = await this.findIdempotencyRecord(user.id, dto.storeId, idempotencyKey);
    if (existing) {
      if (existing.expiresAt.getTime() > now.getTime()) {
        if (existing.requestHash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', ErrorMessages.IDEMPOTENCY_CONFLICT);
        }
        const replayed = await this.findOrderForReplay(existing.orderId);
        if (replayed) {
          return { order: toOrderView(replayed), replayed: true };
        }
      } else {
        await this.prisma.idempotencyKey.delete({ where: { id: existing.id } }).catch(() => undefined);
      }
    }

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const store = await tx.store.findUnique({ where: { id: dto.storeId } });
        if (!store) {
          throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, {
            storeId: dto.storeId,
          });
        }

        const fulfillmentType = dto.fulfillmentType as FulfillmentType;
        let tableId: string | null = null;

        if (fulfillmentType === FulfillmentType.DINE_IN) {
          if (!store.dineInEnabled) {
            throw new AppError(422, 'VALIDATION_ERROR', '该门店未开启堂食。', {
              fields: ['fulfillmentType'],
            });
          }
          if (!dto.tableId) {
            throw new AppError(422, 'TABLE_REQUIRED', ErrorMessages.TABLE_REQUIRED);
          }
          const table = await tx.storeTable.findFirst({
            where: { id: dto.tableId, storeId: store.id },
            select: { id: true },
          });
          if (!table) {
            throw new AppError(422, 'TABLE_NOT_FOUND', ErrorMessages.TABLE_NOT_FOUND, {
              tableId: dto.tableId,
            });
          }
          tableId = table.id;
        } else if (!store.takeawayEnabled) {
          throw new AppError(422, 'VALIDATION_ERROR', '该门店未开启自取。', {
            fields: ['fulfillmentType'],
          });
        }

        const productIds = items.map((item) => item.productId);
        const products = await tx.product.findMany({
          where: { storeId: store.id, id: { in: productIds } },
        });
        const productMap = new Map(products.map((product) => [product.id, product]));

        const lines = items.map((item) => {
          const product = productMap.get(item.productId);
          if (!product || !product.available) {
            throw new AppError(409, 'PRODUCT_UNAVAILABLE', ErrorMessages.PRODUCT_UNAVAILABLE, {
              productId: item.productId,
            });
          }
          return {
            productId: product.id,
            name: product.name,
            unitPriceCents: product.priceCents,
            quantity: item.quantity,
            lineTotalCents: product.priceCents * item.quantity,
          };
        });

        const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
        const orderId = createId('ord');
        const note = (dto.note ?? '').trim();

        const created = await tx.order.create({
          data: {
            id: orderId,
            storeId: store.id,
            userId: user.id,
            tableId,
            fulfillmentType,
            status: OrderStatus.PENDING_PAYMENT,
            paymentStatus: PaymentStatus.UNPAID,
            totalCents,
            note,
            createdAt: now,
            updatedAt: now,
            items: {
              create: lines.map((line) => ({ id: createId('itm'), ...line })),
            },
            statusLogs: {
              create: [
                {
                  id: createId('log'),
                  fromStatus: null,
                  toStatus: OrderStatus.PENDING_PAYMENT,
                  actorType: ActorType.CUSTOMER,
                  actorId: user.id,
                  reason: null,
                  createdAt: now,
                },
              ],
            },
          },
          include: orderBaseInclude,
        });

        await tx.idempotencyKey.create({
          data: {
            id: createId('idm'),
            userId: user.id,
            storeId: store.id,
            key: idempotencyKey,
            requestHash,
            orderId: created.id,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
            createdAt: now,
          },
        });

        return created;
      });

      return { order: toOrderView(order), replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.findIdempotencyRecord(user.id, dto.storeId, idempotencyKey);
        if (raced) {
          if (raced.requestHash !== requestHash) {
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', ErrorMessages.IDEMPOTENCY_CONFLICT);
          }
          const replayed = await this.findOrderForReplay(raced.orderId);
          if (replayed) {
            return { order: toOrderView(replayed), replayed: true };
          }
        }
      }
      throw error;
    }
  }

  async payWithDemo(user: AuthenticatedUser, orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderBaseInclude,
    });
    if (!order || order.userId !== user.id) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }

    if (!this.isDemoPaymentAllowed()) {
      throw new AppError(403, 'DEMO_PAYMENT_DISABLED', ErrorMessages.DEMO_PAYMENT_DISABLED);
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new AppError(409, 'INVALID_STATUS_TRANSITION', ErrorMessages.INVALID_STATUS_TRANSITION, {
        fromStatus: order.status,
        toStatus: OrderStatus.PENDING_ACCEPT,
      });
    }

    if (order.paymentStatus === PaymentStatus.DEMO_PAID) {
      return toOrderView(order);
    }

    assertTransition('CUSTOMER', order.status, OrderStatus.PENDING_ACCEPT);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: order.id, userId: user.id, status: OrderStatus.PENDING_PAYMENT },
        data: {
          status: OrderStatus.PENDING_ACCEPT,
          paymentStatus: PaymentStatus.DEMO_PAID,
          updatedAt: now,
        },
      });
      if (result.count === 0) return null;

      await tx.orderStatusLog.create({
        data: {
          id: createId('log'),
          orderId: order.id,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.PENDING_ACCEPT,
          actorType: ActorType.CUSTOMER,
          actorId: user.id,
          reason: null,
          createdAt: now,
        },
      });

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderBaseInclude });
    });

    if (updated) return toOrderView(updated);

    const latest = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: orderBaseInclude,
    });
    if (!latest || latest.userId !== user.id) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }
    if (latest.paymentStatus === PaymentStatus.DEMO_PAID) {
      return toOrderView(latest);
    }
    throw new AppError(409, 'STATUS_CONFLICT', ErrorMessages.STATUS_CONFLICT);
  }

  async cancelByCustomer(
    user: AuthenticatedUser,
    orderId: string,
    dto: CancelOrderDto,
  ): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderBaseInclude,
    });
    if (!order || order.userId !== user.id) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }

    if (order.status === OrderStatus.CANCELLED) {
      return toOrderView(order);
    }

    assertTransition('CUSTOMER', order.status, OrderStatus.CANCELLED);

    const reason = (dto.reason ?? '').trim() || 'USER_CANCELLED';
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: order.id, userId: user.id, status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.CANCELLED, updatedAt: now },
      });
      if (result.count === 0) return null;

      await tx.orderStatusLog.create({
        data: {
          id: createId('log'),
          orderId: order.id,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          actorType: ActorType.CUSTOMER,
          actorId: user.id,
          reason,
          createdAt: now,
        },
      });

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderBaseInclude });
    });

    if (updated) return toOrderView(updated);

    const latest = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: orderBaseInclude,
    });
    if (!latest || latest.userId !== user.id) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }
    if (latest.status === OrderStatus.CANCELLED) {
      return toOrderView(latest);
    }
    throw new AppError(409, 'STATUS_CONFLICT', ErrorMessages.STATUS_CONFLICT);
  }

  async listForCustomer(
    user: AuthenticatedUser,
    query: ListOrdersQueryDto,
  ): Promise<PaginatedOrders> {
    const store = await this.prisma.store.findUnique({
      where: { id: query.storeId },
      select: { id: true },
    });
    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', ErrorMessages.STORE_NOT_FOUND, {
        storeId: query.storeId,
      });
    }

    const statuses = this.resolveStatuses(query);
    const where: Prisma.OrderWhereInput = {
      userId: user.id,
      storeId: query.storeId,
      ...(statuses ? { status: { in: statuses } } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: orderBaseInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

  async getOrderForViewer(user: AuthenticatedUser, orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderDetailInclude,
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
    }

    if (order.userId !== user.id) {
      const member = await this.prisma.storeMember.findUnique({
        where: { storeId_userId: { storeId: order.storeId, userId: user.id } },
        select: { id: true },
      });
      if (!member) {
        throw new AppError(404, 'ORDER_NOT_FOUND', ErrorMessages.ORDER_NOT_FOUND);
      }
    }

    return toOrderView(order);
  }

  private resolveStatuses(query: ListOrdersQueryDto): OrderStatus[] | null {
    const fromQuery = parseStatusList(query.status);

    if (query.active === 'true') {
      if (fromQuery.length === 0) return [...ACTIVE_STATUSES];
      return fromQuery.filter((status) => ACTIVE_STATUSES.includes(status));
    }

    return fromQuery.length > 0 ? fromQuery : null;
  }

  private mergeItems(input: CreateOrderDto['items']): NormalizedItem[] {
    const merged = new Map<string, number>();
    for (const item of input) {
      const productId = item.productId.trim();
      merged.set(productId, (merged.get(productId) ?? 0) + item.quantity);
    }

    for (const [productId, quantity] of merged) {
      if (quantity < 1 || quantity > 99) {
        throw new AppError(422, 'VALIDATION_ERROR', '同一商品合并后的数量必须在 1–99 之间。', {
          fields: ['items'],
          productId,
          quantity,
        });
      }
    }

    return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  }

  private buildRequestHash(dto: CreateOrderDto, items: NormalizedItem[]): string {
    const normalized = {
      storeId: dto.storeId,
      fulfillmentType: dto.fulfillmentType,
      tableId: dto.fulfillmentType === 'DINE_IN' ? dto.tableId ?? null : null,
      note: (dto.note ?? '').trim(),
      items: [...items].sort((left, right) => left.productId.localeCompare(right.productId)),
    };
    return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
  }

  private findIdempotencyRecord(userId: string, storeId: string, key: string) {
    return this.prisma.idempotencyKey.findUnique({
      where: { userId_storeId_key: { userId, storeId, key } },
    });
  }

  private async findOrderForReplay(orderId: string | null): Promise<OrderBaseRecord | null> {
    if (!orderId) return null;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderBaseInclude,
    });
    if (!order) {
      this.logger.warn(`幂等记录指向的订单不存在 orderId=${orderId}`);
      return null;
    }
    return order;
  }
}