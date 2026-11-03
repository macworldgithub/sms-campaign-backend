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
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { CampaignService, mobileNumber, text } from './campaign.service';

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
  @Post('worker/chrome/catalog') catalog(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.acceptChromeCatalog(input);
  }
  @Post('worker/chrome/snapshot') snapshot(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.acceptChromeSnapshot(input);
  }
  @Post('worker/chrome/claim') claim(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.claimChromeJob(input);
  }
  @Post('worker/chrome/results/:id') finish(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.finishChromeJob(id, input);
  }
  @Post('leads/:id/customer') linkCustomer(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.linkCustomer(id, input);
  }
  @Get('routing') routing(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.routing();
  }
  @Post('routing') setRouting(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.saveRouting(input);
  }
  @Get('health') health() {
    return { status: 'ok' };
  }
  @Get('portal') dashboard(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.dashboard();
  }
  @Post('contacts/import') import(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.importContacts(input);
  }
  @Post('contacts/import-workbook') workbook(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.importWorkbook(input);
  }
  @Post('suppressions') suppress(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.suppress(input.mobile, 'Manual opt-out');
  }
  @Post('campaigns') create(
    @Headers('x-portal-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.createCampaign(input);
  }
  @Post('campaigns/:id/approve') approve(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.approve(id);
  }
  @Post('campaigns/:id/send') send(
    @Headers('x-portal-key') key: string,
    @Param('id') id: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.send(id);
  }
  @Get('dealersocket') async dealer(@Headers('x-portal-key') key: string) {
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
  @Post('dealersocket/:action') dealerAction(
    @Headers('x-portal-key') key: string,
    @Param('action') action: string,
  ) {
    authorize(key, process.env.PORTAL_API_KEY);
    const actions = {
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
  @Get('provider') provider(@Headers('x-portal-key') key: string) {
    authorize(key, process.env.PORTAL_API_KEY);
    return this.service.provider('senders');
  }
  @Post('webhooks/leads') lead(
    @Headers('x-webhook-key') key: string,
    @Body() input: any,
  ) {
    authorize(key, process.env.LEAD_WEBHOOK_KEY);
    return this.service.captureLead(input);
  }
  @Post('webhooks/sms') sms(
    @Req() req: RawBodyRequest<Request>,
    @Body() input: any,
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
      ['delivered', 'failed'].includes(input.status)
    ) {
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
            input.message_id,
            part,
            total,
            input.status,
            received,
          );
          const rows = this.service.store.all(
            'SELECT * FROM receipts WHERE messageId=?',
            input.message_id,
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
              input.message_id,
              text(input.custom_ref),
            );
        });
      }
    }
    return { accepted: true };
  }
  @Get('tracking/:token') tracking(
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
