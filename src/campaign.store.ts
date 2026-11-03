import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

@Injectable()
export class CampaignStore implements OnModuleDestroy {
  readonly db: DatabaseSync;
  constructor() {
    const file = resolve(process.env.CAMPAIGN_DB || 'data/campaign.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, mobile TEXT UNIQUE NOT NULL, firstName TEXT NOT NULL, lastName TEXT NOT NULL, consent TEXT NOT NULL, evidence TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suppressions(mobile TEXT PRIMARY KEY, reason TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, campaignId TEXT NOT NULL REFERENCES campaigns(id), contactId TEXT NOT NULL REFERENCES contacts(id), token TEXT UNIQUE NOT NULL, status TEXT NOT NULL, providerId TEXT, clicks INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, UNIQUE(campaignId,contactId));
      CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY, mobile TEXT NOT NULL, firstName TEXT NOT NULL, lastName TEXT NOT NULL, email TEXT NOT NULL, campaignId TEXT, createdAt TEXT NOT NULL, eventId TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, leadId TEXT UNIQUE NOT NULL REFERENCES leads(id), status TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(messageId TEXT NOT NULL, part INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL, receivedAt TEXT NOT NULL, PRIMARY KEY(messageId,part));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    for (const table of ['contacts', 'leads'])
      if (
        !this.all(`PRAGMA table_info(${table})`).some(
          (column) => column.name === 'dealerSocketContactId',
        )
      )
        this.db.exec(
          `ALTER TABLE ${table} ADD COLUMN dealerSocketContactId TEXT`,
        );
    if (
      !this.all('PRAGMA table_info(suppressions)').some(
        (column) => column.name === 'optOut',
      )
    )
      this.db.exec(
        'ALTER TABLE suppressions ADD COLUMN optOut INTEGER NOT NULL DEFAULT 0',
      );
    this.db.exec(
      "UPDATE suppressions SET optOut=1 WHERE reason!='Lead registered'",
    );
  }
  all(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).all(...params) as Record<string, any>[];
  }
  one(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).get(...params) as
      Record<string, any> | undefined;
  }
  run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  audit(action: string, detail: string) {
    this.run(
      'INSERT INTO audit(action,detail,createdAt) VALUES(?,?,?)',
      action,
      detail,
      new Date().toISOString(),
    );
  }
  onModuleDestroy() {
    this.db.close();
  }
}
