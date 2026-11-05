import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('auth/login') login(@Body() input: any) {
    return this.auth.login(input);
  }
  @Get('auth/me') me(@Req() req: any) {
    return req.portalActor;
  }
  @Post('auth/logout') logout(@Req() req: any) {
    return this.auth.logout(req.portalToken);
  }
  @Post('auth/password') password(@Req() req: any, @Body() input: any) {
    return this.auth.changePassword(req.portalActor, input);
  }
  @Get('users') users() {
    return this.auth.users();
  }
  @Post('users') user(@Req() req: any, @Body() input: any) {
    return this.auth.saveUser(input, req.portalActor);
  }
}
