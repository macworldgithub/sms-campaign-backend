import '../environment';
import { randomUUID } from 'node:crypto';
import { CampaignStore, COLLECTIONS } from '../campaign.store';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replicas = new WeakMap<CampaignStore, MongoMemoryReplSet>();

export async function testStore() {
  const store = new CampaignStore();
  const previous = process.env.MONGODB_DB_NAME;
  const originalUri = process.env.MONGODB_URI;
  const replica = process.env.MONGODB_TEST_URI
    ? undefined
    : await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
      });
  process.env.MONGODB_URI = process.env.MONGODB_TEST_URI || replica!.getUri();
  process.env.MONGODB_DB_NAME = `smsc_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  try {
    await store.connect();
    if (replica) replicas.set(store, replica);
  } catch (error) {
    await store.onModuleDestroy();
    await replica?.stop();
    throw error;
  } finally {
    if (previous === undefined) delete process.env.MONGODB_DB_NAME;
    else process.env.MONGODB_DB_NAME = previous;
    if (originalUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalUri;
  }
  return store;
}
export async function clearTestStore(store: CampaignStore) {
  if (!/^smsc_test_[a-f0-9]{24}$/.test(store.db.databaseName))
    throw new Error('Refusing to clear a non-test database.');
  for (const name of COLLECTIONS) await store.delete(name, {});
}
export async function closeTestStore(store: CampaignStore) {
  if (!/^smsc_test_[a-f0-9]{24}$/.test(store.db.databaseName))
    throw new Error('Refusing to drop a non-test database.');
  await store.db.dropDatabase();
  await store.onModuleDestroy();
  await replicas.get(store)?.stop();
}
