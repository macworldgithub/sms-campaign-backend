import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CampaignStore } from '../src/campaign.store';
import { testStore, closeTestStore } from '../src/testing/mongo';

jest.setTimeout(60000);
describe('MongoDB HTTP integration', () => {
  let app: INestApplication, store: CampaignStore;
  let token = '';
  const old = { ...process.env };
  const key = 'isolated-http-test-key-000000000000000000';
  beforeAll(async () => {
    store = await testStore();
    Object.assign(process.env, {
      PORTAL_API_KEY: key,
      PORTAL_BOOTSTRAP_USERNAME: 'admin',
      PORTAL_BOOTSTRAP_PASSWORD: 'Test administrator password 123',
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
    const auth = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set({ 'X-Portal-Key': key })
      .send({ username: 'admin', password: 'Test administrator password 123' })
      .expect(201);
    token = auth.body.token;
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
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(portal.body.metrics).toMatchObject({
      leads: 1,
      suppressed: 1,
      pending: 1,
    });
    expect(portal.body.leads[0].crmStatus).toBe('pending_configuration');
  });
  it('enforces staff roles over HTTP and revokes disabled accounts', async () => {
    const admin = { 'X-Portal-Key': key, Authorization: 'Bearer ' + token };
    await request(app.getHttpServer())
      .post('/api/users')
      .set(admin)
      .send({
        username: 'http.viewer',
        name: 'HTTP Viewer',
        role: 'viewer',
        active: true,
        password: 'Viewer temporary password 123',
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Portal-Key', key)
      .send({
        username: 'http.viewer',
        password: 'Viewer temporary password 123',
      })
      .expect(201);
    const viewer = {
      'X-Portal-Key': key,
      Authorization: 'Bearer ' + login.body.token,
    };
    await request(app.getHttpServer())
      .get('/api/portal')
      .set(viewer)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/auth/password')
      .set(viewer)
      .send({
        currentPassword: 'Viewer temporary password 123',
        newPassword: 'Viewer permanent password 456',
      })
      .expect(201);
    const next = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Portal-Key', key)
      .send({
        username: 'http.viewer',
        password: 'Viewer permanent password 456',
      })
      .expect(201);
    viewer.Authorization = 'Bearer ' + next.body.token;
    await request(app.getHttpServer())
      .get('/api/portal')
      .set(viewer)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/settings')
      .set(viewer)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/users')
      .set(admin)
      .send({
        username: 'http.viewer',
        name: 'HTTP Viewer',
        role: 'viewer',
        active: false,
      })
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/portal')
      .set(viewer)
      .expect(401);
  });
  it('rejects a public registration when the offer has not been approved', async () => {
    const config = await request(app.getHttpServer())
      .get('/api/public/config')
      .expect(200);
    expect(config.body.active).toBe(false);
    await request(app.getHttpServer())
      .post('/api/webhooks/leads')
      .set('X-Webhook-Key', key)
      .send({
        firstName: 'Expired',
        mobile: '0412345679',
        requireActiveOffer: true,
      })
      .expect(400);
    expect(await store.count('leads', { mobile: '+61412345679' })).toBe(0);
  });
  it('opens the main-page customer view from campaign links and preserves attribution', async () => {
    const previous = process.env.PUBLIC_PORTAL_URL;
    process.env.PUBLIC_PORTAL_URL = 'https://loyalty.example.test';
    try {
      await store.insert('contacts', { id: 'tracking-contact', mobile: '+61412345679' });
      await store.insert('messages', { id: 'tracking-message', contactId: 'tracking-contact', campaignId: 'tracking-campaign', token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clicks: 0 });
      const result = await request(app.getHttpServer()).get('/api/tracking/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').expect(302);
      const target = new URL(result.headers.location);
      expect(target.pathname).toBe('/');
      expect(target.searchParams.get('view')).toBe('customer');
      expect(target.searchParams.get('ref')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(target.searchParams.get('utm_campaign')).toBe('tracking-campaign');
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_PORTAL_URL;
      else process.env.PUBLIC_PORTAL_URL = previous;
    }
  });
});
