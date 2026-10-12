import type { OpeningRules } from '../domain/schemas.ts';

export interface AreaResult {
  label: string;
  lat: number;
  lon: number;
  /** ISO 3166-1 alpha-2, lower case, when known. */
  countryCode: string | null;
}

/** A real place found in OpenStreetMap, before the organiser reviews it. */
export interface PlaceDraft {
  /** Stable id derived from the OSM element, e.g. osm-w123456. */
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  osmUrl: string;
  /** Straight-line distance from the searched area centre — for display only, never used as a travel time. */
  straightLineMetres: number;
  openingHours: { raw: string | null; parsed: OpeningRules | null; caveat: string | null };
  /** Per-person mandatory fee: 0 = free, number = mapped charge, null = unknown. */
  fee: { value: number | null; raw: string | null };
  toilet: boolean | null;
  stepFree: boolean | null;
  seating: boolean | null;
  preferenceTags: Array<'greenery' | 'quiet' | 'photography' | 'conversation' | 'exploring'>;
}

export interface Coord { lat: number; lon: number }

export interface RouteResult {
  minutes: number;
  /** For transit: total and longest walking parts, minutes. */
  walkTotalMinutes?: number;
  walkLongestMinutes?: number;
  source: string;
}

export interface GeoProvider {
  readonly name: string;
  searchArea(query: string): Promise<AreaResult[]>;
  nearbyPlaces(centre: Coord, radiusMetres: number): Promise<PlaceDraft[]>;
  /** Look up a specific named place near a point (organiser's manual add). */
  placeByName(query: string, near: Coord): Promise<PlaceDraft[]>;
}

export interface RouteProvider {
  readonly name: string;
  readonly transitAvailable: boolean;
  foot(from: Coord, to: Coord): Promise<RouteResult | null>;
  car(from: Coord, to: Coord): Promise<RouteResult | null>;
  /** Public transport, arriving by `arriveBy` (ISO). Null when unavailable or no itinerary. */
  transit(from: Coord, to: Coord, arriveBy: string): Promise<RouteResult | null>;
}

export function haversineMetres(a: Coord, b: Coord): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Currency for a country; null when not in the table (the organiser then picks one). */
const CURRENCY: Record<string, string> = {
  in: 'INR', de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', at: 'EUR', be: 'EUR', ie: 'EUR', pt: 'EUR', fi: 'EUR', gr: 'EUR',
  lu: 'EUR', sk: 'EUR', si: 'EUR', ee: 'EUR', lv: 'EUR', lt: 'EUR', hr: 'EUR', mt: 'EUR', cy: 'EUR',
  gb: 'GBP', us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', ch: 'CHF', jp: 'JPY', sg: 'SGD', ae: 'AED', se: 'SEK', no: 'NOK', dk: 'DKK',
  pl: 'PLN', cz: 'CZK', hu: 'HUF', br: 'BRL', mx: 'MXN', za: 'ZAR', lk: 'LKR', np: 'NPR', bd: 'BDT', pk: 'PKR', id: 'IDR', my: 'MYR',
  th: 'THB', vn: 'VND', ph: 'PHP', kr: 'KRW', cn: 'CNY', hk: 'HKD', tw: 'TWD', tr: 'TRY', il: 'ILS', ke: 'KES', ng: 'NGN', eg: 'EGP',
  ar: 'ARS', cl: 'CLP', co: 'COP', pe: 'PEN',
};
export const currencyForCountry = (cc: string | null) => (cc ? CURRENCY[cc.toLowerCase()] ?? null : null);
