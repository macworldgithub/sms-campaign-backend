import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CampaignService } from './campaign.service';
@Controller()
export class OperationsController {
  constructor(private readonly campaign: CampaignService) {}
  @Get('public/config') config() {
    return this.campaign.publicConfig();
  }
  @Get('settings') settings() {
    return this.campaign.settings();
  }
  @Post('settings') save(@Body() input: any) {
    return this.campaign.saveSettings(input);
  }
  @Get('operations') operations() {
    return this.campaign.operations();
  }
  @Get('operations/provider') provider() {
    return this.campaign.verifyProviderSetup();
  }
  @Post('operations/messages/:id') message(@Param('id') id: string) {
    return this.campaign.reconcileMessage(id);
  }
  @Post('operations/crm/:id') crm(@Param('id') id: string, @Body() input: any) {
    return this.campaign.reconcileCrm(id, input);
  }
  @Post('campaigns/:id/pause') pause(@Param('id') id: string) {
    return this.campaign.controlDispatch(id, 'pause');
  }
  @Post('campaigns/:id/resume') resume(@Param('id') id: string) {
    return this.campaign.controlDispatch(id, 'resume');
  }
}
