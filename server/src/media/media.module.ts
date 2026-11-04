import { Module } from '@nestjs/common';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import { PrismaModule } from '../database/prisma.module';
import { MediaController } from './media.controller';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [SessionAuthGuard, StoreOwnerGuard],
})
export class MediaModule {}
