import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/store.ts';
import type { OutingDoc } from '../src/server/model.ts';

const doc = (): OutingDoc => ({
  id: 'abcdef123456', rev: 0, createdAt: '', expiresAt: '2099-01-01T00:00:00Z', planningVersion: 1,
  settings: {} as OutingDoc['settings'], joiningClosed: true, organiserTokenHash: 'x', inviteTokenHash: 'y',
  participants: [], area: { label: 'x', lat: 0, lon: 0, countryCode: null }, places: [], placeEvidence: [], plan: null, selection: null, confirmations: [],
});

describe('compare-and-swap updates', () => {
  it('retries interleaved writers so neither update is lost', async () => {
    const store = new MemoryStore();
    await store.create(doc());
    const slowConfirm = (participantId: string, delay: number) => store.update('abcdef123456', async (d) => {
      await new Promise((r) => setTimeout(r, delay));
      d.confirmations.push({ participantId, candidateKey: 'k', version: 1, inputDigest: 'i', confirmedAt: '' });
      return d;
    });
    await Promise.all([slowConfirm('p1', 20), slowConfirm('p2', 5), slowConfirm('p3', 10)]);
    const final = await store.get('abcdef123456');
    expect(final!.confirmations.map((c) => c.participantId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(final!.rev).toBe(3);
  });

  it('deletes expired outings', async () => {
    const store = new MemoryStore();
    await store.create({ ...doc(), expiresAt: '2020-01-01T00:00:00Z' });
    expect(await store.deleteExpired(new Date())).toBe(1);
    expect(await store.get('abcdef123456')).toBeNull();
  });
});
