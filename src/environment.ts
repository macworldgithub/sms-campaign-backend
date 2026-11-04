import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Credentials stay in the existing connector environment. Local settings take priority.
const local = resolve('.env');
function load(path: string) {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(path, 'utf8')),
  ))
    if (process.env[key] === undefined) process.env[key] = value;
}
load(local);
const shared = process.env.SHARED_ENV_FILE;
if (shared) load(resolve(shared));
