import { Module } from '@nestjs/common';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import { StoresModule } from '../stores/stores.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { PreviewStoresController } from './preview-stores.controller';
import { PreviewStoresService } from './preview-stores.service';

@Module({
  imports: [StoresModule],
  controllers: [ImportsController, PreviewStoresController],
  providers: [ImportsService, PreviewStoresService, SessionAuthGuard, StoreOwnerGuard],
})
export class ImportsModule {}