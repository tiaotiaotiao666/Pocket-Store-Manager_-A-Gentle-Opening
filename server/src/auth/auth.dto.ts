import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class WechatLoginDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'code 不能为空' })
  @MaxLength(128, { message: 'code 最长 128 个字符' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,64}$/, { message: 'demoOpenId 只允许 1–64 位字母、数字和 . _ : -' })
  demoOpenId?: string;
}