import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  ACTIVE_STATUSES,
  assertTransition,
  canTransition,
  parseStatusList,
} from '../src/orders/order-state';
import { AppError } from '../src/common/http/app-error';

describe('订单状态机纯函数', () => {
  it('顾客只能从 PENDING_PAYMENT 付款或取消', () => {
    expect(canTransition('CUSTOMER', OrderStatus.PENDING_PAYMENT, OrderStatus.PENDING_ACCEPT)).toBe(true);
    expect(canTransition('CUSTOMER', OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED)).toBe(true);
    expect(canTransition('CUSTOMER', OrderStatus.PENDING_ACCEPT, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransition('CUSTOMER', OrderStatus.PREPARING, OrderStatus.CANCELLED)).toBe(false);
  });

  it('店主不能处理待付款订单，也不能跳过中间状态', () => {
    expect(canTransition('MERCHANT', OrderStatus.PENDING_PAYMENT, OrderStatus.PREPARING)).toBe(false);
    expect(canTransition('MERCHANT', OrderStatus.PENDING_ACCEPT, OrderStatus.READY)).toBe(false);
    expect(canTransition('MERCHANT', OrderStatus.PREPARING, OrderStatus.COMPLETED)).toBe(false);
    expect(canTransition('MERCHANT', OrderStatus.READY, OrderStatus.COMPLETED)).toBe(true);
    expect(canTransition('MERCHANT', OrderStatus.READY, OrderStatus.PREPARING)).toBe(false);
  });

  it('终态不可再变更', () => {
    for (const status of ACTIVE_STATUSES) {
      expect(canTransition('MERCHANT', status, OrderStatus.CANCELLED)).toBe(
        status !== OrderStatus.PENDING_PAYMENT,
      );
    }
    expect(canTransition('MERCHANT', OrderStatus.COMPLETED, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransition('CUSTOMER', OrderStatus.CANCELLED, OrderStatus.PENDING_ACCEPT)).toBe(false);
  });

  it('非法转换抛出 409 INVALID_STATUS_TRANSITION', () => {
    try {
      assertTransition('MERCHANT', OrderStatus.PENDING_ACCEPT, OrderStatus.READY);
      throw new Error('应当抛出错误');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.status).toBe(409);
      expect(appError.code).toBe('INVALID_STATUS_TRANSITION');
    }
  });

  it('状态列表解析拒绝未知值', () => {
    expect(parseStatusList(undefined)).toEqual([]);
    expect(parseStatusList('PENDING_PAYMENT, PREPARING')).toEqual([
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PREPARING,
    ]);
    expect(() => parseStatusList('PENDING_PAYMENT,BOGUS')).toThrow(AppError);
  });
});