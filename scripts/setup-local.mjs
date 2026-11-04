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
  `PORT=4000\nMONGODB_DB_NAME=sms_campaign\nSHARED_ENV_FILE=../metaphor-replacement-api/.env\nPORTAL_API_KEY=${key}\nLEAD_WEBHOOK_KEY=${leadKey}\nDEALERSOCKET_CONNECTOR_URL=http://127.0.0.1:8000\nDEALERSOCKET_WORKER_MODE=chrome\nDEALERSOCKET_CAMPAIGN_WRITES_ENABLED=false\nCAMPAIGN_SEND_ENABLED=false\nSMS_SENDER_REGISTERED=false\n`,
);
writeFileSync(
  resolve(frontend, '.env.local'),
  `BACKEND_URL=http://127.0.0.1:4000\nPORTAL_API_KEY=${key}\nPORTAL_PASSWORD=${password}\nLEAD_WEBHOOK_KEY=${leadKey}\nPUBLIC_LOYALTY_ORIGIN=http://localhost:3001\n`,
);
console.log(
  'Local configuration created. Portal password is in sms-campaign/.env.local. Live sending remains disabled.',
);
