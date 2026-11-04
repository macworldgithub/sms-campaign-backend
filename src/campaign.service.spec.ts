import { CampaignService, mobileNumber } from './campaign.service';
import { CampaignStore } from './campaign.store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Campaign controls', () => {
  let store: CampaignStore, service: CampaignService, directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'campaign-test-'));
    process.env.CAMPAIGN_DB = join(directory, 'test.sqlite');
    store = new CampaignStore();
    service = new CampaignService(store);
  });
  afterEach(() => {
    store.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.CAMPAIGN_DB;
  });
  const row = {
    mobile: '0412345678',
    firstName: 'Alex',
    consent: 'express',
    evidence: 'Customer opt-in record 123',
  };
  it('stores only the configured sender replies, deduplicates and suppresses STOP', () => {
    const original = process.env.MOBILEMESSAGE_FROM;
    process.env.MOBILEMESSAGE_FROM = '+61468104118';
    try {
      const reply = { to: '61468104118', from: '61412345678', message: 'STOP', type: 'inbound', received_at: '2026-11-04 09:00:00' };
      service.acceptInbound(reply);
      service.acceptInbound(reply);
      service.acceptInbound({ ...reply, to: '61400000000', from: '61412345679' });
      expect(store.all('SELECT * FROM sms_inbound')).toHaveLength(1);
      expect(store.all('SELECT * FROM suppressions')).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.MOBILEMESSAGE_FROM;
      else process.env.MOBILEMESSAGE_FROM = original;
    }
  });
  it('sends a test only to the configured recipient and never duplicates a repeated request', async () => {
    const keys = ['MOBILEMESSAGE_FROM', 'MOBILEMESSAGE_TEST_RECIPIENT', 'SMS_TEST_SEND_ENABLED'];
    const originals = keys.map(key => process.env[key]);
    Object.assign(process.env, { MOBILEMESSAGE_FROM: '+61468104118', MOBILEMESSAGE_TEST_RECIPIENT: '+61499918523', SMS_TEST_SEND_ENABLED: 'true' });
    const provider = jest.spyOn(service, 'provider').mockResolvedValueOnce({ results: [{ sender: '61468104118' }] }).mockResolvedValueOnce({ results: [{ status: 'success', message_id: 'provider-test' }] });
    try {
      const request = { requestId: '00000000-0000-4000-8000-000000000123' };
      const first = await service.sendTest(request);
      expect(first?.status).toBe('sent');
      expect(await service.sendTest(request)).toEqual(first);
      expect(provider).toHaveBeenCalledTimes(2);
      expect((provider.mock.calls[1][2] as any).messages[0].to).toBe('61499918523');
      await expect(service.sendTest({ requestId: '00000000-0000-4000-8000-000000000124' })).rejects.toThrow('Wait one minute');
      expect(store.all('SELECT * FROM contacts')).toHaveLength(0);
    } finally {
      provider.mockRestore();
      keys.forEach((key, i) => { if (originals[i] === undefined) delete process.env[key]; else process.env[key] = originals[i]; });
    }
  });
  it('normalizes AU mobiles and rejects non-mobile numbers', () => {
    expect(mobileNumber('0412 345 678')).toBe('+61412345678');
    expect(() => mobileNumber('0399999999')).toThrow();
  });
  it('gates SMS activity writes, preserves ambiguous jobs and rejects relinking them', () => {
    const before = { mode: process.env.DEALERSOCKET_WORKER_MODE, enabled: process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED };
    try {
      process.env.DEALERSOCKET_WORKER_MODE = 'chrome';
      process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED = 'false';
      service.queueSmsActivity('outbound:fixture', row.mobile, 'outbound', 'Test message', '55858', '162482');
      service.queueSmsActivity('outbound:fixture', row.mobile, 'outbound', 'Test message', '55858', '162482');
      expect(store.all('SELECT * FROM sms_activity')).toHaveLength(1);
      expect(service.claimSmsActivity({ authenticated: true })).toEqual({});
      process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED = 'true';
      const job = service.claimSmsActivity({ authenticated: true }) as any;
      expect(job.contactId).toBe('55858');
      expect((service.claimSmsActivity({ authenticated: true }) as any).reconcile).toBe(true);
      expect(() => service.linkSmsActivity(job.id, { contactId: '55858', opportunityId: '162482' })).toThrow();
      service.finishSmsActivity(job.id, { state: 'needs_review' });
      expect(service.claimSmsActivity({ authenticated: true })).toEqual({});
    } finally {
      if (before.mode === undefined) delete process.env.DEALERSOCKET_WORKER_MODE; else process.env.DEALERSOCKET_WORKER_MODE = before.mode;
      if (before.enabled === undefined) delete process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED; else process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED = before.enabled;
    }
  });
  it('deduplicates normalized numbers and requires consent evidence', () => {
    const result = service.importContacts({
      rows: [
        row,
        { ...row, mobile: '+61412345678' },
        { ...row, mobile: '0412345679', evidence: '' },
      ],
    });
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toHaveLength(1);
  });
  it('registers a lead once, suppresses immediately and queues CRM delivery durably', () => {
    service.importContacts({ rows: [row] });
    const input = { ...row, eventId: 'form-event-1' };
    const first = service.captureLead(input);
    const second = service.captureLead(input);
    expect(first.id).toBe(second.id);
    expect(() =>
      service.captureLead({ ...input, mobile: '0412345679' }),
    ).toThrow();
    expect(service.dashboard().metrics.leads).toBe(1);
    expect(service.dashboard().metrics.eligible).toBe(0);
    expect(service.dashboard().metrics.pending).toBe(1);
  });
  it('preserves suppression when an audience is uploaded again', () => {
    service.suppress(row.mobile, 'STOP reply');
    service.importContacts({ rows: [row] });
    expect(service.dashboard().metrics.eligible).toBe(0);
  });
  it('suppresses the originating SMS mobile when an invitation registers a different contact mobile', () => {
    service.importContacts({ rows: [row] });
    const contact = store.one(
      'SELECT id FROM contacts WHERE mobile=?',
      '+61412345678',
    );
    const campaign = service.createCampaign({
        name: 'Invitation',
        body: 'Booran: offer {link} {optout}',
      }),
      token = '00000000-0000-4000-8000-000000000001';
    store.run(
      "INSERT INTO messages(id,campaignId,contactId,token,status,createdAt) VALUES(?,?,?,?,'sent',?)",
      'fixture-origin-message',
      campaign.id,
      contact!.id,
      token,
      new Date().toISOString(),
    );
    const lead = service.captureLead({
      ...row,
      mobile: '0412345679',
      token,
      eventId: 'forwarded-invitation-fixture',
    });
    expect(
      store.one('SELECT campaignId FROM leads WHERE id=?', lead.id)?.campaignId,
    ).toBe(campaign.id);
    expect(service.dashboard().metrics.suppressed).toBe(2);
  });
  it('requires sender identification, tracking and unsubscribe tokens', () => {
    expect(() =>
      service.createCampaign({ name: 'Offer', body: 'Hello {link}' }),
    ).toThrow();
    expect(
      service.createCampaign({
        name: 'Offer',
        body: 'Booran: offer {link} {optout}',
      }).id,
    ).toBeTruthy();
  });
  it('blocks live sending before configuration', async () => {
    delete process.env.CAMPAIGN_SEND_ENABLED;
    const { id } = service.createCampaign({
      name: 'Offer',
      body: 'Booran: offer {link} {optout}',
    });
    service.approve(id);
    await expect(service.send(id)).rejects.toThrow();
    expect(service.dashboard().metrics.sent).toBe(0);
  });
  it('requires two distinct assignees from the verified catalog', () => {
    jest.spyOn(service, 'catalog').mockReturnValue({
      users: [
        { value: 'sm', text: 'Fixture Sales Manager' },
        { value: 'gm', text: 'Fixture General Manager' },
      ],
    });
    expect(() =>
      service.saveRouting({ salesManager: 'sm', generalManager: 'sm' }),
    ).toThrow();
    expect(() =>
      service.saveRouting({ salesManager: 'sm', generalManager: 'missing' }),
    ).toThrow();
    expect(
      service.saveRouting({ salesManager: 'sm', generalManager: 'gm' })
        .generalManager,
    ).toBe('gm');
  });
  it('retains existing-customer matching from the consented audience', () => {
    service.importContacts({
      rows: [{ ...row, dealerSocketContactId: '12345' }],
    });
    const lead = service.captureLead({ ...row, eventId: 'linked-fixture' });
    expect(
      store.one('SELECT dealerSocketContactId FROM leads WHERE id=?', lead.id)
        ?.dealerSocketContactId,
    ).toBe('12345');
  });
  it('claims a CRM job once and reconciles a repeated claim instead of creating duplicates', () => {
    const mode = process.env.DEALERSOCKET_WORKER_MODE,
      enabled = process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED;
    try {
      process.env.DEALERSOCKET_WORKER_MODE = 'chrome';
      process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED = 'true';
      jest.spyOn(service, 'catalog').mockReturnValue({
        users: [
          { value: 'sm', text: 'SM' },
          { value: 'gm', text: 'GM' },
        ],
      });
      service.saveRouting({ salesManager: 'sm', generalManager: 'gm' });
      const lead = service.captureLead({
        ...row,
        eventId: 'write-fixture',
        dealerSocketContactId: '12345',
      });
      const first = service.claimChromeJob({ authenticated: true }) as any;
      expect(first.leadId).toBe(lead.id);
      expect(first.salesManager).toBe('sm');
      expect(first.generalManager).toBe('gm');
      expect(() => service.finishChromeJob(lead.id, { state: 'synced', opportunityId: '0' })).toThrow();
      expect(
        (service.claimChromeJob({ authenticated: true }) as any).reconcile,
      ).toBe(true);
      service.finishChromeJob(lead.id, {
        state: 'synced',
        opportunityId: '56789',
      });
      service.finishChromeJob(lead.id, {
        state: 'synced',
        opportunityId: '56789',
      });
      expect(service.dashboard().metrics.pending).toBe(0);
      expect(
        (service.claimChromeJob({ authenticated: true }) as any).leadId,
      ).toBeUndefined();
    } finally {
      if (mode === undefined) delete process.env.DEALERSOCKET_WORKER_MODE;
      else process.env.DEALERSOCKET_WORKER_MODE = mode;
      if (enabled === undefined)
        delete process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED;
      else process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED = enabled;
    }
  });
  it('rejects snapshots from another dealership', () => {
    expect(() =>
      service.acceptChromeCatalog({
        siteId: '10876',
        name: 'South Morang Hyundai',
        users: [],
        franchises: [{ key: 1, value: 'Another dealer' }],
      }),
    ).toThrow();
    expect(() =>
      service.acceptChromeSnapshot({
        scope: 'south_morang_hyundai',
        readOnly: true,
        records: [{ dealership_id: 'other', rooftop: 'Other' }],
      }),
    ).toThrow();
  });
  it('records a STOP even after the mobile was suppressed by registration', () => {
    service.suppress(row.mobile, 'Lead registered');
    service.suppress(row.mobile, 'STOP reply');
    expect(service.dashboard().metrics.suppressed).toBe(1);
    expect(service.dashboard().metrics.optOuts).toBe(1);
  });
  it('allows an operator to resolve an ambiguous customer match and resume the queue', () => {
    const lead = service.captureLead({ ...row, eventId: 'ambiguous-fixture' });
    store.run("UPDATE outbox SET status='writing' WHERE leadId=?", lead.id);
    service.finishChromeJob(lead.id, { state: 'needs_match' });
    service.linkCustomer(lead.id, { contactId: '12345' });
    expect(
      store.one('SELECT status FROM outbox WHERE leadId=?', lead.id)?.status,
    ).toBe('pending_configuration');
    expect(
      store.one('SELECT dealerSocketContactId FROM leads WHERE id=?', lead.id)
        ?.dealerSocketContactId,
    ).toBe('12345');
  });
  it('enforces frequency across campaigns without contacting the provider twice', async () => {
    const values = {
      MOBILEMESSAGE_API_USERNAME: 'fixture',
      MOBILEMESSAGE_API_PASSWORD: 'fixture',
      MOBILEMESSAGE_FROM: 'BooranSMH',
      CAMPAIGN_SEND_ENABLED: 'true',
      SMS_SENDER_REGISTERED: 'true',
      PUBLIC_PORTAL_URL: 'https://loyalty.example.test',
      SMS_MAX_PER_WINDOW: '1',
      SMS_FREQUENCY_WINDOW_HOURS: '720',
    };
    const previous = Object.fromEntries(
      Object.keys(values).map((k) => [k, process.env[k]]),
    );
    try {
      Object.assign(process.env, values);
      service.importContacts({ rows: [row] });
      const mock = jest
        .spyOn(service, 'provider')
        .mockImplementation(async (path) =>
          path === 'senders'
            ? { results: [{ sender: 'BooranSMH' }] }
            : {
                results: [
                  { status: 'success', message_id: 'fixture-message-id' },
                ],
              },
        );
      for (const name of ['First campaign', 'Second campaign']) {
        const { id } = service.createCampaign({
          name,
          body: 'Booran: offer {link} {optout}',
        });
        service.approve(id);
        await service.send(id);
      }
      expect(
        mock.mock.calls.filter((call) => call[0] === 'messages'),
      ).toHaveLength(1);
      expect(service.dashboard().metrics.sent).toBe(1);
      expect(service.dashboard().metrics.eligible).toBe(0);
      expect(
        store.one(
          "SELECT COUNT(*) AS n FROM messages WHERE status='frequency_limited'",
        )?.n,
      ).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
