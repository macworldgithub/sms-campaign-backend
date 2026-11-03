# Booran Loyalty Studio

The Next.js portal is in `../sms-campaign`; this NestJS application owns campaign data and sends. The existing Python service in `../metaphor-replacement-api` owns DealerSocket browser automation. Requires Node 22.13+ (built-in SQLite) and the existing Python environment with openpyxl for Excel imports.

## Local operation

Local environment files have been generated, are ignored by Git, and do not copy the provider or DealerSocket credentials. The backend reads the existing connector `.env` using `SHARED_ENV_FILE`. Existing local environment variables take priority.

1. Open the authenticated South Morang Hyundai DealerSocket session in Chrome. For this portal, Chrome mode uses the existing session through the Playwright extension. The original `run_connector.py` remains available for the separate persistent-profile mode.
2. Backend: from `sms-campaign-backend`, run `npm run build`, then `npm run start:prod` (port 4000).
3. Portal: from `sms-campaign`, run `npm run dev` (port 3000).
   Public experience: in a second terminal in the same checkout, run `npm run dev:public` (port 3001). This separate origin serves the supplied customer experience and registration endpoint; operator API access is disabled there.
4. Open `http://localhost:3000`. The portal password is the `PORTAL_PASSWORD` entry in the frontend `.env.local`.
5. From `metaphor-replacement-api`, run `.venv\Scripts\python.exe scripts/run_hyundai_chrome_worker.py`. Approve Chrome's normal share-tab prompt if shown. An already configured `PLAYWRIGHT_MCP_EXTENSION_TOKEN` can provide the supported unattended connection; it is never logged. The worker creates its own tab within the authenticated Chrome profile, refreshes Hyundai queues, and maintains a heartbeat. A refresh can also be requested from Integrations. `--once` captures one snapshot and exits.

For a fresh checkout, `node scripts/setup-local.mjs` creates the backend `.env` and frontend `.env.local` with random credentials. It refuses to overwrite existing files. See `.env.example` in each application. Keep ports 4000 and 8000 private. The portal proxies authenticated operations, so provider credentials and connector keys are never sent to the browser.

## Implemented flows

- Persistent SQLite contacts, consent evidence, global suppression, campaign approval, messages, click tracking, lead registrations, CRM outbox, multipart delivery receipts and audit events.
- CSV and XLSX imports (first worksheet, up to 10,000 records, maximum 5 MB file, bounded decompressed workbook). Columns: `mobile`, `firstName`, `lastName`, `consent`, `evidence`. Consent must be `express` or `inferred`; evidence is mandatory. Importing a number never removes suppression. CRM presence never establishes consent.
- Campaign templates require Booran identification, `{link}` and `{optout}`; `{firstName}` is optional. Copy is reviewed before approval. A recipient can be queued only once per campaign. Dispatch rechecks suppression and frequency immediately before every provider call. The default cross-campaign limit is one attempted/accepted message per customer in 720 hours, configurable with `SMS_MAX_PER_WINDOW` and `SMS_FREQUENCY_WINDOW_HOURS`. Ambiguous attempts count toward this limit. Campaigns cannot be dispatched twice.
- Mobile Message uses its documented Basic-auth API, approved sender check, per-message UUID idempotency key, provider unsubscribe enforcement and `{optout}` replacement. Unicode is enabled to preserve copy; it can increase SMS segments. A four-part ceiling is applied. Provider errors/ambiguous responses are retained for reconciliation instead of automatic resending. No real SMS was sent during implementation.
- Tracking `/r/:token` counts visits then redirects with attribution to `PUBLIC_PORTAL_URL/loyalty`. The wrapper embeds the public landing origin. Counts are visits, including repeat visits/bots, rather than unique people.
- Capturing a lead immediately suppresses its mobile, records an idempotent event and queues CRM delivery. The writer uses the observed DealerSocket form: Internet source, Website tracking code, Hyundai franchise, Sales Manager as Primary and General Manager as Secondary. Both assignees are selected in Integrations from the live form catalog. The Sales Manager suggestion is Mark Robinson (verified site role); the General Manager must be selected explicitly. No live CRM save was performed during implementation; controlled write validation is deferred until the user's test stage.
- The Chrome worker automatically looks up an existing customer by exact mobile in the Hyundai context, using email to narrow duplicate mobile matches. A unique match is required. Optional `dealerSocketContactId` CSV/XLSX or registration fields can provide an explicit match. Ambiguous matches become `needs_match`; an operator can resolve them using “Link existing customer” or `POST /api/leads/:id/customer`. Before saving, the worker verifies the customer ID, matching mobile, dealership 10876 and both assignees. New-customer creation is not automated for this previous-customer campaign.
- Chrome write jobs have a durable journal outside the browser. Successful jobs return the CRM opportunity ID; uncertain attempts become `needs_review` and are never replayed automatically. The optional persistent-profile connector has the same protection.
- DealerSocket session status, normal password/TOTP sign-in, and isolated `south_morang_hyundai` read scope. The original Cranbourne scope is preserved. Hyundai snapshots are not mixed with Cranbourne data. The scheduled original reader retains its configured scope; portal refreshes explicitly request Hyundai.
- Goodshowroom displays exactly: “It will be integrated soon”.

Chrome mode is selected with `DEALERSOCKET_WORKER_MODE=chrome`. `DEALERSOCKET_CAMPAIGN_WRITES_ENABLED=false` remains the default. The same flag must be explicitly enabled in the backend for Chrome writes (and also in the connector environment for persistent-profile writes). Starting a read worker does not enable writing or SMS sending. The Chrome worker requires the supported Playwright extension connection; it does not bypass MFA or clone a user profile.

## Webhooks

Expose backend webhook routes through your HTTPS reverse proxy, separately from the authenticated portal proxy. Never put the portal API key in a public URL.

### Loyalty registration

`POST /api/webhooks/leads`, header `X-Webhook-Key: <LEAD_WEBHOOK_KEY>`.

```json
{"eventId":"unique-form-submission-id","firstName":"Alex","lastName":"Example","mobile":"0412345678","email":"alex@example.com","token":"optional-tracking-token","dealerSocketContactId":"optional-existing-customer-id"}
```

The supplied Netlify page wraps `https://smhloyalty-ryreth7q.manus.space/`. Its actual enquiry contract is the `campaign.enquire` tRPC mutation. The public service preserves that supplied experience through a fixed-host reverse proxy and handles the mutation locally, using this server-to-server webhook. Successful submissions are recorded and suppressed before the existing form displays its success reference. No registration is sent to the original hosted app during this flow. Eligibility, response consent, names, email, Australian mobile, offer expiry and honeypot are validated on the server. A session/tracking key plus normalized mobile makes repeated submissions idempotent. Webhook secrets remain server-only. A valid tracking token attributes the campaign and suppresses the originating SMS recipient as well as the submitted mobile, including forwarded invitations.

The supplied scripts run only on the separate public origin. `APP_ROLE=public` disables the operator API; the admin origin refuses the supplied experience/assets and enquiry handler. Keep this separation in production. `PUBLIC_LOYALTY_ORIGIN` on the operator app points at the public origin; `ADMIN_PORTAL_ORIGIN` on the public app sets the permitted iframe parent. Do not deploy the supplied scripts under the operator origin. The original host's analytics loaders are omitted because campaign reporting is handled first party.

### Mobile Message

Configure inbound and status webhooks at `https://<backend-public-host>/api/webhooks/sms`. Set the same signing secret in the provider dashboard and `MOBILEMESSAGE_WEBHOOK_SECRET`. Verification uses the exact raw body, HMAC-SHA256, timestamp freshness and a timing-safe comparison. Unsigned requests are rejected. Duplicate opt-outs are idempotent; multipart delivery is confirmed only after all parts are delivered, using provider timestamps to ignore older receipt updates.

Official API reference: https://mobilemessage.com.au/api-documentation

## Production dependencies still required

- Confirm the South Morang Hyundai sender. The live account credential check succeeded, but no `BooranSMH` sender was returned. `SMS_SENDER_REGISTERED=true` is an operator confirmation, not a substitute for provider/ACMA registration.
- Final approved copy, consented audience, and authorised DealerSocket Sales Manager/General Manager user or queue IDs.
- Perform the deferred controlled CRM write test and verify the resulting opportunity, Primary/Secondary assignments and idempotent retry handling. No guessed CRM API write endpoints are used; the writer operates the inspected UI.
- Configure Mobile Message signed callbacks on the public backend ingress. The public registration adapter is already connected locally.
- Provision the chosen GoodShowroom subdomain, DNS, TLS and public reverse proxy. Set `PUBLIC_PORTAL_URL=https://<approved-domain>`. DNS ownership/hosting credentials were not supplied.
- Build both frontend roles: `npm run build` and `npm run build:public`; start with `npm start` and `npm run start:public`. Put the two instances behind separate HTTPS hostnames. The public instance defaults to port 3001 and refuses operator access. Both development launchers bind to loopback.
- Set `CAMPAIGN_SEND_ENABLED=true` only after the above are confirmed. The existing `MOBILEMESSAGE_ENABLED` flag alone does not enable campaign dispatch. No campaign is scheduled or dispatched automatically.
- Use HTTPS, rate limiting and an organisation identity provider before exposing this shared-password operator portal publicly. The local preview is loopback-only. Run one backend worker; back up `data/campaign.sqlite` with SQLite's backup API. For multiple application workers, migrate the queue and DB to a shared transactional service.
- If the process stops during a send, reconcile `sending`/`unknown` messages against Mobile Message before retrying. This initial implementation deliberately provides no automatic retry of ambiguous sends.

## Validation

`npm run build` and `npm test -- --runInBand` in this project; `npm run build` and `npm run build:public` in the frontend; `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider` in the connector. Browser checks cover operator login, campaign draft creation, CSV deduplication/rejection, manual suppression, Goodshowroom placeholder, 390px viewport layout, the supplied public form's success path, registration suppression and public/operator API isolation. XLSX import was verified against the running backend. QA records are removed after verification. SMS sends and actual CRM saves are deferred to the user's controlled test stage.
