import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { answers, FakeGeo, FakeRoutes, outingBody } from './fixtures/fake-geo.ts';
import { OutingService } from '../src/server/service.ts';
import { FileStore } from '../src/server/store.ts';

const H = { 'x-cg-request': '1' };
const NOW = new Date('2026-10-09T06:30:00Z');
let dir: string;

const settings = {
  title: 'Sunday walk', date: '2026-10-18', windowStart: '09:00', windowEnd: '11:00',
  durationOptions: [60, 90], expectedCount: 3,
};
const prefs = (over: Record<string, unknown> = {}) => answers(over);

async function makeApp(storeDir: string) {
  const config = { ...loadConfig({}), timeZone: 'Asia/Kolkata' };
  const store = new FileStore(storeDir);
  await store.init();
  const service = new OutingService(store, new FakeGeo(), new FakeRoutes(), config, () => NOW);
  const server = createApp(service, config).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const servers: Server[] = [];

const fragment = (p: string, key: string) => new URLSearchParams(p.split('#')[1]).get(key)!;

async function setupOuting(app: string, people = 3) {
  const org = request.agent(app);
  const created = await org.post('/api/outings').set(H).send(outingBody({ ...settings, expectedCount: people }, { organiserJoins: false })).expect(201);
  const { outingId, invitePath, organiserPath } = created.body;
  const invite = fragment(invitePath, 'invite');
  const agents = [];
  for (let i = 0; i < people; i++) {
    const a = request.agent(app);
    const j = await a.post(`/api/outings/${outingId}/join`).set(H).send({ inviteToken: invite, nickname: `P${i}`, joinKey: `join-key-${i}-xxxx` }).expect(201);
    agents.push({ agent: a, token: fragment(j.body.participantPath, 'p') });
  }
  return { org, outingId, invite, organiserToken: fragment(organiserPath, 'org'), agents };
}

const version = async (agent: request.Agent, id: string) => (await agent.get(`/api/outings/${id}`).expect(200)).body.planningVersion as number;

async function submitAll(s: Awaited<ReturnType<typeof setupOuting>>, overrides: Array<Record<string, unknown>> = []) {
  for (let i = 0; i < s.agents.length; i++) {
    const v = await version(s.agents[i]!.agent, s.outingId);
    await s.agents[i]!.agent.put(`/api/outings/${s.outingId}/me/preferences`).set(H).send({ expectedVersion: v, answers: prefs(overrides[i] ?? {}) }).expect(200);
  }
  await s.org.post(`/api/outings/${s.outingId}/close-joining`).set(H).send({ expectedVersion: await version(s.org, s.outingId), closed: true }).expect(200);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cg-test-'));
});
afterAll(async () => {
  for (const s of servers) s.close();
  await rm(dir, { recursive: true, force: true });
});

describe('membership and privacy boundaries', () => {
  it('creates, joins, submits and plans; shared responses carry no private data', async () => {
    const app = await makeApp(path.join(dir, 'a'));
    const s = await setupOuting(app);
    await submitAll(s);
    const planned = await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: await version(s.org, s.outingId) }).expect(200);
    expect(planned.body.plan.fitting.length).toBeGreaterThan(0);
    expect(planned.body.plan.fitting[0].statusLabel).toBe('Fits the submitted limits');

    for (const res of [planned, await s.org.get(`/api/outings/${s.outingId}`), await s.agents[0]!.agent.get(`/api/outings/${s.outingId}`)]) {
      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/tokenHash|joinKeyHash|preferences|answers|4321|North \(test\)|earliestDeparture|participantId|travel/);
      for (const a of s.agents) expect(json).not.toContain(a.token);
      expect(json).not.toContain(s.invite);
      expect(json).not.toContain(s.organiserToken);
    }
    // Organiser sees member nicknames for removal, but no completion status per person.
    const orgView = (await s.org.get(`/api/outings/${s.outingId}`)).body;
    expect(orgView.members).toHaveLength(3);
    expect(Object.keys(orgView.members[0]).sort()).toEqual(['id', 'nickname']);
    expect((await s.agents[0]!.agent.get(`/api/outings/${s.outingId}`)).body.members).toBeUndefined();
  });

  it('keeps each participant to their own record; organiser cannot read private answers', async () => {
    const app = await makeApp(path.join(dir, 'b'));
    const s = await setupOuting(app);
    await submitAll(s, [{ maxTotalCost: 111 }, { maxTotalCost: 222 }, { maxTotalCost: 333 }]);
    const me0 = (await s.agents[0]!.agent.get(`/api/outings/${s.outingId}/me`).expect(200)).body;
    expect(me0.answers.maxTotalCost).toBe(111);
    expect(JSON.stringify(me0)).not.toMatch(/222|333/);
    await s.org.get(`/api/outings/${s.outingId}/me`).expect(403);
    // Writing with participant 1's session changes only participant 1's record.
    await s.agents[1]!.agent.put(`/api/outings/${s.outingId}/me/preferences`).set(H).send({ expectedVersion: await version(s.org, s.outingId), answers: prefs({ maxTotalCost: 999 }) }).expect(200);
    expect((await s.agents[0]!.agent.get(`/api/outings/${s.outingId}/me`)).body.answers.maxTotalCost).toBe(111);
    expect((await s.agents[1]!.agent.get(`/api/outings/${s.outingId}/me`)).body.answers.maxTotalCost).toBe(999);
    // An outsider with no capability sees nothing.
    await request(app).get(`/api/outings/${s.outingId}`).expect(404);
    // Participants cannot perform organiser actions.
    await s.agents[0]!.agent.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: await version(s.org, s.outingId) }).expect(403);
  });

  it('rejects joining after closure, duplicate clicks, same-device rejoin, and over-capacity joins', async () => {
    const app = await makeApp(path.join(dir, 'c'));
    const org = request.agent(app);
    const created = (await org.post('/api/outings').set(H).send(outingBody({ ...settings, expectedCount: 2 }, { organiserJoins: false })).expect(201)).body;
    const invite = fragment(created.invitePath, 'invite');
    const a = request.agent(app);
    await a.post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'same-key-1234' }).expect(201);
    await request(app).post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'same-key-1234' }).expect(409);
    await a.post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'other-key-1234' }).expect(409);
    await request(app).post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: 'wrong-token-value', joinKey: 'k-12345678' }).expect(404);
    await request(app).post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'b-12345678' }).expect(201);
    await request(app).post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'c-12345678' }).expect(409); // full
    expect((await org.get(`/api/outings/${created.outingId}`)).body.progress.joined).toBe(2);
    await org.patch(`/api/outings/${created.outingId}/settings`).set(H).send({ expectedVersion: await version(org, created.outingId), settings: { expectedCount: 3 } }).expect(200);
    await org.post(`/api/outings/${created.outingId}/close-joining`).set(H).send({ expectedVersion: await version(org, created.outingId), closed: true }).expect(200);
    const late = await request(app).post(`/api/outings/${created.outingId}/join`).set(H).send({ inviteToken: invite, joinKey: 'd-12345678' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('JOINING_CLOSED');
  });

  it('exchanges a capability link for a cookie session on another device', async () => {
    const app = await makeApp(path.join(dir, 'd'));
    const s = await setupOuting(app, 2);
    const phone = request.agent(app);
    await phone.get(`/api/outings/${s.outingId}/me`).expect(404);
    await phone.post('/api/session/exchange').set(H).send({ outingId: s.outingId, role: 'participant', token: s.agents[0]!.token }).expect(204);
    expect((await phone.get(`/api/outings/${s.outingId}/me`).expect(200)).body.nickname).toBe('P0');
    await phone.post('/api/session/exchange').set(H).send({ outingId: s.outingId, role: 'organiser', token: s.agents[0]!.token }).expect(404);
  });

  it('refuses cross-site mutations', async () => {
    const app = await makeApp(path.join(dir, 'e'));
    await request(app).post('/api/outings').send({ settings }).expect(403);
    await request(app).post('/api/outings').set(H).set('Origin', 'https://evil.example').send({ settings }).expect(403);
    await request(app).post('/api/outings').set(H).set('Sec-Fetch-Site', 'cross-site').send({ settings }).expect(403);
  });

  it('validates bodies and rejects overnight or invalid settings', async () => {
    const app = await makeApp(path.join(dir, 'f'));
    const r = await request(app).post('/api/outings').set(H).send(outingBody({ ...settings, windowStart: '21:00', windowEnd: '06:00' }, { organiserJoins: false })).expect(400);
    expect(r.body.error.code).toBe('INVALID_SETTINGS');
    await request(app).post('/api/outings').set(H).send({ settings, places: [] }).expect(400);
    await request(app).post('/api/outings').set(H).send(outingBody(settings, { places: [] })).expect(400);
    await request(app).post('/api/outings').set(H).set('Content-Type', 'application/json').send('{"settings":' + '"x"'.padEnd(20000, ' ') + '}').expect(413);
  });
});

describe('versioned confirmation', () => {
  it('records concurrent confirmations, invalidates on change, and refuses stale confirmations and cards', async () => {
    const app = await makeApp(path.join(dir, 'g'));
    const s = await setupOuting(app);
    await submitAll(s);
    let v = await version(s.org, s.outingId);
    const plan = (await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: v }).expect(200)).body.plan;
    const key = plan.fitting[0].key;
    // Needs-verification options cannot be proposed.
    if (plan.needsVerification[0]) await s.org.post(`/api/outings/${s.outingId}/select`).set(H).send({ expectedVersion: v, candidateKey: plan.needsVerification[0].key }).expect(409);
    await s.org.post(`/api/outings/${s.outingId}/select`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);
    await s.org.get(`/api/outings/${s.outingId}/card`).expect(409);

    await Promise.all(s.agents.map((a) => a.agent.post(`/api/outings/${s.outingId}/confirm`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200)));
    const after = (await s.org.get(`/api/outings/${s.outingId}`)).body;
    expect(after.selection.confirmedCount).toBe(3);
    expect(after.cardReady).toBe(true);
    const card = (await s.agents[0]!.agent.get(`/api/outings/${s.outingId}/card`).expect(200)).body;
    const cardJson = JSON.stringify(card);
    expect(cardJson).not.toMatch(/4321|North \(test\)|tokenHash|preferences/);
    for (const a of s.agents) expect(cardJson).not.toContain(a.token);

    // A private requirement change creates a new version and clears approvals.
    await s.agents[2]!.agent.put(`/api/outings/${s.outingId}/me/preferences`).set(H).send({ expectedVersion: v, answers: prefs({ maxTotalCost: 4000 }) }).expect(200);
    const changed = (await s.org.get(`/api/outings/${s.outingId}`)).body;
    expect(changed.planningVersion).toBe(v + 1);
    expect(changed.plan).toBeNull();
    expect(changed.selection).toBeNull();
    await s.agents[0]!.agent.post(`/api/outings/${s.outingId}/confirm`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(409);
    await s.agents[0]!.agent.get(`/api/outings/${s.outingId}/card`).expect(409);

    // Re-plan, select, then a membership change invalidates again.
    v = changed.planningVersion;
    await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: v }).expect(200);
    await s.org.post(`/api/outings/${s.outingId}/select`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);
    await s.agents[0]!.agent.post(`/api/outings/${s.outingId}/confirm`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);
    const members = (await s.org.get(`/api/outings/${s.outingId}`)).body.members;
    await s.org.delete(`/api/outings/${s.outingId}/participants/${members[2].id}`).set(H).send({ expectedVersion: v }).expect(200);
    const removed = (await s.org.get(`/api/outings/${s.outingId}`)).body;
    expect(removed.progress.joined).toBe(2);
    expect(removed.selection).toBeNull();
    await s.agents[2]!.agent.get(`/api/outings/${s.outingId}`).expect(404); // removed member loses access
    await s.org.patch(`/api/outings/${s.outingId}/settings`).set(H).send({ expectedVersion: v, settings: { title: 'x' } }).expect(409); // stale
  });

  it('shows an honest no-match result as a 200', async () => {
    const app = await makeApp(path.join(dir, 'h'));
    const s = await setupOuting(app, 2);
    await submitAll(s, [{ latestReturnLocal: '09:15' }, {}]);
    const r = await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: await version(s.org, s.outingId) }).expect(200);
    expect(r.body.plan.noMatch).toBe(true);
    expect(r.body.plan.fitting).toEqual([]);
  });

  it('gives each participant a private journey view only for themselves', async () => {
    const app = await makeApp(path.join(dir, 'i'));
    const s = await setupOuting(app, 2);
    await submitAll(s, [{ origin: 'East' }, {}]);
    const plan = (await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: await version(s.org, s.outingId) }).expect(200)).body.plan;
    const key = plan.fitting[0].key;
    const mine = (await s.agents[0]!.agent.get(`/api/outings/${s.outingId}/candidates/${encodeURIComponent(key)}/me`).expect(200)).body;
    expect(mine.leaveBy).toMatch(/^\d\d:\d\d$/);
    expect(mine.costUpper).toBeGreaterThanOrEqual(0);
    await s.org.get(`/api/outings/${s.outingId}/candidates/${encodeURIComponent(key)}/me`).expect(403);
  });
});

describe('restart persistence', () => {
  it('preserves participants, plan, selection and approvals across a server restart (file adapter)', async () => {
    const storeDir = path.join(dir, 'restart');
    const app1 = await makeApp(storeDir);
    const s = await setupOuting(app1, 2);
    await submitAll(s);
    const v = await version(s.org, s.outingId);
    const key = (await s.org.post(`/api/outings/${s.outingId}/plan`).set(H).send({ expectedVersion: v }).expect(200)).body.plan.fitting[0].key;
    await s.org.post(`/api/outings/${s.outingId}/select`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);
    await s.agents[0]!.agent.post(`/api/outings/${s.outingId}/confirm`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);

    const app2 = await makeApp(storeDir); // fresh process state, same directory
    const exchange = async (role: string, token: string) => {
      const a = request.agent(app2);
      await a.post('/api/session/exchange').set(H).send({ outingId: s.outingId, role, token }).expect(204);
      return a;
    };
    const org2 = await exchange('organiser', s.organiserToken);
    const view = (await org2.get(`/api/outings/${s.outingId}`).expect(200)).body;
    expect(view.progress).toMatchObject({ joined: 2, submitted: 2 });
    expect(view.selection.confirmedCount).toBe(1);
    const p1 = await exchange('participant', s.agents[1]!.token);
    await p1.post(`/api/outings/${s.outingId}/confirm`).set(H).send({ expectedVersion: v, candidateKey: key }).expect(200);
    expect((await p1.get(`/api/outings/${s.outingId}/card`).expect(200)).body.venue.name).toMatch(/\(test\)/);
  });
});

describe('what would make this work', () => {
  it('turns a known conflict into a confirmable plan through a calculated shared change, without relaxing private limits', async () => {
    const app = await makeApp(path.join(dir, 'explore'));
    const org = request.agent(app);
    const created = (await org.post('/api/outings').set(H).send(outingBody({ ...settings, windowStart: '10:00', windowEnd: '10:00', durationOptions: [90], expectedCount: 3 }, { organiserJoins: false })).expect(201)).body;
    const invite = fragment(created.invitePath, 'invite');
    const id = created.outingId as string;
    const people = [];
    for (const [i, over] of [{}, { origin: 'East' }, { origin: 'South', latestReturnLocal: '11:45' }].entries()) {
      const a = request.agent(app);
      await a.post(`/api/outings/${id}/join`).set(H).send({ inviteToken: invite, joinKey: `explore-key-${i}` }).expect(201);
      await a.put(`/api/outings/${id}/me/preferences`).set(H).send({ expectedVersion: await version(org, id), answers: prefs(over) }).expect(200);
      people.push(a);
    }
    let v = await version(org, id);
    await org.post(`/api/outings/${id}/close-joining`).set(H).send({ expectedVersion: v, closed: true }).expect(200);
    v = await version(org, id);
    const plan = (await org.post(`/api/outings/${id}/plan`).set(H).send({ expectedVersion: v }).expect(200)).body.plan;
    expect(plan.noMatch).toBe(true);

    // A participant explores the failing idea.
    const ex = (await people[0]!.post(`/api/outings/${id}/explore`).set(H).send({ expectedVersion: v, idea: { venueId: 'osm-w1', meetingTime: '10:00', durationMinutes: 90 } }).expect(200)).body;
    expect(ex.idea.status).toBe('fail');
    expect(ex.idea.groupNote).toBe('This option does not fit all submitted requirements.');
    const descriptions = ex.alternatives.map((a: { description: string }) => a.description);
    expect(descriptions).toContain('Meet at 09:15 instead of 10:00');
    expect(descriptions).toContain('Stay 45 min instead of 90');
    for (const a of ex.alternatives) expect(a.candidate.status).toBe('pass');
    expect(JSON.stringify(ex)).not.toMatch(/11:45|South \(test\)|budget|4321/i);
    // Exploring does not mutate anything.
    expect(await version(org, id)).toBe(v);

    // Organiser applies the duration change, re-plans, and proposes it.
    const shorter = ex.alternatives.find((a: { description: string }) => a.description === 'Stay 45 min instead of 90');
    expect(shorter.patch).toEqual({ durationOptions: [45, 90] });
    await org.patch(`/api/outings/${id}/settings`).set(H).send({ expectedVersion: v, settings: shorter.patch }).expect(200);
    const v2 = await version(org, id);
    expect(v2).toBe(v + 1);
    await org.post(`/api/outings/${id}/plan`).set(H).send({ expectedVersion: v2 }).expect(200);
    await org.post(`/api/outings/${id}/select`).set(H).send({ expectedVersion: v2, candidateKey: shorter.candidate.key }).expect(200);
    // An approval bound to the old version fails.
    await people[0]!.post(`/api/outings/${id}/confirm`).set(H).send({ expectedVersion: v, candidateKey: shorter.candidate.key }).expect(409);
    for (const p of people) await p.post(`/api/outings/${id}/confirm`).set(H).send({ expectedVersion: v2, candidateKey: shorter.candidate.key }).expect(200);
    const card = (await people[2]!.get(`/api/outings/${id}/card`).expect(200)).body;
    expect(card).toMatchObject({ meetingTime: '10:00', endTime: '10:45', durationMinutes: 45 });

    // Selecting a different candidate resets confirmations.
    const other = (await org.get(`/api/outings/${id}`)).body.plan.fitting.find((c: { key: string }) => c.key !== shorter.candidate.key);
    if (other) {
      await org.post(`/api/outings/${id}/select`).set(H).send({ expectedVersion: v2, candidateKey: other.key }).expect(200);
      expect((await org.get(`/api/outings/${id}`)).body.selection.confirmedCount).toBe(0);
      await people[0]!.get(`/api/outings/${id}/card`).expect(409);
    }
  });
});
