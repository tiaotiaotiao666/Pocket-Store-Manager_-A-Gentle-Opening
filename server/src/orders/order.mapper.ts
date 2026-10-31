import { Prisma } from '@prisma/client';

export const orderBaseInclude = {
  store: { select: { id: true, name: true } },
  table: { select: { id: true, name: true } },
  items: { orderBy: { id: 'asc' } },
} satisfies Prisma.OrderInclude;

export const orderDetailInclude = {
  ...orderBaseInclude,
  statusLogs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.OrderInclude;

export type OrderBaseRecord = Prisma.OrderGetPayload<{ include: typeof orderBaseInclude }>;
export type OrderDetailRecord = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

export interface OrderItemView {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderStatusHistoryView {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  reason: string | null;
  createdAt: string;
}

export interface OrderView {
  id: string;
  storeId: string;
  storeName: string;
  tableId: string | null;
  tableName: string | null;
  fulfillmentType: string;
  status: string;
  paymentStatus: string;
  items: OrderItemView[];
  totalCents: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  statusHistory?: OrderStatusHistoryView[];
}

export function toOrderView(order: OrderBaseRecord | OrderDetailRecord): OrderView {
  const view: OrderView = {
    id: order.id,
    storeId: order.storeId,
    storeName: order.store.name,
    tableId: order.tableId,
    tableName: order.table ? order.table.name : null,
    fulfillmentType: order.fulfillmentType,
    status: order.status,
    paymentStatus: order.paymentStatus,
    items: order.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
    })),
    totalCents: order.totalCents,
    note: order.note,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };

  if ('statusLogs' in order && Array.isArray(order.statusLogs)) {
    view.statusHistory = order.statusLogs.map((log) => ({
      id: log.id,
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      actorType: log.actorType,
      reason: log.reason,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  return view;
}

export interface PaginatedOrders {
  items: OrderView[];
  page: number;
  pageSize: number;
  total: number;
}