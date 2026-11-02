import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ALL_STATUSES } from '../orders/order-state';
import type { OrderStatus } from '@prisma/client';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const isPresent = (_object: object, value: unknown): boolean => value !== undefined;

export class MerchantOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'status 最长 200 个字符' })
  status?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 只能是 asc 或 desc' })
  order: 'asc' | 'desc' = 'asc';
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

class ProductPriceDto {
  @IsInt({ message: '价格必须是整数分' })
  @Min(1, { message: '价格必须大于 0' })
  @Max(999999, { message: '价格不能超过 999999 分' })
  priceCents!: number;
}

export class CreateProductDto extends ProductPriceDto {
  @IsString()
  categoryId!: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 48, { message: '商品名称 1–48 个字符' })
  name!: string;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(255, { message: '商品描述最长 255 个字符' })
  description?: string;

  @ValidateIf(isPresent)
  @IsBoolean({ message: 'available 必须是布尔值' })
  available?: boolean;

  @ValidateIf(isPresent)
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 不能小于 0' })
  @Max(999, { message: 'sortOrder 不能超过 999' })
  sortOrder?: number;
}

export class UpdateProductPriceDto extends ProductPriceDto {
  @IsDateString({}, { message: 'expectedUpdatedAt 必须是合法时间' })
  expectedUpdatedAt!: string;
}

export class CreateCategoryDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 48, { message: '分类名称 1–48 个字符' })
  name!: string;

  @ValidateIf(isPresent)
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 不能小于 0' })
  @Max(999, { message: 'sortOrder 不能超过 999' })
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ValidateIf(isPresent)
  @Transform(trimString)
  @IsString()
  @Length(1, 48, { message: '分类名称 1–48 个字符' })
  name?: string;

  @ValidateIf(isPresent)
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 不能小于 0' })
  @Max(999, { message: 'sortOrder 不能超过 999' })
  sortOrder?: number;
}