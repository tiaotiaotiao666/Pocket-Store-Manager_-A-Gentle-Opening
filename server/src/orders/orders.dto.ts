import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

export class CreateOrderItemDto {
  @IsString()
  @IsNotEmpty({ message: 'productId 不能为空' })
  @MaxLength(64, { message: 'productId 最长 64 个字符' })
  productId!: string;

  @Type(() => Number)
  @IsInt({ message: 'quantity 必须是整数' })
  @Min(1, { message: 'quantity 最小为 1' })
  @Max(99, { message: 'quantity 最大为 99' })
  quantity!: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty({ message: 'storeId 不能为空' })
  @MaxLength(64, { message: 'storeId 最长 64 个字符' })
  storeId!: string;

  @IsIn(['DINE_IN', 'TAKEAWAY'], { message: 'fulfillmentType 必须是 DINE_IN 或 TAKEAWAY' })
  fulfillmentType!: 'DINE_IN' | 'TAKEAWAY';

  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'tableId 最长 64 个字符' })
  tableId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'items 至少包含 1 个商品' })
  @ArrayMaxSize(50, { message: 'items 最多包含 50 项' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'note 最长 255 个字符' })
  note?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'reason 最长 255 个字符' })
  reason?: string;
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'storeId 不能为空' })
  @MaxLength(64, { message: 'storeId 最长 64 个字符' })
  storeId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'status 最长 200 个字符' })
  status?: string;

  @IsOptional()
  @IsIn(['true', 'false'], { message: 'active 只能是 true 或 false' })
  active?: 'true' | 'false';
}