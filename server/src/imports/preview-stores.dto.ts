import { IsString, Length, Matches } from 'class-validator';

const PREVIEW_BINDING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export class PreviewStoreRequestDto {
  @IsString()
  @Length(1, 120)
  @Matches(PREVIEW_BINDING_KEY_PATTERN)
  bindingKey!: string;
}