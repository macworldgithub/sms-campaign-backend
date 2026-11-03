import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('Webhook and portal authentication', () => {
  let store: CampaignStore, controller: CampaignController, directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-test-'));
    process.env.CAMPAIGN_DB = join(directory, 'db.sqlite');
    process.env.MOBILEMESSAGE_WEBHOOK_SECRET = 'test-signing-secret';
    store = new CampaignStore();
    controller = new CampaignController(new CampaignService(store));
  });
  afterEach(() => {
    store.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.CAMPAIGN_DB;
    delete process.env.MOBILEMESSAGE_WEBHOOK_SECRET;
  });
  it('rejects unauthenticated portal reads', () => {
    expect(() => controller.dashboard('wrong')).toThrow();
  });
  it('rejects unsigned SMS callbacks', () => {
    expect(() =>
      controller.sms({ headers: {} } as any, {
        type: 'unsubscribe',
        sender: '61412345678',
      }),
    ).toThrow();
  });
  it('processes repeated signed opt-outs once', () => {
    const input = { type: 'unsubscribe', sender: '61412345678' },
      rawBody = Buffer.from(JSON.stringify(input)),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'test-signing-secret')
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const req = {
      rawBody,
      headers: { 'x-mm-timestamp': timestamp, 'x-mm-signature': signature },
    } as any;
    controller.sms(req, input);
    controller.sms(req, input);
    expect(store.all('SELECT * FROM suppressions')).toHaveLength(1);
  });
});
