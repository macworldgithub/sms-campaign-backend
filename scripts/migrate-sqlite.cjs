// One-time importer only. The running application never loads node:sqlite.
require('../dist/environment');
const { DatabaseSync, backup } = require('node:sqlite');
const {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs');
const { resolve, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { CampaignStore, COLLECTIONS } = require('../dist/campaign.store');

function sourceBundle(source) {
  if (!existsSync(source))
    throw Error('SQLite migration source does not exist.');
  const sqlite = new DatabaseSync(source, { readOnly: true });
  try {
    const tables = new Set(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((x) => x.name),
    );
    const bundle = Object.fromEntries(
      COLLECTIONS.map((name) => [
        name,
        tables.has(name)
          ? sqlite
              .prepare(`SELECT * FROM ${name}`)
              .all()
              .map((row) => ({ ...row }))
          : [],
      ]),
    );
    for (const [key, path] of [
      [
        'chrome-catalog',
        process.env.DEALERSOCKET_CATALOG_PATH ||
          '../metaphor-replacement-api/.private/south-morang-hyundai-catalog.json',
      ],
      [
        'chrome-snapshot',
        process.env.DEALERSOCKET_CHROME_SNAPSHOT_PATH ||
          '../metaphor-replacement-api/.private/south-morang-hyundai-leads.json',
      ],
    ]) {
      if (existsSync(resolve(path))) {
        const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
        if (
          key === 'chrome-catalog' &&
          (value.siteId !== '10876' ||
            !value.franchises?.every(
              (f) =>
                [1, 2].includes(Number(f.key)) &&
                /^South Morang Hyundai(?: Used Cars)?$/.test(f.value),
            ))
        )
          throw Error('Catalog is not exclusively South Morang Hyundai.');
        if (
          key === 'chrome-snapshot' &&
          (value.scope !== 'south_morang_hyundai' ||
            value.readOnly !== true ||
            value.records?.some(
              (r) =>
                r.dealership_id !== '10876' ||
                r.rooftop !== 'South Morang Hyundai',
            ))
        )
          throw Error('Snapshot is not exclusively South Morang Hyundai.');
        if (!bundle.settings.some((row) => row.key === key))
          bundle.settings.push({ key, value: JSON.stringify(value) });
      }
    }
    for (const row of bundle.suppressions)
      if (row.optOut === undefined)
        row.optOut = row.reason === 'Lead registered' ? 0 : 1;
    return bundle;
  } finally {
    sqlite.close();
  }
}
function identity(name, row) {
  if (name === 'suppressions') return { mobile: row.mobile };
  if (name === 'settings') return { key: row.key };
  if (name === 'receipts') return { messageId: row.messageId, part: row.part };
  return { id: row.id };
}
async function verify(store, bundle) {
  for (const name of COLLECTIONS)
    for (const row of bundle[name]) {
      const actual = await store.one(name, identity(name, row));
      if (!isDeepStrictEqual(actual, row))
        throw Error(
          `Migration verification failed in ${name}; source records were preserved.`,
        );
    }
}
async function migrate(store, bundle) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(bundle))
    .digest('hex');
  await store.transaction(async (session) => {
    for (const name of COLLECTIONS)
      for (const row of bundle[name]) {
        const existing = await store.one(name, identity(name, row));
        if (existing && !isDeepStrictEqual(existing, row))
          throw Error(
            `Conflicting target record in ${name}; refusing to overwrite.`,
          );
        if (!existing) await store.insert(name, row);
      }
    await verify(store, bundle);
    await store.db
      .collection('_migrations')
      .updateOne(
        { _id: 'sqlite-v1' },
        {
          $set: {
            fingerprint,
            status: 'complete',
            completedAt: new Date().toISOString(),
            counts: Object.fromEntries(
              COLLECTIONS.map((n) => [n, bundle[n].length]),
            ),
          },
        },
        { upsert: true, session },
      );
  });
  await verify(store, bundle);
  return fingerprint;
}
async function main() {
  const sourceIndex = process.argv.indexOf('--source');
  const source = resolve(
    sourceIndex >= 0
      ? process.argv[sourceIndex + 1]
      : process.env.SQLITE_MIGRATION_SOURCE || 'data/campaign.sqlite',
  );
  const apply = process.argv.includes('--apply'),
    verifyOnly = process.argv.includes('--verify');
  const bundle = sourceBundle(source),
    counts = Object.fromEntries(COLLECTIONS.map((n) => [n, bundle[n].length]));
  if (!apply && !verifyOnly) {
    console.log(
      JSON.stringify({
        mode: 'dry-run',
        database: process.env.MONGODB_DB_NAME || 'sms_campaign',
        counts,
        note: 'Stop all legacy backend/worker writers before applying.',
      }),
    );
    return;
  }
  const store = new CampaignStore();
  try {
    await store.connect();
    if (!(await store.db.listCollections({ name: '_migrations' }).hasNext()))
      await store.db.createCollection('_migrations');
    if (verifyOnly) {
      await verify(store, bundle);
      console.log(JSON.stringify({ verified: true, counts }));
      return;
    }
    const backupPath = resolve(
      'data/backups',
      `campaign-before-mongodb-${Date.now()}.sqlite`,
    );
    mkdirSync(dirname(backupPath), { recursive: true });
    const sqlite = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(sqlite, backupPath);
    } finally {
      sqlite.close();
    }
    const fingerprint = await migrate(store, bundle);
    const report = {
      migrated: true,
      verified: true,
      database: store.db.databaseName,
      counts,
      fingerprint,
      backupPath,
    };
    writeFileSync(
      resolve('data/mongodb-migration-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await store.onModuleDestroy();
  }
}
module.exports = { sourceBundle, migrate, verify };
if (require.main === module)
  main().catch((error) => {
    const safe = String(error.message).replace(
      /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
      '[MongoDB connection redacted]',
    );
    console.error(safe);
    process.exitCode = 1;
  });
