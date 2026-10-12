/**
 * Live check of the free OpenStreetMap services on THIS machine:
 *   npm run check:osm -- "Friedrichshain, Berlin"
 * Searches the area, lists real outdoor places nearby, and times one walking,
 * driving (and, if TRANSITOUS_ENABLED=true, public transport) route.
 */
import { existsSync } from 'node:fs';
import { OsmGeoProvider, OsmRouteProvider, osmConfigFromEnv } from '../src/geo/osm.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const query = process.argv.slice(2).join(' ') || 'Koregaon Park, Pune';
const cfg = osmConfigFromEnv();
const geo = new OsmGeoProvider(cfg);
const routes = new OsmRouteProvider(cfg);
let ok = true;
const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
  const t = Date.now();
  try { const r = await fn(); console.log(`✓ ${label} (${Date.now() - t} ms)`); return r; } catch (e) { ok = false; console.log(`✕ ${label}: ${(e as Error).message}`); return null; }
};

const areas = await step(`Nominatim search "${query}"`, () => geo.searchArea(query));
const area = areas?.[0];
if (area) {
  console.log(`  → ${area.label} (${area.lat.toFixed(4)}, ${area.lon.toFixed(4)}), country ${area.countryCode}`);
  const places = await step('Outdoor places within 2.5 km (Nominatim, plus Overpass if it answers)', () => geo.nearbyPlaces(area, 2500));
  if (places) console.log(`  sources that answered: ${geo.lastSources.join(' + ') || 'cache'}; ${places.length} places`);
  for (const p of (places ?? []).slice(0, 8)) {
    console.log(`  · ${p.name} [${p.kind}] ${(p.straightLineMetres / 1000).toFixed(1)} km · hours: ${p.openingHours.raw ?? 'not mapped'}${p.openingHours.raw && !p.openingHours.parsed ? ' (not parsed)' : ''} · fee: ${p.fee.value ?? 'unknown'} · toilets: ${p.toilet ?? 'unknown'}`);
  }
  const byName = await step('Find a place by name ("park")', () => geo.placeByName('park', area));
  if (byName) console.log(`  → ${byName.slice(0, 3).map((p) => p.name).join(', ') || 'none'}`);
  // Routing is tested even if place search failed: to a point ~1.5 km away.
  const target = places?.[Math.min(2, places.length - 1)] ?? { name: 'a point 1.5 km away', lat: area.lat + 0.0135, lon: area.lon };
  {
    const r1 = await step(`Walking route centre → ${target.name}`, () => routes.foot(area, target));
    if (r1) console.log(`  → ${r1.minutes.toFixed(1)} min (raw, before padding)`);
    const r2 = await step(`Driving route centre → ${target.name}`, () => routes.car(area, target));
    if (r2) console.log(`  → ${r2.minutes.toFixed(1)} min (raw, no live traffic)`);
    if (routes.transitAvailable) {
      const when = new Date(Date.now() + 2 * 86_400_000); when.setUTCHours(8, 0, 0, 0);
      const r3 = await step(`Transitous public transport → ${target.name}`, () => routes.transit({ lat: area.lat + 0.02, lon: area.lon + 0.02 }, target, when.toISOString()));
      console.log(r3 ? `  → ${r3.minutes.toFixed(1)} min, walking ${r3.walkTotalMinutes?.toFixed(1)} min` : '  → no itinerary (coverage may be missing here)');
    } else {
      console.log('· Public-transport timetables are off (set TRANSITOUS_ENABLED=true after reading the Transitous usage policy).');
    }
  }
}
console.log(ok ? '\nAll OpenStreetMap services reachable.' : '\nSome services failed — check your internet connection or try again in a minute.');
process.exit(ok ? 0 : 1);
