/**
 * Free text → PROPOSED preference fields. Nothing here is saved: the person
 * reviews, edits and saves through the ordinary form. Every proposed value must
 * be traceable to the person's own words; anything ambiguous becomes a question.
 */
import { z } from 'zod';
import { FACILITIES, SOFT_PREFERENCES, TRANSPORT_MODES, DAY_START, DAY_END } from '../domain/schemas.ts';
import { hhmmToMinutes, minutesToHHmm } from '../domain/time.ts';
import { generateStructured, type GenerationMetrics, type OllamaConfig } from './ollama.ts';
import { ruleExtract, type RuleResult } from './rules.ts';

export const INTERPRET_PROMPT_VERSION = 'interpret-v2';
export const MAX_FREE_TEXT = 600;

const quoted = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, quote: z.string().max(200) }).nullable();

export const ModelInterpretation = z.object({
  earliestDeparture: quoted(z.string()),
  latestReturn: quoted(z.string()),
  maxOneWayTravelMinutes: quoted(z.number()),
  maxTotalCost: quoted(z.number()),
  maxTotalWalkMinutes: quoted(z.number()),
  maxContinuousWalkMinutes: quoted(z.number()),
  allowedModes: quoted(z.array(z.enum(TRANSPORT_MODES))),
  requiredFacilities: quoted(z.array(z.enum(FACILITIES))),
  likes: z.array(z.enum(SOFT_PREFERENCES)).max(5),
  unclear: z.array(z.string().max(200)).max(5),
});
export type ModelInterpretation = z.infer<typeof ModelInterpretation>;

const SYSTEM = `You turn a person's description of their limits for a short outdoor outing into settings.
Rules:
- Fill a field ONLY if the person clearly states it. Otherwise use null.
- For every filled field, copy the person's exact words that support it into "quote".
- earliestDeparture / latestReturn: 24-hour "HH:mm". latestReturn is when they must be back home.
- maxOneWayTravelMinutes: longest trip in one direction, in minutes.
- maxTotalCost: total spending limit for the whole outing, as a plain number in the local currency.
- maxTotalWalkMinutes: total walking; maxContinuousWalkMinutes: longest walk without a rest.
- allowedModes: only from walk, public_transport, own_vehicle. requiredFacilities: only from seating, step_free_access, toilet.
- likes: things they would enjoy, only from greenery, quiet, photography, conversation, exploring.
- Convert clear times: "12pm" → "12:00", "1 pm" → "13:00", "9:00 am" → "09:00". If a time has no am/pm, use the reading that makes sense with their other times (a morning outing is the default).
- Only if something is truly vague (for example "not too far", "cheap", "not too late") leave it null and add a short question to "unclear".
- Never guess numbers. Never add facts the person did not say.
Example: "back by 12pm, budget 500rs, can leave from 9" → latestReturn {"value":"12:00","quote":"back by 12pm"}, maxTotalCost {"value":500,"quote":"budget 500rs"}, earliestDeparture {"value":"09:00","quote":"can leave from 9"}.`;

export interface Suggestion { field: string; label: string; value: unknown; display: string; quote: string }
export interface InterpretOutcome {
  /** gemma = model + rules; rules = model unavailable, clear statements read by rules only. */
  source: 'gemma' | 'rules';
  promptVersion: string;
  suggestions: Suggestion[];
  questions: string[];
  /** Fields the model proposed that failed deterministic checks (field names only). */
  rejectedFields: string[];
  metrics: GenerationMetrics | null;
}
export type InterpretResult = InterpretOutcome | { source: 'unavailable'; reason: string; metrics: GenerationMetrics | null };

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};

/** Every number the quote could reasonably mean, in minutes or rupees. */
export function numbersIn(quote: string, unit: 'minutes' | 'money'): Set<number> {
  const q = norm(quote);
  const out = new Set<number>();
  const raw: number[] = [];
  for (const m of q.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/g)) {
    let n = Number(m[1]!.replace(/,/g, ''));
    if (m[2]) n *= 1000;
    raw.push(n);
  }
  for (const [w, n] of Object.entries(WORD_NUMBERS)) if (new RegExp(`\\b${w}\\b`).test(q)) raw.push(n);
  if (unit === 'money') {
    for (const n of raw) out.add(n);
    if (/\b(free|no money|nothing|zero)\b/.test(q)) out.add(0);
    return out;
  }
  const hours = /\b(hours?|hrs?|h)\b/.test(q);
  for (const n of raw) { out.add(n); if (hours) out.add(Math.round(n * 60)); }
  if (/\bhalf an hour\b|\bhalf hour\b/.test(q)) out.add(30);
  if (/\b(an|one) hour\b/.test(q)) out.add(60);
  if (/\b(an|one) hour and a half\b|\b(one and a half|1\.5) hours?\b|\bhour and a half\b/.test(q)) out.add(90);
  if (/\bquarter of an hour\b/.test(q)) out.add(15);
  return out;
}

/** Parses an unambiguous time from a quote; returns 'ambiguous' for e.g. "by 6". */
export function timeIn(quote: string): string | 'ambiguous' | null {
  const q = norm(quote);
  if (/\b(noon|midday)\b/.test(q)) return '12:00';
  const ampm = /\b(\d{1,2})(?::|\.)?(\d{2})?\s*(a\.?m\.?|p\.?m\.?)/.exec(q);
  if (ampm) {
    let h = Number(ampm[1]);
    const min = Number(ampm[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = ampm[3]!.startsWith('p');
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return minutesToHHmm(h * 60 + min);
  }
  const h24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(q);
  if (h24) {
    const h = Number(h24[1]);
    // 13:00–23:59, or a leading zero like 07:30, is unambiguous 24-hour time.
    if (h >= 13 || h24[1]!.length === 2 && h24[1]!.startsWith('0')) return minutesToHHmm(h * 60 + Number(h24[2]));
    return 'ambiguous';
  }
  if (/\b(\d{1,2})\b/.test(q) && /\b(by|at|after|before|until|till|leave|back|home|from)\b/.test(q)) {
    if (/\b(morning)\b/.test(q) || /\b(evening|night|afternoon)\b/.test(q)) {
      const h = Number(/\b(\d{1,2})\b/.exec(q)![1]);
      if (h >= 1 && h <= 12) {
        const pm = /\b(evening|night|afternoon)\b/.test(q) && h !== 12;
        return minutesToHHmm(((pm ? h + 12 : h) % 24) * 60);
      }
    }
    return 'ambiguous';
  }
  return null;
}

const MODE_WORDS: Record<(typeof TRANSPORT_MODES)[number], RegExp> = {
  walk: /\b(walk|walking|on foot)\b/,
  public_transport: /\b(bus|buses|metro|train|trains|public transport|transit|pmpml|local)\b/,
  own_vehicle: /\b(car|bike|scooter|scooty|drive|driving|two-wheeler|motorbike|my vehicle|own vehicle)\b/,
};
const FACILITY_WORDS: Record<(typeof FACILITIES)[number], RegExp> = {
  seating: /\b(seat|seats|seating|bench|benches|sit|sit down|sitting)\b/,
  step_free_access: /\b(step-free|step free|stairs|steps|wheelchair|ramp|ramps)\b/,
  toilet: /\b(toilet|toilets|washroom|washrooms|restroom|bathroom|loo)\b/,
};
const NEGATION = /\b(not|no|can't|cannot|don't|won't|without|avoid|never)\b/;
const LABEL: Record<string, string> = {
  earliestDepartureLocal: 'Leave home no earlier than', latestReturnLocal: 'Be home by', maxOneWayTravelMinutes: 'Longest trip each way',
  maxTotalCost: 'Total budget', maxTotalWalkMinutes: 'Total walking', maxContinuousWalkMinutes: 'Longest walk without a rest',
  allowedModes: 'Ways you can travel', requiredFacilities: 'Must have', softPreferences: 'Nice to have',
};

/** Deterministic checks on the model's proposal against the person's own words. */
export function verifyInterpretation(text: string, m: ModelInterpretation): Omit<InterpretOutcome, 'source' | 'promptVersion' | 'metrics'> {
  const t = norm(text);
  const suggestions: Suggestion[] = [];
  const questions = [...m.unclear.map((q) => q.trim()).filter(Boolean)];
  const rejected: string[] = [];
  const quoteOk = (quote: string) => quote.trim().length >= 2 && t.includes(norm(quote));

  const time = (field: 'earliestDepartureLocal' | 'latestReturnLocal', p: ModelInterpretation['earliestDeparture']) => {
    if (!p) return;
    if (!quoteOk(p.quote)) { rejected.push(field); return; }
    const parsed = timeIn(p.quote);
    if (parsed === 'ambiguous') { questions.push(`"${p.quote}" — what time exactly, in 24-hour form (for example 18:00)?`); return; }
    if (!parsed || parsed !== p.value) { rejected.push(field); return; }
    const mins = hhmmToMinutes(parsed);
    if (mins < hhmmToMinutes(DAY_START) || mins > hhmmToMinutes(DAY_END)) { questions.push(`${LABEL[field]}: ${parsed} is outside the daytime outings this app supports.`); return; }
    suggestions.push({ field, label: LABEL[field]!, value: parsed, display: parsed, quote: p.quote });
  };
  time('earliestDepartureLocal', m.earliestDeparture);
  time('latestReturnLocal', m.latestReturn);

  const number = (field: string, p: { value: number; quote: string } | null, unit: 'minutes' | 'money', max: number) => {
    if (!p) return;
    if (!quoteOk(p.quote) || !Number.isFinite(p.value)) { rejected.push(field); return; }
    const value = Math.round(p.value);
    if (!numbersIn(p.quote, unit).has(value)) { rejected.push(field); questions.push(`${LABEL[field]}: could you give it as a number${unit === 'money' ? ' (amount only)' : ' of minutes'}?`); return; }
    if (value < 0 || value > max) { rejected.push(field); return; }
    suggestions.push({ field, label: LABEL[field]!, value, display: unit === 'money' ? `${value}` : `${value} min`, quote: p.quote });
  };
  number('maxOneWayTravelMinutes', m.maxOneWayTravelMinutes, 'minutes', 240);
  number('maxTotalCost', m.maxTotalCost, 'money', 100000);
  number('maxTotalWalkMinutes', m.maxTotalWalkMinutes, 'minutes', 600);
  number('maxContinuousWalkMinutes', m.maxContinuousWalkMinutes, 'minutes', 600);

  if (m.allowedModes && m.allowedModes.value.length > 0) {
    const q = norm(m.allowedModes.quote);
    const ok = quoteOk(m.allowedModes.quote) && !NEGATION.test(q) && m.allowedModes.value.every((mode) => MODE_WORDS[mode].test(q));
    if (ok) suggestions.push({ field: 'allowedModes', label: LABEL.allowedModes!, value: [...new Set(m.allowedModes.value)], display: [...new Set(m.allowedModes.value)].map((x) => x.replace('_', ' ')).join(', '), quote: m.allowedModes.quote });
    else { rejected.push('allowedModes'); questions.push('Which ways can you travel: walking, public transport, or your own vehicle?'); }
  }
  if (/\b(auto|rickshaw|cab|taxi|uber|ola|rapido)\b/.test(t)) questions.push('Autos and cabs are not covered by the travel data yet — would walking, public transport or your own vehicle work?');

  if (m.requiredFacilities && m.requiredFacilities.value.length > 0) {
    const q = norm(m.requiredFacilities.quote);
    const ok = quoteOk(m.requiredFacilities.quote) && m.requiredFacilities.value.every((f) => FACILITY_WORDS[f].test(q));
    if (ok) suggestions.push({ field: 'requiredFacilities', label: LABEL.requiredFacilities!, value: [...new Set(m.requiredFacilities.value)], display: [...new Set(m.requiredFacilities.value)].map((x) => x.replace(/_/g, ' ')).join(', '), quote: m.requiredFacilities.quote });
    else rejected.push('requiredFacilities');
  }

  if (m.likes.length > 0) {
    const likes = [...new Set(m.likes)];
    suggestions.push({ field: 'softPreferences', label: LABEL.softPreferences!, value: likes, display: likes.join(', '), quote: '' });
  }
  if (/\b(quiet|peaceful|calm|crowd)/.test(t) && /\b(must|need|have to|really)\b/.test(t)) {
    questions.push('Is quiet a must-have? If so, tick "Quiet is a must" — places then need verified low-crowd evidence for that time.');
  }
  return { suggestions, questions: [...new Set(questions)].slice(0, 6), rejectedFields: [...new Set(rejected)] };
}

function displayFor(field: string, value: unknown): string {
  if (field === 'maxTotalCost') return `${value}`;
  if (/Minutes$/.test(field)) return `${value} min`;
  if (Array.isArray(value)) return value.map((x) => String(x).replace(/_/g, ' ')).join(', ');
  return String(value);
}

const FIELD_WORDS: Record<string, RegExp> = {
  earliestDepartureLocal: /depart|leave|leaving|start|earliest|from/i,
  latestReturnLocal: /return|back|home|latest|until/i,
  maxTotalCost: /budget|cost|spend|money|price|rupee|amount/i,
  maxOneWayTravelMinutes: /travel|trip|far|journey/i,
  allowedModes: /travel|transport|mode|bus|car/i,
};

/** Rules first (exact, quoted), then verified model output for anything the rules didn't read. */
export function mergeInterpretations(text: string, rules: RuleResult, model: ModelInterpretation | null): Omit<InterpretOutcome, 'source' | 'promptVersion' | 'metrics'> {
  const suggestions: Suggestion[] = rules.suggestions.map((r) => ({ field: r.field, label: LABEL[r.field] ?? r.field, value: r.value, display: displayFor(r.field, r.value), quote: r.quote }));
  const have = new Set(suggestions.map((s) => s.field));
  let questions = [...rules.questions];
  let rejectedFields: string[] = [];
  if (model) {
    const v = verifyInterpretation(text, model);
    for (const s of v.suggestions) if (!have.has(s.field)) { suggestions.push(s); have.add(s.field); }
    rejectedFields = v.rejectedFields.filter((f) => !have.has(f));
    // Drop the model's questions about things that are now filled in.
    questions.push(...v.questions.filter((q) => ![...have].some((f) => FIELD_WORDS[f]?.test(q))));
  }
  const e = suggestions.find((s) => s.field === 'earliestDepartureLocal')?.value as string | undefined;
  const l = suggestions.find((s) => s.field === 'latestReturnLocal')?.value as string | undefined;
  if (e && l && e >= l) {
    questions.push('The leave and be-home times seem to contradict each other — please set them in the form.');
    return { suggestions: suggestions.filter((s) => s.field !== 'earliestDepartureLocal' && s.field !== 'latestReturnLocal'), questions: [...new Set(questions)].slice(0, 6), rejectedFields };
  }
  questions = [...new Set(questions)].slice(0, 6);
  return { suggestions, questions, rejectedFields };
}

export async function interpretFreeText(cfg: OllamaConfig, text: string, fetchImpl?: typeof fetch): Promise<InterpretResult> {
  const clean = text.slice(0, MAX_FREE_TEXT);
  const rules = ruleExtract(clean);
  const user = `Description (between the markers):\n<<<\n${clean}\n>>>\nReturn the settings as JSON.`;
  const r = await generateStructured({ ...cfg, numPredict: 300 }, ModelInterpretation, SYSTEM, user, fetchImpl);
  if (!r.ok) {
    // The model failed or isn't running: still return what the rules read clearly.
    if (rules.suggestions.length > 0) return { source: 'rules', promptVersion: INTERPRET_PROMPT_VERSION, ...mergeInterpretations(clean, rules, null), metrics: r.metrics };
    return { source: 'unavailable', reason: r.error, metrics: r.metrics };
  }
  return { source: 'gemma', promptVersion: INTERPRET_PROMPT_VERSION, ...mergeInterpretations(clean, rules, r.value), metrics: r.metrics };
}
