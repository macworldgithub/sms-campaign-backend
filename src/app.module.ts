import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessGuard, ActorInterceptor } from './access';
import { OperationsController } from './operations.controller';

@Module({
  imports: [],
  controllers: [
    AppController,
    CampaignController,
    AuthController,
    OperationsController,
  ],
  providers: [
    AppService,
    CampaignService,
    AuthService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: ActorInterceptor },
    {
      provide: CampaignStore,
      useFactory: async () => {
        const store = new CampaignStore();
        await store.connect();
        return store;
      },
    },
  ],
})
export class AppModule {}
