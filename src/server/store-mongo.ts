import { MongoClient, type Collection } from 'mongodb';
import type { OutingDoc } from './model.ts';
import { casUpdate, type OutingStore } from './store.ts';

type Stored = Omit<OutingDoc, 'id' | 'expiresAt'> & { _id: string; expiresAt: Date };

const toStored = (d: OutingDoc): Stored => {
  const { id, expiresAt, ...rest } = d;
  return { ...rest, _id: id, expiresAt: new Date(expiresAt) };
};
const fromStored = (s: Stored): OutingDoc => {
  const { _id, expiresAt, ...rest } = s;
  return { ...rest, id: _id, expiresAt: expiresAt.toISOString() } as OutingDoc;
};

/**
 * MongoDB adapter (works with an Atlas Free cluster). The whole outing is one
 * bounded document; updates use compare-and-swap on `rev`. A TTL index on
 * expiresAt deletes expired outings eventually; access-time checks in the
 * service enforce expiry immediately.
 */
export class MongoStore implements OutingStore {
  readonly name: string;
  private constructor(private client: MongoClient, private col: Collection<Stored>, dbName: string) {
    this.name = `MongoDB (${dbName})`;
  }

  static async connect(uri: string, dbName: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { appName: 'common-ground', serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    const col = client.db(dbName).collection<Stored>('outings');
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return new MongoStore(client, col, dbName);
  }

  async create(doc: OutingDoc) { await this.col.insertOne(toStored(doc)); }
  async get(id: string) { const s = await this.col.findOne({ _id: id }); return s ? fromStored(s) : null; }
  async update(id: string, mutate: (doc: OutingDoc) => OutingDoc | Promise<OutingDoc>) {
    return casUpdate(() => this.get(id), async (doc, rev) => {
      const r = await this.col.replaceOne({ _id: id, rev }, toStored(doc));
      return r.matchedCount === 1;
    }, mutate);
  }
  async delete(id: string) { await this.col.deleteOne({ _id: id }); }
  async deleteExpired(now: Date) { return (await this.col.deleteMany({ expiresAt: { $lte: now } })).deletedCount; }
  async close() { await this.client.close(); }
}
