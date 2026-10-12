/**
 * Grounded plan summaries from PUBLIC projections only. The input never
 * contains names, origins, budgets or private blockers. Output is checked:
 * every number must come from the input, only known candidate keys are
 * allowed, and facts not confirmed by evidence must not be claimed.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublicCandidate } from '../domain/projection.ts';
import { generateStructured, type GenerationMetrics, type OllamaConfig } from './ollama.ts';

export const SUMMARY_PROMPT_VERSION = 'summary-v1';

export interface SummaryInput {
  key: string; venue: string; meetingTime: string; endTime: string; durationMinutes: number;
  goodFor: string[]; knownFacts: string[]; needsChecking: string[];
}

export function toSummaryInput(c: PublicCandidate): SummaryInput {
  return {
    key: c.key, venue: c.venue.name, meetingTime: c.meetingTime, endTime: c.endTime, durationMinutes: c.durationMinutes,
    goodFor: c.sharedPreferences,
    knownFacts: c.facts.filter((f) => f.status === 'known').map((f) => `${f.label}: ${f.text}`),
    needsChecking: c.facts.filter((f) => f.status === 'unknown').map((f) => f.label),
  };
}

const ModelSummaries = z.object({ summaries: z.array(z.object({ key: z.string().max(120), text: z.string().max(400) })).max(3) });

const SYSTEM = `You write one short, friendly summary (at most 2 sentences, under 220 characters) for each outdoor outing option.
Use ONLY the facts given. Do not invent features, crowd levels, weather, prices, distances or travel times.
Mention a fact listed under needsChecking only to say it still needs checking. Do not mention people or their limits.
Use each option's exact "key". Keep times exactly as given (24-hour).`;

const FACILITY_CLAIMS: Array<{ label: string; words: RegExp }> = [
  { label: 'Toilet', words: /\b(toilet|toilets|washroom|restroom|bathroom)\b/i },
  { label: 'Step-free access', words: /\b(step-free|step free|wheelchair|accessible|ramp)\b/i },
  { label: 'Seating', words: /\b(seat|seats|seating|bench|benches)\b/i },
];

export function checkSummary(text: string, input: SummaryInput, allVenueNames: string[]): string | null {
  const allowedNumbers = new Set<string>();
  const source = [input.meetingTime, input.endTime, String(input.durationMinutes), ...input.knownFacts].join(' ');
  for (const m of source.matchAll(/\d+/g)) allowedNumbers.add(String(Number(m[0])));
  for (const m of text.matchAll(/\d+/g)) if (!allowedNumbers.has(String(Number(m[0])))) return `unsupported number ${m[0]}`;
  for (const name of allVenueNames) if (name !== input.venue && text.toLowerCase().includes(name.toLowerCase())) return 'mentions another venue';
  if (/\b(crowd|crowded|busy|empty|peaceful|deserted|weather|rain|sunny|guarantee|guaranteed|safe)\b/i.test(text)) return 'claims unsupported conditions';
  for (const f of FACILITY_CLAIMS) {
    if (!f.words.test(text)) continue;
    const known = input.knownFacts.find((k) => k.startsWith(`${f.label}:`));
    const needsCheck = input.needsChecking.includes(f.label);
    // Mentioning a facility is allowed if it is confirmed, or if the text says it needs checking.
    if (!known && !(needsCheck && /\b(check|verif|unknown|unconfirmed|not (yet )?(known|confirmed))/i.test(text))) return `unsupported facility claim (${f.label})`;
    if (known && /Not available/.test(known) && !/\b(no|not|without)\b/i.test(text)) return `contradicts facility fact (${f.label})`;
  }
  if (/[₹€$£]|\brs\.?\b|\b(rupees?|euros?|dollars?|pounds?)\b/i.test(text) && !input.knownFacts.some((k) => k.startsWith('Entry'))) return 'mentions cost without a cost fact';
  return null;
}

export function templateSummary(i: SummaryInput): string {
  const good = i.goodFor.length ? ` Good for ${i.goodFor.join(', ')}.` : '';
  const check = i.needsChecking.length ? ` Still to check: ${i.needsChecking.join(', ').toLowerCase()}.` : '';
  return `${i.venue}, ${i.meetingTime}–${i.endTime} (${i.durationMinutes} min outside).${good}${check}`;
}

export interface SummaryOutcome {
  source: 'gemma' | 'template';
  promptVersion: string;
  items: Array<{ key: string; text: string; source: 'gemma' | 'template' }>;
  failureReason?: string;
  metrics: GenerationMetrics | null;
  cached: boolean;
}

const cache = new Map<string, { at: number; items: SummaryOutcome['items'] }>();
const CACHE_TTL_MS = 7 * 86_400_000;

export async function summarisePlans(cfg: OllamaConfig | null, inputs: SummaryInput[], allVenueNames: string[], fetchImpl?: typeof fetch): Promise<SummaryOutcome> {
  const templateAll = (reason?: string, metrics: GenerationMetrics | null = null): SummaryOutcome => ({
    source: 'template', promptVersion: SUMMARY_PROMPT_VERSION, items: inputs.map((i) => ({ key: i.key, text: templateSummary(i), source: 'template' })), failureReason: reason, metrics, cached: false,
  });
  if (inputs.length === 0) return templateAll();
  if (!cfg) return templateAll('AI_DISABLED');
  const cacheKey = createHash('sha256').update(JSON.stringify([cfg.model, SUMMARY_PROMPT_VERSION, inputs])).digest('hex');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { source: 'gemma', promptVersion: SUMMARY_PROMPT_VERSION, items: hit.items, metrics: null, cached: true };

  const user = `Options:\n${JSON.stringify(inputs, null, 1)}\nReturn {"summaries":[{"key":..., "text":...}]} with one entry per option.`;
  const r = await generateStructured({ ...cfg, numPredict: 500 }, ModelSummaries, SYSTEM, user, fetchImpl);
  if (!r.ok) return templateAll(r.error, r.metrics);
  const items: SummaryOutcome['items'] = [];
  let anyRejected: string | undefined;
  for (const i of inputs) {
    const got = r.value.summaries.filter((s) => s.key === i.key);
    const text = got[0]?.text.trim();
    const problem = got.length !== 1 ? 'missing or duplicate key' : !text ? 'empty' : checkSummary(text, i, allVenueNames);
    if (problem) { anyRejected ??= problem; items.push({ key: i.key, text: templateSummary(i), source: 'template' }); }
    else items.push({ key: i.key, text: text!, source: 'gemma' });
  }
  if (r.value.summaries.some((s) => !inputs.some((i) => i.key === s.key))) anyRejected ??= 'unknown key in output';
  // Only fully validated results are cached.
  if (!anyRejected) {
    cache.set(cacheKey, { at: Date.now(), items });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return { source: items.some((x) => x.source === 'gemma') ? 'gemma' : 'template', promptVersion: SUMMARY_PROMPT_VERSION, items, failureReason: anyRejected, metrics: r.metrics, cached: false };
}

export function clearSummaryCache() { cache.clear(); }
