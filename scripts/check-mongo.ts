/**
 * Real MongoDB/Atlas check for the outing store (needs MONGODB_URI):
 *   npm run check:mongo
 * Creates a throwaway outing, runs concurrent compare-and-swap updates, reconnects
 * with a fresh client (simulating a restart), checks the TTL index, then deletes it.
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoStore } from '../src/server/store-mongo.ts';
import type { OutingDoc } from '../src/server/model.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'common_ground';
if (!uri) { console.error('Set MONGODB_URI (e.g. in .env) first.'); process.exit(2); }

const id = randomBytes(12).toString('hex');
const doc: OutingDoc = {
  id, rev: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), planningVersion: 1,
  settings: { title: 'check-mongo', coveredAreaId: 'x', date: '2026-10-18', windowStart: '09:00', windowEnd: '10:00', durationOptions: [60], expectedCount: 3, timeGridMinutes: 15, arrivalBufferMinutes: 10, departureBufferMinutes: 10, timeZone: 'Asia/Kolkata', currency: 'INR' },
  joiningClosed: true, organiserTokenHash: 'x', inviteTokenHash: 'y', participants: [], area: { label: 'x', lat: 0, lon: 0, countryCode: null }, places: [], placeEvidence: [], plan: null, selection: null, confirmations: [],
};

const t0 = Date.now();
const a = await MongoStore.connect(uri, dbName);
console.log(`connected in ${Date.now() - t0} ms (${a.name})`);
await a.create(doc);
await Promise.all(['p1', 'p2', 'p3'].map((p, i) => a.update(id, async (d) => {
  await new Promise((r) => setTimeout(r, 30 * (3 - i)));
  d.confirmations.push({ participantId: p, candidateKey: 'k', version: 1, inputDigest: 'i', confirmedAt: new Date().toISOString() });
  return d;
})));
await a.close();

const b = await MongoStore.connect(uri, dbName); // fresh client = restart
const after = await b.get(id);
const ok1 = after?.confirmations.map((c) => c.participantId).sort().join(',') === 'p1,p2,p3' && after?.rev === 3;
console.log(`${ok1 ? 'PASS' : 'FAIL'} concurrent confirmations preserved across reconnect (rev=${after?.rev}, confirmations=${after?.confirmations.length})`);

const client = new MongoClient(uri);
await client.connect();
const idx = await client.db(dbName).collection('outings').indexes();
const ttl = idx.find((i) => i.key?.expiresAt === 1 && i.expireAfterSeconds === 0);
console.log(`${ttl ? 'PASS' : 'FAIL'} TTL index on expiresAt`);
await client.close();

await b.delete(id);
const gone = (await b.get(id)) === null;
console.log(`${gone ? 'PASS' : 'FAIL'} delete`);
await b.close();
process.exit(ok1 && ttl && gone ? 0 : 1);
