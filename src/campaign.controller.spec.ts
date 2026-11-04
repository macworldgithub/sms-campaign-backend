import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { createHmac } from 'node:crypto';
import { testStore, clearTestStore, closeTestStore } from './testing/mongo';

jest.setTimeout(60000);
describe('MongoDB webhook and portal authentication', () => {
  let store: CampaignStore, controller: CampaignController;
  const previous = process.env.MOBILEMESSAGE_WEBHOOK_SECRET;
  beforeAll(async () => {
    store = await testStore();
  });
  beforeEach(() => {
    process.env.MOBILEMESSAGE_WEBHOOK_SECRET = 'test-signing-secret';
    controller = new CampaignController(new CampaignService(store));
  });
  afterEach(async () => {
    if (store) await clearTestStore(store);
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
    if (previous === undefined) delete process.env.MOBILEMESSAGE_WEBHOOK_SECRET;
    else process.env.MOBILEMESSAGE_WEBHOOK_SECRET = previous;
  });
  it('rejects unauthenticated portal reads', () => {
    expect(() => controller.dashboard('wrong')).toThrow();
  });
  it('rejects unsigned SMS callbacks', async () => {
    await expect(
      controller.sms({ headers: {} } as any, {
        type: 'unsubscribe',
        sender: '61412345678',
      }),
    ).rejects.toThrow();
  });
  it('processes signed repeated opt-outs idempotently in MongoDB', async () => {
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
    await controller.sms(req, input);
    await controller.sms(req, input);
    expect(await store.count('suppressions')).toBe(1);
  });
  it('rejects stale webhook signatures', async () => {
    const rawBody = Buffer.from('{}'),
      timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = createHmac('sha256', 'test-signing-secret')
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    await expect(
      controller.sms(
        {
          rawBody,
          headers: { 'x-mm-timestamp': timestamp, 'x-mm-signature': signature },
        } as any,
        {},
      ),
    ).rejects.toThrow();
  });
});
