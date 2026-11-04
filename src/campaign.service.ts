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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  onModuleInit() {
    this.worker = setInterval(() => void this.syncQueue(), 10000);
    this.worker.unref();
    if (process.env.SMS_INBOX_POLL_ENABLED === 'true') {
      this.inboxWorker = setInterval(() => {
        if (this.inboxSyncing) return;
        this.inboxSyncing = true;
        void this.smsInbox(true).catch(() => {
          this.store.audit('SMS inbox refresh failed', 'Check Mobile Message connectivity; stored replies remain available.');
        }).finally(() => { this.inboxSyncing = false; });
      }, 60000);
      this.inboxWorker.unref();
    }
  }
  onModuleDestroy() {
    if (this.worker) clearInterval(this.worker);
    if (this.inboxWorker) clearInterval(this.inboxWorker);
  }
  constructor(readonly store: CampaignStore) {}
  catalog() {
    try {
      const catalog = JSON.parse(
        readFileSync(
          resolve(
            process.env.DEALERSOCKET_CATALOG_PATH ||
              '../metaphor-replacement-api/.private/south-morang-hyundai-catalog.json',
          ),
          'utf8',
        ),
      );
      if (!isHyundaiCatalog(catalog))
        throw new Error('Catalog belongs to another dealership');
      return catalog;
    } catch {
      return {
        siteId: '10876',
        name: 'South Morang Hyundai',
        users: [],
        franchises: [],
      };
    }
  }
  acceptChromeCatalog(input: any) {
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
    const path = resolve(
      process.env.DEALERSOCKET_CATALOG_PATH ||
        '../metaphor-replacement-api/.private/south-morang-hyundai-catalog.json',
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(input));
    renameSync(path + '.tmp', path);
    return { accepted: true };
  }
  chromeSnapshot() {
    try {
      const snapshot = JSON.parse(
        readFileSync(
          resolve(
            process.env.DEALERSOCKET_CHROME_SNAPSHOT_PATH ||
              '../metaphor-replacement-api/.private/south-morang-hyundai-leads.json',
          ),
          'utf8',
        ),
      );
      return snapshot.scope === 'south_morang_hyundai' &&
        snapshot.readOnly === true
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }
  acceptChromeSnapshot(input: any) {
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
    const path = resolve(
      process.env.DEALERSOCKET_CHROME_SNAPSHOT_PATH ||
        '../metaphor-replacement-api/.private/south-morang-hyundai-leads.json',
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(input));
    renameSync(path + '.tmp', path);
    this.store.run("DELETE FROM settings WHERE key='chrome-refresh'");
    return { accepted: true, records: input.records.length };
  }
  chromeStatus() {
    const saved = this.store.one(
      "SELECT value FROM settings WHERE key='chrome-heartbeat'",
    );
    const heartbeat = saved ? JSON.parse(saved.value) : null;
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
  requestChromeRefresh() {
    this.store.run(
      "INSERT INTO settings VALUES('chrome-refresh',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      now(),
    );
    return { accepted: true, message: 'Chrome refresh requested.' };
  }
  claimChromeJob(input: any = {}) {
    const authenticated = input.authenticated === true;
    this.store.run(
      "INSERT INTO settings VALUES('chrome-heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({ seenAt: now(), authenticated }),
    );
    const refreshRequested = Boolean(
      this.store.one("SELECT key FROM settings WHERE key='chrome-refresh'"),
    );
    if (
      !authenticated ||
      process.env.DEALERSOCKET_WORKER_MODE !== 'chrome' ||
      process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED !== 'true'
    )
      return { refreshRequested };
    const routing = this.routing();
    if (!routing.salesManager || !routing.generalManager)
      return { refreshRequested };
    return this.store.transaction(() => {
      const running = this.store.one(
        "SELECT leadId FROM outbox WHERE status='writing' ORDER BY createdAt LIMIT 1",
      );
      if (running)
        return { leadId: running.leadId, reconcile: true, refreshRequested };
      const lead = this.store.one(
        "SELECT l.* FROM leads l JOIN outbox o ON o.leadId=l.id WHERE o.status='pending_configuration' ORDER BY l.createdAt LIMIT 1",
      );
      if (!lead) return { refreshRequested };
      this.store.run(
        "UPDATE outbox SET status='writing',detail='Chrome worker is verifying the customer and both manager assignments' WHERE leadId=?",
        lead.id,
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
  finishChromeJob(id: string, input: any) {
    if (
      !['synced', 'needs_review', 'needs_match'].includes(input.state) ||
      (input.state === 'synced' &&
        !/^[1-9]\d*$/.test(String(input.opportunityId || '')))
    )
      throw new BadRequestException('Invalid worker result.');
    const job = this.store.one('SELECT * FROM outbox WHERE leadId=?', id);
    if (!job) throw new BadRequestException('CRM job not found.');
    if (job.status === 'synced') return { accepted: true };
    if (job.status !== 'writing')
      throw new ConflictException('CRM job is not being processed.');
    this.store.run(
      'UPDATE outbox SET status=?,detail=? WHERE leadId=?',
      input.state,
      input.state === 'synced'
        ? `DealerSocket opportunity ${input.opportunityId}; Primary and Secondary managers assigned`
        : input.state === 'needs_match'
          ? 'No unique Hyundai customer matched the mobile/email. Link the correct existing customer to continue.'
          : 'Reconcile the Chrome worker write journal before retrying.',
      id,
    );
    this.store.audit(
      'CRM delivery result',
      input.state === 'synced'
        ? `DealerSocket opportunity ${input.opportunityId}`
        : 'Operator review required',
    );
    if (input.state === 'synced' && /^\d+$/.test(String(input.contactId || '')))
      this.store.run("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `crm-opportunity:${input.contactId}`, String(input.opportunityId));
    if (input.state === 'synced' && /^\d+$/.test(String(input.contactId || '')))
      this.store.run(
        'UPDATE leads SET dealerSocketContactId=? WHERE id=?',
        String(input.contactId),
        id,
      );
    return { accepted: true };
  }
  routing() {
    const saved = this.store.one(
      'SELECT value FROM settings WHERE key=?',
      'crm-routing',
    );
    return {
      ...(saved
        ? JSON.parse(saved.value)
        : { salesManager: '', generalManager: '', franchise: '1' }),
      catalog: this.catalog(),
    };
  }
  saveRouting(input: any) {
    const catalog = this.catalog();
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
    this.store.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'crm-routing',
      JSON.stringify(value),
    );
    this.store.audit(
      'CRM routing configured',
      'Sales Manager as Primary; General Manager as Secondary; South Morang Hyundai',
    );
    return value;
  }
  dashboard() {
    const count = (table: string, where = '') =>
      this.store.one(`SELECT COUNT(*) AS n FROM ${table} ${where}`)?.n || 0;
    return {
      metrics: {
        contacts: count('contacts'),
        eligible:
          this.store.one(
            "SELECT COUNT(*) AS n FROM contacts c WHERE c.mobile NOT IN (SELECT mobile FROM suppressions) AND (SELECT COUNT(*) FROM messages m WHERE m.contactId=c.id AND m.status IN ('sending','sent','delivered','unknown') AND m.createdAt>=?)<?",
            new Date(Date.now() - frequency().hours * 3600000).toISOString(),
            frequency().maximum,
          )?.n || 0,
        sent: count('messages', "WHERE status IN ('sent','delivered')"),
        delivered: count('messages', "WHERE status='delivered'"),
        clicks:
          this.store.one('SELECT COALESCE(SUM(clicks),0) AS n FROM messages')
            ?.n || 0,
        leads: count('leads'),
        suppressed: count('suppressions'),
        optOuts: count('suppressions', 'WHERE optOut=1'),
        pending: count('outbox', "WHERE status!='synced'"),
      },
      campaigns: this.store.all(
        'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.campaignId=c.id) AS recipients FROM campaigns c ORDER BY createdAt DESC',
      ),
      contacts: this.store.all(
        'SELECT c.*, s.reason AS suppressionReason FROM contacts c LEFT JOIN suppressions s ON s.mobile=c.mobile ORDER BY c.createdAt DESC LIMIT 500',
      ),
      leads: this.store.all(
        'SELECT l.*, o.status AS crmStatus, o.detail AS crmDetail FROM leads l LEFT JOIN outbox o ON o.leadId=l.id ORDER BY l.createdAt DESC LIMIT 500',
      ),
      suppressions: this.store.all(
        'SELECT * FROM suppressions ORDER BY createdAt DESC LIMIT 500',
      ),
      activity: this.store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 30'),
      readiness: {
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
      },
    };
  }
  importContacts(input: any) {
    if (!Array.isArray(input.rows) || input.rows.length > 10000)
      throw new BadRequestException('Upload up to 10,000 rows at a time.');
    const result = {
      imported: 0,
      duplicates: 0,
      rejected: [] as { row: number; reason: string }[],
    };
    this.store.transaction(() => {
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
          if (
            this.store.one('SELECT id FROM contacts WHERE mobile=?', mobile)
          ) {
            result.duplicates++;
            return;
          }
          this.store.run(
            'INSERT INTO contacts(id,mobile,firstName,lastName,consent,evidence,createdAt,dealerSocketContactId) VALUES(?,?,?,?,?,?,?,?)',
            randomUUID(),
            mobile,
            text(row.firstName),
            text(row.lastName),
            row.consent,
            text(row.evidence, 1000),
            now(),
            /^\d+$/.test(String(row.dealerSocketContactId || ''))
              ? String(row.dealerSocketContactId)
              : null,
          );
          result.imported++;
        } catch (error) {
          result.rejected.push({
            row: index + 2,
            reason: error instanceof Error ? error.message : 'Invalid row',
          });
        }
      });
      this.store.audit(
        'Audience imported',
        `${result.imported} added, ${result.duplicates} duplicates, ${result.rejected.length} rejected`,
      );
    });
    return result;
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
  suppress(mobile: unknown, reason: string) {
    const normalized = mobileNumber(mobile);
    this.store.run(
      'INSERT OR IGNORE INTO suppressions(mobile,reason,createdAt,optOut) VALUES(?,?,?,?)',
      normalized,
      reason,
      now(),
      reason === 'Lead registered' ? 0 : 1,
    );
    if (reason !== 'Lead registered')
      this.store.run(
        'UPDATE suppressions SET optOut=1 WHERE mobile=?',
        normalized,
      );
    this.store.run(
      "UPDATE messages SET status='suppressed' WHERE status='queued' AND contactId IN (SELECT id FROM contacts WHERE mobile=?)",
      normalized,
    );
    return { suppressed: true };
  }
  createCampaign(input: any) {
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
    this.store.run(
      'INSERT INTO campaigns(id,name,body,createdAt) VALUES(?,?,?,?)',
      id,
      name,
      body,
      now(),
    );
    this.store.audit('Campaign created', name);
    return { id };
  }
  approve(id: string) {
    const campaign = this.store.one('SELECT * FROM campaigns WHERE id=?', id);
    if (!campaign) throw new BadRequestException('Campaign not found.');
    if (campaign.status !== 'draft')
      throw new ConflictException('Only a draft can be approved.');
    this.store.run(
      "UPDATE campaigns SET approved=1,status='approved' WHERE id=?",
      id,
    );
    this.store.audit('Copy approved', campaign.name);
    return { approved: true };
  }
  acceptInbound(input: any) {
    const configured = mobileNumber(process.env.MOBILEMESSAGE_FROM);
    if (mobileNumber(input.to) !== configured) return { accepted: true, ignored: true };
    const mobile = mobileNumber(input.sender || input.from);
    const body = text(input.message, 4000), received = text(input.received_at, 40);
    if (!received) throw new BadRequestException('Inbound timestamp is required.');
    const ref = text(input.original_custom_ref);
    const id = createHash('sha256').update(JSON.stringify([mobile, configured, body, received, ref])).digest('hex');
    this.store.run('INSERT OR IGNORE INTO sms_inbound VALUES(?,?,?,?,?,?,?)', id, mobile, configured, body, text(input.type), ref, received);
    if (input.type === 'unsubscribe' || /^(STOP|UNSUBSCRIBE|CANCEL|END|QUIT)$/i.test(body))
      this.suppress(mobile, 'Provider opt-out');
    const original = this.store.one('SELECT m.id,c.mobile,c.dealerSocketContactId FROM messages m JOIN contacts c ON c.id=m.contactId WHERE m.id=? OR m.providerId=?', ref, text(input.original_message_id));
    // Never copy unrelated account conversations into this dealership's CRM.
    if (original && original.mobile === mobile)
      this.queueSmsActivity(`inbound:${id}`, mobile, 'inbound', body, original.dealerSocketContactId);
    return { accepted: true };
  }
  queueSmsActivity(sourceRef: string, mobile: string, direction: string, body: string, contactId?: string, opportunityId?: string) {
    this.store.run("INSERT OR IGNORE INTO sms_activity(id,sourceRef,mobile,direction,body,contactId,opportunityId,status,createdAt) VALUES(?,?,?,?,?,?,?,'pending',?)", randomUUID(), sourceRef, mobileNumber(mobile), direction, text(body, 4000), contactId || null, opportunityId || null, now());
  }
  claimSmsActivity(input: any = {}) {
    if (input.authenticated !== true || process.env.DEALERSOCKET_WORKER_MODE !== 'chrome' || process.env.DEALERSOCKET_SMS_ACTIVITY_ENABLED !== 'true') return {};
    return this.store.transaction(() => {
      const running = this.store.one("SELECT * FROM sms_activity WHERE status='writing' ORDER BY createdAt LIMIT 1");
      if (running) return { ...running, reconcile: true };
      const job = this.store.one("SELECT * FROM sms_activity WHERE status='pending' ORDER BY createdAt LIMIT 1");
      if (!job) return {};
      if (!job.contactId) {
        const matched = this.store.all('SELECT DISTINCT dealerSocketContactId AS id FROM leads WHERE mobile=? AND dealerSocketContactId IS NOT NULL UNION SELECT DISTINCT dealerSocketContactId AS id FROM contacts WHERE mobile=? AND dealerSocketContactId IS NOT NULL', job.mobile, job.mobile);
        if (matched.length === 1) job.contactId = matched[0].id;
      }
      if (!job.opportunityId && job.contactId)
        job.opportunityId = this.store.one('SELECT value FROM settings WHERE key=?', `crm-opportunity:${job.contactId}`)?.value;
      if (!job.opportunityId && job.contactId) {
        const snapshot = this.chromeSnapshot();
        const ids = [...new Set((snapshot?.records || []).filter((r: any) => r.dealership_id === '10876' && r.rooftop === 'South Morang Hyundai' && r.customer_id === job.contactId).map((r: any) => String(r.opportunity_id)))];
        if (ids.length === 1 && /^\d+$/.test(String(ids[0]))) job.opportunityId = ids[0];
      }
      this.store.run("UPDATE sms_activity SET status='writing',contactId=?,opportunityId=? WHERE id=?", job.contactId || null, job.opportunityId || null, job.id);
      return job;
    });
  }
  finishSmsActivity(id: string, input: any) {
    if (!['synced', 'needs_match', 'needs_review'].includes(input.state)) throw new BadRequestException('Invalid SMS activity outcome.');
    const job = this.store.one('SELECT * FROM sms_activity WHERE id=?', id);
    if (!job) throw new BadRequestException('SMS activity not found.');
    if (job.status === 'synced') return { accepted: true };
    if (job.status !== 'writing') throw new ConflictException('SMS activity is not being processed.');
    this.store.run('UPDATE sms_activity SET status=?,detail=? WHERE id=?', input.state, input.state === 'synced' ? 'Verified in DealerSocket opportunity work notes' : 'Operator review required; no automatic replay', id);
    return { accepted: true };
  }
  linkSmsActivity(id: string, input: any) {
    if (!/^\d+$/.test(String(input.contactId || '')) || !/^\d+$/.test(String(input.opportunityId || ''))) throw new BadRequestException('Customer and opportunity IDs are required.');
    const job = this.store.one('SELECT status FROM sms_activity WHERE id=?', id);
    if (!job || !['pending', 'needs_match'].includes(job.status)) throw new ConflictException('Only an unmatched SMS activity can be linked.');
    this.store.run("UPDATE sms_activity SET contactId=?,opportunityId=?,status='pending',detail='' WHERE id=?", String(input.contactId), String(input.opportunityId), id);
    this.store.audit('SMS activity customer linked', 'Chrome must verify site, customer, mobile and opportunity before saving.');
    return { linked: true };
  }
  async smsInbox(sync = false) {
    let truncated = false;
    if (sync) {
      for (let offset = 0; offset < 2000; offset += 200) {
        const page = await this.provider(`inbound?limit=200&offset=${offset}&from=${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}`);
        if (!Array.isArray(page.results)) throw new ServiceUnavailableException('Invalid provider inbox response.');
        for (const item of page.results) this.acceptInbound(item);
        if (page.results.length < 200) break;
        if (offset === 1800) truncated = true;
      }
    }
    return { results: this.store.all('SELECT * FROM sms_inbound ORDER BY receivedAt DESC LIMIT 100'), tests: this.store.all('SELECT * FROM sms_tests ORDER BY createdAt DESC LIMIT 10'), activities: this.store.all('SELECT id,mobile,direction,status,detail,createdAt FROM sms_activity ORDER BY createdAt DESC LIMIT 100'), truncated };
  }
  async sendTest(input: { requestId?: string }) {
    if (process.env.SMS_TEST_SEND_ENABLED !== 'true') throw new BadRequestException('Test sending is disabled.');
    if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '')) throw new BadRequestException('A test request UUID is required.');
    const id = input.requestId!, recipient = mobileNumber(process.env.MOBILEMESSAGE_TEST_RECIPIENT), sender = mobileNumber(process.env.MOBILEMESSAGE_FROM);
    const previous = this.store.one('SELECT * FROM sms_tests WHERE id=?', id);
    if (previous) return previous;
    if (this.store.one('SELECT mobile FROM suppressions WHERE mobile=?', recipient)) throw new BadRequestException('The test recipient is suppressed.');
    if (this.store.one('SELECT id FROM sms_tests WHERE createdAt>?', new Date(Date.now() - 60000).toISOString())) throw new BadRequestException('Wait one minute before another test.');
    const senders = await this.provider('senders');
    if (!senders.results?.some((s: any) => String(s.sender).replace(/^\+/, '') === sender.slice(1))) throw new BadRequestException('The test sender is not approved on this provider account.');
    // Claim after the asynchronous account check, before any paid send.
    if (this.store.one('SELECT id FROM sms_tests WHERE id=? OR createdAt>?', id, new Date(Date.now() - 60000).toISOString())) throw new ConflictException('A test is already in progress.');
    this.store.run("INSERT INTO sms_tests VALUES(?,?,?,'sending',NULL,?)", id, recipient, sender, now());
    try {
      const response = await this.provider('messages', 'POST', { messages: [{ to: recipient.slice(1), sender: sender.slice(1), message: 'Booran South Morang Hyundai: Portal connection test only. No customer campaign has been launched. {optout}', custom_ref: id }], ignore_unsubscribes: false, max_parts: 2 }, id);
      const result = response.results?.[0];
      const status = result?.status === 'success' ? 'sent' : ['blocked', 'error'].includes(result?.status) ? 'failed' : 'unknown';
      this.store.run('UPDATE sms_tests SET status=?,providerId=? WHERE id=?', status, result?.message_id || null, id);
    } catch {
      this.store.run("UPDATE sms_tests SET status='unknown' WHERE id=?", id);
    }
    this.store.audit('Test SMS attempted', 'Configured test recipient only; campaign sending unchanged');
    return this.store.one('SELECT * FROM sms_tests WHERE id=?', id);
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
  async send(id: string) {
    const ready = this.dashboard().readiness;
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
      !senders.results?.some((sender: any) => String(sender.sender).replace(/^\+/, '') === String(ready.senderId).replace(/^\+/, ''))
    )
      throw new BadRequestException(
        'The configured sender is not approved on the Mobile Message account.',
      );
    const campaign = this.store.one('SELECT * FROM campaigns WHERE id=?', id);
    if (!campaign?.approved)
      throw new BadRequestException('Approve campaign copy first.');
    if (campaign.status !== 'approved')
      throw new ConflictException('Campaign has already been dispatched.');
    this.store.transaction(() => {
      this.store.run("UPDATE campaigns SET status='sending' WHERE id=?", id);
      for (const c of this.store.all(
        'SELECT * FROM contacts WHERE mobile NOT IN (SELECT mobile FROM suppressions)',
      ))
        this.store.run(
          "INSERT OR IGNORE INTO messages(id,campaignId,contactId,token,status,createdAt) VALUES(?,?,?,?,'queued',?)",
          randomUUID(),
          id,
          c.id,
          randomUUID(),
          now(),
        );
    });
    let sent = 0,
      uncertain = 0;
    for (const m of this.store.all(
      "SELECT m.*,c.mobile,c.firstName FROM messages m JOIN contacts c ON c.id=m.contactId WHERE campaignId=? AND m.status='queued'",
      id,
    )) {
      if (
        this.store.one(
          'SELECT mobile FROM suppressions WHERE mobile=?',
          m.mobile,
        )
      ) {
        this.store.run(
          "UPDATE messages SET status='suppressed' WHERE id=?",
          m.id,
        );
        continue;
      }
      const url = `${process.env.PUBLIC_PORTAL_URL!.replace(/\/$/, '')}/r/${m.token}`;
      const limit = frequency(),
        cutoff = new Date(Date.now() - limit.hours * 3600000).toISOString();
      const attempts =
        this.store.one(
          "SELECT COUNT(*) AS n FROM messages WHERE contactId=? AND status IN ('sending','sent','delivered','unknown') AND createdAt>=?",
          m.contactId,
          cutoff,
        )?.n || 0;
      if (attempts >= limit.maximum) {
        this.store.run(
          "UPDATE messages SET status='frequency_limited' WHERE id=?",
          m.id,
        );
        continue;
      }
      const body = campaign.body
        .replaceAll('{link}', url)
        .replaceAll('{firstName}', m.firstName || 'there');
      this.store.run("UPDATE messages SET status='sending' WHERE id=?", m.id);
      try {
        const data = await this.provider(
          'messages',
          'POST',
          {
            messages: [
              {
                to: m.mobile.slice(1),
                sender: ready.senderId,
                message: body,
                custom_ref: m.id,
              },
            ],
            enable_unicode: true,
            ignore_unsubscribes: false,
            shorten_urls: 'auto',
            max_parts: 4,
          },
          m.id,
        );
        const result = data.results?.[0];
        if (!result || !['success', 'blocked', 'error'].includes(result.status))
          throw new Error('Unrecognized provider response');
        const status =
          result.status === 'success'
            ? 'sent'
            : result.status === 'blocked'
              ? 'suppressed'
              : 'failed';
        this.store.run(
          "UPDATE messages SET status=CASE WHEN status IN ('delivered','failed') THEN status ELSE ? END,providerId=? WHERE id=?",
          status,
          result.message_id || null,
          m.id,
        );
        if (result.status === 'blocked')
          this.suppress(m.mobile, 'Provider opt-out');
        if (status === 'sent') sent++;
        if (status === 'sent') {
          const contact = this.store.one('SELECT dealerSocketContactId FROM contacts WHERE id=?', m.contactId);
          this.queueSmsActivity(`outbound:${m.id}`, m.mobile, 'outbound', body, contact?.dealerSocketContactId);
        }
      } catch {
        this.store.run("UPDATE messages SET status='unknown' WHERE id=?", m.id);
        uncertain++;
      }
    }
    this.store.run(
      'UPDATE campaigns SET status=? WHERE id=?',
      uncertain ? 'needs_review' : 'completed',
      id,
    );
    this.store.audit(
      'Campaign send finished',
      `${sent} accepted; ${uncertain} require provider reconciliation`,
    );
    return { sent, uncertain };
  }
  captureLead(input: any) {
    const mobile = mobileNumber(input.mobile),
      eventId = text(input.eventId, 100);
    if (!eventId || !text(input.firstName))
      throw new BadRequestException(
        'First name and unique eventId are required.',
      );
    return this.store.transaction(() => {
      const existing = this.store.one(
        'SELECT id,mobile FROM leads WHERE eventId=?',
        eventId,
      );
      if (existing && existing.mobile !== mobile)
        throw new ConflictException(
          'Submission ID already belongs to another registration.',
        );
      if (existing) return { id: existing.id };
      const id = randomUUID();
      const message = input.token
        ? this.store.one(
            'SELECT m.*,c.mobile AS originatingMobile FROM messages m JOIN contacts c ON c.id=m.contactId WHERE token=?',
            text(input.token),
          )
        : null;
      this.store.run(
        'INSERT INTO leads(id,mobile,firstName,lastName,email,campaignId,createdAt,eventId,dealerSocketContactId) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        mobile,
        text(input.firstName),
        text(input.lastName),
        text(input.email, 320),
        message?.campaignId || null,
        now(),
        eventId,
        /^\d+$/.test(String(input.dealerSocketContactId || ''))
          ? String(input.dealerSocketContactId)
          : this.store.one(
              'SELECT dealerSocketContactId FROM contacts WHERE mobile=?',
              mobile,
            )?.dealerSocketContactId || null,
      );
      this.suppress(mobile, 'Lead registered');
      if (message?.originatingMobile && message.originatingMobile !== mobile)
        this.suppress(message.originatingMobile, 'Lead registered');
      this.store.run(
        'INSERT INTO outbox VALUES(?,?,?,?,?)',
        randomUUID(),
        id,
        'pending_configuration',
        'Waiting for CRM routing, matched customer, and enabled write worker',
        now(),
      );
      this.store.audit(
        'Lead registered',
        'Further campaign messages suppressed; CRM delivery queued',
      );
      return { id };
    });
  }
  linkCustomer(id: string, input: any) {
    if (!/^\d+$/.test(String(input.contactId || '')))
      throw new BadRequestException(
        'Enter the matching DealerSocket customer ID.',
      );
    const lead = this.store.one(
      'SELECT l.*,o.status AS crmStatus FROM leads l JOIN outbox o ON o.leadId=l.id WHERE l.id=?',
      id,
    );
    if (!lead) throw new BadRequestException('Lead not found.');
    if (['writing', 'synced', 'needs_review'].includes(lead.crmStatus))
      throw new ConflictException(
        'Resolve the current CRM write before changing its customer match.',
      );
    this.store.run(
      'UPDATE leads SET dealerSocketContactId=? WHERE id=?',
      String(input.contactId),
      id,
    );
    this.store.run(
      "UPDATE outbox SET status='pending_configuration',detail='Customer linked; waiting for enabled CRM worker' WHERE leadId=? AND status='needs_match'",
      id,
    );
    this.store.audit(
      'CRM customer linked',
      'Customer identity will be verified against the registration mobile before saving.',
    );
    return { linked: true };
  }
  async syncQueue() {
    if (process.env.DEALERSOCKET_WORKER_MODE === 'chrome') return;
    if (
      this.syncing ||
      process.env.DEALERSOCKET_CAMPAIGN_WRITES_ENABLED !== 'true'
    )
      return;
    this.syncing = true;
    try {
      const routing = this.routing();
      if (!routing.salesManager || !routing.generalManager) return;
      const running = this.store.one(
        "SELECT * FROM outbox WHERE status='writing' ORDER BY createdAt LIMIT 1",
      );
      if (running) {
        const result = await this.connector(`campaign/leads/${running.leadId}`);
        if (result.state === 'synced') {
          this.store.run(
            "UPDATE outbox SET status='synced',detail=? WHERE leadId=?",
            `DealerSocket opportunity ${result.opportunityId}; both managers assigned`,
            running.leadId,
          );
          this.store.audit(
            'CRM lead delivered',
            `DealerSocket opportunity ${result.opportunityId}`,
          );
        } else if (
          ['needs_review', 'not_started', 'preparation_failed'].includes(
            result.state,
          )
        )
          this.store.run(
            "UPDATE outbox SET status='needs_review',detail=? WHERE leadId=?",
            result.message ||
              'Verify the customer, session and CRM write journal before retrying.',
            running.leadId,
          );
        return;
      }
      const lead = this.store.one(
        "SELECT l.* FROM leads l JOIN outbox o ON o.leadId=l.id WHERE o.status='pending_configuration' AND l.dealerSocketContactId IS NOT NULL ORDER BY l.createdAt LIMIT 1",
      );
      if (!lead) return;
      this.store.run(
        "UPDATE outbox SET status='writing',detail='Verifying customer identity and routing in DealerSocket' WHERE leadId=?",
        lead.id,
      );
      try {
        await this.connector('campaign/leads', 'POST', {
          leadId: lead.id,
          contactId: Number(lead.dealerSocketContactId),
          mobile: lead.mobile,
          salesManager: routing.salesManager,
          generalManager: routing.generalManager,
        });
      } catch {
        this.store.run(
          "UPDATE outbox SET status='needs_review',detail='Connector response unavailable. Reconcile the write journal before retrying.' WHERE leadId=?",
          lead.id,
        );
      }
    } catch {
      /* Retain the durable outbox state; check again on the next cycle. */
    } finally {
      this.syncing = false;
    }
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
