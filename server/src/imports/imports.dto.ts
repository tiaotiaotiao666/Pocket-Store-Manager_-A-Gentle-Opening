import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ImportBusinessHourDto {
  @Matches(TIME_PATTERN, { message: '营业时间开始必须是 HH:MM' })
  start!: string;

  @Matches(TIME_PATTERN, { message: '营业时间结束必须是 HH:MM' })
  end!: string;
}

export class ImportProfileDto {
  @IsString()
  @Length(1, 48, { message: '门店名称 1–48 个字符' })
  name!: string;

  @IsString()
  @Length(1, 48, { message: '门店品类 1–48 个字符' })
  category!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: '地址最长 120 个字符' })
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32, { message: '电话最长 32 个字符' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '简介最长 200 个字符' })
  notes?: string;

  @IsArray()
  @ArrayMinSize(1, { message: '营业时间至少 1 段' })
  @ArrayMaxSize(3, { message: '营业时间最多 3 段' })
  @ValidateNested({ each: true })
  @Type(() => ImportBusinessHourDto)
  businessHours!: ImportBusinessHourDto[];
}

export class ImportCategoryDto {
  @IsString()
  @Length(1, 48)
  draftId!: string;

  @IsString()
  @Length(1, 48, { message: '分类名称 1–48 个字符' })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class ImportProductDto {
  @IsString()
  @Length(1, 48)
  draftId!: string;

  @IsString()
  @Length(1, 48)
  categoryDraftId!: string;

  @IsString()
  @Length(1, 48, { message: '菜品名称 1–48 个字符' })
  name!: string;

  @IsInt({ message: '价格必须是整数分' })
  @Min(1, { message: '价格必须大于 0' })
  @Max(999999, { message: '价格不能超过 999999 分' })
  priceCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsBoolean({ message: 'available 必须是布尔值' })
  available!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(0, { message: '暂不支持菜品图片导入' })
  imageUrl?: string;

  @IsOptional()
  modifiers?: unknown;

  @IsOptional()
  specs?: unknown;
}

export class ImportTableDto {
  @IsString()
  @Length(1, 48)
  draftId!: string;

  @IsString()
  @Length(1, 32, { message: '桌号名称 1–32 个字符' })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class ImportUnsupportedDto {
  @IsOptional()
  @IsBoolean()
  images?: boolean;

  @IsOptional()
  @IsBoolean()
  modifiers?: boolean;

  @IsOptional()
  @IsBoolean()
  specs?: boolean;
}

export class ImportPayloadDto {
  @ValidateNested()
  @Type(() => ImportProfileDto)
  profile!: ImportProfileDto;

  @IsArray()
  @ArrayMaxSize(3, { message: '分类最多 3 个' })
  @ValidateNested({ each: true })
  @Type(() => ImportCategoryDto)
  categories!: ImportCategoryDto[];

  @IsArray()
  @ArrayMinSize(3, { message: '菜品必须是 3–5 道' })
  @ArrayMaxSize(5, { message: '菜品必须是 3–5 道' })
  @ValidateNested({ each: true })
  @Type(() => ImportProductDto)
  products!: ImportProductDto[];

  @IsArray()
  @ArrayMaxSize(20, { message: '桌号最多 20 个' })
  @ValidateNested({ each: true })
  @Type(() => ImportTableDto)
  tables!: ImportTableDto[];

  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'sourceDraftDigest 必须是 64 位小写十六进制' })
  sourceDraftDigest!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImportUnsupportedDto)
  unsupported?: ImportUnsupportedDto;

  @IsOptional()
  @IsBoolean()

  delivery?: boolean;
}

export class ImportRequestDto {
  @IsIn(['preview', 'apply'], { message: 'mode 只能是 preview 或 apply' })
  mode!: 'preview' | 'apply';

  @ValidateNested()
  @Type(() => ImportPayloadDto)
  payload!: ImportPayloadDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  confirmations?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  previewToken?: string;
}