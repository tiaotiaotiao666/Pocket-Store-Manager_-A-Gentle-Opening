import { Module } from '@nestjs/common';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreMemberGuard } from '../common/auth/store-member.guard';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import { StoresModule } from '../stores/stores.module';
import { MerchantController } from './merchant.controller';
import { MerchantService } from './merchant.service';

@Module({
  imports: [StoresModule],
  controllers: [MerchantController],
  providers: [MerchantService, SessionAuthGuard, StoreMemberGuard, StoreOwnerGuard],
})
export class MerchantModule {}