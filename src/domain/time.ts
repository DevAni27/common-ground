/**
 * Date/time helpers. All comparisons are made on absolute instants (epoch ms)
 * built from a local date + HH:mm in the configured IANA time zone, never on
 * bare HH:mm strings, so that crossing midnight or a zone offset is explicit.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isHHmm(value: string): boolean {
  return HHMM.test(value);
}

export function isLocalDate(value: string): boolean {
  const m = YMD.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function hhmmToMinutes(value: string): number {
  const m = HHMM.exec(value);
  if (!m) throw new Error(`Invalid HH:mm value: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHmm(total: number): string {
  if (!Number.isInteger(total) || total < 0 || total >= 24 * 60) throw new Error(`Minutes out of day range: ${total}`);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Converts a local wall-clock date + time in `timeZone` to an epoch-ms instant. */
const instantCache = new Map<string, number>();
export function localToInstant(date: string, time: string, timeZone: string = DEFAULT_TIMEZONE): number {
  const key = `${date}|${time}|${timeZone}`;
  const hit = instantCache.get(key);
  if (hit !== undefined) return hit;
  const value = computeLocalToInstant(date, time, timeZone);
  if (instantCache.size > 50_000) instantCache.clear();
  instantCache.set(key, value);
  return value;
}

function computeLocalToInstant(date: string, time: string, timeZone: string): number {
  if (!isLocalDate(date)) throw new Error(`Invalid local date: ${date}`);
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const minutes = hhmmToMinutes(time);
  const naiveUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Two-pass correction handles zones whose offset differs around the instant.
  let instant = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  instant = naiveUtc - zoneOffsetMs(instant, timeZone);
  return instant;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function instantToLocalDate(instant: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

/** Local HH:mm of an instant in `timeZone`. */
export function instantToLocalTime(instant: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

/** Day of week (0 = Sunday) of a local date. */
export function weekdayOfLocalDate(date: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Whole days between an ISO timestamp and the start of a local date (positive = timestamp is earlier). */
export function ageInDaysAt(isoTimestamp: string, referenceInstant: number): number {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (referenceInstant - t) / DAY_MS;
}
