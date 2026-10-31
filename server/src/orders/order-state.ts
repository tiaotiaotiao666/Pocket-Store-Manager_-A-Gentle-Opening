import { OrderStatus } from '@prisma/client';
import { AppError, ErrorMessages } from '../common/http/app-error';

export type OrderActor = 'CUSTOMER' | 'MERCHANT';

const CUSTOMER_TRANSITIONS: ReadonlyMap<OrderStatus, readonly OrderStatus[]> = new Map([
  [OrderStatus.PENDING_PAYMENT, [OrderStatus.PENDING_ACCEPT, OrderStatus.CANCELLED]],
]);

const MERCHANT_TRANSITIONS: ReadonlyMap<OrderStatus, readonly OrderStatus[]> = new Map([
  [OrderStatus.PENDING_ACCEPT, [OrderStatus.PREPARING, OrderStatus.CANCELLED]],
  [OrderStatus.PREPARING, [OrderStatus.READY, OrderStatus.CANCELLED]],
  [OrderStatus.READY, [OrderStatus.COMPLETED, OrderStatus.CANCELLED]],
]);

export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_ACCEPT,
  OrderStatus.PREPARING,
  OrderStatus.READY,
];

export const ALL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_ACCEPT,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
];

export const MERCHANT_DEFAULT_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_ACCEPT,
];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ALL_STATUSES as readonly string[]).includes(value);
}

export function parseStatusList(raw: string | undefined): OrderStatus[] {
  if (!raw) return [];
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = requested.filter((item) => !isOrderStatus(item));
  if (invalid.length > 0) {
    throw new AppError(422, 'VALIDATION_ERROR', 'status 包含未知的订单状态。', {
      fields: ['status'],
      invalid,
    });
  }
  return requested as OrderStatus[];
}

export function canTransition(actor: OrderActor, from: OrderStatus, to: OrderStatus): boolean {
  const table = actor === 'CUSTOMER' ? CUSTOMER_TRANSITIONS : MERCHANT_TRANSITIONS;
  return (table.get(from) ?? []).includes(to);
}

export function assertTransition(actor: OrderActor, from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(actor, from, to)) {
    throw new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      ErrorMessages.INVALID_STATUS_TRANSITION,
      { fromStatus: from, toStatus: to },
    );
  }
}