import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import { ImportRequestDto } from './imports.dto';
import { ImportsService } from './imports.service';
import type { ApplyResult, ImportDetail, PreviewResult } from './imports.service';

@Controller('merchant/stores/:storeId/imports')
@UseGuards(SessionAuthGuard, StoreOwnerGuard)
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
    @Body() dto: ImportRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PreviewResult | ApplyResult> {
    if (dto.mode === 'apply') {
      return this.importsService.apply(user, storeId, dto, idempotencyKey);
    }
    return this.importsService.preview(user, storeId, dto);
  }

  @Get(':importId')
  getImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
    @Param('importId') importId: string,
  ): Promise<ImportDetail> {
    return this.importsService.getImport(user, storeId, importId);
  }
}