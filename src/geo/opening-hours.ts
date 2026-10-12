/**
 * Conservative parser for a common subset of the OpenStreetMap `opening_hours`
 * syntax. Anything it does not fully understand returns `null` (unknown) so
 * the organiser can enter hours by hand — it never guesses.
 *
 * Supported: "24/7"; "08:00-20:00"; "Mo-Fr 08:00-20:00; Sa,Su 09:00-18:00";
 * multiple time ranges ("Mo-Su 06:00-10:00,16:00-20:00"); "Mo off";
 * a trailing "PH off" (public holidays — reported as a caveat).
 * Not supported (→ null): sunrise/sunset, months/dates, week numbers,
 * overnight ranges, comments, "open"/"unknown" keywords, fallback rules.
 */
import type { OpeningRules } from '../domain/schemas.ts';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

export interface ParsedHours { rules: OpeningRules; caveat: string | null; text: string }

function expandDays(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return null;
    const a = ORDER.indexOf(m[1] as (typeof ORDER)[number]);
    const b = m[2] ? ORDER.indexOf(m[2] as (typeof ORDER)[number]) : a;
    // Wrapping ranges such as Sa-Mo are valid OSM syntax.
    for (let i = a; ; i = (i + 1) % 7) { out.add(DAYS.indexOf(ORDER[i]!)); if (i === b) break; }
  }
  return [...out].sort();
}

function parseTimes(spec: string): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const part of spec.split(',')) {
    const m = /^([01]\d|2[0-4]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/.exec(part.trim());
    if (!m) return null;
    const open = `${m[1]}:${m[2]}`;
    let close = `${m[3]}:${m[4]}`;
    if (open === '24:00') return null;
    if (close === '24:00') close = '23:59';
    if (close <= open) return null; // overnight or empty ranges are not supported
    out.push([open, close]);
  }
  return out;
}

export function parseOpeningHours(raw: string | undefined | null): ParsedHours | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > 200) return null;
  if (text === '24/7') return { rules: { weekly: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '00:00', close: '23:59' }], exceptions: [] }, caveat: null, text };

  let caveat: string | null = null;
  const byDay = new Map<number, Array<[string, string]>>();
  for (const ruleRaw of text.split(';')) {
    const rule = ruleRaw.trim();
    if (!rule) continue;
    if (/^PH\s+(off|closed)$/i.test(rule)) { caveat = 'Closed on public holidays'; continue; }
    if (/^(off|closed)$/i.test(rule)) return null;
    const m = /^(?:((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+)?(.+)$/.exec(rule);
    if (!m) return null;
    const days = m[1] ? expandDays(m[1].replace(/\s+/g, '')) : [0, 1, 2, 3, 4, 5, 6];
    if (!days) return null;
    const rest = m[2]!.trim();
    if (/^(off|closed)$/i.test(rest)) { for (const d of days) byDay.set(d, []); continue; }
    const times = parseTimes(rest);
    if (!times) return null;
    // Later rules override earlier ones for the same day (OSM semantics).
    for (const d of days) byDay.set(d, times);
  }
  if (byDay.size === 0) return null;

  // Group days that share identical time ranges.
  const groups = new Map<string, number[]>();
  for (const [d, times] of byDay) {
    for (const [o, c] of times) {
      const key = `${o}-${c}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
  }
  const weekly = [...groups.entries()].map(([k, days]) => {
    const [open, close] = k.split('-') as [string, string];
    return { days: days.sort(), open, close };
  });
  // A rule set that leaves some days unmentioned means those days are closed (OSM default).
  return { rules: { weekly, exceptions: [] }, caveat, text };
}
