import { CampaignService } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { testStore, clearTestStore, closeTestStore } from './testing/mongo';
jest.setTimeout(120000);
describe('Durable dispatch and recovery', () => {
  let store: CampaignStore, service: CampaignService;
  const original = { ...process.env };
  const row = (index: number) => ({
    mobile: '04' + String(10000000 + index),
    firstName: 'Fixture',
    consent: 'express',
    evidence: 'Test permission; mocked delivery only',
  });
  beforeAll(async () => {
    store = await testStore();
  });
  beforeEach(async () => {
    Object.assign(process.env, {
      SMS_CHANNEL_MODE: 'one_way',
      CAMPAIGN_SEND_ENABLED: 'true',
      SMS_SENDER_REGISTERED: 'true',
      PUBLIC_PORTAL_URL: 'https://loyalty.example.test',
      MOBILEMESSAGE_FROM: '+61468104118',
      MOBILEMESSAGE_API_USERNAME: 'fixture',
      MOBILEMESSAGE_API_PASSWORD: 'fixture',
      DEALERSOCKET_WORKER_MODE: 'chrome',
    });
    service = new CampaignService(store);
    await service.saveSettings({
      offerName: 'Fixture',
      offerDetails: 'Test only',
      eligibility: 'Authorised fixtures',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      clientApprovalConfirmed: true,
    });
  });
  afterEach(async () => {
    service?.onModuleDestroy();
    jest.restoreAllMocks();
    if (store) await clearTestStore(store);
    for (const k of Object.keys(process.env))
      if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
  });
  async function queued(size = 3) {
    await service.importContacts({
      rows: Array.from({ length: size }, (_, i) => row(i)),
    });
    const campaign = await service.createCampaign({
      name: 'Fixture campaign',
      body: 'Booran test {link} {optout}',
    });
    await service.approve(campaign.id);
    const result = await service.send(campaign.id);
    return { ...result, campaign };
  }
  it('queues 10,000 consented recipients without making provider calls in the request', async () => {
    const provider = jest.spyOn(service, 'provider');
    const job = await queued(10000);
    expect(job.status).toBe('queued');
    expect(provider).not.toHaveBeenCalled();
    expect(
      await store.count('messages', {
        campaignId: job.campaignId,
        status: 'queued',
      }),
    ).toBe(10000);
    expect(
      (await store.one('dispatch_jobs', { id: job.jobId }))?.remaining,
    ).toBe(10000);
  });
  it('pauses between attempts and resumes after a worker restart without duplicate sends', async () => {
    const job = await queued();
    let sent = 0;
    const handler = async (path: string) => {
      if (path === 'senders') return { results: [{ sender: '61468104118' }] };
      sent++;
      if (sent === 1) await service.controlDispatch(job.campaignId, 'pause');
      return { results: [{ status: 'success', message_id: 'mock-' + sent }] };
    };
    jest.spyOn(service, 'provider').mockImplementation(handler);
    await service.runDispatchOnce();
    expect((await store.one('dispatch_jobs', { id: job.jobId }))?.status).toBe(
      'paused',
    );
    expect(sent).toBe(1);
    await service.controlDispatch(job.campaignId, 'resume');
    const restarted = new CampaignService(store);
    jest.spyOn(restarted, 'provider').mockImplementation(handler);
    await restarted.runDispatchOnce();
    expect(sent).toBe(3);
    expect((await store.one('dispatch_jobs', { id: job.jobId }))?.status).toBe(
      'completed',
    );
  });
  it('reconciles expired leases without replaying an interrupted provider attempt', async () => {
    const job = await queued(2);
    const messages = await store.find('messages', {
      campaignId: job.campaignId,
    });
    await store.update(
      'dispatch_jobs',
      { id: job.jobId },
      {
        $set: {
          status: 'running',
          owner: 'dead-worker',
          leaseUntil: new Date(Date.now() - 1000),
        },
      },
    );
    await store.update(
      'messages',
      { id: messages[0].id },
      { $set: { status: 'sending' } },
    );
    const provider = jest
      .spyOn(service, 'provider')
      .mockImplementation(async (path) =>
        path === 'senders'
          ? { results: [{ sender: '61468104118' }] }
          : { results: [{ status: 'success', message_id: 'safe-remaining' }] },
      );
    await service.runDispatchOnce();
    expect(provider.mock.calls.filter((c) => c[0] === 'messages')).toHaveLength(
      1,
    );
    expect((await store.one('messages', { id: messages[0].id }))?.status).toBe(
      'unknown',
    );
    expect((await store.one('dispatch_jobs', { id: job.jobId }))?.status).toBe(
      'needs_review',
    );
    await expect(
      service.controlDispatch(job.campaignId, 'resume'),
    ).rejects.toThrow('No unsent queued');
  });
  it('uses matching provider evidence to resolve uncertainty, never to resend', async () => {
    const job = await queued(1);
    const message = (await store.one('messages', {
      campaignId: job.campaignId,
    }))!;
    await store.update(
      'messages',
      { id: message.id },
      { $set: { status: 'unknown' } },
    );
    const contact = (await store.one('contacts', { id: message.contactId }))!;
    const provider = jest
      .spyOn(service, 'provider')
      .mockResolvedValue({ results: [] });
    expect((await service.reconcileMessage(message.id)).reconciled).toBe(false);
    provider.mockResolvedValueOnce({
      results: [
        {
          custom_ref: message.id,
          to: contact.mobile.slice(1),
          sender: '61468104118',
          status: 'delivered',
          message_id: 'verified-provider',
        },
      ],
    });
    expect((await service.reconcileMessage(message.id)).reconciled).toBe(true);
    expect((await store.one('messages', { id: message.id }))?.status).toBe(
      'delivered',
    );
    expect(
      provider.mock.calls.every((c) => c[0].startsWith('messages?custom_ref=')),
    ).toBe(true);
  });
  it('refuses wrong-recipient provider evidence', async () => {
    const job = await queued(1);
    const message = (await store.one('messages', {
      campaignId: job.campaignId,
    }))!;
    await store.update(
      'messages',
      { id: message.id },
      { $set: { status: 'unknown' } },
    );
    jest
      .spyOn(service, 'provider')
      .mockResolvedValue({
        results: [
          {
            custom_ref: message.id,
            to: '61499999999',
            sender: '61468104118',
            status: 'delivered',
          },
        ],
      });
    expect((await service.reconcileMessage(message.id)).reconciled).toBe(false);
    expect((await store.one('messages', { id: message.id }))?.status).toBe(
      'unknown',
    );
  });
  it('records explicit operator CRM evidence and keeps GoodShowroom independent', async () => {
    const lead = await service.captureLead({
      mobile: row(0).mobile,
      firstName: 'Fixture',
      eventId: 'reviewed-crm',
      dealerSocketContactId: '55858',
    });
    await store.update(
      'outbox',
      { leadId: lead.id },
      { $set: { status: 'needs_review' } },
    );
    await expect(
      service.reconcileCrm(lead.id, { outcome: 'confirmed_not_saved' }),
    ).rejects.toThrow('evidence');
    await service.reconcileCrm(lead.id, {
      outcome: 'confirmed_not_saved',
      evidence: 'CRM marker and customer checked; no opportunity was created.',
    });
    const pending = await store.one('outbox', { leadId: lead.id });
    expect(pending?.status).toBe('pending_configuration');
    expect(pending?.journalResetRequested).toBe(true);
    expect(pending?.goodshowroomStatus).toBe('pending_configuration');
  });
  it('pauses CRM claims when Chrome authentication expires', async () => {
    const result = await service.claimChromeJob({ authenticated: false });
    expect((result as any).leadId).toBeUndefined();
    expect((await service.chromeStatus()).state).toBe('login_required');
  });
  it('uses Melbourne end-of-day expiry with the seasonal UTC offset', async () => {
    const futureYear = new Date().getUTCFullYear() + 1;
    const summer = await service.saveSettings({
      offerName: 'Summer',
      offerDetails: 'Fixture',
      eligibility: 'Fixture',
      expiresAt: `${futureYear}-01-15`,
      clientApprovalConfirmed: true,
    });
    const winter = await service.saveSettings({
      offerName: 'Winter',
      offerDetails: 'Fixture',
      eligibility: 'Fixture',
      expiresAt: `${futureYear}-07-15`,
      clientApprovalConfirmed: true,
    });
    expect(summer.expiresAt).toBe(`${futureYear}-01-15T12:59:59.000Z`);
    expect(winter.expiresAt).toBe(`${futureYear}-07-15T13:59:59.000Z`);
  });
});
