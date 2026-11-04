import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CampaignStore } from '../src/campaign.store';
import { testStore, closeTestStore } from '../src/testing/mongo';

jest.setTimeout(60000);
describe('MongoDB HTTP integration', () => {
  let app: INestApplication, store: CampaignStore;
  const old = { ...process.env };
  const key = 'isolated-http-test-key-000000000000000000';
  beforeAll(async () => {
    store = await testStore();
    Object.assign(process.env, {
      PORTAL_API_KEY: key,
      LEAD_WEBHOOK_KEY: key,
      SMS_INBOX_POLL_ENABLED: 'false',
      DEALERSOCKET_CAMPAIGN_WRITES_ENABLED: 'false',
      DEALERSOCKET_SMS_ACTIVITY_ENABLED: 'false',
      CAMPAIGN_SEND_ENABLED: 'false',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CampaignStore)
      .useValue(store)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
    if (app) await app.close();
    for (const k of Object.keys(process.env))
      if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
  });
  it('reports MongoDB health', async () => {
    const r = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(r.body.storage).toBe('mongodb');
  });
  it('rejects unauthenticated operations and unsigned callbacks', async () => {
    await request(app.getHttpServer()).get('/api/portal').expect(401);
    await request(app.getHttpServer())
      .post('/api/webhooks/sms')
      .send({ type: 'inbound' })
      .expect(401);
  });
  it('persists registration, suppression and CRM state through HTTP', async () => {
    const input = {
      firstName: 'HTTP',
      lastName: 'Fixture',
      mobile: '0412345678',
      eventId: 'http-fixture',
    };
    const first = await request(app.getHttpServer())
      .post('/api/webhooks/leads')
      .set('X-Webhook-Key', key)
      .send(input)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/webhooks/leads')
      .set('X-Webhook-Key', key)
      .send(input)
      .expect(201);
    expect(first.body.id).toBe(retry.body.id);
    const portal = await request(app.getHttpServer())
      .get('/api/portal')
      .set('X-Portal-Key', key)
      .expect(200);
    expect(portal.body.metrics).toMatchObject({
      leads: 1,
      suppressed: 1,
      pending: 1,
    });
    expect(portal.body.leads[0].crmStatus).toBe('pending_configuration');
  });
});
