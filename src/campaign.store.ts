import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  MongoClient,
  type ClientSession,
  type Db,
  type Document,
  type Filter,
  type Sort,
  type UpdateFilter,
} from 'mongodb';

export const COLLECTIONS = [
  'contacts',
  'suppressions',
  'campaigns',
  'messages',
  'leads',
  'outbox',
  'audit',
  'receipts',
  'settings',
  'sms_tests',
  'sms_inbound',
  'sms_activity',
  'users',
  'sessions',
  'dispatch_jobs',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

@Injectable()
export class CampaignStore implements OnModuleInit, OnModuleDestroy {
  client!: MongoClient;
  db!: Db;
  private readonly context = new AsyncLocalStorage<ClientSession>();
  private connecting?: Promise<void>;

  onModuleInit() {
    return this.connect();
  }
  connect() {
    return (this.connecting ||= this.initialize());
  }
  private async initialize() {
    const uri = process.env.MONGODB_URI;
    if (!uri)
      throw new Error(
        'MONGODB_URI is required; SQLite fallback is not supported.',
      );
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 20,
      retryWrites: true,
      writeConcern: { w: 'majority' },
    });
    await this.client.connect();
    const configuredDb = process.env.MONGODB_DB_NAME || undefined;
    this.db = this.client.db(configuredDb);
    if (this.db.databaseName === 'sms-campaign') {
      try {
        const dbs = await this.client.db().admin().listDatabases();
        if (
          !dbs.databases.some((d) => d.name === 'sms-campaign') &&
          dbs.databases.some((d) => d.name === 'sms_campaign')
        ) {
          this.db = this.client.db('sms_campaign');
        }
      } catch {
        // Continue if admin list is not permitted
      }
    }
    for (const name of COLLECTIONS) {
      if (!(await this.db.listCollections({ name }).hasNext()))
        await this.db.createCollection(name);
      if (!['suppressions', 'settings', 'receipts'].includes(name))
        await this.db.collection(name).createIndex({ id: 1 }, { unique: true });
    }
    for (const [name, keys] of [
      ['contacts', { mobile: 1 }],
      ['suppressions', { mobile: 1 }],
      ['settings', { key: 1 }],
      ['messages', { token: 1 }],
      ['messages', { campaignId: 1, contactId: 1 }],
      ['leads', { eventId: 1 }],
      ['outbox', { leadId: 1 }],
      ['receipts', { messageId: 1, part: 1 }],
      ['sms_activity', { sourceRef: 1 }],
      ['users', { username: 1 }],
      ['sessions', { tokenHash: 1 }],
      ['dispatch_jobs', { campaignId: 1 }],
    ] as [string, Record<string, 1>][])
      await this.db.collection(name).createIndex(keys, { unique: true });
    for (const name of ['outbox', 'sms_activity', 'messages', 'sms_tests'])
      await this.db.collection(name).createIndex({ status: 1, createdAt: 1 });
    await this.db
      .collection('messages')
      .createIndex({ contactId: 1, createdAt: 1, status: 1 });
    await this.db.collection('messages').createIndex({ providerId: 1 });
    await this.db.collection('leads').createIndex({ mobile: 1 });
    await this.db.collection('sms_inbound').createIndex({ receivedAt: -1 });
    await this.db.collection('audit').createIndex({ createdAt: -1 });
    await this.db
      .collection('sessions')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db
      .collection('settings')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db
      .collection('dispatch_jobs')
      .createIndex({ status: 1, leaseUntil: 1 });
    await this.db
      .collection('_locks')
      .updateOne(
        { _id: 'campaign-operations' as any },
        { $setOnInsert: { version: 0 } },
        { upsert: true },
      );
  }
  private get options() {
    return { session: this.context.getStore() };
  }
  private readonly actor = new AsyncLocalStorage<{
    id: string;
    username: string;
    role: string;
  }>();
  asActor<T>(
    actor: { id: string; username: string; role: string },
    fn: () => T,
  ) {
    return this.actor.run(actor, fn);
  }
  currentActor() {
    return (
      this.actor.getStore() || {
        id: 'system',
        username: 'system',
        role: 'system',
      }
    );
  }
  one(name: CollectionName, filter: Filter<Document> = {}, sort?: Sort) {
    return this.db.collection(name).findOne(filter, {
      ...this.options,
      projection: { _id: 0 },
      ...(sort ? { sort } : {}),
    });
  }
  find(
    name: CollectionName,
    filter: Filter<Document> = {},
    sort: Sort = {},
    limit = 0,
  ) {
    return this.db
      .collection(name)
      .find(filter, { ...this.options, projection: { _id: 0 } })
      .sort(sort)
      .limit(limit)
      .toArray();
  }
  count(name: CollectionName, filter: Filter<Document> = {}) {
    return this.db.collection(name).countDocuments(filter, this.options);
  }
  aggregate(name: CollectionName, pipeline: Document[]) {
    return this.db.collection(name).aggregate(pipeline, this.options).toArray();
  }
  insert(name: CollectionName, doc: Document) {
    return this.db.collection(name).insertOne({ ...doc }, this.options);
  }
  async insertMany(name: CollectionName, docs: Document[]) {
    if (docs.length)
      await this.db.collection(name).insertMany(
        docs.map((doc) => ({ ...doc })),
        this.options,
      );
  }
  update(
    name: CollectionName,
    filter: Filter<Document>,
    update: UpdateFilter<Document>,
    upsert = false,
  ) {
    return this.db
      .collection(name)
      .updateOne(filter, update, { ...this.options, upsert });
  }
  updateMany(
    name: CollectionName,
    filter: Filter<Document>,
    update: UpdateFilter<Document>,
  ) {
    return this.db.collection(name).updateMany(filter, update, this.options);
  }
  delete(name: CollectionName, filter: Filter<Document>) {
    return this.db.collection(name).deleteMany(filter, this.options);
  }
  async setting(key: string) {
    return (await this.one('settings', { key }))?.value;
  }
  async setSetting(key: string, value: string) {
    await this.update('settings', { key }, { $set: { value } }, true);
  }
  async transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) return fn(active);
    const session = this.client.startSession();
    try {
      // A common write fence serializes cross-collection claims, suppression and dispatch
      // decisions across application instances. withTransaction retries write conflicts.
      return (await session.withTransaction(
        async () =>
          this.context.run(session, async () => {
            await this.db
              .collection('_locks')
              .updateOne(
                { _id: 'campaign-operations' as any },
                { $inc: { version: 1 } },
                { session },
              );
            return fn(session);
          }),
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      )) as T;
    } finally {
      await session.endSession();
    }
  }
  async audit(action: string, detail: string) {
    await this.insert('audit', {
      id: randomUUID(),
      action,
      detail,
      actorId: this.currentActor().id,
      actorName: this.currentActor().username,
      createdAt: new Date().toISOString(),
    });
  }
  async ping() {
    await this.db.command({ ping: 1 });
    return { storage: 'mongodb', database: this.db.databaseName };
  }
  async onModuleDestroy() {
    await this.client?.close();
  }
}
