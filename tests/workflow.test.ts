import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.ts';
import { answers, FakeGeo, FakeRoutes, outingBody } from './fixtures/fake-geo.ts';
import { OutingService } from '../src/server/service.ts';
import { MemoryStore } from '../src/server/store.ts';
import { createPlanningEngine } from '../src/workflows/planning.ts';

const NOW = new Date('2026-10-09T06:30:00Z');
let dir = '';
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('Mastra planning workflow', () => {
  it('runs snapshot → match → explain, persists the plan, and logs a run without private content', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cg-wf-'));
    // Unreachable Ollama: the explain step must fall back to templates without changing results.
    const config = { ...loadConfig({}), timeZone: 'Asia/Kolkata', ollamaBaseUrl: 'http://127.0.0.1:9' };
    const service = new OutingService(new MemoryStore(), new FakeGeo(), new FakeRoutes(), config, () => NOW);
    const runLogFile = path.join(dir, 'runs.jsonl');
    service.planning = createPlanningEngine({ now: () => NOW.getTime(), ollama: () => service.ollamaConfig(), runLogFile });

    const { doc, organiserToken, inviteToken } = await service.create({ ...outingBody({ title: 'W', date: '2026-10-18', windowStart: '09:00', windowEnd: '10:00', durationOptions: [60], expectedCount: 2 }), organiserJoins: false });
    for (let i = 0; i < 2; i++) {
      const j = await service.join(doc.id, { inviteToken, nickname: `Secret${i}`, joinKey: `wf-join-key-${i}` }, {});
      await service.savePreferences(doc.id, { expectedVersion: (await service.load(doc.id)).planningVersion, answers: answers({
        origin: 'North', earliestDepartureLocal: '07:00', latestReturnLocal: '16:47', allowedModes: ['public_transport'],
        maxOneWayTravelMinutes: 60, maxTotalCost: 919, requiredFacilities: [], requireVerifiedLowCrowd: false,
        softPreferences: { greenery: 1, quiet: 0, photography: 0, conversation: 0, exploring: 0 },
      }) }, { participantToken: j.participantToken });
    }
    let v = (await service.load(doc.id)).planningVersion;
    await service.setJoining(doc.id, { expectedVersion: v, closed: true }, { organiserToken });
    v = (await service.load(doc.id)).planningVersion;
    const shared = await service.plan(doc.id, { expectedVersion: v }, { organiserToken });
    expect(shared.plan!.fitting.length).toBeGreaterThan(0);

    // Same result as the inline engine.
    const inline = new OutingService(new MemoryStore(), new FakeGeo(), new FakeRoutes(), config, () => NOW);
    const r2 = await inline.store.create(await service.load(doc.id)).then(async () => {
      const d = await inline.load(doc.id);
      d.plan = null; await inline.store.update(doc.id, () => d);
      return inline.plan(doc.id, { expectedVersion: v }, { organiserToken });
    });
    expect(r2.plan!.fitting.map((c) => c.key)).toEqual(shared.plan!.fitting.map((c) => c.key));

    const log = (await readFile(runLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ workflow: 'plan-outing', status: 'success', summarySource: 'template' });
    expect(log[0].steps.map((s: { id: string }) => s.id)).toEqual(['snapshot-inputs', 'match', 'explain']);
    const raw = JSON.stringify(log);
    expect(raw).not.toMatch(/Secret|North \(test\)|919|16:47|"lat"/);
    expect(raw).not.toContain(doc.id);
  });
});
