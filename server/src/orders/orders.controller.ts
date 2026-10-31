import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import type { OrderView, PaginatedOrders } from './order.mapper';
import { CancelOrderDto, CreateOrderDto, ListOrdersQueryDto } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(SessionAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    const result = await this.ordersService.createOrder(user, dto, idempotencyKey ?? '');
    response.status(result.replayed ? 200 : 201);
    return result.order;
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<PaginatedOrders> {
    return this.ordersService.listForCustomer(user, query);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
  ): Promise<OrderView> {
    return this.ordersService.getOrderForViewer(user, orderId);
  }

  @Post(':id/demo-payment')
  @HttpCode(200)
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
  ): Promise<OrderView> {
    return this.ordersService.payWithDemo(user, orderId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Body() dto: CancelOrderDto,
  ): Promise<OrderView> {
    return this.ordersService.cancelByCustomer(user, orderId, dto);
  }
}