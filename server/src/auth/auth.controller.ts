import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import type { AuthenticatedUser } from '../common/http/request-context';
import { WechatLoginDto } from './auth.dto';
import { AuthService } from './auth.service';
import type { LoginResult, UserView } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('wechat/login')
  @HttpCode(200)
  login(@Body() dto: WechatLoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserView & { serverTime: string }> {
    return this.authService.buildMeView(user.id);
  }
}