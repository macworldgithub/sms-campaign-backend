import { CampaignStore, COLLECTIONS } from './campaign.store';
import { testStore, clearTestStore, closeTestStore } from './testing/mongo';
const { migrate, verify } = require('../scripts/migrate-sqlite.cjs');

jest.setTimeout(60000);
describe('MongoDB data migration', () => {
  let store: CampaignStore;
  beforeAll(async () => {
    store = await testStore();
    await store.db.createCollection('_migrations');
  });
  afterEach(async () => {
    if (store) await clearTestStore(store);
  });
  afterAll(async () => {
    if (store) await closeTestStore(store);
  });
  function bundle() {
    const data: any = Object.fromEntries(COLLECTIONS.map((n) => [n, []]));
    data.contacts = [
      {
        id: 'source-contact',
        mobile: '+61412345678',
        firstName: 'Migration',
        lastName: 'Fixture',
        consent: 'express',
        evidence: 'Test only',
        createdAt: '2026-11-04T00:00:00.000Z',
        dealerSocketContactId: null,
      },
    ];
    data.suppressions = [
      {
        mobile: '+61412345678',
        reason: 'Provider opt-out',
        optOut: 1,
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    ];
    data.settings = [
      {
        key: 'crm-routing',
        value: '{"salesManager":"sm","generalManager":"gm"}',
      },
    ];
    return data;
  }
  it('preserves fields and IDs and can be rerun without duplicates', async () => {
    const data = bundle();
    await migrate(store, data);
    await migrate(store, data);
    await verify(store, data);
    expect(await store.count('contacts')).toBe(1);
    expect(await store.count('suppressions')).toBe(1);
    expect(
      (
        await store.db
          .collection('_migrations')
          .findOne({ _id: 'sqlite-v1' as any })
      )?.status,
    ).toBe('complete');
  });
  it('refuses conflicting records and rolls back new imports', async () => {
    const data = bundle();
    await migrate(store, data);
    data.contacts = [
      { ...data.contacts[0], id: 'must-rollback', mobile: '+61412345679' },
      { ...data.contacts[0], firstName: 'Conflicting' },
    ];
    await expect(migrate(store, data)).rejects.toThrow(
      'Conflicting target record',
    );
    expect(await store.count('contacts', { id: 'must-rollback' })).toBe(0);
    expect(
      (await store.one('contacts', { id: 'source-contact' }))?.firstName,
    ).toBe('Migration');
  });
});
