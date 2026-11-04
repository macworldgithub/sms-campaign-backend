import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { CampaignStore } from './campaign.store';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function mobileNumber(value: unknown) {
  let mobile = String(value || '').replace(/[\s().-]/g, '');
  if (/^04\d{8}$/.test(mobile)) mobile = '+61' + mobile.slice(1);
  if (/^614\d{8}$/.test(mobile)) mobile = '+' + mobile;
  if (!/^\+614\d{8}$/.test(mobile))
    throw new BadRequestException('Use a valid Australian mobile number.');
  return mobile;
}
export function text(value: unknown, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
const now = () => new Date().toISOString();
const isHyundaiCatalog = (value: any) =>
  value?.siteId === '10876' &&
  Array.isArray(value.franchises) &&
  value.franchises.length > 0 &&
  value.franchises.every(
    (f: any) =>
      (Number(f.key) === 1 && f.value === 'South Morang Hyundai') ||
      (Number(f.key) === 2 && f.value === 'South Morang Hyundai Used Cars'),
  );
const frequency = () => ({
  hours: Math.max(
    1,
    Math.min(2160, Number(process.env.SMS_FREQUENCY_WINDOW_HOURS) || 720),
  ),
  maximum: Math.max(
    1,
    Math.min(5, Math.floor(Number(process.env.SMS_MAX_PER_WINDOW) || 1)),
  ),
});

@Injectable()
export class CampaignService {
  private worker?: ReturnType<typeof setInterval>;
  private inboxWorker?: ReturnType<typeof setInterval>;
  private inboxSyncing = false;
  private syncing = false;
  constructor(readonly store: CampaignStore) {}
  onModuleInit() {
    this.worker = setInterval(
      () => void this.syncQueue().catch(() => {}),
      10000,
    );
    this.worker.unref();
    if (process.env.SMS_INBOX_POLL_ENABLED === 'true') {
      this.inboxWorker = setInterval(() => {
        if (this.inboxSyncing) return;
        this.inboxSyncing = true;
        void this.smsInbox(true)
          .catch(() =>
            this.store.audit(
              'SMS inbox refresh failed',
              'Check Mobile Message connectivity; stored replies remain available.',
            ),
          )
          .catch(() => {})
          .finally(() => {
            this.inboxSyncing = false;
          });
      }, 60000);
      this.inboxWorker.unref();
    }
  }
  onModuleDestroy() {
    if (this.worker) clearInterval(this.worker);
    if (this.inboxWorker) clearInterval(this.inboxWorker);
  }
  async catalog() {
    const value = await this.store.setting('chrome-catalog');
    const catalog = value ? JSON.parse(value) : null;
    return isHyundaiCatalog(catalog)
      ? catalog
      : {
          siteId: '10876',
          name: 'South Morang Hyundai',
          users: [],
          franchises: [],
        };
  }
  async acceptChromeCatalog(input: any) {
    if (
      !isHyundaiCatalog(input) ||
      input.name !== 'South Morang Hyundai' ||
      !Array.isArray(input.users) ||
      input.users.length > 500 ||
      input.users.some(
        (u: any) =>
          !/^[-\w]{1,60}$/.test(u.value) || typeof u.text !== 'string',
      )
    )
      throw new BadRequestException('Invalid Hyundai catalog.');
    await this.store.setSetting('chrome-catalog', JSON.stringify(input));
    return { accepted: true };
  }
  async chromeSnapshot() {
    const value = await this.store.setting('chrome-snapshot');
    const snapshot = value ? JSON.parse(value) : null;
    return snapshot?.scope === 'south_morang_hyundai' &&
      snapshot.readOnly === true
      ? snapshot
      : null;
  }
  async acceptChromeSnapshot(input: any) {
    if (
      input.scope !== 'south_morang_hyundai' ||
      input.readOnly !== true ||
      !Array.isArray(input.records) ||
      input.records.length > 1000 ||
      input.records.some(
        (r: any) =>
          r.dealership_id !== '10876' || r.rooftop !== 'South Morang Hyundai',
      )
    )
      throw new BadRequestException(
        'Only verified South Morang Hyundai snapshots are accepted.',
      );
    await this.store.transaction(async () => {
      await this.store.setSetting('chrome-snapshot', JSON.stringify(input));
      await this.store.delete('settings', { key: 'chrome-refresh' });
    });
    return { accepted: true, records: input.records.length };
  }
  async chromeStatus() {
    const saved = await this.store.setting('chrome-heartbeat'),
      heartbeat = saved ? JSON.parse(saved) : null;
    const running =
      heartbeat && Date.now() - Date.parse(heartbeat.seenAt) < 90000;
    return {
      state: running
        ? heartbeat.authenticated
          ? 'connected'
          : 'login_required'
        : 'worker_offline',
      message: running
        ? heartbeat.authenticated
          ? 'Authenticated Chrome worker is running for South Morang Hyundai.'
          : 'Complete DealerSocket sign-in in the Chrome worker tab.'
        : 'Start the Hyundai Chrome worker to enable unattended refresh. The captured snapshot retains its observation time.',
      lastCheckedAt: heartbeat?.seenAt || null,
    };
  }
  async requestChromeRefresh() {
    await this.store.setSetting('chrome-refresh', now());
    return { accepted: true, message: 'Chrome refresh requested.' };
  }
  async claimChromeJob(input: any = {}) {
    const authenticated = input.authenticated === true;
    await this.store.setSetting(
      'chrome-heartbeat',
      JSON.stringify({ seenAt: now(), authenticated }),
    );
    const refreshRequested = Boolean(
      await this.store.setting('chrome-refresh'),
    );
    if (
      !authenticated ||
      process.env.DEALERSOCKET_WORKER_MODE !== 'chrome' ||
      process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED !== 'true'
    )
      return { refreshRequested };
    const routing = await this.routing();
    if (!routing.salesManager || !routing.generalManager)
      return { refreshRequested };
    return this.store.transaction(async () => {
      const running = await this.store.one(
        'outbox',
        { status: 'writing' },
        { createdAt: 1 },
      );
      if (running)
        return { leadId: running.leadId, reconcile: true, refreshRequested };
      const pending = await this.store.one(
        'outbox',
        { status: 'pending_configuration' },
        { createdAt: 1 },
      );
      if (!pending) return { refreshRequested };
      const lead = await this.store.one('leads', { id: pending.leadId });
      if (!lead)
        throw new ConflictException('CRM job is missing its registration.');
      await this.store.update(
        'outbox',
        { id: pending.id, status: 'pending_configuration' },
        {
          $set: {
            status: 'writing',
            detail:
              'Chrome worker is verifying the customer and both manager assignments',
          },
        },
      );
      return {
        leadId: lead.id,
        contactId: lead.dealerSocketContactId,
        mobile: lead.mobile,
        email: lead.email,
        salesManager: routing.salesManager,
        generalManager: routing.generalManager,
        refreshRequested,
      };
    });
  }
  async finishChromeJob(id: string, input: any) {
    if (
      !['synced', 'needs_review', 'needs_match'].includes(input.state) ||
      (input.state === 'synced' &&
        !/^[1-9]\d*$/.test(String(input.opportunityId || '')))
    )
      throw new BadRequestException('Invalid worker result.');
    return this.store.transaction(async () => {
      const job = await this.store.one('outbox', { leadId: id });
      if (!job) throw new BadRequestException('CRM job not found.');
      if (job.status === 'synced') return { accepted: true };
      if (job.status !== 'writing')
        throw new ConflictException('CRM job is not being processed.');
      const detail =
        input.state === 'synced'
          ? `DealerSocket opportunity ${input.opportunityId}; Primary and Secondary managers assigned`
          : input.state === 'needs_match'
            ? 'No unique Hyundai customer matched the mobile/email. Link the correct existing customer to continue.'
            : 'Reconcile the Chrome worker write journal before retrying.';
      await this.store.update(
        'outbox',
        { leadId: id },
        {
          $set: {
            status: input.state,
            detail,
            ...(input.state === 'synced'
              ? { opportunityId: input.opportunityId }
              : {}),
          },
        },
      );
      await this.store.audit(
        'CRM delivery result',
        input.state === 'synced'
          ? `DealerSocket opportunity ${input.opportunityId}`
          : 'Operator review required',
      );
      if (
        input.state === 'synced' &&
        /^\d+$/.test(String(input.contactId || ''))
      ) {
        await this.store.setSetting(
          `crm-opportunity:${input.contactId}`,
          String(input.opportunityId),
        );
        await this.store.update(
          'leads',
          { id },
          { $set: { dealerSocketContactId: String(input.contactId) } },
        );
      }
      return { accepted: true };
    });
  }
  async routing() {
    const saved = await this.store.setting('crm-routing');
    return {
      ...(saved
        ? JSON.parse(saved)
        : { salesManager: '', generalManager: '', franchise: '1' }),
      catalog: await this.catalog(),
    };
  }
  async saveRouting(input: any) {
    const catalog = await this.catalog();
    if (
      !catalog.users.some((u: any) => u.value === input.salesManager) ||
      !catalog.users.some((u: any) => u.value === input.generalManager) ||
      input.salesManager === input.generalManager
    )
      throw new BadRequestException(
        'Select two distinct DealerSocket assignees from the verified site catalog.',
      );
    const value = {
      salesManager: input.salesManager,
      generalManager: input.generalManager,
      franchise: '1',
    };
    await this.store.transaction(async () => {
      await this.store.setSetting('crm-routing', JSON.stringify(value));
      await this.store.audit(
        'CRM routing configured',
        'Sales Manager as Primary; General Manager as Secondary; South Morang Hyundai',
      );
    });
    return value;
  }
  readiness() {
    return {
      storage: 'mongodb',
      provider: Boolean(
        process.env.MOBILEMESSAGE_API_USERNAME &&
        process.env.MOBILEMESSAGE_API_PASSWORD,
      ),
      sendingEnabled: process.env.CAMPAIGN_SEND_ENABLED === 'true',
      senderRegistered: process.env.SMS_SENDER_REGISTERED === 'true',
      senderId: process.env.MOBILEMESSAGE_FROM || 'Not configured',
      testRecipient: process.env.MOBILEMESSAGE_TEST_RECIPIENT || '',
      testSendingEnabled: process.env.SMS_TEST_SEND_ENABLED === 'true',
      publicUrl: Boolean(process.env.PUBLIC_PORTAL_URL),
      dealerSocket: Boolean(
        process.env.DEALERSOCKET_CONNECTOR_URL &&
        process.env.DEALERSOCKET_CONNECTOR_KEY,
      ),
      goodshowroom: 'It will be integrated soon',
      dealerSocketMode: process.env.DEALERSOCKET_WORKER_MODE || 'connector',
      frequencyPolicy: `Up to ${frequency().maximum} message(s) per customer every ${frequency().hours} hours`,
      crmWritesEnabled:
        process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED === 'true',
    };
  }
  async dashboard() {
    const cutoff = new Date(
      Date.now() - frequency().hours * 3600000,
    ).toISOString();
    const eligible = await this.store.aggregate('contacts', [
      {
        $lookup: {
          from: 'suppressions',
          localField: 'mobile',
          foreignField: 'mobile',
          as: 'suppression',
        },
      },
      { $match: { 'suppression.0': { $exists: false } } },
      {
        $lookup: {
          from: 'messages',
          let: { contact: '$id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$contactId', '$$contact'] },
                status: { $in: ['sending', 'sent', 'delivered', 'unknown'] },
                createdAt: { $gte: cutoff },
              },
            },
            { $count: 'n' },
          ],
          as: 'attempts',
        },
      },
      {
        $match: {
          $expr: {
            $lt: [
              { $ifNull: [{ $arrayElemAt: ['$attempts.n', 0] }, 0] },
              frequency().maximum,
            ],
          },
        },
      },
      { $count: 'n' },
    ]);
    const counts = await Promise.all([
      this.store.count('contacts'),
      this.store.count('messages', { status: { $in: ['sent', 'delivered'] } }),
      this.store.count('messages', { status: 'delivered' }),
      this.store.count('leads'),
      this.store.count('suppressions'),
      this.store.count('suppressions', { optOut: 1 }),
      this.store.count('outbox', { status: { $ne: 'synced' } }),
    ]);
    const clicks = await this.store.aggregate('messages', [
      { $group: { _id: null, n: { $sum: '$clicks' } } },
    ]);
    return {
      metrics: {
        contacts: counts[0],
        eligible: eligible[0]?.n || 0,
        sent: counts[1],
        delivered: counts[2],
        clicks: clicks[0]?.n || 0,
        leads: counts[3],
        suppressed: counts[4],
        optOuts: counts[5],
        pending: counts[6],
      },
      campaigns: await this.store.aggregate('campaigns', [
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: 'messages',
            let: { campaign: '$id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$campaignId', '$$campaign'] } } },
              { $count: 'n' },
            ],
            as: 'totals',
          },
        },
        {
          $set: {
            recipients: { $ifNull: [{ $arrayElemAt: ['$totals.n', 0] }, 0] },
          },
        },
        { $project: { _id: 0, totals: 0 } },
      ]),
      contacts: await this.store.aggregate('contacts', [
        { $sort: { createdAt: -1 } },
        { $limit: 500 },
        {
          $lookup: {
            from: 'suppressions',
            localField: 'mobile',
            foreignField: 'mobile',
            as: 'suppression',
          },
        },
        {
          $set: {
            suppressionReason: { $arrayElemAt: ['$suppression.reason', 0] },
          },
        },
        { $project: { _id: 0, suppression: 0 } },
      ]),
      leads: await this.store.aggregate('leads', [
        { $sort: { createdAt: -1 } },
        { $limit: 500 },
        {
          $lookup: {
            from: 'outbox',
            localField: 'id',
            foreignField: 'leadId',
            as: 'crm',
          },
        },
        {
          $set: {
            crmStatus: { $arrayElemAt: ['$crm.status', 0] },
            crmDetail: { $arrayElemAt: ['$crm.detail', 0] },
          },
        },
        { $project: { _id: 0, crm: 0 } },
      ]),
      suppressions: await this.store.find(
        'suppressions',
        {},
        { createdAt: -1 },
        500,
      ),
      activity: await this.store.find('audit', {}, { createdAt: -1 }, 30),
      readiness: this.readiness(),
    };
  }
  async importContacts(input: any) {
    if (!Array.isArray(input.rows) || input.rows.length > 10000)
      throw new BadRequestException('Upload up to 10,000 rows at a time.');
    const rejected: { row: number; reason: string }[] = [],
      rows: any[] = [];
    input.rows.forEach((row: any, index: number) => {
      try {
        const mobile = mobileNumber(row.mobile);
        if (
          !['express', 'inferred'].includes(row.consent) ||
          !text(row.evidence, 1000)
        )
          throw new BadRequestException(
            'Consent type and evidence are required.',
          );
        rows.push({
          id: randomUUID(),
          mobile,
          firstName: text(row.firstName),
          lastName: text(row.lastName),
          consent: row.consent,
          evidence: text(row.evidence, 1000),
          createdAt: now(),
          dealerSocketContactId: /^\d+$/.test(
            String(row.dealerSocketContactId || ''),
          )
            ? String(row.dealerSocketContactId)
            : null,
        });
      } catch (error) {
        rejected.push({
          row: index + 2,
          reason: error instanceof Error ? error.message : 'Invalid row',
        });
      }
    });
    return this.store.transaction(async () => {
      const existing = await this.store.find('contacts', {
        mobile: { $in: rows.map((r) => r.mobile) },
      });
      const seen = new Set(existing.map((r) => r.mobile));
      const fresh: any[] = [];
      let duplicates = 0;
      for (const row of rows) {
        if (seen.has(row.mobile)) {
          duplicates++;
          continue;
        }
        seen.add(row.mobile);
        fresh.push(row);
      }
      await this.store.insertMany('contacts', fresh);
      const imported = fresh.length;
      await this.store.audit(
        'Audience imported',
        `${imported} added, ${duplicates} duplicates, ${rejected.length} rejected`,
      );
      return { imported, duplicates, rejected };
    });
  }
  async suppress(mobile: unknown, reason: string) {
    const normalized = mobileNumber(mobile);
    return this.store.transaction(async () => {
      await this.store.update(
        'suppressions',
        { mobile: normalized },
        {
          $setOnInsert: {
            mobile: normalized,
            reason,
            createdAt: now(),
            ...(reason === 'Lead registered' ? { optOut: 0 } : {}),
          },
          ...(reason !== 'Lead registered' ? { $set: { optOut: 1 } } : {}),
        },
        true,
      );
      const contacts = await this.store.find('contacts', {
        mobile: normalized,
      });
      await this.store.updateMany(
        'messages',
        { status: 'queued', contactId: { $in: contacts.map((c) => c.id) } },
        { $set: { status: 'suppressed' } },
      );
      return { suppressed: true };
    });
  }
  async createCampaign(input: any) {
    const name = text(input.name),
      body = text(input.body, 1000);
    if (
      !name ||
      !body.includes('{link}') ||
      !body.includes('{optout}') ||
      !/Booran/i.test(body)
    )
      throw new BadRequestException(
        'Provide a name, identify Booran, and include {link} and {optout}.',
      );
    const id = randomUUID();
    await this.store.transaction(async () => {
      await this.store.insert('campaigns', {
        id,
        name,
        body,
        status: 'draft',
        approved: 0,
        createdAt: now(),
      });
      await this.store.audit('Campaign created', name);
    });
    return { id };
  }
  async approve(id: string) {
    return this.store.transaction(async () => {
      const campaign = await this.store.one('campaigns', { id });
      if (!campaign) throw new BadRequestException('Campaign not found.');
      if (campaign.status !== 'draft')
        throw new ConflictException('Only a draft can be approved.');
      await this.store.update(
        'campaigns',
        { id, status: 'draft' },
        { $set: { approved: 1, status: 'approved' } },
      );
      await this.store.audit('Copy approved', campaign.name);
      return { approved: true };
    });
  }
  async acceptInbound(input: any) {
    const configured = mobileNumber(process.env.MOBILEMESSAGE_FROM);
    if (mobileNumber(input.to) !== configured)
      return { accepted: true, ignored: true };
    const mobile = mobileNumber(input.sender || input.from),
      body = text(input.message, 4000),
      received = text(input.received_at, 40),
      ref = text(input.original_custom_ref);
    if (!received)
      throw new BadRequestException('Inbound timestamp is required.');
    const id = createHash('sha256')
      .update(JSON.stringify([mobile, configured, body, received, ref]))
      .digest('hex');
    return this.store.transaction(async () => {
      await this.store.update(
        'sms_inbound',
        { id },
        {
          $setOnInsert: {
            id,
            mobile,
            recipient: configured,
            body,
            type: text(input.type),
            originalRef: ref,
            receivedAt: received,
          },
        },
        true,
      );
      if (
        input.type === 'unsubscribe' ||
        /^(STOP|UNSUBSCRIBE|CANCEL|END|QUIT)$/i.test(body)
      )
        await this.suppress(mobile, 'Provider opt-out');
      const original = await this.store.one('messages', {
        $or: [{ id: ref }, { providerId: text(input.original_message_id) }],
      });
      const contact = original
        ? await this.store.one('contacts', { id: original.contactId })
        : null;
      if (contact?.mobile === mobile)
        await this.queueSmsActivity(
          `inbound:${id}`,
          mobile,
          'inbound',
          body,
          contact.dealerSocketContactId,
        );
      return { accepted: true };
    });
  }
  async queueSmsActivity(
    sourceRef: string,
    mobile: string,
    direction: string,
    body: string,
    contactId?: string,
    opportunityId?: string,
  ) {
    await this.store.update(
      'sms_activity',
      { sourceRef },
      {
        $setOnInsert: {
          id: randomUUID(),
          sourceRef,
          mobile: mobileNumber(mobile),
          direction,
          body: text(body, 4000),
          contactId: contactId || null,
          opportunityId: opportunityId || null,
          status: 'pending',
          detail: '',
          createdAt: now(),
        },
      },
      true,
    );
  }
  async claimSmsActivity(input: any = {}) {
    if (
      input.authenticated !== true ||
      process.env.DEALERSOCKET_WORKER_MODE !== 'chrome' ||
      process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED !== 'true'
    )
      return {};
    return this.store.transaction(async () => {
      const running = await this.store.one(
        'sms_activity',
        { status: 'writing' },
        { createdAt: 1 },
      );
      if (running) return { ...running, reconcile: true };
      const job = await this.store.one(
        'sms_activity',
        { status: 'pending' },
        { createdAt: 1 },
      );
      if (!job) return {};
      if (!job.contactId) {
        const leads = await this.store.find('leads', {
            mobile: job.mobile,
            dealerSocketContactId: { $ne: null },
          }),
          contacts = await this.store.find('contacts', {
            mobile: job.mobile,
            dealerSocketContactId: { $ne: null },
          });
        const ids = [
          ...new Set(
            [...leads, ...contacts]
              .map((c) => c.dealerSocketContactId)
              .filter(Boolean),
          ),
        ];
        if (ids.length === 1) job.contactId = ids[0];
      }
      if (!job.opportunityId && job.contactId)
        job.opportunityId = await this.store.setting(
          `crm-opportunity:${job.contactId}`,
        );
      if (!job.opportunityId && job.contactId) {
        const snapshot = await this.chromeSnapshot();
        const ids = [
          ...new Set(
            (snapshot?.records || [])
              .filter(
                (r: any) =>
                  r.dealership_id === '10876' &&
                  r.rooftop === 'South Morang Hyundai' &&
                  r.customer_id === job.contactId,
              )
              .map((r: any) => String(r.opportunity_id)),
          ),
        ];
        if (ids.length === 1 && /^[1-9]\d*$/.test(String(ids[0])))
          job.opportunityId = ids[0];
      }
      await this.store.update(
        'sms_activity',
        { id: job.id, status: 'pending' },
        {
          $set: {
            status: 'writing',
            contactId: job.contactId || null,
            opportunityId: job.opportunityId || null,
          },
        },
      );
      return job;
    });
  }
  async finishSmsActivity(id: string, input: any) {
    if (!['synced', 'needs_match', 'needs_review'].includes(input.state))
      throw new BadRequestException('Invalid SMS activity outcome.');
    return this.store.transaction(async () => {
      const job = await this.store.one('sms_activity', { id });
      if (!job) throw new BadRequestException('SMS activity not found.');
      if (job.status === 'synced') return { accepted: true };
      if (job.status !== 'writing')
        throw new ConflictException('SMS activity is not being processed.');
      await this.store.update(
        'sms_activity',
        { id },
        {
          $set: {
            status: input.state,
            detail:
              input.state === 'synced'
                ? 'Verified in DealerSocket opportunity work notes'
                : 'Operator review required; no automatic replay',
          },
        },
      );
      return { accepted: true };
    });
  }
  async linkSmsActivity(id: string, input: any) {
    if (
      !/^\d+$/.test(String(input.contactId || '')) ||
      !/^[1-9]\d*$/.test(String(input.opportunityId || ''))
    )
      throw new BadRequestException(
        'Customer and opportunity IDs are required.',
      );
    return this.store.transaction(async () => {
      const job = await this.store.one('sms_activity', { id });
      if (!job || !['pending', 'needs_match'].includes(job.status))
        throw new ConflictException(
          'Only an unmatched SMS activity can be linked.',
        );
      await this.store.update(
        'sms_activity',
        { id },
        {
          $set: {
            contactId: String(input.contactId),
            opportunityId: String(input.opportunityId),
            status: 'pending',
            detail: '',
          },
        },
      );
      await this.store.audit(
        'SMS activity customer linked',
        'Chrome must verify site, customer, mobile and opportunity before saving.',
      );
      return { linked: true };
    });
  }
  async smsInbox(sync = false) {
    let truncated = false;
    if (sync)
      for (let offset = 0; offset < 2000; offset += 200) {
        const page = await this.provider(
          `inbound?limit=200&offset=${offset}&from=${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}`,
        );
        if (!Array.isArray(page.results))
          throw new ServiceUnavailableException(
            'Invalid provider inbox response.',
          );
        for (const item of page.results) await this.acceptInbound(item);
        if (page.results.length < 200) break;
        if (offset === 1800) truncated = true;
      }
    return {
      results: await this.store.find(
        'sms_inbound',
        {},
        { receivedAt: -1 },
        100,
      ),
      tests: await this.store.find('sms_tests', {}, { createdAt: -1 }, 10),
      activities: (
        await this.store.find('sms_activity', {}, { createdAt: -1 }, 100)
      ).map(({ body, sourceRef, contactId, opportunityId, ...row }) => row),
      truncated,
    };
  }
  async sendTest(input: { requestId?: string }) {
    if (process.env.SMS_TEST_SEND_ENABLED !== 'true')
      throw new BadRequestException('Test sending is disabled.');
    if (!/^[a-f0-9-]{36}$/i.test(input.requestId || ''))
      throw new BadRequestException('A test request UUID is required.');
    const id = input.requestId!,
      recipient = mobileNumber(process.env.MOBILEMESSAGE_TEST_RECIPIENT),
      sender = mobileNumber(process.env.MOBILEMESSAGE_FROM);
    const previous = await this.store.one('sms_tests', { id });
    if (previous) return previous;
    const senders = await this.provider('senders');
    if (
      !senders.results?.some(
        (s: any) => String(s.sender).replace(/^\+/, '') === sender.slice(1),
      )
    )
      throw new BadRequestException(
        'The test sender is not approved on this provider account.',
      );
    const claimed = await this.store.transaction(async () => {
      const existing = await this.store.one('sms_tests', { id });
      if (existing) return false;
      if (await this.store.one('suppressions', { mobile: recipient }))
        throw new BadRequestException('The test recipient is suppressed.');
      if (
        await this.store.one('sms_tests', {
          createdAt: { $gt: new Date(Date.now() - 60000).toISOString() },
        })
      )
        throw new ConflictException('Wait one minute before another test.');
      await this.store.insert('sms_tests', {
        id,
        recipient,
        sender,
        status: 'sending',
        providerId: null,
        createdAt: now(),
      });
      return true;
    });
    if (!claimed) return this.store.one('sms_tests', { id });
    try {
      const response = await this.provider(
        'messages',
        'POST',
        {
          messages: [
            {
              to: recipient.slice(1),
              sender: sender.slice(1),
              message:
                'Booran South Morang Hyundai: Portal connection test only. No customer campaign has been launched. {optout}',
              custom_ref: id,
            },
          ],
          ignore_unsubscribes: false,
          max_parts: 2,
        },
        id,
      );
      const result = response.results?.[0],
        status =
          result?.status === 'success'
            ? 'sent'
            : ['blocked', 'error'].includes(result?.status)
              ? 'failed'
              : 'unknown';
      await this.store.update(
        'sms_tests',
        { id, status: { $nin: ['delivered', 'failed'] } },
        { $set: { status, providerId: result?.message_id || null } },
      );
    } catch {
      await this.store.update(
        'sms_tests',
        { id, status: 'sending' },
        { $set: { status: 'unknown' } },
      );
    }
    await this.store.audit(
      'Test SMS attempted',
      'Configured test recipient only; campaign sending unchanged',
    );
    return this.store.one('sms_tests', { id });
  }
  async send(id: string) {
    const ready = this.readiness();
    if (
      !ready.provider ||
      !ready.sendingEnabled ||
      !ready.senderRegistered ||
      !ready.publicUrl
    )
      throw new BadRequestException(
        'Sending requires configured Mobile Message credentials, registered Sender ID, a public URL, and CAMPAIGN_SEND_ENABLED=true.',
      );
    const senders = await this.provider('senders');
    if (
      !senders.results?.some(
        (s: any) =>
          String(s.sender).replace(/^\+/, '') ===
          String(ready.senderId).replace(/^\+/, ''),
      )
    )
      throw new BadRequestException(
        'The configured sender is not approved on the Mobile Message account.',
      );
    const campaign = await this.store.transaction(async () => {
      const c = await this.store.one('campaigns', { id });
      if (!c?.approved)
        throw new BadRequestException('Approve campaign copy first.');
      if (c.status !== 'approved')
        throw new ConflictException('Campaign has already been dispatched.');
      await this.store.update(
        'campaigns',
        { id, status: 'approved' },
        { $set: { status: 'sending' } },
      );
      const suppressed = new Set(
        (await this.store.find('suppressions')).map((s) => s.mobile),
      );
      const contacts = await this.store.find('contacts', {
        mobile: { $nin: [...suppressed] },
      });
      await this.store.insertMany(
        'messages',
        contacts.map((contact) => ({
          id: randomUUID(),
          campaignId: id,
          contactId: contact.id,
          token: randomUUID(),
          status: 'queued',
          providerId: null,
          clicks: 0,
          createdAt: now(),
        })),
      );
      return c;
    });
    let sent = 0,
      uncertain = 0;
    for (const queued of await this.store.find('messages', {
      campaignId: id,
      status: 'queued',
    })) {
      const contact = await this.store.one('contacts', {
        id: queued.contactId,
      });
      if (!contact) continue;
      const claimed = await this.store.transaction(async () => {
        if (
          !(await this.store.one('messages', {
            id: queued.id,
            status: 'queued',
          }))
        )
          return false;
        if (await this.store.one('suppressions', { mobile: contact.mobile })) {
          await this.store.update(
            'messages',
            { id: queued.id },
            { $set: { status: 'suppressed' } },
          );
          return false;
        }
        const attempts = await this.store.count('messages', {
          contactId: contact.id,
          status: { $in: ['sending', 'sent', 'delivered', 'unknown'] },
          createdAt: {
            $gte: new Date(
              Date.now() - frequency().hours * 3600000,
            ).toISOString(),
          },
        });
        if (attempts >= frequency().maximum) {
          await this.store.update(
            'messages',
            { id: queued.id },
            { $set: { status: 'frequency_limited' } },
          );
          return false;
        }
        await this.store.update(
          'messages',
          { id: queued.id, status: 'queued' },
          { $set: { status: 'sending' } },
        );
        return true;
      });
      if (!claimed) continue;
      // Network side effects must stay outside retryable MongoDB transactions.
      if (await this.store.one('suppressions', { mobile: contact.mobile })) {
        await this.store.update(
          'messages',
          { id: queued.id, status: 'sending' },
          { $set: { status: 'suppressed' } },
        );
        continue;
      }
      const url = `${process.env.PUBLIC_PORTAL_URL!.replace(/\/$/, '')}/r/${queued.token}`,
        body = campaign.body
          .replaceAll('{link}', url)
          .replaceAll('{firstName}', contact.firstName || 'there');
      let result: any;
      try {
        const data = await this.provider(
          'messages',
          'POST',
          {
            messages: [
              {
                to: contact.mobile.slice(1),
                sender: String(ready.senderId).replace(/^\+/, ''),
                message: body,
                custom_ref: queued.id,
              },
            ],
            enable_unicode: true,
            ignore_unsubscribes: false,
            shorten_urls: 'auto',
            max_parts: 4,
          },
          queued.id,
        );
        result = data.results?.[0];
        if (!result || !['success', 'blocked', 'error'].includes(result.status))
          throw new Error('Unrecognized provider response');
      } catch {
        await this.store.update(
          'messages',
          { id: queued.id, status: 'sending' },
          { $set: { status: 'unknown' } },
        );
        uncertain++;
        continue;
      }
      const status =
        result.status === 'success'
          ? 'sent'
          : result.status === 'blocked'
            ? 'suppressed'
            : 'failed';
      await this.store.transaction(async () => {
        await this.store.update(
          'messages',
          { id: queued.id },
          { $set: { providerId: result.message_id || null } },
        );
        await this.store.update(
          'messages',
          { id: queued.id, status: { $nin: ['delivered', 'failed'] } },
          { $set: { status } },
        );
        if (result.status === 'blocked')
          await this.suppress(contact.mobile, 'Provider opt-out');
        if (status === 'sent')
          await this.queueSmsActivity(
            `outbound:${queued.id}`,
            contact.mobile,
            'outbound',
            body,
            contact.dealerSocketContactId,
          );
      });
      if (status === 'sent') sent++;
    }
    await this.store.update(
      'campaigns',
      { id },
      { $set: { status: uncertain ? 'needs_review' : 'completed' } },
    );
    await this.store.audit(
      'Campaign send finished',
      `${sent} accepted; ${uncertain} require provider reconciliation`,
    );
    return { sent, uncertain };
  }
  async captureLead(input: any) {
    const mobile = mobileNumber(input.mobile),
      eventId = text(input.eventId, 100);
    if (!eventId || !text(input.firstName))
      throw new BadRequestException(
        'First name and unique eventId are required.',
      );
    return this.store.transaction(async () => {
      const existing = await this.store.one('leads', { eventId });
      if (existing && existing.mobile !== mobile)
        throw new ConflictException(
          'Submission ID already belongs to another registration.',
        );
      if (existing) return { id: existing.id };
      const message = input.token
        ? await this.store.one('messages', { token: text(input.token) })
        : null;
      const origin = message
        ? await this.store.one('contacts', { id: message.contactId })
        : null;
      const contact = await this.store.one('contacts', { mobile });
      const id = randomUUID();
      await this.store.insert('leads', {
        id,
        mobile,
        firstName: text(input.firstName),
        lastName: text(input.lastName),
        email: text(input.email),
        campaignId: message?.campaignId || null,
        createdAt: now(),
        eventId,
        dealerSocketContactId: /^\d+$/.test(
          String(input.dealerSocketContactId || ''),
        )
          ? String(input.dealerSocketContactId)
          : contact?.dealerSocketContactId || null,
      });
      await this.suppress(mobile, 'Lead registered');
      if (origin?.mobile && origin.mobile !== mobile)
        await this.suppress(origin.mobile, 'Lead registered');
      await this.store.insert('outbox', {
        id: randomUUID(),
        leadId: id,
        status: 'pending_configuration',
        detail:
          'Waiting for CRM routing, matched customer, and enabled write worker',
        createdAt: now(),
      });
      await this.store.audit(
        'Lead registered',
        'Further campaign messages suppressed; CRM delivery queued',
      );
      return { id };
    });
  }
  async linkCustomer(id: string, input: any) {
    if (!/^\d+$/.test(String(input.contactId || '')))
      throw new BadRequestException(
        'Enter the matching DealerSocket customer ID.',
      );
    return this.store.transaction(async () => {
      const lead = await this.store.one('leads', { id }),
        job = await this.store.one('outbox', { leadId: id });
      if (!lead || !job) throw new BadRequestException('Lead not found.');
      if (['writing', 'synced', 'needs_review'].includes(job.status))
        throw new ConflictException(
          'Resolve the current CRM write before changing its customer match.',
        );
      await this.store.update(
        'leads',
        { id },
        { $set: { dealerSocketContactId: String(input.contactId) } },
      );
      await this.store.update(
        'outbox',
        { leadId: id, status: 'needs_match' },
        {
          $set: {
            status: 'pending_configuration',
            detail: 'Customer linked; waiting for enabled CRM worker',
          },
        },
      );
      await this.store.audit(
        'CRM customer linked',
        'Customer identity will be verified against the registration mobile before saving.',
      );
      return { linked: true };
    });
  }
  async recordReceipt(input: any) {
    const messageId = input.message_id,
      part = Number(input.part_number || 1),
      total = Number(input.total_parts || 1),
      received = text(input.received_at, 40);
    if (
      !Number.isInteger(part) ||
      !Number.isInteger(total) ||
      part < 1 ||
      part > total ||
      total > 99 ||
      !received
    )
      return;
    await this.store.transaction(async () => {
      const previous = await this.store.one('receipts', { messageId, part });
      if (!previous)
        await this.store.insert('receipts', {
          messageId,
          part,
          total,
          status: input.status,
          receivedAt: received,
        });
      else if (received > previous.receivedAt)
        await this.store.update(
          'receipts',
          { messageId, part },
          { $set: { status: input.status, receivedAt: received, total } },
        );
      const rows = await this.store.find('receipts', { messageId });
      const expected = Math.max(total, ...rows.map((r) => r.total));
      const status = rows.some((r) => r.status === 'failed')
        ? 'failed'
        : rows.length === expected &&
            rows.every((r) => r.status === 'delivered')
          ? 'delivered'
          : null;
      if (status)
        for (const name of ['sms_tests', 'messages'] as const)
          await this.store.updateMany(
            name,
            {
              $or: [
                { providerId: messageId },
                { id: text(input.custom_ref), providerId: null },
              ],
            },
            { $set: { status } },
          );
    });
  }
  async track(token: string) {
    const message = await this.store.one('messages', { token });
    if (message)
      await this.store.update(
        'messages',
        { id: message.id },
        { $inc: { clicks: 1 } },
      );
    return message;
  }
  async syncQueue() {
    if (
      process.env.DEALERSOCKET_WORKER_MODE === 'chrome' ||
      this.syncing ||
      process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED !== 'true'
    )
      return;
    this.syncing = true;
    try {
      const routing = await this.routing();
      if (!routing.salesManager || !routing.generalManager) return;
      const running = await this.store.one(
        'outbox',
        { status: 'writing' },
        { createdAt: 1 },
      );
      if (running) {
        const result = await this.connector(`campaign/leads/${running.leadId}`);
        if (result.state === 'synced')
          await this.finishChromeJob(running.leadId, result);
        else if (
          ['needs_review', 'not_started', 'preparation_failed'].includes(
            result.state,
          )
        )
          await this.finishChromeJob(running.leadId, { state: 'needs_review' });
        return;
      }
      const job: any = await this.store.transaction(async () => {
        if (await this.store.one('outbox', { status: 'writing' })) return null;
        for (const candidate of await this.store.find(
          'outbox',
          { status: 'pending_configuration' },
          { createdAt: 1 },
        )) {
          const lead = await this.store.one('leads', {
            id: candidate.leadId,
            dealerSocketContactId: { $ne: null },
          });
          if (!lead) continue;
          await this.store.update(
            'outbox',
            { id: candidate.id },
            {
              $set: {
                status: 'writing',
                detail:
                  'Verifying customer identity and routing in DealerSocket',
              },
            },
          );
          return lead;
        }
        return null;
      });
      if (!job) return;
      try {
        await this.connector('campaign/leads', 'POST', {
          leadId: job.id,
          contactId: Number(job.dealerSocketContactId),
          mobile: job.mobile,
          salesManager: routing.salesManager,
          generalManager: routing.generalManager,
        });
      } catch {
        await this.finishChromeJob(job.id, { state: 'needs_review' });
      }
    } catch {
      /* Keep ambiguous jobs for reconciliation, never blindly replay. */
    } finally {
      this.syncing = false;
    }
  }
  async provider(path: string, method = 'GET', body?: unknown, id?: string) {
    const user = process.env.MOBILEMESSAGE_API_USERNAME,
      pass = process.env.MOBILEMESSAGE_API_PASSWORD;
    if (!user || !pass)
      throw new ServiceUnavailableException(
        'Mobile Message API credentials are not configured.',
      );
    const response = await fetch(
      `https://api.mobilemessage.com.au/v1/${path}`,
      {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...(id ? { 'Idempotency-Key': id } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new ServiceUnavailableException(
        `Mobile Message request failed (${response.status}).`,
      );
    return response.json();
  }
  async importWorkbook(input: any) {
    if (
      typeof input.base64 !== 'string' ||
      input.base64.length > 7 * 1024 * 1024
    )
      throw new BadRequestException(
        'Upload an XLSX workbook smaller than 5 MB.',
      );
    const rows = await new Promise<any[]>((accept, reject) => {
      const executable =
        process.env.AUDIENCE_PYTHON ||
        resolve('../metaphor-replacement-api/.venv/Scripts/python.exe');
      const child = spawn(executable, [resolve('scripts/read-audience.py')], {
        windowsHide: true,
      });
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new BadRequestException('Workbook processing timed out.'));
      }, 30000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 12 * 1024 * 1024) {
          child.kill();
          reject(new BadRequestException('Workbook is too large.'));
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        reject(
          new BadRequestException(
            'Workbook reader unavailable. Configure AUDIENCE_PYTHON.',
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new BadRequestException(
              'Invalid workbook. Use the first sheet with mobile, consent and evidence columns.',
            ),
          );
        try {
          accept(JSON.parse(output));
        } catch {
          reject(new BadRequestException('Workbook could not be read.'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input.base64);
    });
    return this.importContacts({ rows });
  }
  async connector(path: string, method = 'GET', body?: any) {
    if (
      !process.env.DEALERSOCKET_CONNECTOR_URL ||
      !process.env.DEALERSOCKET_CONNECTOR_KEY
    )
      throw new ServiceUnavailableException(
        'DealerSocket connector is not configured.',
      );
    try {
      const response = await fetch(
        `${process.env.DEALERSOCKET_CONNECTOR_URL.replace(/\/$/, '')}/dealersocket/${path}`,
        {
          method,
          headers: {
            'X-Connector-Key': process.env.DEALERSOCKET_CONNECTOR_KEY,
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new ServiceUnavailableException(
        'DealerSocket request failed. Check connector availability and session.',
      );
    }
  }
}
