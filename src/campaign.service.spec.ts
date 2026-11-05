import { randomUUID } from 'node:crypto';
import { CampaignService, mobileNumber } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { testStore, clearTestStore, closeTestStore } from './testing/mongo';

jest.setTimeout(60000);
describe('MongoDB campaign controls', () => {
  let store: CampaignStore, service: CampaignService;
  const originalEnv = { ...process.env };
  const row = {
    mobile: '0412345678',
    firstName: 'Alex',
    consent: 'express',
    evidence: 'Authorised test fixture',
    dealerSocketContactId: '55858',
  };
  beforeAll(async () => {
    store = await testStore();
  });
  beforeEach(async () => {
    service = new CampaignService(store);
    process.env.CAMPAIGN_SEND_ENABLED = 'false';
    process.env.SMS_CHANNEL_MODE = 'two_way';
    process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED = 'true';
    process.env.DEALERSOCKET_WORKER_MODE = 'chrome';
    process.env.MOBILEMESSAGE_FROM = '+61468104118';
    await service.acceptChromeCatalog({
      siteId: '10876',
      name: 'South Morang Hyundai',
      users: [
        { value: 'sm', text: 'Sales Manager' },
        { value: 'gm', text: 'General Manager' },
      ],
      franchises: [{ key: 1, value: 'South Morang Hyundai' }],
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    service?.onModuleDestroy();
    if (store) await clearTestStore(store);
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
  });
  async function message() {
    await service.importContacts({ rows: [row] });
    const contact = (await store.one('contacts', { mobile: '+61412345678' }))!;
    const campaign = await service.createCampaign({
      name: 'Test campaign',
      body: 'Booran test {link} {optout}',
    });
    const msg = {
      id: randomUUID(),
      campaignId: campaign.id,
      contactId: contact.id,
      token: randomUUID(),
      status: 'sent',
      providerId: 'provider-fixture',
      clicks: 0,
      createdAt: new Date().toISOString(),
    };
    await store.insert('messages', msg);
    return msg;
  }
  it('normalises Australian mobiles and rejects invalid numbers', () => {
    expect(mobileNumber('0412 345 678')).toBe('+61412345678');
    expect(() => mobileNumber('0399999999')).toThrow();
  });
  it('deduplicates imports and rejects missing consent evidence', async () => {
    const result = await service.importContacts({
      rows: [
        row,
        { ...row, mobile: '+61412345678' },
        { ...row, evidence: '', mobile: '0412345679' },
      ],
    });
    expect(result).toMatchObject({ imported: 1, duplicates: 1 });
    expect(result.rejected).toHaveLength(1);
  });
  it('serialises concurrent imports without duplicate contacts', async () => {
    const results = await Promise.all([
      service.importContacts({ rows: [row] }),
      service.importContacts({ rows: [row] }),
    ]);
    expect(results.reduce((n, r) => n + r.imported, 0)).toBe(1);
    expect(await store.count('contacts')).toBe(1);
  });
  it('rolls back registration, suppression and outbox together', async () => {
    jest
      .spyOn(store, 'audit')
      .mockRejectedValueOnce(new Error('Simulated database write failure'));
    await expect(
      service.captureLead({ ...row, eventId: 'rollback' }),
    ).rejects.toThrow();
    expect(await store.count('leads')).toBe(0);
    expect(await store.count('suppressions')).toBe(0);
    expect(await store.count('outbox')).toBe(0);
  });
  it('registers concurrent retries once and rejects conflicting event IDs', async () => {
    const input = { ...row, eventId: 'same-event' };
    const results = await Promise.all([
      service.captureLead(input),
      service.captureLead(input),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await store.count('outbox')).toBe(1);
    await expect(
      service.captureLead({ ...input, mobile: '0412345679' }),
    ).rejects.toThrow();
  });
  it('preserves suppression when contacts are imported later', async () => {
    await service.suppress(row.mobile, 'STOP reply');
    await service.importContacts({ rows: [row] });
    expect((await service.dashboard()).metrics.eligible).toBe(0);
  });
  it('attributes a forwarded registration and suppresses both mobiles', async () => {
    const msg = await message();
    const lead = await service.captureLead({
      ...row,
      mobile: '0412345679',
      eventId: 'forwarded',
      token: msg.token,
    });
    expect((await store.one('leads', { id: lead.id }))?.campaignId).toBe(
      msg.campaignId,
    );
    expect(await store.count('suppressions')).toBe(2);
  });
  it('records STOP even when already suppressed by a registration', async () => {
    await service.captureLead({ ...row, eventId: 'already-lead' });
    await service.suppress(row.mobile, 'Provider opt-out');
    expect(
      (await store.one('suppressions', { mobile: '+61412345678' }))?.optOut,
    ).toBe(1);
  });
  it('cancels queued messages on suppression', async () => {
    const msg = await message();
    await store.update(
      'messages',
      { id: msg.id },
      { $set: { status: 'queued' } },
    );
    await service.suppress(row.mobile, 'STOP');
    expect((await store.one('messages', { id: msg.id }))?.status).toBe(
      'suppressed',
    );
  });
  it('requires distinct verified manager assignments', async () => {
    await expect(
      service.saveRouting({ salesManager: 'sm', generalManager: 'sm' }),
    ).rejects.toThrow();
    await expect(
      service.saveRouting({ salesManager: 'sm', generalManager: 'absent' }),
    ).rejects.toThrow();
    await service.saveRouting({ salesManager: 'sm', generalManager: 'gm' });
    expect((await service.routing()).generalManager).toBe('gm');
  });
  it('rejects another dealership catalog or snapshot', async () => {
    await expect(
      service.acceptChromeCatalog({ siteId: 'other', users: [] }),
    ).rejects.toThrow();
    await expect(
      service.acceptChromeSnapshot({ scope: 'cranbourne', records: [] }),
    ).rejects.toThrow();
  });
  it('stores scoped Chrome snapshots in MongoDB', async () => {
    await service.acceptChromeSnapshot({
      scope: 'south_morang_hyundai',
      readOnly: true,
      records: [],
    });
    expect((await service.chromeSnapshot()).scope).toBe('south_morang_hyundai');
    expect(await store.setting('chrome-snapshot')).toBeTruthy();
  });
  it('claims one CRM job and reconciles concurrent workers', async () => {
    process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED = 'true';
    await service.saveRouting({ salesManager: 'sm', generalManager: 'gm' });
    const lead = await service.captureLead({ ...row, eventId: 'crm-job' });
    const jobs: any[] = await Promise.all([
      service.claimChromeJob({ authenticated: true }),
      service.claimChromeJob({ authenticated: true }),
    ]);
    expect(jobs.every((j) => j.leadId === lead.id)).toBe(true);
    expect(jobs.filter((j) => !j.reconcile)).toHaveLength(1);
    await expect(
      service.finishChromeJob(lead.id, { state: 'synced', opportunityId: '0' }),
    ).rejects.toThrow();
    await service.finishChromeJob(lead.id, {
      state: 'synced',
      opportunityId: '162549',
      contactId: '55858',
    });
    await service.finishChromeJob(lead.id, {
      state: 'synced',
      opportunityId: '162549',
    });
    expect((await service.dashboard()).metrics.pending).toBe(0);
    expect(await store.setting('crm-opportunity:55858')).toBe('162549');
  });
  it('requires an authenticated enabled worker', async () => {
    process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED = 'false';
    await service.captureLead({ ...row, eventId: 'gated' });
    expect(
      ((await service.claimChromeJob({ authenticated: true })) as any).leadId,
    ).toBeUndefined();
  });
  it('links unresolved customers and blocks changes during writes', async () => {
    const lead = await service.captureLead({ ...row, eventId: 'link' });
    await store.update(
      'outbox',
      { leadId: lead.id },
      { $set: { status: 'needs_match' } },
    );
    await service.linkCustomer(lead.id, { contactId: '55858' });
    expect((await store.one('outbox', { leadId: lead.id }))?.status).toBe(
      'pending_configuration',
    );
    await store.update(
      'outbox',
      { leadId: lead.id },
      { $set: { status: 'writing' } },
    );
    await expect(
      service.linkCustomer(lead.id, { contactId: '55859' }),
    ).rejects.toThrow();
  });
  it('deduplicates inbound replies and excludes other sender numbers', async () => {
    const reply = {
      to: '61468104118',
      from: '61412345678',
      type: 'inbound',
      message: 'STOP',
      received_at: '2026-11-04 09:00:00',
    };
    await service.acceptInbound(reply);
    await service.acceptInbound(reply);
    await service.acceptInbound({ ...reply, to: '61400000000' });
    expect(await store.count('sms_inbound')).toBe(1);
    expect(await store.count('sms_activity')).toBe(0);
    expect(await store.count('suppressions')).toBe(1);
  });
  it('queues only inbound conversations linked to campaigns', async () => {
    const msg = await message();
    await service.acceptInbound({
      to: '61468104118',
      sender: '61412345678',
      type: 'inbound',
      message: 'Interested',
      received_at: '2026-11-04 10:00:00',
      original_custom_ref: msg.id,
    });
    expect(await store.count('sms_activity')).toBe(1);
  });
  it('deduplicates SMS activity and prevents unsafe relinking', async () => {
    process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED = 'true';
    await service.queueSmsActivity(
      'source',
      row.mobile,
      'outbound',
      'Test',
      '55858',
      '162549',
    );
    await service.queueSmsActivity(
      'source',
      row.mobile,
      'outbound',
      'Test',
      '55858',
      '162549',
    );
    const job: any = await service.claimSmsActivity({ authenticated: true });
    expect(await store.count('sms_activity')).toBe(1);
    expect(
      ((await service.claimSmsActivity({ authenticated: true })) as any)
        .reconcile,
    ).toBe(true);
    await expect(
      service.linkSmsActivity(job.id, {
        contactId: '55858',
        opportunityId: '162549',
      }),
    ).rejects.toThrow();
    await service.finishSmsActivity(job.id, { state: 'synced' });
    expect((await service.smsInbox()).activities[0].status).toBe('synced');
  });
  it('blocks campaign sending before configuration', async () => {
    const c = await service.createCampaign({
      name: 'Offer',
      body: 'Booran {link} {optout}',
    });
    await service.approve(c.id);
    await expect(service.send(c.id)).rejects.toThrow();
  });
  it('sends an approved campaign once with concurrent dispatches', async () => {
    Object.assign(process.env, {
      CAMPAIGN_SEND_ENABLED: 'true',
      SMS_SENDER_REGISTERED: 'true',
      PUBLIC_PORTAL_URL: 'https://example.test',
      MOBILEMESSAGE_API_USERNAME: 'fixture',
      MOBILEMESSAGE_API_PASSWORD: 'fixture',
    });
    await service.importContacts({ rows: [row] });
    const c = await service.createCampaign({
      name: 'Offer',
      body: 'Booran {link} {optout}',
    });
    await service.approve(c.id);
    const provider = jest
      .spyOn(service, 'provider')
      .mockImplementation(async (path) =>
        path === 'senders'
          ? { results: [{ sender: '61468104118' }] }
          : { results: [{ status: 'success', message_id: 'mock-sent' }] },
      );
    const results = await Promise.allSettled([
      service.send(c.id),
      service.send(c.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(provider.mock.calls.filter((c) => c[0] === 'messages')).toHaveLength(
      1,
    );
    expect(await store.count('sms_activity')).toBe(1);
    expect((await service.dashboard()).metrics.sent).toBe(1);
  });
  it('retains ambiguous sends without retrying', async () => {
    Object.assign(process.env, {
      CAMPAIGN_SEND_ENABLED: 'true',
      SMS_SENDER_REGISTERED: 'true',
      PUBLIC_PORTAL_URL: 'https://example.test',
      MOBILEMESSAGE_API_USERNAME: 'fixture',
      MOBILEMESSAGE_API_PASSWORD: 'fixture',
    });
    await service.importContacts({ rows: [row] });
    const c = await service.createCampaign({
      name: 'Offer',
      body: 'Booran {link} {optout}',
    });
    await service.approve(c.id);
    jest.spyOn(service, 'provider').mockImplementation(async (path) => {
      if (path === 'senders') return { results: [{ sender: '61468104118' }] };
      throw new Error('timeout');
    });
    expect((await service.send(c.id)).uncertain).toBe(1);
    await expect(service.send(c.id)).rejects.toThrow();
    expect(await store.count('messages', { status: 'unknown' })).toBe(1);
  });
  it('enforces the frequency limit across separate campaigns', async () => {
    Object.assign(process.env, { CAMPAIGN_SEND_ENABLED: 'true', SMS_SENDER_REGISTERED: 'true', PUBLIC_PORTAL_URL: 'https://example.test', MOBILEMESSAGE_API_USERNAME: 'fixture', MOBILEMESSAGE_API_PASSWORD: 'fixture' });
    await service.importContacts({ rows: [row] });
    const provider = jest.spyOn(service, 'provider').mockImplementation(async path => path === 'senders' ? { results: [{ sender: '61468104118' }] } : { results: [{ status: 'success', message_id: 'mock-frequency' }] });
    for (const name of ['First', 'Second']) {
      const campaign = await service.createCampaign({ name, body: 'Booran {link} {optout}' });
      await service.approve(campaign.id); await service.send(campaign.id);
    }
    expect(provider.mock.calls.filter(c => c[0] === 'messages')).toHaveLength(1);
    expect(await store.count('messages', { status: 'frequency_limited' })).toBe(1);
    expect((await service.dashboard()).metrics.eligible).toBe(0);
  });
  it('sends a configured test recipient only once and enforces cooldown', async () => {
    Object.assign(process.env, { SMS_TEST_SEND_ENABLED: 'true', MOBILEMESSAGE_TEST_RECIPIENT: '+61499918523' });
    const provider = jest.spyOn(service, 'provider').mockImplementation(async path => path === 'senders' ? { results: [{ sender: '61468104118' }] } : { results: [{ status: 'success', message_id: 'mock-test' }] });
    const input = { requestId: randomUUID() };
    expect((await service.sendTest(input))?.status).toBe('sent');
    await service.sendTest(input);
    await expect(service.sendTest({ requestId: randomUUID() })).rejects.toThrow('Wait one minute');
    const posts = provider.mock.calls.filter(c => c[0] === 'messages');
    expect(posts).toHaveLength(1);
    expect((posts[0][2] as any).messages[0].to).toBe('61499918523');
    expect(await store.count('contacts')).toBe(0);
  });
  it('never sends a connection test to a suppressed recipient', async () => {
    Object.assign(process.env, { SMS_TEST_SEND_ENABLED: 'true', MOBILEMESSAGE_TEST_RECIPIENT: '+61499918523' });
    await service.suppress('+61499918523', 'STOP');
    const provider = jest.spyOn(service, 'provider').mockResolvedValue({ results: [{ sender: '61468104118' }] });
    await expect(service.sendTest({ requestId: randomUUID() })).rejects.toThrow('suppressed');
    expect(provider.mock.calls.every(c => c[0] === 'senders')).toBe(true);
  });
  it('renders one-way invitations with a landing link and web opt-out, without creating enquiry or conversation jobs', async () => {
    Object.assign(process.env, { SMS_CHANNEL_MODE: 'one_way', CAMPAIGN_SEND_ENABLED: 'true', SMS_SENDER_REGISTERED: 'true', PUBLIC_PORTAL_URL: 'https://loyalty.example.test', MOBILEMESSAGE_API_USERNAME: 'fixture', MOBILEMESSAGE_API_PASSWORD: 'fixture' });
    await service.importContacts({ rows: [row] });
    const campaign = await service.createCampaign({ name: 'One-way invitation', body: 'Booran loyalty offer {link} {optout}' });
    await service.approve(campaign.id);
    const provider = jest.spyOn(service, 'provider').mockImplementation(async path => path === 'senders' ? { results: [{ sender: '61468104118' }] } : { results: [{ status: 'success', message_id: 'one-way-fixture' }] });
    await service.send(campaign.id);
    const msg = (await store.one('messages', { campaignId: campaign.id }))!;
    const payload = provider.mock.calls.find(c => c[0] === 'messages')![2] as any;
    expect(payload.messages[0].message).toContain(`/r/${msg.token}`);
    expect(payload.messages[0].message).toContain(`/unsubscribe/${msg.token}`);
    expect(payload.messages[0].message).not.toMatch(/\{optout\}|reply stop/i);
    expect(await store.count('leads')).toBe(0);
    expect(await store.count('outbox')).toBe(0);
    expect(await store.count('sms_activity')).toBe(0);
  });
  it('does not unsubscribe on link preview and suppresses idempotently on confirmation', async () => {
    const msg = await message();
    await store.update('messages', { id: msg.id }, { $set: { status: 'queued' } });
    const preview = await service.unsubscribeStatus(msg.token);
    expect(preview.maskedMobile).not.toBe('+61412345678');
    expect(await store.count('suppressions')).toBe(0);
    await service.unsubscribe(msg.token); await service.unsubscribe(msg.token);
    expect(await store.count('suppressions')).toBe(1);
    expect((await store.one('messages', { id: msg.id }))?.status).toBe('suppressed');
    expect((await store.one('suppressions', { mobile: '+61412345678' }))?.optOut).toBe(1);
  });
  it('rejects invalid and unknown unsubscribe tokens without modifying customer preferences', async () => {
    await expect(service.unsubscribe('invalid')).rejects.toThrow();
    await expect(service.unsubscribe(randomUUID())).rejects.toThrow();
    expect(await store.count('suppressions')).toBe(0);
  });
  it('keeps DealerSocket and GoodShowroom delivery independent and suppresses on form registration', async () => {
    Object.assign(process.env, { SMS_CHANNEL_MODE: 'one_way', DEALERSOCKET_CAMPAIGN_WRITES_ENABLED: 'true' });
    await service.saveRouting({ salesManager: 'sm', generalManager: 'gm' });
    const input = { ...row, eventId: 'dual-crm-form', contactConsent: true, existingCustomer: true };
    const lead = await service.captureLead(input); await service.captureLead(input);
    expect(await store.count('outbox')).toBe(1);
    expect((await store.one('leads', { id: lead.id }))?.source).toBe('loyalty_landing_page');
    expect(await store.count('suppressions')).toBe(1);
    await service.claimChromeJob({ authenticated: true });
    await service.finishChromeJob(lead.id, { state: 'synced', opportunityId: '162549', contactId: '55858' });
    const portal = await service.dashboard();
    expect(portal.leads[0]).toMatchObject({ crmStatus: 'synced', goodshowroomStatus: 'pending_configuration' });
    expect(portal.metrics.pendingDealerSocket).toBe(0);
    expect(portal.metrics.pendingGoodshowroom).toBe(1);
  });
  it('ignores conversational replies in one-way mode but still honours legacy opt-outs', async () => {
    process.env.SMS_CHANNEL_MODE = 'one_way';
    const reply = { to: '61468104118', from: '61412345678', type: 'inbound', message: 'Interested', received_at: '2026-11-05 10:00:00' };
    await service.acceptInbound(reply);
    expect(await store.count('sms_inbound')).toBe(0);
    expect(await store.count('leads')).toBe(0);
    await service.acceptInbound({ ...reply, message: 'STOP' });
    expect(await store.count('suppressions')).toBe(1);
    expect(await service.claimSmsActivity({ authenticated: true })).toEqual({});
  });
  it('does not expose historical conversations or call the inbox provider in one-way mode', async () => {
    await store.insert('sms_inbound', { id: 'historic', body: 'Historical conversation', receivedAt: '2026-11-04' });
    process.env.SMS_CHANNEL_MODE = 'one_way';
    const provider = jest.spyOn(service, 'provider');
    expect((await service.smsInbox(true)).results).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
    expect(await store.count('sms_inbound')).toBe(1);
  });
  it('blocks Reply STOP copy and requires public HTTPS URLs for one-way tests', async () => {
    process.env.SMS_CHANNEL_MODE = 'one_way';
    await expect(service.createCampaign({ name: 'Invalid copy', body: 'Booran {link} Reply STOP {optout}' })).rejects.toThrow('One-way SMS');
    for (const url of ['', 'http://localhost:3001', 'https://localhost:3001']) {
      process.env.PUBLIC_PORTAL_URL = url;
      expect(service.readiness().publicUrl).toBe(false);
    }
    process.env.SMS_TEST_SEND_ENABLED = 'true';
    process.env.MOBILEMESSAGE_TEST_RECIPIENT = '+61499918523';
    await expect(service.sendTest({ requestId: randomUUID() })).rejects.toThrow('public HTTPS');
  });
  it('counts tracking visits using atomic increments', async () => {
    const msg = await message();
    await Promise.all([service.track(msg.token), service.track(msg.token)]);
    expect((await service.dashboard()).metrics.clicks).toBe(2);
  });
  it('waits for all delivery parts and ignores stale receipts', async () => {
    const msg = await message();
    const input = {
      message_id: msg.providerId,
      part_number: 1,
      total_parts: 2,
      status: 'delivered',
      received_at: '2026-11-04 10:00:00',
    };
    await service.recordReceipt(input);
    expect((await store.one('messages', { id: msg.id }))?.status).toBe('sent');
    await service.recordReceipt({ ...input, part_number: 2 });
    await service.recordReceipt({
      ...input,
      status: 'failed',
      received_at: '2026-11-04 09:00:00',
    });
    expect((await store.one('messages', { id: msg.id }))?.status).toBe(
      'delivered',
    );
  });
});
