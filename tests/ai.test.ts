/**
 * PLUMBING TESTS ONLY. These inject fake model outputs to test validation,
 * fallbacks and privacy of prompts. They say nothing about how accurately the
 * real Gemma model behaves — see scripts/eval-gemma.ts for real inference.
 */
import { describe, expect, it } from 'vitest';
import { numbersIn, timeIn, verifyInterpretation, interpretFreeText, type ModelInterpretation } from '../src/ai/interpret.ts';
import { checkSummary, summarisePlans, clearSummaryCache, type SummaryInput } from '../src/ai/summary.ts';
import { loadConfig } from '../src/server/config.ts';
import { answers, FakeGeo, FakeRoutes, outingBody } from './fixtures/fake-geo.ts';
import { OutingService } from '../src/server/service.ts';
import { MemoryStore } from '../src/server/store.ts';

const empty: ModelInterpretation = {
  earliestDeparture: null, latestReturn: null, maxOneWayTravelMinutes: null, maxTotalCost: null,
  maxTotalWalkMinutes: null, maxContinuousWalkMinutes: null, allowedModes: null, requiredFacilities: null, likes: [], unclear: [],
};

const fakeOllama = (content: unknown, capture?: (body: string) => void): typeof fetch => (async (_url: unknown, init?: RequestInit) => {
  capture?.(String(init?.body ?? ''));
  return new Response(JSON.stringify({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, eval_count: 42, prompt_eval_count: 300, total_duration: 1_500_000_000 }), { status: 200 });
}) as typeof fetch;
const deadOllama: typeof fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
const cfg = { baseUrl: 'http://ollama.invalid', model: 'gemma3:4b' };

describe('deterministic checks on interpreted settings', () => {
  it('parses times and numbers conservatively', () => {
    expect(timeIn('back home by 6 pm')).toBe('18:00');
    expect(timeIn('home by 6')).toBe('ambiguous');
    expect(timeIn('leave after 07:30')).toBe('07:30');
    expect(timeIn('by 18:15')).toBe('18:15');
    expect(timeIn('around noon')).toBe('12:00');
    expect(numbersIn('max an hour each way', 'minutes').has(60)).toBe(true);
    expect(numbersIn('1.5 hours', 'minutes').has(90)).toBe(true);
    expect(numbersIn('under ₹1,500', 'money').has(1500)).toBe(true);
  });

  it('accepts values traceable to the words and rejects invented or misquoted ones', () => {
    const text = "I can spend about 300 rupees, need to be back by 1 pm, and I can't walk more than 15 minutes at a stretch. Bus is fine.";
    const r = verifyInterpretation(text, {
      ...empty,
      maxTotalCost: { value: 500, quote: 'about 300 rupees' }, // number not in quote
      latestReturn: { value: '13:00', quote: 'back by 1 pm' },
      maxContinuousWalkMinutes: { value: 15, quote: "can't walk more than 15 minutes at a stretch" },
      maxOneWayTravelMinutes: { value: 45, quote: 'not too far' }, // quote not in text
      allowedModes: { value: ['public_transport'], quote: 'Bus is fine' },
    });
    expect(r.suggestions.map((s) => s.field).sort()).toEqual(['allowedModes', 'latestReturnLocal', 'maxContinuousWalkMinutes']);
    expect(r.rejectedFields).toEqual(expect.arrayContaining(['maxTotalCost', 'maxOneWayTravelMinutes']));
  });

  it('turns an ambiguous time into a question instead of a hard limit', () => {
    const r = verifyInterpretation('I need to be home by 6', { ...empty, latestReturn: { value: '18:00', quote: 'home by 6' } });
    expect(r.suggestions).toEqual([]);
    expect(r.questions.join(' ')).toMatch(/what time exactly/);
  });

  it('rejects a mode whose quote is negated', () => {
    const r = verifyInterpretation("I don't want to walk there", { ...empty, allowedModes: { value: ['walk'], quote: "don't want to walk" } });
    expect(r.suggestions).toEqual([]);
  });
});

describe('model failures fall back honestly', () => {
  it('reports unavailable when Ollama cannot be reached', async () => {
    const r = await interpretFreeText(cfg, 'somewhere not too far please', deadOllama);
    expect(r.source).toBe('unavailable');
  });
  it('reports schema mismatch for malformed output', async () => {
    const r = await interpretFreeText(cfg, 'somewhere not too far please', fakeOllama('{"oops": true}'));
    expect(r).toMatchObject({ source: 'unavailable', reason: 'SCHEMA_MISMATCH' });
  });
});

const input: SummaryInput = {
  key: 'fx-riverside-walk@1000+60', venue: 'Riverside Walk (synthetic)', meetingTime: '10:00', endTime: '11:00', durationMinutes: 60,
  goodFor: ['greenery'], knownFacts: ['Entry / activity cost: Free (₹0)', 'Seating: Available'], needsChecking: ['Step-free access'],
};

describe('grounded summaries', () => {
  it('rejects invented numbers, other venues, unsupported conditions and unconfirmed facilities', () => {
    expect(checkSummary('Meet at 10:00 for an hour of greenery with benches to rest on.', input, [])).toBeNull();
    expect(checkSummary('Meet at 10:00; it is only 12 minutes away.', input, [])).toMatch(/number/);
    expect(checkSummary('Quieter than Hill Trail (synthetic).', input, ['Hill Trail (synthetic)', input.venue])).toMatch(/another venue/);
    expect(checkSummary('Never crowded in the morning.', input, [])).toMatch(/conditions/);
    expect(checkSummary('Fully wheelchair accessible.', input, [])).toMatch(/facility/);
    expect(checkSummary('Step-free access still needs checking.', input, [])).toBeNull();
  });

  it('uses the model text when valid and a labelled template otherwise', async () => {
    clearSummaryCache();
    const ok = await summarisePlans(cfg, [input], [input.venue], fakeOllama({ summaries: [{ key: input.key, text: 'A green 60-minute stroll from 10:00, free to enter.' }] }));
    expect(ok.items[0]).toMatchObject({ source: 'gemma' });
    clearSummaryCache();
    const bad = await summarisePlans(cfg, [input], [input.venue], fakeOllama({ summaries: [{ key: input.key, text: 'Only 5 minutes from the station!' }] }));
    expect(bad.items[0]!.source).toBe('template');
    expect(bad.failureReason).toMatch(/number/);
    const down = await summarisePlans(cfg, [input], [input.venue], deadOllama);
    expect(down.source).toBe('template');
  });
});

describe('privacy of the summary prompt and resilience of matching', () => {
  it('sends only public facts to the model, and a model failure does not change the plan', async () => {
    const service = new OutingService(new MemoryStore(), new FakeGeo(), new FakeRoutes(), { ...loadConfig({}), timeZone: 'Asia/Kolkata' }, () => new Date('2026-10-09T06:30:00Z'));
    const { doc, organiserToken, inviteToken } = await service.create({ ...outingBody({ title: 'Walk', date: '2026-10-18', windowStart: '09:00', windowEnd: '10:00', durationOptions: [60], expectedCount: 2 }), organiserJoins: false });
    const people = [];
    for (const [i, nickname] of ['Priya-Secret-Name', 'Rahul-Secret-Name'].entries()) {
      const j = await service.join(doc.id, { inviteToken, nickname, joinKey: `ai-test-join-${i}` }, {});
      const v = (await service.load(doc.id)).planningVersion;
      await service.savePreferences(doc.id, { expectedVersion: v, answers: answers({
        origin: i === 0 ? 'East' : 'North', earliestDepartureLocal: '07:00', latestReturnLocal: '17:43', allowedModes: ['public_transport'],
        maxOneWayTravelMinutes: 57, maxTotalCost: 777, requiredFacilities: [], requireVerifiedLowCrowd: false,
        softPreferences: { greenery: 3, quiet: 0, photography: 0, conversation: 0, exploring: 0 },
      }) }, { participantToken: j.participantToken });
      people.push(j);
    }
    const org = { organiserToken };
    let v = (await service.load(doc.id)).planningVersion;
    await service.setJoining(doc.id, { expectedVersion: v, closed: true }, org);
    v = (await service.load(doc.id)).planningVersion;
    const before = await service.plan(doc.id, { expectedVersion: v }, org);

    let prompt = '';
    clearSummaryCache();
    await service.summaries(doc.id, { expectedVersion: v }, org, fakeOllama({ summaries: [] }, (b) => { prompt = b; }));
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toMatch(/Secret-Name|East \(test\)|North \(test\)|777|17:43|\b57\b/);

    const failed = await service.summaries(doc.id, { expectedVersion: v }, org, deadOllama);
    expect(failed.source).toBe('template');
    const after = await service.shared(doc.id, org);
    expect(after.plan).toEqual(before.plan);
  });
});
