import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ALL_STATUSES } from '../orders/order-state';
import type { OrderStatus } from '@prisma/client';

export class MerchantOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'status 最长 200 个字符' })
  status?: string;
}

export class UpdateOrderStatusDto {
  @IsIn([...ALL_STATUSES], { message: 'toStatus 不是合法的订单状态' })
  toStatus!: OrderStatus;

  @IsOptional()
  @IsIn([...ALL_STATUSES], { message: 'expectedStatus 不是合法的订单状态' })
  expectedStatus?: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'reason 最长 255 个字符' })
  reason?: string;
}

export class UpdateProductAvailabilityDto {
  @IsBoolean({ message: 'available 必须是布尔值' })
  available!: boolean;
}