import { Global, Module } from '@nestjs/common';
import { DesktopSessionController } from './desktop-session.controller';
import { DesktopSessionService } from './desktop-session.service';

/**
 * B2：桌面会话模块。
 *
 * 全局导出 `DesktopSessionService`：`AgentAuthGuard` 需要用它校验桌面 token，
 * 但 AgentModule 不该自己 new 一份内存表（否则桌面申领的 token 在别处无效）。
 */
@Global()
@Module({
  controllers: [DesktopSessionController],
  providers: [DesktopSessionService],
  exports: [DesktopSessionService],
})
export class DesktopModule {}
