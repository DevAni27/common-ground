import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OutingDoc } from './model.ts';
import { HttpError, notFound } from './errors.ts';

/**
 * Persistence for the bounded outing aggregate. `update` applies a mutator with
 * compare-and-swap on `rev`, retrying on concurrent writes, so two participants
 * confirming at the same time never lose each other's update.
 */
export interface OutingStore {
  readonly name: string;
  create(doc: OutingDoc): Promise<void>;
  get(id: string): Promise<OutingDoc | null>;
  update(id: string, mutate: (doc: OutingDoc) => OutingDoc | Promise<OutingDoc>): Promise<OutingDoc>;
  delete(id: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
  close(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);
const VALID_ID = /^[a-z0-9]{8,40}$/;

/** Shared CAS retry loop for adapters exposing get + conditional replace. */
export async function casUpdate(
  get: () => Promise<OutingDoc | null>,
  replaceIfRev: (doc: OutingDoc, expectedRev: number) => Promise<boolean>,
  mutate: (doc: OutingDoc) => OutingDoc | Promise<OutingDoc>,
): Promise<OutingDoc> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await get();
    if (!current) throw notFound();
    const next = await mutate(clone(current));
    next.rev = current.rev + 1;
    if (await replaceIfRev(next, current.rev)) return next;
  }
  throw new HttpError(503, 'BUSY', 'Too many simultaneous updates; please retry.');
}

export class MemoryStore implements OutingStore {
  readonly name: string = 'memory (not persistent)';
  protected docs = new Map<string, OutingDoc>();
  async create(doc: OutingDoc) { this.docs.set(doc.id, clone(doc)); }
  async get(id: string) { const d = this.docs.get(id); return d ? clone(d) : null; }
  async update(id: string, mutate: (doc: OutingDoc) => OutingDoc | Promise<OutingDoc>) {
    return casUpdate(() => this.get(id), async (doc, rev) => {
      if (this.docs.get(id)?.rev !== rev) return false;
      this.docs.set(id, clone(doc));
      return true;
    }, mutate);
  }
  async delete(id: string) { this.docs.delete(id); }
  async deleteExpired(now: Date) {
    let n = 0;
    for (const [id, d] of this.docs) if (Date.parse(d.expiresAt) <= now.getTime()) { this.docs.delete(id); n++; }
    return n;
  }
  async close() {}
}

/**
 * One JSON file per outing with atomic replace (write temp file, then rename).
 * Mutations are serialised per outing inside this process; run a single server
 * process against a given directory.
 */
export class FileStore implements OutingStore {
  readonly name: string;
  private locks = new Map<string, Promise<unknown>>();
  constructor(private dir: string) { this.name = `local file store (${dir})`; }

  private file(id: string) {
    if (!VALID_ID.test(id)) throw notFound();
    return path.join(this.dir, `${id}.json`);
  }
  async init() { await mkdir(this.dir, { recursive: true }); }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(id, run.catch(() => undefined));
    try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); }
  }

  private async write(doc: OutingDoc) {
    const target = this.file(doc.id);
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, target);
  }

  async create(doc: OutingDoc) { await this.withLock(doc.id, () => this.write(doc)); }

  async get(id: string): Promise<OutingDoc | null> {
    let file: string;
    try { file = this.file(id); } catch { return null; }
    try { return JSON.parse(await readFile(file, 'utf8')) as OutingDoc; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async update(id: string, mutate: (doc: OutingDoc) => OutingDoc | Promise<OutingDoc>) {
    return this.withLock(id, () => casUpdate(() => this.get(id), async (doc, rev) => {
      const latest = await this.get(id);
      if (!latest || latest.rev !== rev) return false;
      await this.write(doc);
      return true;
    }, mutate));
  }

  async delete(id: string) { await this.withLock(id, async () => { try { await rm(this.file(id), { force: true }); } catch { /* invalid id */ } }); }

  async deleteExpired(now: Date) {
    let n = 0;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const doc = await this.get(id).catch(() => null);
      if (doc && Date.parse(doc.expiresAt) <= now.getTime()) { await this.delete(id); n++; }
    }
    return n;
  }
  async close() {}
}
