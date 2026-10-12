/**
 * Free, worldwide OpenStreetMap-based providers (server-side only):
 *  - Nominatim for area search (usage policy: ≤ 1 request/second, identify the app, no autocomplete)
 *  - Overpass for real outdoor places near the area
 *  - FOSSGIS OSRM (routing.openstreetmap.de) for walking and driving times
 *  - Transitous (MOTIS) for public transport — OPT-IN: its policy asks projects to
 *    contact the maintainers before using routing.
 * Data © OpenStreetMap contributors (ODbL). Attribution is shown in the app.
 */
import { parseOpeningHours } from './opening-hours.ts';
import { haversineMetres, type AreaResult, type Coord, type GeoProvider, type PlaceDraft, type RouteProvider, type RouteResult } from './types.ts';

export interface OsmConfig {
  userAgent: string;
  nominatimUrl: string;
  /** Tried in order; the next one is used when a server is busy (429/5xx) or times out. */
  overpassUrls: string[];
  footRoutingUrl: string;
  carRoutingUrl: string;
  transitousUrl: string | null;
  transitousPlanPath: string;
  timeoutMs: number;
}

export function osmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OsmConfig {
  const contact = env.APP_CONTACT || 'https://github.com/';
  return {
    userAgent: `CommonGround/0.2 (open-source outing planner; ${contact})`,
    nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    overpassUrls: (env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
      .split(',').map((u) => u.trim()).filter(Boolean),
    footRoutingUrl: env.FOOT_ROUTING_URL || 'https://routing.openstreetmap.de/routed-foot',
    carRoutingUrl: env.CAR_ROUTING_URL || 'https://routing.openstreetmap.de/routed-car',
    transitousUrl: /^(1|true|yes|on)$/i.test(env.TRANSITOUS_ENABLED ?? '') ? env.TRANSITOUS_URL || 'https://api.transitous.org' : null,
    transitousPlanPath: env.TRANSITOUS_PLAN_PATH || '/api/v1/plan',
    timeoutMs: Number(env.GEO_TIMEOUT_MS ?? 20_000),
  };
}

/* ---------------- small helpers ---------------- */

let nominatimQueue: Promise<unknown> = Promise.resolve();
let lastNominatim = 0;
/** Serialises Nominatim calls with at least 1.1 s between them (usage policy). */
function nominatimSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimQueue.catch(() => undefined).then(async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    return fn();
  });
  nominatimQueue = run.catch(() => undefined);
  return run;
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return value;
}

/** Parses a per-person charge such as "20 INR", "€3", "3.50 EUR", "INR 50"; null if not a single clear amount. */
export function parseCharge(raw: string | undefined): number | null {
  if (!raw) return null;
  const nums = raw.match(/\d+(?:[.,]\d{1,2})?/g);
  if (!nums || nums.length !== 1) return null;
  if (/\b(child|children|student|senior|per hour|hour|car|vehicle|parking)\b/i.test(raw)) return null;
  return Number(nums[0]!.replace(',', '.'));
}

const KIND_LABEL: Record<string, string> = {
  park: 'Park', garden: 'Garden', nature_reserve: 'Nature reserve', common: 'Common', viewpoint: 'Viewpoint',
  picnic_site: 'Picnic site', beach: 'Beach',
};
const KIND_TAGS: Record<string, PlaceDraft['preferenceTags']> = {
  park: ['greenery', 'conversation'], garden: ['greenery', 'photography'], nature_reserve: ['greenery', 'exploring'],
  common: ['greenery', 'conversation'], viewpoint: ['photography'], picnic_site: ['conversation'], beach: ['exploring', 'photography'],
};

interface OverpassElement { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export function placesFromOverpass(elements: OverpassElement[], centre: Coord): PlaceDraft[] {
  const out: PlaceDraft[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const t = el.tags ?? {};
    const name = t['name:en'] || t.name;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;
    if (['private', 'no', 'customers', 'permit'].includes(t.access ?? '')) continue;
    if (t['garden:type'] === 'residential' || t['garden:type'] === 'private') continue;
    const kind = t.leisure ?? t.tourism ?? t.natural ?? 'park';
    const dedupe = `${name.toLowerCase()}|${kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const parsed = parseOpeningHours(t.opening_hours);
    const fee = t.fee === 'no' ? 0 : t.fee === 'yes' ? parseCharge(t.charge) : null;
    out.push({
      id: `osm-${el.type[0]}${el.id}`,
      name,
      kind: KIND_LABEL[kind] ?? 'Outdoor place',
      lat, lon,
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      straightLineMetres: Math.round(haversineMetres(centre, { lat, lon })),
      openingHours: { raw: t.opening_hours ?? null, parsed: parsed?.rules ?? null, caveat: parsed?.caveat ?? null },
      fee: { value: fee, raw: t.charge ?? t.fee ?? null },
      toilet: t.toilets === 'yes' ? true : t.toilets === 'no' ? false : null,
      stepFree: t.wheelchair === 'yes' ? true : t.wheelchair === 'no' ? false : null,
      seating: null,
      preferenceTags: KIND_TAGS[kind] ?? ['greenery'],
    });
  }
  return out.sort((a, b) => a.straightLineMetres - b.straightLineMetres);
}

async function getJson(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

/* ---------------- providers ---------------- */

export class OsmGeoProvider implements GeoProvider {
  readonly name = 'OpenStreetMap (Nominatim + Overpass)';
  constructor(private cfg: OsmConfig, private fetchImpl: typeof fetch = fetch) {}

  async searchArea(query: string): Promise<AreaResult[]> {
    const q = query.trim().slice(0, 120);
    return cached(`area|${q.toLowerCase()}`, 24 * 3_600_000, () => nominatimSlot(async () => {
      const url = `${this.cfg.nominatimUrl}/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '6', addressdetails: '1' })}`;
      const body = await getJson(url, { headers: { 'User-Agent': this.cfg.userAgent, 'Accept-Language': 'en' } }, this.cfg.timeoutMs, this.fetchImpl) as Array<{ lat: string; lon: string; display_name: string; address?: { country_code?: string } }>;
      return body.map((r) => ({ label: r.display_name, lat: Number(r.lat), lon: Number(r.lon), countryCode: r.address?.country_code ?? null }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    }));
  }

  /**
   * Real outdoor places near the centre. Nominatim (the same service as area search) is the
   * main source; Overpass runs alongside with a short time limit and can only ADD places.
   * If Overpass is down, results still come from Nominatim.
   */
  async nearbyPlaces(centre: Coord, radiusMetres: number): Promise<PlaceDraft[]> {
    const r = Math.max(300, Math.min(8000, Math.round(radiusMetres)));
    const key = `places|${centre.lat.toFixed(5)}|${centre.lon.toFixed(5)}|${r}`;
    return cached(key, 6 * 3_600_000, async () => {
      const [nom, ovp] = await Promise.allSettled([
        this.nominatimPlaces(centre, r),
        overpassWithFallback({ ...this.cfg, timeoutMs: 12_000 }, overpassQuery(centre, r), this.fetchImpl, 12_000).then((b) => b.elements ?? []),
      ]);
      const elements: OverpassElement[] = [
        ...(ovp.status === 'fulfilled' ? ovp.value : []),
        ...(nom.status === 'fulfilled' ? nom.value : []),
      ];
      if (nom.status === 'rejected' && ovp.status === 'rejected') {
        throw new Error(`Nominatim: ${(nom.reason as Error).message}; Overpass: ${(ovp.reason as Error).message}`);
      }
      this.lastSources = [nom.status === 'fulfilled' ? 'nominatim' : null, ovp.status === 'fulfilled' ? 'overpass' : null].filter(Boolean) as string[];
      return placesFromOverpass(dedupeById(elements), centre).filter((p) => p.straightLineMetres <= r).slice(0, 30);
    });
  }

  /** For diagnostics: which sources answered the last uncached nearbyPlaces call. */
  lastSources: string[] = [];

  /** Nominatim "special phrase" searches bounded to a box, with OSM tags via extratags. */
  private async nominatimPlaces(centre: Coord, r: number): Promise<OverpassElement[]> {
    const { south, west, north, east } = bbox(centre, r);
    const out: OverpassElement[] = [];
    let ok = 0;
    let lastErr: Error | null = null;
    for (const phrase of ['park', 'garden', 'viewpoint', 'nature reserve']) {
      try {
        const rows = await nominatimSlot(async () => {
          const url = `${this.cfg.nominatimUrl}/search?${new URLSearchParams({
            q: phrase, format: 'jsonv2', limit: '40', bounded: '1', extratags: '1',
            viewbox: `${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)},${south.toFixed(5)}`,
          })}`;
          return await getJson(url, { headers: { 'User-Agent': this.cfg.userAgent, 'Accept-Language': 'en' } }, this.cfg.timeoutMs, this.fetchImpl) as NominatimRow[];
        });
        ok++;
        out.push(...nominatimToElements(rows));
      } catch (e) { lastErr = e as Error; }
    }
    if (ok === 0) throw lastErr ?? new Error('no response');
    return out;
  }

  /** Find a specific place by name near the area (organiser's "add a place" search). */
  async placeByName(query: string, near: Coord): Promise<PlaceDraft[]> {
    const { south, west, north, east } = bbox(near, 15_000);
    const rows = await nominatimSlot(async () => {
      const url = `${this.cfg.nominatimUrl}/search?${new URLSearchParams({
        q: query.trim().slice(0, 120), format: 'jsonv2', limit: '8', extratags: '1',
        viewbox: `${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)},${south.toFixed(5)}`,
      })}`;
      return await getJson(url, { headers: { 'User-Agent': this.cfg.userAgent, 'Accept-Language': 'en' } }, this.cfg.timeoutMs, this.fetchImpl) as NominatimRow[];
    });
    // Any named place the organiser explicitly searched for is allowed (they know it is outdoors).
    return placesFromOverpass(nominatimToElements(rows, true), near).slice(0, 8);
  }
}

interface NominatimRow { osm_type?: string; osm_id?: number; lat: string; lon: string; category?: string; type?: string; name?: string; display_name?: string; extratags?: Record<string, string> | null }

const OUTDOOR: Record<string, string[]> = {
  leisure: ['park', 'garden', 'nature_reserve', 'common'],
  tourism: ['viewpoint', 'picnic_site'],
  natural: ['beach'],
};

export function nominatimToElements(rows: NominatimRow[], anyKind = false): OverpassElement[] {
  const out: OverpassElement[] = [];
  for (const r of rows) {
    const type = r.osm_type === 'way' || r.osm_type === 'node' || r.osm_type === 'relation' ? r.osm_type : null;
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    const name = r.name || r.display_name?.split(',')[0];
    if (!type || !r.osm_id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cat = r.category ?? '';
    const kind = r.type ?? '';
    const outdoor = OUTDOOR[cat]?.includes(kind);
    if (!outdoor && !anyKind) continue;
    out.push({ type, id: r.osm_id, lat, lon, tags: { ...(r.extratags ?? {}), name, ...(outdoor ? { [cat]: kind } : { leisure: 'park' }) } });
  }
  return out;
}

function dedupeById(els: OverpassElement[]): OverpassElement[] {
  const seen = new Set<string>();
  return els.filter((e) => { const k = `${e.type}${e.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function bbox(centre: Coord, radiusMetres: number) {
  const dLat = radiusMetres / 111_320;
  const dLon = radiusMetres / (111_320 * Math.max(0.1, Math.cos((centre.lat * Math.PI) / 180)));
  return { south: centre.lat - dLat, west: centre.lon - dLon, north: centre.lat + dLat, east: centre.lon + dLon };
}

/** Bounding-box query (cheaper for Overpass than `around`), one statement per tag family. */
export function overpassQuery(centre: Coord, radiusMetres: number): string {
  const b = bbox(centre, radiusMetres);
  const box = [b.south, b.west, b.north, b.east].map((x) => x.toFixed(5)).join(',');
  return `[out:json][timeout:20][bbox:${box}];(`
    + `nwr["leisure"~"^(park|garden|nature_reserve|common)$"]["name"];`
    + `nwr["tourism"~"^(viewpoint|picnic_site)$"]["name"];`
    + `nwr["natural"="beach"]["name"];`
    + `);out center tags qt 150;`;
}

/** Anything except a malformed query (HTTP 400) is worth trying on the next server. */
const NOT_RETRYABLE = /HTTP 400/;

/** Tries each Overpass server in turn when one is busy or slow. */
export async function overpassWithFallback(cfg: OsmConfig, query: string, fetchImpl: typeof fetch, perServerTimeoutMs = 30_000): Promise<{ elements?: OverpassElement[] }> {
  const errors: string[] = [];
  for (const url of cfg.overpassUrls) {
    try {
      const body = await getJson(url, {
        method: 'POST',
        headers: { 'User-Agent': cfg.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
      }, perServerTimeoutMs, fetchImpl) as { elements?: OverpassElement[]; remark?: string };
      // Overpass reports query timeouts inside a 200 response as a "remark" with no elements.
      if (!body.elements?.length && body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(`timeout: ${body.remark.slice(0, 80)}`);
      return body;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${new URL(url).hostname}: ${msg}`);
      if (NOT_RETRYABLE.test(msg)) throw e;
    }
  }
  throw new Error(`All Overpass servers busy (${errors.join('; ')})`);
}

export class OsmRouteProvider implements RouteProvider {
  readonly name: string;
  readonly transitAvailable: boolean;
  constructor(private cfg: OsmConfig, private fetchImpl: typeof fetch = fetch) {
    this.transitAvailable = !!cfg.transitousUrl;
    this.name = `OSM routing (FOSSGIS)${cfg.transitousUrl ? ' + Transitous' : ''}`;
  }

  private async osrm(base: string, from: Coord, to: Coord): Promise<number | null> {
    const key = `osrm|${base}|${from.lat.toFixed(4)},${from.lon.toFixed(4)}|${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
    return cached(key, 24 * 3_600_000, async () => {
      const url = `${base}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
      const body = await getJson(url, { headers: { 'User-Agent': this.cfg.userAgent } }, this.cfg.timeoutMs, this.fetchImpl) as { code?: string; routes?: Array<{ duration: number }> };
      if (body.code !== 'Ok' || !body.routes?.[0]) return null;
      return body.routes[0].duration / 60;
    });
  }

  async foot(from: Coord, to: Coord): Promise<RouteResult | null> {
    const m = await this.osrm(this.cfg.footRoutingUrl, from, to);
    return m === null ? null : { minutes: m, source: 'routing.openstreetmap.de (foot)' };
  }

  async car(from: Coord, to: Coord): Promise<RouteResult | null> {
    const m = await this.osrm(this.cfg.carRoutingUrl, from, to);
    return m === null ? null : { minutes: m, source: 'routing.openstreetmap.de (car, no live traffic)' };
  }

  async transit(from: Coord, to: Coord, arriveBy: string): Promise<RouteResult | null> {
    if (!this.cfg.transitousUrl) return null;
    const params = new URLSearchParams({ fromPlace: `${from.lat},${from.lon}`, toPlace: `${to.lat},${to.lon}`, time: arriveBy, arriveBy: 'true' });
    const url = `${this.cfg.transitousUrl}${this.cfg.transitousPlanPath}?${params}`;
    return cached(`transit|${url}`, 6 * 3_600_000, async () => {
      const body = await getJson(url, { headers: { 'User-Agent': this.cfg.userAgent } }, this.cfg.timeoutMs, this.fetchImpl) as { itineraries?: TransitItinerary[] };
      return bestItinerary(body.itineraries ?? []);
    });
  }
}

interface TransitLeg { mode?: string; duration?: number; startTime?: string; endTime?: string }
interface TransitItinerary { duration?: number; startTime?: string; endTime?: string; legs?: TransitLeg[] }

const secondsOf = (x: { duration?: number; startTime?: string; endTime?: string }) =>
  typeof x.duration === 'number' ? x.duration : x.startTime && x.endTime ? (Date.parse(x.endTime) - Date.parse(x.startTime)) / 1000 : NaN;

/** Shortest itinerary that actually uses transit; walking parts reported separately. */
export function bestItinerary(its: TransitItinerary[]): RouteResult | null {
  let best: RouteResult | null = null;
  for (const it of its) {
    const total = secondsOf(it);
    const legs = it.legs ?? [];
    if (!Number.isFinite(total) || legs.length === 0) continue;
    if (!legs.some((l) => l.mode && l.mode !== 'WALK')) continue;
    const walks = legs.filter((l) => l.mode === 'WALK').map(secondsOf);
    if (walks.some((w) => !Number.isFinite(w))) continue;
    const r: RouteResult = {
      minutes: total / 60,
      walkTotalMinutes: walks.reduce((a, b) => a + b, 0) / 60,
      walkLongestMinutes: Math.max(0, ...walks) / 60,
      source: 'Transitous (public transport timetables)',
    };
    if (!best || r.minutes < best.minutes) best = r;
  }
  return best;
}
