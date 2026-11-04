import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStore } from './campaign.store';

@Module({
  imports: [],
  controllers: [AppController, CampaignController],
  providers: [
    AppService,
    CampaignService,
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
