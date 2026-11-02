import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { StoreMemberGuard } from '../common/auth/store-member.guard';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import type { OrderView, PaginatedOrders } from '../orders/order.mapper';
import {
  CreateCategoryDto,
  CreateProductDto,
  MerchantOrdersQueryDto,
  UpdateCategoryDto,
  UpdateOrderStatusDto,
  UpdateProductAvailabilityDto,
  UpdateProductPriceDto,
} from './merchant.dto';
import { MerchantService } from './merchant.service';
import type {
  MerchantCatalogView,
  MerchantCategoryView,
  MerchantProductView,
} from './merchant.service';

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

  @Post('stores/:storeId/products')
  @UseGuards(SessionAuthGuard, StoreOwnerGuard)
  createProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
    @Body() dto: CreateProductDto,
  ): Promise<MerchantProductView> {
    return this.merchantService.createProduct(user, storeId, dto);
  }

  @Patch('products/:id/price')
  @UseGuards(SessionAuthGuard)
  updatePrice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: UpdateProductPriceDto,
  ): Promise<MerchantProductView> {
    return this.merchantService.updateProductPrice(user, productId, dto);
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

  @Post('stores/:storeId/categories')
  @UseGuards(SessionAuthGuard, StoreOwnerGuard)
  createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('storeId') storeId: string,
    @Body() dto: CreateCategoryDto,
  ): Promise<MerchantCategoryView> {
    return this.merchantService.createCategory(user, storeId, dto);
  }

  @Patch('categories/:id')
  @UseGuards(SessionAuthGuard)
  updateCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<MerchantCategoryView> {
    return this.merchantService.updateCategory(user, categoryId, dto);
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