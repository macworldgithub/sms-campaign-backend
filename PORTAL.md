# Booran Loyalty Studio

The Next.js portal is in `../sms-campaign`; this NestJS application owns campaign data and sends. The existing Python service in `../metaphor-replacement-api` owns DealerSocket browser automation. Requires Node 22.13+, a MongoDB replica set/Atlas cluster with transaction support, and the existing Python environment with openpyxl for Excel imports. The running application uses MongoDB exclusively.

## Current client-approved journey (5 November 2026)

The client clarified that loyalty SMS is one way. The PDF's Reply STOP branch is superseded for the one-way channel; functional unsubscribe remains available through a web link.

1. Upload the client's consented list; normalise/deduplicate mobiles and check suppression/frequency.
2. Send a one-way loyalty invitation containing `{link}` and `{optout}`. `{link}` becomes a tracked landing-page URL; `{optout}` becomes `Opt out: https://<PUBLIC_PORTAL_URL>/unsubscribe/<message-token>`. Copy asking recipients to Reply STOP is rejected in one-way mode, including previously approved copy at dispatch.
3. The recipient follows the link and submits the loyalty enquiry form. SMS replies and imported CRM records never create campaign enquiries.
4. Capture the form idempotently in MongoDB, preserve response permission/eligibility, attribute the campaign, and suppress further SMS immediately, even when either CRM is unavailable.
5. Stage each CRM destination independently in the durable outbox. DealerSocket uses the confirmed Quoc Truong Primary / Mark Robinson Secondary mapping. GoodShowroom Sales Floor remains `pending_configuration` with “It will be integrated soon”, per the client's explicit instruction; its lead payload remains available through the outbox's leadId until documented API access and instance mappings are supplied. No fabricated GoodShowroom API request is made and no delivery is marked successful.
6. The sales team follows up in the CRMs. The portal reports sends, delivery, link visits, enquiries, opt-outs and separate CRM statuses.

Default `SMS_CHANNEL_MODE=one_way`. Local `SMS_INBOX_POLL_ENABLED=false` and `DEALERSOCKET_SMS_ACTIVITY_ENABLED=false`. The backend additionally enforces one-way behavior even if these legacy flags are accidentally set to true. Conversation endpoints remain backward compatible but do not return conversations, poll the provider, or claim activity writes in one-way mode. Existing history and journals are retained rather than deleted. `sms/outbound` provides delivery/test history without conversation controls.

Unsubscribe GET renders confirmation only; scanners/link previews cannot suppress anyone. POST confirms the opt-out idempotently. The public frontend requires same-origin confirmation and never exposes the full phone number. Delivery receipts and signed provider opt-out events remain supported, including a legacy STOP if received; they are not enquiry channels.

`PUBLIC_PORTAL_URL` must be a public HTTPS base URL for campaign sending and one-way connection tests. An empty URL or localhost cannot produce a usable phone journey. Keep CAMPAIGN_SEND_ENABLED=false until the public domain, callbacks, audience, copy and sender are approved.

## Local operation

Local environment files have been generated, are ignored by Git, and do not copy the provider or DealerSocket credentials. The backend reads the existing connector `.env` using `SHARED_ENV_FILE`. Existing local environment variables take priority.

1. Open the authenticated South Morang Hyundai DealerSocket session in Chrome. For this portal, Chrome mode uses the existing session through the Playwright extension. The original `run_connector.py` remains available for the separate persistent-profile mode.
2. Backend: from `sms-campaign-backend`, run `npm run build`, then `npm run start:prod` (port 4000).
3. Portal: from `sms-campaign`, run `npm run dev` (port 3000).
   Public experience: in a second terminal in the same checkout, run `npm run dev:public` (port 3001). This separate origin serves the supplied customer experience and registration endpoint; operator API access is disabled there.
4. Open `http://localhost:3000`. Sign in as `admin` with `PORTAL_BOOTSTRAP_PASSWORD` from the backend `.env`. This creates the first individual administrator only when no accounts exist; subsequent environment changes do not reset it. Passwords are stored as salted scrypt hashes in MongoDB.
5. From `metaphor-replacement-api`, run `.venv\Scripts\python.exe scripts/run_hyundai_chrome_worker.py`. Approve Chrome's normal share-tab prompt if shown. An already configured `PLAYWRIGHT_MCP_EXTENSION_TOKEN` can provide the supported unattended connection; it is never logged. The worker creates its own tab within the authenticated Chrome profile, refreshes Hyundai queues, and maintains a heartbeat. A refresh can also be requested from Integrations. `--once` captures one snapshot and exits.

For a fresh checkout, `node scripts/setup-local.mjs` creates the backend `.env` and frontend `.env.local` with random credentials. It refuses to overwrite existing files. See `.env.example` in each application. Keep ports 4000 and 8000 private. The portal proxies authenticated operations, so provider credentials and connector keys are never sent to the browser.

## Implemented flows

- Persistent MongoDB contacts, consent evidence, global suppression, campaign approval, messages, click tracking, lead registrations, CRM outbox, multipart delivery receipts and audit events.
- CSV and XLSX imports (first worksheet, up to 10,000 records, maximum 5 MB file, bounded decompressed workbook). Columns: `mobile`, `firstName`, `lastName`, `consent`, `evidence`. Consent must be `express` or `inferred`; evidence is mandatory. Importing a number never removes suppression. CRM presence never establishes consent.
- Campaign templates require Booran identification, `{link}` and `{optout}`; `{firstName}` is optional. Copy is reviewed before approval. A recipient can be queued only once per campaign. Dispatch rechecks suppression and frequency immediately before every provider call. The default cross-campaign limit is one attempted/accepted message per customer in 720 hours, configurable with `SMS_MAX_PER_WINDOW` and `SMS_FREQUENCY_WINDOW_HOURS`. Ambiguous attempts count toward this limit. Campaigns cannot be dispatched twice.
- Mobile Message uses its documented Basic-auth API, approved sender check, per-message UUID idempotency key and provider unsubscribe enforcement. One-way opt-out replacement is handled by the portal web link. Unicode is enabled to preserve copy; it can increase SMS segments. A four-part ceiling is applied. Provider errors/ambiguous responses are retained for reconciliation instead of automatic resending. One authorised connection-test SMS was sent and confirmed delivered; no audience campaign was dispatched.
- Tracking `/r/:token` counts visits then redirects with attribution to `PUBLIC_PORTAL_URL/loyalty`. The wrapper embeds the public landing origin. Counts are visits, including repeat visits/bots, rather than unique people.
- Capturing a lead immediately suppresses its mobile, records an idempotent event and queues CRM delivery. The writer uses the observed DealerSocket form: Internet source, Website tracking code, Hyundai franchise, Sales Manager as Primary and General Manager as Secondary. Both assignees are selected in Integrations from the live form catalog. The client-confirmed mapping is Quoc Truong (s7xqtruong, quoct@southmoranghyundai.com.au) as Sales Manager / Primary, and Mark Robinson (s7xmrobins, markr@booranmotors.com.au) as General Manager / Secondary. Controlled opportunity 162549 was created for approved test customer AJ (55858), then reopened to verify the customer, Hyundai dealership and both assignees. The corresponding portal lead is retained as the controlled test registration and its mobile is suppressed.
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

### Controlled SMS test and optional legacy reply inbox

Set `MOBILEMESSAGE_FROM` and `MOBILEMESSAGE_TEST_RECIPIENT` to the authorised test numbers and enable only `SMS_TEST_SEND_ENABLED`. Integrations provides a fixed-content connection test; the recipient cannot be overridden in the request. Tests use a UUID, persist ambiguous outcomes, respect suppression, and enforce a one-minute cooldown. Retrying the same UUID does not send again. Test records are separate from campaign audience/reporting. `CAMPAIGN_SEND_ENABLED` remains false.

“Refresh SMS replies” imports up to 2,000 account replies from the last 30 days, retains only the configured receiving number and displays the latest 100 stored replies. STOP is immediately suppressed. Signed callbacks use the same storage/deduplication. Test delivery callbacks update test status. Only in explicit two_way mode, SMS_INBOX_POLL_ENABLED enables a 60-second background refresh for replies and STOP handling while local callbacks are unavailable; production signed callbacks remain the immediate notification path. Only in explicit two_way mode, campaign SMS conversations may enter the durable sms_activity queue. DEALERSOCKET_SMS_ACTIVITY_ENABLED controls Chrome activity writes independently from opportunity creation. Only replies linked to portal campaign messages are queued; unrelated account replies are not copied into DealerSocket. Customer/opportunity IDs must match the verified Hyundai record and mobile before an Add a note UI save. A unique matching snapshot opportunity or a previously synced campaign opportunity can resolve the target; otherwise the portal provides manual linking. Ambiguous writes require operator reconciliation and are not automatically replayed. AJ customer 55858 / opportunity 162482 was used for one labelled integration-test note, verified after reload; a repeated job found the existing marker without adding another note. No SMS was sent to AJ. Dual-manager opportunity creation was verified on opportunity 162549 with the client-confirmed Quoc Truong / Mark Robinson mapping. Cynthia Pace is not used.

The supplied numeric sender is approved for account testing; this does not verify the final branded alphanumeric sender required by the original scope. The portal uses the configured MongoDB cluster and a dedicated sms_campaign database; existing collections in other databases are not modified. Do not point the Hyundai Chrome worker at another rooftop's connector without verifying its scoped API support.

- Confirm the South Morang Hyundai sender. The live account credential check succeeded, but no `BooranSMH` sender was returned. `SMS_SENDER_REGISTERED=true` is an operator confirmation, not a substitute for provider/ACMA registration.
- Final approved copy and consented audience. DealerSocket manager mappings are now saved and verified.
- The controlled CRM write test passed for opportunity 162549, including persisted Primary/Secondary assignments. Uncertain writes remain blocked from automatic replay; no guessed CRM API write endpoints are used.
- Configure Mobile Message signed callbacks on the public backend ingress. The public registration adapter is already connected locally.
- Provision the chosen GoodShowroom subdomain, DNS, TLS and public reverse proxy. Set `PUBLIC_PORTAL_URL=https://<approved-domain>`. DNS ownership/hosting credentials were not supplied.
- Build both frontend roles: `npm run build` and `npm run build:public`; start with `npm start` and `npm run start:public`. Put the two instances behind separate HTTPS hostnames. The public instance defaults to port 3001 and refuses operator access. Both development launchers bind to loopback.
- Set `CAMPAIGN_SEND_ENABLED=true` only after the above are confirmed. The existing `MOBILEMESSAGE_ENABLED` flag alone does not enable campaign dispatch. Approved sends are explicitly queued by an operator; a backend background worker dispatches the durable job independently of the browser request.
- Use HTTPS and edge rate limiting before exposing the portal publicly. Staff sign in with individual accounts; sign-in attempts are throttled in MongoDB, and opaque sessions expire after eight hours. An organisation identity provider can be added if required. The local preview is loopback-only. Configure Atlas backups/point-in-time recovery according to the selected cluster tier. MongoDB unique indexes, majority writes, transactions and an operation fence protect cross-collection changes and worker claims. Keep one Chrome worker per dealership; its local journal is additional ambiguity protection. There is no SQLite runtime or fallback.
- If the process stops during a send, reconcile `sending`/`unknown` messages against Mobile Message before retrying. This initial implementation deliberately provides no automatic retry of ambiguous sends.

## Validation

`npm run build` and `npm test -- --runInBand` in this project; `npm run build` and `npm run build:public` in the frontend; `.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider` in the connector. Browser checks cover operator login, campaign draft creation, CSV deduplication/rejection, manual suppression, Goodshowroom placeholder, 390px viewport layout, the supplied public form's success path, registration suppression and public/operator API isolation. XLSX import was verified against the running backend. QA records are removed after verification. The connection-test SMS is confirmed delivered. The controlled CRM opportunity save and both assignments have also been verified. Audience campaign sends still require final copy, consented list and production end-to-end testing. AJ test registration is deliberately retained as the verified CRM test record.

## MongoDB storage and migration

`MONGODB_URI` is required. It can be set directly in the backend environment or inherited from `SHARED_ENV_FILE`; avoid an empty local value if relying on the shared environment. `MONGODB_DB_NAME=sms_campaign` isolates portal records from other applications on the cluster. The backend waits for MongoDB and indexes before listening. `/api/health` pings the database and reports `storage: mongodb`. No SQLite cache, dual writing or in-memory persistence is used. Catalogs and snapshots are stored in MongoDB settings; old JSON sidecars are only migration inputs.

Collections: contacts, suppressions, campaigns, messages, leads, outbox, audit, receipts, settings, sms_tests, sms_inbound, sms_activity, plus _locks and _migrations (14 collection slots). IDs, event IDs, mobile suppression keys, provider references and job statuses are retained. External SMS/CRM side effects never run inside retryable database transaction callbacks.

Migration commands (from this backend folder):

1. `npm run migrate:sqlite` builds and shows a read-only source summary.
2. Stop every legacy backend/CRM writer, then run `node scripts/migrate-sqlite.cjs --apply`. The tool creates an SQLite backup under ignored data/backups, imports atomically, rejects conflicting target records and verifies every imported document. It also imports only the verified Hyundai catalog/snapshot.
3. Before restarting writers, `node scripts/migrate-sqlite.cjs --verify` can compare the frozen source again. After normal operation resumes, target records may legitimately change; do not reimport an outdated source.
4. Start `npm run start:prod` and the Chrome worker. Compare portal metrics, manager routing, registration/outbox state and SMS history with the saved baseline.

The actual cutover report is stored locally in data/mongodb-migration-report.json. Original data/campaign.sqlite and its backup are retained offline; the application no longer accesses them. Do not restart an old SQLite build against those files after cutover, because that creates two divergent data stores.

`npm test -- --runInBand` and `npm run test:e2e -- --runInBand` use disposable local MongoDB replica sets by default (a MongoDB binary download is required on first use). They test real transactions, concurrent claims, suppression, reporting, HTTP flows and migration rollback/idempotency; SMS is mocked and no CRM writes occur. Optional MONGODB_TEST_URI runs them against a dedicated test cluster with strictly checked temporary database names. Test cleanup cannot drop the application database.


## Staff, offers and dispatch operations

- First boot requires a 12–256 character `PORTAL_BOOTSTRAP_PASSWORD`. The backend inherits shared provider credentials but owns its bootstrap configuration. The frontend only holds private backend keys and an HttpOnly session cookie; it does not authenticate a shared password.
- Admins manage Staff, offer approval and routing. Campaign managers manage audiences, campaigns and recovery. Viewers cannot mutate campaign data. Changes and operator recovery evidence carry the authenticated user's identity. Legacy events remain explicitly unattributed.
- The five supplied names are disabled staff records, not consented customers. An administrator sets each person's role and a temporary password before activation; their first login requires a password change. No public registration or invented email addresses are used. Confirm the spelling of Kri Libreri before activation.
- Settings requires the real offer, eligibility, client approval and future expiry. A date-only expiry means the end of that day in Melbourne, including daylight saving. Inactive/expired offers block customer registration and dispatch. Keep the supplied customer creative consistent with the approved terms. No draft offer is silently approved.
- Send queues recipients and returns immediately. Jobs, recipient state and leases are in MongoDB. The backend checks approval, suppression and frequency before each attempt. Pause stops after an in-flight request; resume continues queued recipients. Following an expired lease, interrupted sending records become unknown and are never resent automatically. Run at least one backend instance for dispatch; restarting it does not lose the queue.
- Operations shows jobs and recovery items. For uncertain SMS, provider lookup matches custom reference, recipient and sender, updates local state and never resends. An unresolved lookup stays uncertain. For uncertain CRM writes, inspect DealerSocket first; record the existing opportunity ID, or explicit NOT SAVED evidence before allowing a retry. Restart the Chrome worker after updating its journal-reset support. GoodShowroom remains independently queued.
- Provider verification reads sender/webhook configuration without changing account-wide hooks that may serve other dealerships. Configure `MOBILEMESSAGE_CALLBACK_URL` and `MOBILEMESSAGE_WEBHOOK_SECRET` with the documented provider setup; a configured secret alone is not proof of delivery. Operations shows the last accepted signed callback. Verify a real controlled delivery and opt-out through the public HTTPS endpoint before enabling campaign sends.
- New MongoDB collections are `users`, `sessions`, and `dispatch_jobs`; sessions use TTL expiry. The shared cluster must have capacity for these collections and indexes. If it is at its 500-collection limit, free unused slots or increase capacity; never remove other applications' data automatically.

Validation: backend unit/integration suites cover permissions, account revocation, durable 10,000-recipient queueing, lease recovery without duplicate sends, pause/resume, provider matching, CRM recovery evidence, Melbourne expiry and one-way suppression. Tests use an isolated MongoDB instance and mocked external sends. They do not replace a final controlled provider/DealerSocket test against approved client data.
