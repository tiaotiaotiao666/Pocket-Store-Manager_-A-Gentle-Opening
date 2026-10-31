import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreMemberGuard } from '../common/auth/store-member.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import type { OrderView, PaginatedOrders } from '../orders/order.mapper';
import {
  MerchantOrdersQueryDto,
  UpdateOrderStatusDto,
  UpdateProductAvailabilityDto,
} from './merchant.dto';
import { MerchantService } from './merchant.service';
import type { MerchantCatalogView, MerchantProductView } from './merchant.service';

@Controller('merchant')
export class MerchantController {
  constructor(private readonly merchantService: MerchantService) {}

  @Get('stores/:storeId/orders')
  @UseGuards(SessionAuthGuard, StoreMemberGuard)
  listOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
    @Query() query: MerchantOrdersQueryDto,
  ): Promise<PaginatedOrders> {
    return this.merchantService.listOrders(user, storeId, query);
  }

  @Patch('orders/:id/status')
  @UseGuards(SessionAuthGuard)
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<OrderView> {
    return this.merchantService.updateOrderStatus(user, orderId, dto);
  }

  @Patch('products/:id/availability')
  @UseGuards(SessionAuthGuard)
  updateAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: UpdateProductAvailabilityDto,
  ): Promise<MerchantProductView> {
    return this.merchantService.updateProductAvailability(user, productId, dto);
  }

  @Get('stores/:storeId/products')
  @UseGuards(SessionAuthGuard, StoreMemberGuard)
  listProducts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
  ): Promise<MerchantCatalogView> {
    return this.merchantService.listProducts(user, storeId);
  }
}