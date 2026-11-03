import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { CampaignService, mobileNumber, text } from './campaign.service';
import {
  CaptureLeadDto,
  ChromeCatalogDto,
  ChromeClaimJobDto,
  ChromeJobResultDto,
  ChromeSnapshotDto,
  CreateCampaignDto,
  HealthResponseDto,
  ImportContactsDto,
  ImportWorkbookDto,
  LinkCustomerDto,
  MobileMessageWebhookDto,
  SaveRoutingDto,
  SuppressionDto,
} from './dto/campaign.dto';

function authorize(actual: string | undefined, expected: string | undefined) {
  if (
    !expected ||
    expected.length < 32 ||
    !actual ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new UnauthorizedException('Valid API credentials are required.');
}

@Controller()
export class CampaignController {
  constructor(private readonly service: CampaignService) {}

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Submit Chrome Worker Catalog',
    description:
      'Receives and stores verified South Morang Hyundai staff & franchise catalog from the unattended Chrome worker.',
  })
  @ApiBody({ type: ChromeCatalogDto })
  @ApiResponse({ status: 201, description: 'Catalog accepted and saved.' })
  @ApiResponse({ status: 400, description: 'Invalid Hyundai catalog payload.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @Post('worker/chrome/catalog')
  catalog(
    @Headers('x-portal-key') key: string,
    @Body() input: ChromeCatalogDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.acceptChromeCatalog(input);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Submit Chrome Worker Snapshot',
    description:
      'Accepts read-only DealerSocket lead observations for South Morang Hyundai.',
  })
  @ApiBody({ type: ChromeSnapshotDto })
  @ApiResponse({ status: 201, description: 'Snapshot accepted.' })
  @ApiResponse({ status: 400, description: 'Invalid snapshot scope or rooftop.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @Post('worker/chrome/snapshot')
  snapshot(
    @Headers('x-portal-key') key: string,
    @Body() input: ChromeSnapshotDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.acceptChromeSnapshot(input);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Claim Pending Chrome Worker Job',
    description:
      'Heartbeat check for Chrome worker that claims the next pending CRM delivery job.',
  })
  @ApiBody({ type: ChromeClaimJobDto, required: false })
  @ApiResponse({ status: 201, description: 'Assigned job details or refresh request flag.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @Post('worker/chrome/claim')
  claim(
    @Headers('x-portal-key') key: string,
    @Body() input: ChromeClaimJobDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.claimChromeJob(input);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Report Chrome Worker Job Results',
    description:
      'Updates outbox status with opportunity ID on success or flags for operator review.',
  })
  @ApiParam({ name: 'id', description: 'Lead ID' })
  @ApiBody({ type: ChromeJobResultDto })
  @ApiResponse({ status: 201, description: 'Job result accepted.' })
  @ApiResponse({ status: 400, description: 'Invalid result or CRM job not found.' })
  @ApiResponse({ status: 409, description: 'Job not in writing state.' })
  @Post('worker/chrome/results/:id')
  finish(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
    @Body() input: ChromeJobResultDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.finishChromeJob(id, input);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Link Lead to DealerSocket Customer',
    description:
      'Manually links a campaign lead to a specific DealerSocket customer profile ID.',
  })
  @ApiParam({ name: 'id', description: 'Lead ID' })
  @ApiBody({ type: LinkCustomerDto })
  @ApiResponse({ status: 201, description: 'Customer linked successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid contact ID or lead not found.' })
  @ApiResponse({ status: 409, description: 'Cannot change match while CRM write is in progress.' })
  @Post('leads/:id/customer')
  linkCustomer(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
    @Body() input: LinkCustomerDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.linkCustomer(id, input);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Get CRM Routing Configuration',
    description:
      'Returns current DealerSocket manager assignments (Primary Sales Manager, Secondary General Manager) and verified user catalog.',
  })
  @ApiResponse({ status: 200, description: 'Current routing settings and catalog.' })
  @Get('routing')
  routing(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.routing();
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Update CRM Routing Configuration',
    description:
      'Saves DealerSocket manager assignments for South Morang Hyundai lead routing.',
  })
  @ApiBody({ type: SaveRoutingDto })
  @ApiResponse({ status: 201, description: 'Routing configuration saved.' })
  @ApiResponse({ status: 400, description: 'Invalid or duplicate manager assignments.' })
  @Post('routing')
  setRouting(
    @Headers('x-portal-key') key: string,
    @Body() input: SaveRoutingDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.saveRouting(input);
  }

  @ApiTags('Health & System')
  @ApiOperation({
    summary: 'Service Health Status',
    description: 'Public health probe endpoint for monitoring and uptime checks.',
  })
  @ApiResponse({ status: 200, description: 'Service is operational.', type: HealthResponseDto })
  @Get('health')
  health(): HealthResponseDto {
    return { status: 'ok' };
  }

  @ApiTags('Dashboard & Operations')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Get Operator Dashboard State',
    description:
      'Returns complete dashboard data including metrics, campaigns, recent contacts, leads with CRM outbox state, suppressions, activity log, and service readiness.',
  })
  @ApiResponse({ status: 200, description: 'Operator dashboard state.' })
  @Get('portal')
  dashboard(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.dashboard();
  }

  @ApiTags('Contacts & Audience')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Import Audience Contacts (JSON)',
    description:
      'Imports a batch of contact rows with Spam Act 2003 consent type and audit evidence.',
  })
  @ApiBody({ type: ImportContactsDto })
  @ApiResponse({ status: 201, description: 'Import summary with count of added, duplicate, and rejected rows.' })
  @ApiResponse({ status: 400, description: 'Invalid contact data or batch exceeds 10,000 rows.' })
  @Post('contacts/import')
  import(
    @Headers('x-portal-key') key: string,
    @Body() input: ImportContactsDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.importContacts(input);
  }

  @ApiTags('Contacts & Audience')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Import Audience Contacts from XLSX Workbook',
    description:
      'Accepts a Base64-encoded XLSX spreadsheet and extracts audience contacts via Python helper.',
  })
  @ApiBody({ type: ImportWorkbookDto })
  @ApiResponse({ status: 201, description: 'Import summary.' })
  @ApiResponse({ status: 400, description: 'Invalid workbook, missing columns, or file exceeds 5 MB.' })
  @Post('contacts/import-workbook')
  workbook(
    @Headers('x-portal-key') key: string,
    @Body() input: ImportWorkbookDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.importWorkbook(input);
  }

  @ApiTags('Suppressions')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Manually Suppress Contact',
    description:
      'Adds a mobile number to the opt-out suppression list and marks any queued messages as suppressed.',
  })
  @ApiBody({ type: SuppressionDto })
  @ApiResponse({ status: 201, description: 'Mobile number suppressed successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid Australian mobile number.' })
  @Post('suppressions')
  suppress(
    @Headers('x-portal-key') key: string,
    @Body() input: SuppressionDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.suppress(input.mobile, 'Manual opt-out');
  }

  @ApiTags('Campaigns')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Create SMS Campaign Draft',
    description:
      'Creates a new campaign draft. Message body must mention Booran and include {link} and {optout} placeholders.',
  })
  @ApiBody({ type: CreateCampaignDto })
  @ApiResponse({ status: 201, description: 'Campaign created with assigned ID.' })
  @ApiResponse({ status: 400, description: 'Validation failed for required placeholders or brand name.' })
  @Post('campaigns')
  create(
    @Headers('x-portal-key') key: string,
    @Body() input: CreateCampaignDto,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.createCampaign(input);
  }

  @ApiTags('Campaigns')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Approve Campaign Copy',
    description: 'Marks a draft campaign copy as approved for operator dispatch.',
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID' })
  @ApiResponse({ status: 201, description: 'Campaign approved.' })
  @ApiResponse({ status: 400, description: 'Campaign not found.' })
  @ApiResponse({ status: 409, description: 'Campaign is not in draft status.' })
  @Post('campaigns/:id/approve')
  approve(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.approve(id);
  }

  @ApiTags('Campaigns')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Dispatch Approved Campaign',
    description:
      'Initiates batch SMS transmission through MobileMessage provider, enforcing opt-out suppressions and frequency caps.',
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID' })
  @ApiResponse({ status: 201, description: 'Dispatch finished with counts of sent and uncertain messages.' })
  @ApiResponse({ status: 400, description: 'Campaign not approved or prerequisites not configured.' })
  @ApiResponse({ status: 409, description: 'Campaign already dispatched.' })
  @Post('campaigns/:id/send')
  send(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.send(id);
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Get DealerSocket Session & Snapshot Status',
    description:
      'Returns current DealerSocket connection status and latest snapshot of leads for South Morang Hyundai.',
  })
  @ApiResponse({ status: 200, description: 'DealerSocket status and latest snapshot.' })
  @Get('dealersocket')
  async dealer(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    if (process.env.DEALERSOCKET_WORKER_MODE === 'chrome')
      return {
        session: this.service.chromeStatus(),
        snapshot: this.service.chromeSnapshot() || {
          scope: 'south_morang_hyundai',
          state: 'idle',
          records: [],
          coverageNote:
            'Run the Hyundai Chrome worker to collect the first snapshot.',
        },
      };
    const [session, liveSnapshot] = await Promise.all([
      this.service.connector('status').catch(() => ({
        state: 'unavailable',
        message:
          'The unattended connector is unavailable. Chrome observations retain their original capture time.',
      })),
      this.service
        .connector('leads/status?scope=south_morang_hyundai')
        .catch(() => null),
    ]);
    const chromeSnapshot = this.service.chromeSnapshot();
    const snapshot =
      liveSnapshot?.scope === 'south_morang_hyundai' &&
      (!chromeSnapshot ||
        Date.parse(liveSnapshot.fetchedAt || '') >
          Date.parse(chromeSnapshot.fetchedAt))
        ? liveSnapshot
        : chromeSnapshot || {};
    return {
      session,
      snapshot:
        snapshot.scope === 'south_morang_hyundai'
          ? snapshot
          : {
              state: 'scope_refresh_required',
              records: [],
              coverageNote:
                'Existing snapshot belongs to another rooftop scope. Restart the updated connector, then refresh South Morang Hyundai leads.',
            },
    };
  }

  @ApiTags('DealerSocket & Chrome Worker')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Trigger DealerSocket Action',
    description:
      'Executes session diagnostic check, automatic login, or lead synchronization on the connector or Chrome worker.',
  })
  @ApiParam({
    name: 'action',
    enum: ['check', 'login', 'sync'],
    description: 'Action to trigger',
  })
  @ApiResponse({ status: 201, description: 'Action initiated.' })
  @ApiResponse({ status: 401, description: 'Unsupported action.' })
  @Post('dealersocket/:action')
  dealerAction(
    @Headers('x-portal-key') key: string,
    @Param('action') action: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    const actions: Record<string, string> = {
      check: 'check',
      login: 'login/automatic/start',
      sync: 'leads/read',
    };
    if (!actions[action]) throw new UnauthorizedException('Unsupported action');
    if (process.env.DEALERSOCKET_WORKER_MODE === 'chrome')
      return action === 'sync'
        ? this.service.requestChromeRefresh()
        : this.service.chromeStatus();
    return this.service.connector(
      actions[action],
      'POST',
      action === 'sync'
        ? { maxRecords: 200, detailLimit: 50, scope: 'south_morang_hyundai' }
        : undefined,
    );
  }

  @ApiTags('Dashboard & Operations')
  @ApiSecurity('portal-key')
  @ApiOperation({
    summary: 'Get SMS Provider Senders',
    description:
      'Retrieves the list of registered sender IDs from the MobileMessage provider account.',
  })
  @ApiResponse({ status: 200, description: 'List of registered sender IDs.' })
  @ApiResponse({ status: 503, description: 'MobileMessage credentials not configured.' })
  @Get('provider')
  provider(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.provider('senders');
  }

  @ApiTags('Webhooks')
  @ApiSecurity('webhook-key')
  @ApiOperation({
    summary: 'Inbound Lead Registration Webhook',
    description:
      'Receives form submissions from the public loyalty landing page, deduplicates by eventId, and stages lead for CRM delivery.',
  })
  @ApiHeader({
    name: 'x-webhook-key',
    description: 'Authentication key for lead ingestion (LEAD_WEBHOOK_KEY)',
  })
  @ApiBody({ type: CaptureLeadDto })
  @ApiResponse({ status: 201, description: 'Lead successfully captured and queued.' })
  @ApiResponse({ status: 400, description: 'Validation failed for required lead fields.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 409, description: 'Event ID already registered to a different mobile number.' })
  @Post('webhooks/leads')
  lead(
    @Headers('x-webhook-key') key: string,
    @Body() input: CaptureLeadDto,
  ) {
    authorize(key, process.env.LEAD_WEBHOOK_KEY);
    return this.service.captureLead(input);
  }

  @ApiTags('Webhooks')
  @ApiSecurity('sms-webhook-signature')
  @ApiOperation({
    summary: 'MobileMessage SMS Provider Webhook',
    description:
      'Receives delivery receipts, inbound customer replies, and STOP opt-out events with HMAC-SHA256 signature verification.',
  })
  @ApiHeader({
    name: 'x-mm-timestamp',
    description: 'Unix epoch timestamp in seconds for replay prevention',
  })
  @ApiHeader({
    name: 'x-mm-signature',
    description: 'HMAC-SHA256 hex digest computed over timestamp + rawBody',
  })
  @ApiBody({ type: MobileMessageWebhookDto })
  @ApiResponse({ status: 201, description: 'Webhook acknowledged and processed.' })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature or expired timestamp.' })
  @Post('webhooks/sms')
  sms(
    @Req() req: RawBodyRequest<Request>,
    @Body() input: MobileMessageWebhookDto,
  ) {
    const timestamp = String(req.headers['x-mm-timestamp'] || ''),
      signature = String(req.headers['x-mm-signature'] || ''),
      secret = process.env.MOBILEMESSAGE_WEBHOOK_SECRET;
    if (
      !secret ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      !req.rawBody
    )
      throw new UnauthorizedException('Invalid webhook signature.');
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(req.rawBody)
      .digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new UnauthorizedException('Invalid webhook signature.');
    if (
      input.type === 'unsubscribe' ||
      (input.type === 'inbound' &&
        /^(STOP|UNSUBSCRIBE|CANCEL|END|QUIT)$/i.test(text(input.message)))
    )
      return this.service.suppress(
        mobileNumber(input.sender),
        'Provider opt-out',
      );
    if (
      typeof input.message_id === 'string' &&
      ['delivered', 'failed'].includes(input.status || '')
    ) {
      const messageId = input.message_id;
      const part = Number(input.part_number || 1),
        total = Number(input.total_parts || 1),
        received = text(input.received_at, 40);
      if (
        Number.isInteger(part) &&
        Number.isInteger(total) &&
        part > 0 &&
        part <= total &&
        total <= 99 &&
        received
      ) {
        this.service.store.transaction(() => {
          this.service.store.run(
            'INSERT INTO receipts VALUES(?,?,?,?,?) ON CONFLICT(messageId,part) DO UPDATE SET status=excluded.status,receivedAt=excluded.receivedAt WHERE excluded.receivedAt>receipts.receivedAt',
            messageId,
            part,
            total,
            input.status || null,
            received,
          );
          const rows = this.service.store.all(
            'SELECT * FROM receipts WHERE messageId=?',
            messageId,
          );
          const status = rows.some((r) => r.status === 'failed')
            ? 'failed'
            : rows.length === total &&
                rows.every((r) => r.status === 'delivered')
              ? 'delivered'
              : null;
          if (status)
            this.service.store.run(
              'UPDATE messages SET status=? WHERE providerId=? OR (id=? AND providerId IS NULL)',
              status,
              messageId,
              text(input.custom_ref),
            );
        });
      }
    }
    return { accepted: true };
  }

  @ApiTags('Tracking')
  @ApiOperation({
    summary: 'Campaign Shortlink Click Tracking & Redirect',
    description:
      'Increments message click count, constructs loyalty portal destination with UTM parameters, and returns an HTTP 302 redirect.',
  })
  @ApiParam({ name: 'token', description: 'Unique 36-character campaign message shortlink token' })
  @ApiResponse({ status: 302, description: 'Redirected to loyalty experience.' })
  @ApiResponse({ status: 404, description: 'Token not found.' })
  @Get('tracking/:token')
  tracking(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const message = this.service.store.one(
      'SELECT id,campaignId FROM messages WHERE token=?',
      token,
    );
    if (!message) return res.status(404).send('Link not found');
    this.service.store.run(
      'UPDATE messages SET clicks=clicks+1 WHERE id=?',
      message.id,
    );
    const target = new URL(
      process.env.PUBLIC_PORTAL_URL
        ? `${process.env.PUBLIC_PORTAL_URL.replace(/\/$/, '')}/loyalty`
        : process.env.LOYALTY_EMBED_URL ||
            'https://smh-loyalty-embed.netlify.app',
    );
    target.searchParams.set('utm_source', 'sms');
    target.searchParams.set('utm_medium', 'loyalty');
    target.searchParams.set('utm_campaign', message.campaignId);
    target.searchParams.set('ref', token);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, target.toString());
  }
}
