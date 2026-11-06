import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const backend = fileURLToPath(new URL('../', import.meta.url));
const frontend = resolve(backend, '../sms-campaign');
if (
  existsSync(resolve(backend, '.env')) ||
  existsSync(resolve(frontend, '.env.local'))
)
  throw new Error(
    'Local environment exists; preserve existing credentials and configure manually.',
  );
const key = randomBytes(32).toString('hex'),
  leadKey = randomBytes(32).toString('hex'),
  password = randomBytes(18).toString('base64url');
writeFileSync(
  resolve(backend, '.env'),
  `PORT=4000\nPUBLIC_PORTAL_URL=http://localhost:3000\nPORTAL_BOOTSTRAP_USERNAME=admin\nPORTAL_BOOTSTRAP_PASSWORD=${password}\nMONGODB_DB_NAME=sms_campaign\nSHARED_ENV_FILE=../metaphor-replacement-api/.env\nPORTAL_API_KEY=${key}\nLEAD_WEBHOOK_KEY=${leadKey}\nDEALERSOCKET_CONNECTOR_URL=http://127.0.0.1:8000\nDEALERSOCKET_WORKER_MODE=chrome\nDEALERSOCKET_CAMPAIGN_WRITES_ENABLED=false\nCAMPAIGN_SEND_ENABLED=false\nSMS_CHANNEL_MODE=one_way\nSMS_INBOX_POLL_ENABLED=false\nDEALERSOCKET_SMS_ACTIVITY_ENABLED=false\nSMS_SENDER_REGISTERED=false\n`,
);
writeFileSync(
  resolve(frontend, '.env.local'),
  `BACKEND_URL=http://127.0.0.1:4000\nPORTAL_API_KEY=${key}\nLEAD_WEBHOOK_KEY=${leadKey}\n`,
);
console.log(
  'Local configuration created. Sign in as admin using PORTAL_BOOTSTRAP_PASSWORD in the backend .env. Live sending remains disabled.',
);
