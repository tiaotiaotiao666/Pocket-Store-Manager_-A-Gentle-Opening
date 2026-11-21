import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import { PreviewStoreRequestDto } from './preview-stores.dto';
import { PreviewStoresService } from './preview-stores.service';
import type { PreviewStoreResult } from './preview-stores.service';

@Controller('merchant/preview-stores')
@UseGuards(SessionAuthGuard)
export class PreviewStoresController {
  constructor(private readonly previewStores: PreviewStoresService) {}

  @Post()
  ensure(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PreviewStoreRequestDto,
  ): Promise<PreviewStoreResult> {
    return this.previewStores.ensure(user, dto.bindingKey);
  }
}