/**
 * TEST-ONLY fake providers. They stand in for OpenStreetMap search and routing
 * so automated tests run offline and deterministically. Place names say
 * "(test)"; nothing here is shown by the real app.
 */
import type { AreaResult, Coord, GeoProvider, PlaceDraft, RouteProvider, RouteResult } from '../../src/geo/types.ts';
import type { PlaceInput } from '../../src/server/outing-data.ts';

export const ORIGINS: Record<string, Coord & { label: string }> = {
  North: { label: 'North (test)', lat: 0.05, lon: 0.0 },
  East: { label: 'East (test)', lat: 0.0, lon: 0.05 },
  South: { label: 'South (test)', lat: -0.05, lon: 0.0 },
};
export const AREA = { label: 'Test Area', lat: 0, lon: 0, countryCode: 'in' };

const daily = [0, 1, 2, 3, 4, 5, 6];
const base = { kind: 'Park', meetingPoint: '', edited: [] as PlaceInput['edited'], checked: true };
export const PLACES: PlaceInput[] = [
  { ...base, id: 'osm-w1', name: 'Riverside Walk (test)', lat: 0.01, lon: 0.01, osmUrl: 'https://www.openstreetmap.org/way/1',
    opening: { weekly: [{ days: daily, open: '06:00', close: '20:00' }], exceptions: [] }, fee: 0, toilet: true, stepFree: null, seating: true, walkMinutes: 30,
    preferenceTags: ['greenery', 'conversation', 'photography'] },
  { ...base, id: 'osm-w2', name: 'Botanic Garden (test)', lat: 0.02, lon: 0.01, osmUrl: 'https://www.openstreetmap.org/way/2',
    opening: { weekly: [{ days: [0, 2, 3, 4, 5, 6], open: '09:00', close: '17:30' }], exceptions: [] }, fee: 40, toilet: true, stepFree: true, seating: true, walkMinutes: 45,
    preferenceTags: ['greenery', 'quiet', 'photography'] },
  { ...base, id: 'osm-w3', name: 'Hill Trail (test)', lat: 0.03, lon: 0.02, osmUrl: 'https://www.openstreetmap.org/way/3',
    opening: { weekly: [{ days: daily, open: '05:30', close: '18:30' }], exceptions: [] }, fee: 0, toilet: null, stepFree: null, seating: false, walkMinutes: 100,
    preferenceTags: ['greenery', 'exploring', 'photography'] },
  { ...base, id: 'osm-w4', name: 'Lake Promenade (test)', lat: 0.04, lon: 0.0, osmUrl: 'https://www.openstreetmap.org/way/4',
    opening: null, fee: 0, toilet: null, stepFree: null, seating: null, walkMinutes: 40, preferenceTags: ['conversation', 'photography'] },
];

/** Raw (unpadded) minutes by origin → place. Transit is padded +10 then rounded up to 5 by the app. */
const TRANSIT: Record<string, Record<string, number>> = {
  North: { 'osm-w1': 15, 'osm-w2': 25, 'osm-w3': 40, 'osm-w4': 20 },
  East: { 'osm-w1': 15, 'osm-w2': 35, 'osm-w3': 50, 'osm-w4': 25 },
  South: { 'osm-w1': 30, 'osm-w2': 20, 'osm-w4': 30 }, // South → Hill Trail: no route
};
const FOOT: Record<string, Record<string, number>> = { North: { 'osm-w1': 27 } };

const originName = (c: Coord) => Object.entries(ORIGINS).find(([, o]) => o.lat === c.lat && o.lon === c.lon)?.[0];
const placeId = (c: Coord) => PLACES.find((p) => p.lat === c.lat && p.lon === c.lon)?.id;

export class FakeGeo implements GeoProvider {
  readonly name = 'fake geo (tests)';
  async searchArea(q: string): Promise<AreaResult[]> {
    const o = ORIGINS[q.trim()];
    return o ? [{ label: o.label, lat: o.lat, lon: o.lon, countryCode: 'in' }] : [{ ...AREA, label: `${q} (test)` }];
  }
  async placeByName(q: string): Promise<PlaceDraft[]> {
    return (await this.nearbyPlaces()).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  }
  async nearbyPlaces(): Promise<PlaceDraft[]> {
    return PLACES.map((p) => ({ id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, osmUrl: p.osmUrl, straightLineMetres: 1000,
      openingHours: { raw: null, parsed: p.opening, caveat: null }, fee: { value: p.fee, raw: null }, toilet: p.toilet, stepFree: p.stepFree, seating: p.seating, preferenceTags: p.preferenceTags }));
  }
}

export class FakeRoutes implements RouteProvider {
  readonly name = 'fake routing (tests)';
  calls: string[] = [];
  constructor(readonly transitAvailable = true, private fail = false) {}
  private look(table: Record<string, Record<string, number>>, from: Coord, to: Coord): number | undefined {
    const o = originName(from) ?? (from.lat === AREA.lat && from.lon === AREA.lon ? 'Area' : undefined);
    const p = placeId(to);
    return o && p ? table[o]?.[p] : undefined;
  }
  async foot(from: Coord, to: Coord): Promise<RouteResult | null> {
    this.calls.push('foot'); if (this.fail) throw new Error('unreachable');
    if (from.lat === AREA.lat && from.lon === AREA.lon) return { minutes: 10, source: 'fake' };
    const m = this.look(FOOT, from, to); return m === undefined ? null : { minutes: m, source: 'fake' };
  }
  async car(): Promise<RouteResult | null> { this.calls.push('car'); if (this.fail) throw new Error('unreachable'); return null; }
  async transit(from: Coord, to: Coord): Promise<RouteResult | null> {
    this.calls.push('transit'); if (this.fail) throw new Error('unreachable');
    const m = this.look(TRANSIT, from, to); return m === undefined ? null : { minutes: m, walkTotalMinutes: 6, walkLongestMinutes: 4, source: 'fake' };
  }
}

export const outingBody = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  settings: { timeZone: 'Asia/Kolkata', currency: 'INR', ...settings }, area: AREA, places: PLACES, ...extra,
});

export const answers = (over: Record<string, unknown> = {}) => {
  const { origin = 'North', ...rest } = over as { origin?: keyof typeof ORIGINS } & Record<string, unknown>;
  return {
    origin: ORIGINS[origin as string], earliestDepartureLocal: '07:00', latestReturnLocal: '18:00', allowedModes: ['public_transport'],
    maxOneWayTravelMinutes: 60, maxTotalCost: 4321, requiredFacilities: [], requireVerifiedLowCrowd: false,
    softPreferences: { greenery: 2, quiet: 0, photography: 1, conversation: 1, exploring: 0 },
    publicTransport: { fareOneWay: 25, typicalMinutesToArea: null }, ...rest,
  };
};
