/**
 * Plain, deterministic reading of the clearest statements in a person's own words
 * ("back by 12pm", "budget 500rs", "can do 9:00", "max 40 min each way").
 * Runs alongside Gemma: it catches what the small model misses, and still works when
 * the model is slow or not running. Every value is quoted from the person's text.
 */
import { DAY_END, DAY_START } from '../domain/schemas.ts';
import { hhmmToMinutes, minutesToHHmm } from '../domain/time.ts';

export interface RuleSuggestion { field: string; value: unknown; quote: string }
export interface RuleResult { suggestions: RuleSuggestion[]; questions: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** Splits into short clauses so each value is tied to the words around it. */
function clauses(text: string): string[] {
  return norm(text).split(/(?<!\d)\.(?!\d)|[;!?\n]+|,\s*(?=[a-z])|\s+\b(?:and|but|also|plus|so)\b\s+/).map((c) => c.trim()).filter((c) => c.length > 1);
}

const TIME = /\b(noon|midday)\b|\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d%])/;
const TIME_G = new RegExp(TIME.source, 'g');

interface TimeRead { exact: string | null; options: string[]; text: string }

/** Reads one time; returns the exact value or the possible readings when am/pm is missing. */
function readTime(m: RegExpExecArray, clause: string): TimeRead | null {
  if (m[1]) return { exact: '12:00', options: ['12:00'], text: m[0] };
  const h = Number(m[2]);
  const min = Number(m[3] ?? 0);
  if (min > 59 || h > 23) return null;
  const ampm = m[4];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    const hh = ampm.startsWith('p') ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    return { exact: minutesToHHmm(hh * 60 + min), options: [], text: m[0] };
  }
  // A bare number only counts as a time if it looks like one (has minutes, or follows a time word).
  if (m[3] === undefined && !/(\b(by|at|after|before|until|till|from|around|about|to|between|and)\s+|[-–]\s*)$/.test(clause.slice(0, m.index))) return null;
  if (h >= 13 || (m[2]!.length === 2 && m[2]!.startsWith('0'))) return { exact: minutesToHHmm(h * 60 + min), options: [], text: m[0] };
  if (h === 12) return { exact: minutesToHHmm(12 * 60 + min), options: [], text: m[0] };
  if (/\b(morning)\b/.test(clause)) return { exact: minutesToHHmm(h * 60 + min), options: [], text: m[0] };
  if (/\b(evening|night|afternoon|tonight)\b/.test(clause)) return { exact: minutesToHHmm((h + 12) * 60 + min), options: [], text: m[0] };
  const opts = [h * 60 + min, (h + 12) * 60 + min].filter((x) => x >= hhmmToMinutes(DAY_START) && x <= hhmmToMinutes(DAY_END)).map(minutesToHHmm);
  return { exact: opts.length === 1 ? opts[0]! : null, options: opts, text: m[0] };
}

const LATEST = /\b(back|home|return|returning|get back|be back|until|till|wrap up|done by|finish by|latest)\b/;
const EARLIEST = /\b(leave|leaving|start|starting|from|after|earliest|can do|free from|free after|available|not before|earliest)\b/;
const MONEY_BEFORE = /(₹|rs\.?|inr|€|eur|\$|usd|£|gbp)\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/;
const MONEY_AFTER = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(₹|rs\b|rs\.|rupees?|inr|€|eur\b|euros?|\$|usd|dollars?|bucks|£|pounds?)/;
const MONEY_WORD = /\b(budget|spend|afford|cost|costs|pay|spending)\b[^0-9]{0,25}?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?(?!\s*(?:min|mins|minutes|hour|hours|hr|hrs|am|pm|:|km|m\b))/;
const FREE_MONEY = /\b(no money|can't spend anything|cannot spend anything|zero budget|has to be free|must be free|only free)\b/;
const NEG = /\b(not|no|can't|cannot|don't|won't|without|avoid|never|hate)\b/;

const toNum = (s: string, k?: string) => Number(s.replace(/,/g, '')) * (k ? 1000 : 1);

export function ruleExtract(text: string): RuleResult {
  const found = new Map<string, RuleSuggestion>();
  const questions: string[] = [];
  const pendingTimes: Array<{ field: 'earliestDepartureLocal' | 'latestReturnLocal'; read: TimeRead; quote: string }> = [];
  const put = (field: string, value: unknown, quote: string) => { if (!found.has(field)) found.set(field, { field, value, quote }); };

  for (const c of clauses(text)) {
    // Time ranges like "free from 9 to 1" or "9-12".
    const range = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:to|-|–|till|until)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/.exec(c);
    const times = [...c.matchAll(TIME_G)].map((m) => readTime(m as RegExpExecArray, c)).filter((x): x is TimeRead => !!x);
    if (range && times.length >= 2 && /\b(free|available|from|between|can do|ok|okay)\b/.test(c)) {
      pendingTimes.push({ field: 'earliestDepartureLocal', read: times[0]!, quote: c });
      pendingTimes.push({ field: 'latestReturnLocal', read: times[1]!, quote: c });
    } else if (times.length === 1) {
      if (LATEST.test(c)) pendingTimes.push({ field: 'latestReturnLocal', read: times[0]!, quote: c });
      else if (EARLIEST.test(c)) pendingTimes.push({ field: 'earliestDepartureLocal', read: times[0]!, quote: c });
    }

    // Money.
    if (!/\b(min|mins|minutes|hour|hours)\b/.test(c) || MONEY_BEFORE.test(c) || MONEY_AFTER.test(c)) {
      const mb = MONEY_BEFORE.exec(c); const ma = MONEY_AFTER.exec(c); const mw = MONEY_WORD.exec(c);
      if (mb) put('maxTotalCost', toNum(mb[2]!, mb[3]), c);
      else if (ma) put('maxTotalCost', toNum(ma[1]!, ma[2]), c);
      else if (mw) put('maxTotalCost', toNum(mw[2]!, mw[3]), c);
      else if (FREE_MONEY.test(c)) put('maxTotalCost', 0, c);
    }

    // One-way travel time.
    const dur = /(\d+(?:\.\d+)?)\s*(min|mins|minutes|hr|hrs|hour|hours)\b|\b(half an hour|an hour|one hour)\b/.exec(c);
    if (dur && /\b(travel|each way|one way|one-way|journey|commute|far|ride|get there|to get|away)\b/.test(c) && !/\b(total|both ways|round trip|in all)\b/.test(c) && !/\bwalk/.test(c)) {
      const minutes = dur[3] ? (dur[3] === 'half an hour' ? 30 : 60) : Math.round(Number(dur[1]) * (/^h/.test(dur[2]!) ? 60 : 1));
      if (minutes > 0 && minutes <= 240) put('maxOneWayTravelMinutes', minutes, c);
    }

    // Walking limits.
    const walkDur = /(\d+)\s*(min|mins|minutes)\b/.exec(c);
    if (walkDur && /\bwalk/.test(c)) {
      const n = Number(walkDur[1]);
      if (/\b(at a time|without (a )?(break|rest|sitting)|in one go|stretch|at once|continuous)\b/.test(c)) put('maxContinuousWalkMinutes', n, c);
      else if (/\b(total|in all|overall|altogether)\b/.test(c)) put('maxTotalWalkMinutes', n, c);
    }

    // Ways to travel (only positive statements).
    if (!NEG.test(c)) {
      const modes: string[] = [];
      if (/\b(bus|buses|metro|train|trains|public transport|tram|subway|local)\b/.test(c)) modes.push('public_transport');
      if (/\b(on foot|walking distance|walk there|can walk)\b/.test(c)) modes.push('walk');
      if (/\b(car|bike|scooter|scooty|drive|driving|motorbike|my vehicle)\b/.test(c)) modes.push('own_vehicle');
      if (modes.length) put('allowedModes', modes, c);
    }

    // Must-have facilities.
    if (/\b(need|needs|must|have to|require|essential|important|should have)\b/.test(c)) {
      const f: string[] = [];
      if (/\b(toilet|toilets|washroom|restroom|bathroom|loo)\b/.test(c)) f.push('toilet');
      if (/\b(sit|seat|seats|bench|benches|seating)\b/.test(c)) f.push('seating');
      if (/\b(wheelchair|step-free|step free|no stairs|ramp)\b/.test(c)) f.push('step_free_access');
      if (f.length) put('requiredFacilities', f, c);
    }
  }

  // Resolve times, using the other time to pick between morning and evening readings.
  const exactOf = (field: string) => pendingTimes.find((p) => p.field === field && p.read.exact)?.read.exact ?? null;
  for (const p of pendingTimes) {
    if (found.has(p.field)) continue;
    let value = p.read.exact;
    if (!value && p.read.options.length > 1) {
      const other = exactOf(p.field === 'earliestDepartureLocal' ? 'latestReturnLocal' : 'earliestDepartureLocal');
      if (other) {
        const fits = p.read.options.filter((o) => (p.field === 'earliestDepartureLocal' ? o < other : o > other));
        if (fits.length === 1) value = fits[0]!;
      }
    }
    if (value) put(p.field, value, p.quote);
    else if (p.read.options.length > 1) questions.push(`“${p.read.text.trim()}” — did you mean ${p.read.options.join(' or ')}? Please set it in the form.`);
  }
  const e = found.get('earliestDepartureLocal')?.value as string | undefined;
  const l = found.get('latestReturnLocal')?.value as string | undefined;
  if (e && l && e >= l) { found.delete('earliestDepartureLocal'); found.delete('latestReturnLocal'); questions.push('The leave and be-home times seem to contradict each other — please set them in the form.'); }

  return { suggestions: [...found.values()], questions };
}
