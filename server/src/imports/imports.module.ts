import { Module } from '@nestjs/common';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import { StoresModule } from '../stores/stores.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [StoresModule],
  controllers: [ImportsController],
  providers: [ImportsService, StoreOwnerGuard],
})
export class ImportsModule {}