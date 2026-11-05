import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Project root .env takes priority, regardless of process.cwd()
const projectRoot = resolve(__dirname, '..');
const local = existsSync(resolve(projectRoot, '.env'))
  ? resolve(projectRoot, '.env')
  : resolve('.env');

function load(path: string) {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(path, 'utf8')),
  ))
    if (process.env[key] === undefined) process.env[key] = value;
}

load(local);

const shared = process.env.SHARED_ENV_FILE;
if (shared) {
  const sharedPath = existsSync(resolve(projectRoot, shared))
    ? resolve(projectRoot, shared)
    : resolve(shared);
  load(sharedPath);
}
