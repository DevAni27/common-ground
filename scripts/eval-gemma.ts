/**
 * REAL local inference evaluation (run on the machine that has Ollama):
 *   npm run eval:gemma
 * Inputs below are synthetic examples written for evaluation (no real people).
 * Writes aggregate + per-case results to eval-results/. Nothing here is a mock.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { interpretFreeText, type InterpretOutcome } from '../src/ai/interpret.ts';
import { clearSummaryCache, summarisePlans, toSummaryInput } from '../src/ai/summary.ts';
import { ollamaAvailable } from '../src/ai/ollama.ts';
import { match } from '../src/domain/matching.ts';
import { toPublicCandidate } from '../src/domain/projection.ts';
import { ParticipantPreferences, SharedSettings } from '../src/domain/schemas.ts';
import { syntheticDataset } from '../tests/fixtures/synthetic-dataset.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const cfg = { baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434', model: process.env.OLLAMA_MODEL ?? 'gemma3:4b', timeoutMs: 180_000 };

type Expect = Partial<Record<'earliestDepartureLocal' | 'latestReturnLocal' | 'maxOneWayTravelMinutes' | 'maxTotalCost' | 'maxTotalWalkMinutes' | 'maxContinuousWalkMinutes', string | number>> & {
  allowedModes?: string[]; requiredFacilities?: string[]; mustNotSet?: string[]; expectQuestion?: boolean;
};
const CASES: Array<{ id: string; kind: string; text: string; expect: Expect }> = [
  { id: 'i01', kind: 'plain', text: 'I need to be home by 1 pm and can spend up to 250 rupees.', expect: { latestReturnLocal: '13:00', maxTotalCost: 250 } },
  { id: 'i02', kind: 'paraphrase of i01', text: "Budget's ₹250 max, gotta be back home at 1pm.", expect: { latestReturnLocal: '13:00', maxTotalCost: 250 } },
  { id: 'i03', kind: 'paraphrase of i01 (24h, slang)', text: "Can't be out past 13:00, and 250 bucks is my limit.", expect: { latestReturnLocal: '13:00', maxTotalCost: 250 } },
  { id: 'i04', kind: 'plain', text: "Max 40 minutes travel each way, I'm fine with metro or bus.", expect: { maxOneWayTravelMinutes: 40, allowedModes: ['public_transport'] } },
  { id: 'i05', kind: 'paraphrase of i04 (hours)', text: 'An hour each way is the most I can do on the bus.', expect: { maxOneWayTravelMinutes: 60, allowedModes: ['public_transport'] } },
  { id: 'i06', kind: 'walking + facility', text: "I can't walk for more than 10 minutes without sitting down, and I need a bench.", expect: { maxContinuousWalkMinutes: 10, requiredFacilities: ['seating'] } },
  { id: 'i07', kind: 'total vs continuous', text: 'Maybe 20 mins of walking in total, 10 at a time.', expect: { maxTotalWalkMinutes: 20, maxContinuousWalkMinutes: 10 } },
  { id: 'i08', kind: 'ambiguous time', text: 'Home by 6.', expect: { mustNotSet: ['latestReturnLocal'], expectQuestion: true } },
  { id: 'i09', kind: 'vague', text: 'Not too far and not too expensive please.', expect: { mustNotSet: ['maxOneWayTravelMinutes', 'maxTotalCost'], expectQuestion: true } },
  { id: 'i10', kind: 'contradictory', text: 'I can leave after 9 am but I need to leave by 8 am.', expect: { expectQuestion: true } },
  { id: 'i11', kind: 'modes + facility + likes', text: "I'll ride my scooter, and I need a toilet nearby. Love taking photos.", expect: { allowedModes: ['own_vehicle'], requiredFacilities: ['toilet'] } },
  { id: 'i12', kind: 'trap: total travel is not one-way', text: 'Leave no earlier than 7:30 am, back by 11:30 am, 1.5 hours of travel in total.', expect: { earliestDepartureLocal: '07:30', latestReturnLocal: '11:30', mustNotSet: ['maxOneWayTravelMinutes'] } },
  { id: 'i13', kind: 'Hinglish, ambiguous hour', text: 'Mera budget 200 rupay hai, aur 12 baje tak ghar wapas aana hai.', expect: { maxTotalCost: 200 } },
  { id: 'i14', kind: 'access need', text: 'I use a wheelchair, so step-free access is essential.', expect: { requiredFacilities: ['step_free_access'] } },
  { id: 'i15', kind: 'zero budget', text: "I don't have money to spend this week, so it has to be free.", expect: { maxTotalCost: 0 } },
];

const HARD_FIELDS = ['earliestDepartureLocal', 'latestReturnLocal', 'maxOneWayTravelMinutes', 'maxTotalCost', 'maxTotalWalkMinutes', 'maxContinuousWalkMinutes', 'allowedModes', 'requiredFacilities'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

function score(out: InterpretOutcome, e: Expect) {
  const got = new Map(out.suggestions.map((s) => [s.field, s.value]));
  const res = { correct: 0, wrong: 0, missing: 0, unexpected: 0, forbiddenSet: 0, questionOk: true, notes: [] as string[] };
  for (const f of HARD_FIELDS) {
    const exp = (e as Record<string, unknown>)[f];
    if (exp !== undefined) {
      if (!got.has(f)) { res.missing++; res.notes.push(`missing ${f}`); }
      else if (same(got.get(f), exp)) res.correct++;
      else { res.wrong++; res.notes.push(`wrong ${f}: ${JSON.stringify(got.get(f))} ≠ ${JSON.stringify(exp)}`); }
    } else if (got.has(f)) {
      if (e.mustNotSet?.includes(f)) { res.forbiddenSet++; res.notes.push(`set forbidden ${f}=${JSON.stringify(got.get(f))}`); }
      else { res.unexpected++; res.notes.push(`unexpected ${f}=${JSON.stringify(got.get(f))}`); }
    }
  }
  if (e.expectQuestion && out.questions.length === 0) { res.questionOk = false; res.notes.push('expected a clarifying question'); }
  return res;
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };

async function main() {
  const status = await ollamaAvailable(cfg);
  if (!status.ok) {
    console.error(`Ollama not ready at ${cfg.baseUrl}: ${status.detail}. Start Ollama and run: ollama pull ${cfg.model}`);
    process.exit(2);
  }
  const version = await fetch(`${cfg.baseUrl}/api/version`).then((r) => r.json()).catch(() => ({}));
  console.log(`Model ${cfg.model} · Ollama ${(version as { version?: string }).version ?? '?'}\n`);

  // Warm-up (model load) measured separately from steady-state latency.
  const warm = await interpretFreeText(cfg, 'Home by 2 pm.');
  console.log(`Warm-up (includes model load): ${warm.metrics?.elapsedMs ?? '?'} ms, source=${warm.source}`);
  const ps = await fetch(`${cfg.baseUrl}/api/ps`).then((r) => r.json()).catch(() => ({})) as { models?: Array<{ name: string; size: number; size_vram: number }> };
  const loaded = ps.models?.find((m) => m.name.startsWith(cfg.model.split(':')[0]!));
  if (loaded) console.log(`Loaded model size ${(loaded.size / 1e9).toFixed(2)} GB, in VRAM ${(loaded.size_vram / 1e9).toFixed(2)} GB`);

  const interpretResults = [];
  for (const c of CASES) {
    const r = await interpretFreeText(cfg, c.text);
    if (r.source !== 'gemma') {
      const reason = r.source === 'unavailable' ? r.reason : 'model failed (rules only)';
      interpretResults.push({ id: c.id, kind: c.kind, valid: false, error: reason, elapsedMs: r.metrics?.elapsedMs ?? null });
      console.log(`${c.id} ✕ model output failed: ${reason}`);
      continue;
    }
    const s = score(r, c.expect);
    interpretResults.push({ id: c.id, kind: c.kind, valid: true, elapsedMs: r.metrics?.elapsedMs ?? 0, outputTokens: r.metrics?.outputTokens ?? null, ...s, suggestions: r.suggestions.map(({ field, value, quote }) => ({ field, value, quote })), questions: r.questions, rejectedByChecks: r.rejectedFields });
    const ok = s.wrong === 0 && s.missing === 0 && s.forbiddenSet === 0 && s.questionOk;
    console.log(`${c.id} ${ok ? '✓' : '△'} ${r.metrics?.elapsedMs ?? '?'} ms  ${c.kind}${s.notes.length ? `  — ${s.notes.join('; ')}` : ''}${r.rejectedFields.length ? `  [checks rejected: ${r.rejectedFields.join(', ')}]` : ''}`);
  }

  // Grounded summaries over synthetic plans, including unknown facts.
  const ds = syntheticDataset(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString());
  const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const baseP = { earliestDepartureLocal: '06:30', latestReturnLocal: '19:00', allowedModes: ['public_transport', 'walk'], maxOneWayTravelMinutes: 70, maxTotalCost: 400, requiredFacilities: [], requireVerifiedLowCrowd: false };
  const summaryScenarios = [
    { id: 's01', settings: { windowStart: '07:00', windowEnd: '10:00', durationOptions: [60, 90] }, prefs: [{ originAreaId: 'fx-north', softPreferences: { greenery: 3, quiet: 1, photography: 2, conversation: 0, exploring: 1 } }, { originAreaId: 'fx-east', softPreferences: { greenery: 1, quiet: 0, photography: 0, conversation: 3, exploring: 2 } }] },
    { id: 's02', settings: { windowStart: '15:00', windowEnd: '17:00', durationOptions: [45] }, prefs: [{ originAreaId: 'fx-south', softPreferences: { greenery: 2, quiet: 3, photography: 0, conversation: 1, exploring: 0 } }, { originAreaId: 'fx-north', softPreferences: { greenery: 0, quiet: 0, photography: 3, conversation: 1, exploring: 3 } }] },
    { id: 's03', settings: { windowStart: '08:00', windowEnd: '09:00', durationOptions: [30, 120] }, prefs: [{ originAreaId: 'fx-north', softPreferences: { greenery: 1, quiet: 1, photography: 1, conversation: 1, exploring: 1 } }, { originAreaId: 'fx-north', softPreferences: { greenery: 3, quiet: 3, photography: 0, conversation: 0, exploring: 0 } }] },
  ];
  const summaryResults = [];
  for (const sc of summaryScenarios) {
    const settings = SharedSettings.parse({ title: 'Eval', coveredAreaId: 'fx-zone', date, expectedCount: 2, ...sc.settings });
    const people = sc.prefs.map((p, i) => ({ participantId: `p${i}`, preferences: ParticipantPreferences.parse({ ...baseP, ...p }) }));
    const result = match(settings, people, ds, { timeZone: 'Asia/Kolkata', now: Date.now() });
    const cands = [...result.fitting, ...result.needsVerification].slice(0, 3).map((c) => toPublicCandidate(c, settings, people, ds, Date.now(), 'Asia/Kolkata'));
    clearSummaryCache();
    const out = await summarisePlans(cfg, cands.map(toSummaryInput), ds.venues.map((v) => v.name));
    summaryResults.push({ id: sc.id, options: cands.length, elapsedMs: out.metrics?.elapsedMs ?? null, gemmaItems: out.items.filter((i) => i.source === 'gemma').length, templateItems: out.items.filter((i) => i.source === 'template').length, failureReason: out.failureReason ?? null, items: out.items });
    console.log(`${sc.id} ${out.items.filter((i) => i.source === 'gemma').length}/${out.items.length} accepted  ${out.metrics?.elapsedMs ?? '?'} ms${out.failureReason ? `  — rejected: ${out.failureReason}` : ''}`);
    for (const i of out.items) console.log(`     [${i.source}] ${i.text}`);
  }

  const valid = interpretResults.filter((r) => r.valid) as Array<{ elapsedMs: number; correct: number; wrong: number; missing: number; unexpected: number; forbiddenSet: number; questionOk: boolean }>;
  const lat = valid.map((r) => r.elapsedMs);
  const summary = {
    model: cfg.model, ollamaVersion: (version as { version?: string }).version ?? null, ranAt: new Date().toISOString(),
    warmupMs: warm.metrics?.elapsedMs ?? null, vramGB: loaded ? +(loaded.size_vram / 1e9).toFixed(2) : null,
    interpret: {
      cases: CASES.length, schemaValid: valid.length,
      fieldsCorrect: valid.reduce((a, r) => a + r.correct, 0), fieldsWrong: valid.reduce((a, r) => a + r.wrong, 0),
      fieldsMissing: valid.reduce((a, r) => a + r.missing, 0), unexpectedFields: valid.reduce((a, r) => a + r.unexpected, 0),
      forbiddenFieldsSet: valid.reduce((a, r) => a + r.forbiddenSet, 0), questionExpectationsMissed: valid.filter((r) => !r.questionOk).length,
      latencyMs: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: lat.length ? Math.max(...lat) : null },
    },
    summaries: { scenarios: summaryResults.length, itemsAccepted: summaryResults.reduce((a, r) => a + r.gemmaItems, 0), itemsFallback: summaryResults.reduce((a, r) => a + r.templateItems, 0) },
  };
  console.log('\n' + JSON.stringify(summary, null, 2));
  await mkdir('eval-results', { recursive: true });
  const file = `eval-results/gemma-eval-${summary.ranAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify({ summary, interpretResults, summaryResults, cases: CASES }, null, 2));
  console.log(`\nSaved ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
