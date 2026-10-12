import { describe, expect, it } from 'vitest';
import { ruleExtract } from '../src/ai/rules.ts';
import { interpretFreeText, type ModelInterpretation } from '../src/ai/interpret.ts';

const USER_TEXT = 'i need to be back by 12pm, and the budget that i have is 500rs. now the starting time is little early for me can do 9:00 if thats okay';
const value = (r: { suggestions: Array<{ field: string; value: unknown }> }, f: string) => r.suggestions.find((s) => s.field === f)?.value;

const emptyModel: ModelInterpretation = {
  earliestDeparture: null, latestReturn: null, maxOneWayTravelMinutes: null, maxTotalCost: null,
  maxTotalWalkMinutes: null, maxContinuousWalkMinutes: null, allowedModes: null, requiredFacilities: null, likes: [],
  unclear: ['The earliest departure time is unclear.', 'The latest return time is unclear.'],
};
const fakeOllama = (content: unknown): typeof fetch => (async () => new Response(JSON.stringify({ message: { content: JSON.stringify(content) }, eval_count: 40 }), { status: 200 })) as unknown as typeof fetch;
const deadOllama = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
const cfg = { baseUrl: 'http://ollama.invalid', model: 'gemma3:4b' };

describe('rule-based reading of clear statements', () => {
  it('reads the real example: back by 12pm, 500rs, can do 9:00', () => {
    const r = ruleExtract(USER_TEXT);
    expect(value(r, 'latestReturnLocal')).toBe('12:00');
    expect(value(r, 'maxTotalCost')).toBe(500);
    expect(value(r, 'earliestDepartureLocal')).toBe('09:00'); // 21:00 would be after "back by 12pm"
    expect(r.questions).toEqual([]);
    for (const s of r.suggestions) expect(USER_TEXT.toLowerCase()).toContain(s.quote);
  });

  it('fixes what the model missed when Gemma returns nothing and calls it unclear', async () => {
    const r = await interpretFreeText(cfg, USER_TEXT, fakeOllama(emptyModel));
    expect(r.source).toBe('gemma');
    if (r.source === 'unavailable') throw new Error('unexpected');
    expect(value(r, 'latestReturnLocal')).toBe('12:00');
    expect(value(r, 'maxTotalCost')).toBe(500);
    expect(value(r, 'earliestDepartureLocal')).toBe('09:00');
    expect(r.questions).toEqual([]); // the model's "unclear" questions are dropped once filled
  });

  it('still works when the model is not running', async () => {
    const r = await interpretFreeText(cfg, USER_TEXT, deadOllama);
    expect(r.source).toBe('rules');
    if (r.source === 'unavailable') throw new Error('unexpected');
    expect(r.suggestions.map((s) => s.field).sort()).toEqual(['earliestDepartureLocal', 'latestReturnLocal', 'maxTotalCost']);
  });

  it.each([
    ['Budget is ₹300, home by 1 pm', { maxTotalCost: 300, latestReturnLocal: '13:00' }],
    ['can spend 15 euros, free from 9 to 1', { maxTotalCost: 15, earliestDepartureLocal: '09:00', latestReturnLocal: '13:00' }],
    ['back home by 18:30. max 40 min travel each way', { latestReturnLocal: '18:30', maxOneWayTravelMinutes: 40 }],
    ['I can leave after 7.30am and I have to be home by 11', { earliestDepartureLocal: '07:30', latestReturnLocal: '11:00' }],
    ['an hour each way is fine by bus', { maxOneWayTravelMinutes: 60, allowedModes: ['public_transport'] }],
    ['I can’t walk more than 10 minutes at a time and I need a bench', { maxContinuousWalkMinutes: 10, requiredFacilities: ['seating'] }],
    ['it has to be free this week', { maxTotalCost: 0 }],
    ['budget 2k', { maxTotalCost: 2000 }],
  ])('reads "%s"', (text, expected) => {
    const r = ruleExtract(text);
    for (const [f, v] of Object.entries(expected)) expect(value(r, f)).toEqual(v);
  });

  it('asks instead of guessing when a time could be morning or evening', () => {
    const r = ruleExtract('I need to be home by 6');
    expect(value(r, 'latestReturnLocal')).toBeUndefined();
    expect(r.questions.join(' ')).toMatch(/06:00 or 18:00/);
  });

  it('does not read durations or distances as money, or negated modes as allowed', () => {
    const r = ruleExtract("I don't want to take the bus. It's about 20 minutes away");
    expect(value(r, 'maxTotalCost')).toBeUndefined();
    expect(value(r, 'allowedModes')).toBeUndefined();
  });

  it('flags contradictory times instead of saving them', () => {
    const r = ruleExtract('I can leave after 2 pm but need to be back by 1 pm');
    expect(value(r, 'earliestDepartureLocal')).toBeUndefined();
    expect(r.questions.join(' ')).toMatch(/contradict/);
  });
});
