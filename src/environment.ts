import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Credentials stay in the existing connector environment. Local settings take priority.
const local = resolve('.env');
if (existsSync(local)) process.loadEnvFile(local);
const shared = process.env.SHARED_ENV_FILE;
if (shared && existsSync(shared)) process.loadEnvFile(resolve(shared));
