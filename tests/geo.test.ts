import { describe, expect, it } from 'vitest';
import { parseOpeningHours } from '../src/geo/opening-hours.ts';
import { bestItinerary, parseCharge, placesFromOverpass } from '../src/geo/osm.ts';
import { buildPlaces, computeTravel, outingDataset } from '../src/server/outing-data.ts';
import { assessFact, buildEvidenceContext } from '../src/domain/evidence.ts';
import { SharedSettings, ParticipantAnswers } from '../src/domain/schemas.ts';
import { AREA, FakeRoutes, PLACES, answers } from './fixtures/fake-geo.ts';

describe('OpenStreetMap opening_hours parser', () => {
  it('parses common forms', () => {
    expect(parseOpeningHours('24/7')!.rules.weekly).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], open: '00:00', close: '23:59' }]);
    expect(parseOpeningHours('06:00-20:00')!.rules.weekly).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], open: '06:00', close: '20:00' }]);
    const r = parseOpeningHours('Mo-Fr 08:00-20:00; Sa,Su 09:00-18:00')!.rules.weekly;
    expect(r).toContainEqual({ days: [1, 2, 3, 4, 5], open: '08:00', close: '20:00' });
    expect(r).toContainEqual({ days: [0, 6], open: '09:00', close: '18:00' });
  });
  it('handles split ranges, closed days, later-rule overrides and PH caveat', () => {
    const r = parseOpeningHours('Mo-Su 06:00-10:00,16:00-20:00; Mo off; PH off')!;
    expect(r.caveat).toBe('Closed on public holidays');
    expect(r.rules.weekly).toContainEqual({ days: [0, 2, 3, 4, 5, 6], open: '06:00', close: '10:00' });
    expect(r.rules.weekly.some((w) => w.days.includes(1))).toBe(false);
    expect(parseOpeningHours('Sa-Mo 08:00-12:00')!.rules.weekly[0]!.days).toEqual([0, 1, 6]);
  });
  it('returns null (unknown) for anything it cannot fully understand', () => {
    for (const s of ['sunrise-sunset', 'Apr-Sep Mo-Su 06:00-21:00', '22:00-02:00', 'Mo-Fr 08:00-20:00 "by appointment"', 'open', '', undefined]) {
      expect(parseOpeningHours(s as string)).toBeNull();
    }
  });
});

describe('Overpass and transit parsing', () => {
  it('maps OSM elements to place drafts conservatively', () => {
    const places = placesFromOverpass([
      { type: 'way', id: 11, center: { lat: 0.01, lon: 0 }, tags: { leisure: 'park', name: 'Green Park', opening_hours: '06:00-21:00', fee: 'no', toilets: 'yes' } },
      { type: 'relation', id: 12, center: { lat: 0.011, lon: 0 }, tags: { leisure: 'park', name: 'Green Park' } }, // duplicate name
      { type: 'node', id: 13, lat: 0.02, lon: 0, tags: { tourism: 'viewpoint', name: 'Hill View', fee: 'yes', charge: '20 INR', wheelchair: 'limited' } },
      { type: 'way', id: 14, center: { lat: 0, lon: 0.01 }, tags: { leisure: 'garden', name: 'Private Garden', access: 'private' } },
      { type: 'way', id: 15, center: { lat: 0, lon: 0.02 }, tags: { leisure: 'park' } }, // unnamed
    ], { lat: 0, lon: 0 });
    expect(places.map((p) => p.name)).toEqual(['Green Park', 'Hill View']);
    expect(places[0]).toMatchObject({ id: 'osm-w11', osmUrl: 'https://www.openstreetmap.org/way/11', fee: { value: 0 }, toilet: true, stepFree: null, seating: null });
    expect(places[0]!.openingHours.parsed).not.toBeNull();
    expect(places[1]).toMatchObject({ fee: { value: 20 }, stepFree: null });
  });
  it('parses charges only when unambiguous', () => {
    expect(parseCharge('€3')).toBe(3);
    expect(parseCharge('3,50 EUR')).toBe(3.5);
    expect(parseCharge('20 INR adults; 10 INR children')).toBeNull();
    expect(parseCharge('2 EUR per hour')).toBeNull();
  });
  it('picks the shortest transit itinerary and measures walking parts', () => {
    const r = bestItinerary([
      { duration: 3000, legs: [{ mode: 'WALK', duration: 300 }, { mode: 'BUS', duration: 2400 }, { mode: 'WALK', duration: 300 }] },
      { duration: 2400, legs: [{ mode: 'WALK', duration: 600 }, { mode: 'SUBWAY', duration: 1200 }, { mode: 'WALK', duration: 600 }] },
      { duration: 1200, legs: [{ mode: 'WALK', duration: 1200 }] }, // walking only: not transit
    ])!;
    expect(r).toMatchObject({ minutes: 40, walkTotalMinutes: 20, walkLongestMinutes: 10 });
  });
});

describe('per-outing places and private travel', () => {
  const settings = SharedSettings.parse({ title: 'x', coveredAreaId: 'area', date: '2026-10-18', windowStart: '09:00', windowEnd: '11:00', durationOptions: [60], expectedCount: 2, timeZone: 'Asia/Kolkata', currency: 'INR' });
  const now = '2026-10-09T06:00:00.000Z';
  const ctx = (ds: ReturnType<typeof outingDataset>) => buildEvidenceContext(ds, Date.parse('2026-10-17T18:30:00Z'), Date.parse(now));

  it('treats facts the organiser has not checked as unknown, never as a pass', () => {
    const built = buildPlaces([{ ...PLACES[0]!, checked: false }, PLACES[1]!], now, '2026-10-09');
    const ds = outingDataset('x', built.venues, built.evidence, []);
    expect(assessFact(built.venues[0]!.opening, 'opening', ctx(ds)).usable).toBe(false);
    expect(assessFact(built.venues[1]!.opening, 'opening', ctx(ds)).usable).toBe(true);
    // Absent facts stay unknown.
    expect(built.venues[0]!.facilities.step_free_access!.value).toBeNull();
  });

  it('pads routing results and keeps each estimate tied to its evidence', async () => {
    const built = buildPlaces(PLACES, now, '2026-10-09');
    const a = ParticipantAnswers.parse(answers({ allowedModes: ['public_transport', 'walk'] }));
    const t = await computeTravel('abc123', a, built.venues, settings, AREA, new FakeRoutes(), now);
    const transit = t.estimates.find((e) => e.venueId === 'osm-w1' && e.mode === 'public_transport' && e.direction === 'outbound')!;
    expect(transit.durationUpperMinutes).toBe(25); // 15 + 10, rounded up to 5
    expect(transit.costUpper).toBe(25);
    const walk = t.estimates.find((e) => e.venueId === 'osm-w1' && e.mode === 'walk')!;
    expect(walk.durationUpperMinutes).toBe(35); // 27 × 1.2 + 2 = 34.4 → 35
    expect(walk.walkContinuousUpperMinutes).toBe(35);
    for (const e of t.estimates) for (const id of e.evidenceIds) expect(t.evidence.some((x) => x.id === id)).toBe(true);
    expect(t.estimates.some((e) => e.venueId === 'osm-w2' && e.mode === 'walk')).toBe(false); // no foot route → no estimate
  });

  it('falls back to the person\'s own public-transport time when timetable routing is off, and notes missing fares', async () => {
    const built = buildPlaces(PLACES, now, '2026-10-09');
    const a = ParticipantAnswers.parse(answers({ origin: 'South', publicTransport: { fareOneWay: null, typicalMinutesToArea: 30 } }));
    const t = await computeTravel('abc123', a, built.venues, settings, AREA, new FakeRoutes(false), now);
    const e = t.estimates.find((x) => x.venueId === 'osm-w3' && x.direction === 'outbound')!;
    expect(e.durationUpperMinutes).toBe(50); // 30 + 10×1.2 + 5 = 47 → 50
    expect(e.costUpper).toBeNull();
    expect(e.walkTotalUpperMinutes).toBeNull();
    expect(t.notes.join(' ')).toMatch(/fare/);
  });

  it('reports unreachable routing services instead of inventing routes', async () => {
    const built = buildPlaces(PLACES, now, '2026-10-09');
    const t = await computeTravel('abc123', ParticipantAnswers.parse(answers()), built.venues, settings, AREA, new FakeRoutes(true, true), now);
    expect(t.estimates).toEqual([]);
    expect(t.notes.join(' ')).toMatch(/failed/);
  });

});

import { overpassQuery, overpassWithFallback } from '../src/geo/osm.ts';

describe('Overpass resilience', () => {
  const cfg = { userAgent: 'test', nominatimUrl: '', overpassUrls: ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'], footRoutingUrl: '', carRoutingUrl: '', transitousUrl: null, transitousPlanPath: '', timeoutMs: 1000 };
  it('falls back to the next server when one is busy or reports a query timeout', async () => {
    const hits: string[] = [];
    const fetchImpl = (async (url: string) => {
      hits.push(new URL(url).hostname);
      if (url.includes('a.example')) return new Response('busy', { status: 504 });
      if (url.includes('b.example')) return new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }), { status: 200 });
      return new Response(JSON.stringify({ elements: [{ type: 'way', id: 1, center: { lat: 0, lon: 0 }, tags: { leisure: 'park', name: 'P' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const body = await overpassWithFallback(cfg, 'q', fetchImpl);
    expect(body.elements).toHaveLength(1);
    expect(hits).toEqual(['a.example', 'b.example', 'c.example']);
  });
  it('reports clearly when every server is busy, and does not retry on bad requests', async () => {
    const busy = (async () => new Response('x', { status: 429 })) as unknown as typeof fetch;
    await expect(overpassWithFallback(cfg, 'q', busy)).rejects.toThrow(/All Overpass servers busy/);
    let n = 0;
    const bad = (async () => { n++; return new Response('x', { status: 400 }); }) as unknown as typeof fetch;
    await expect(overpassWithFallback(cfg, 'q', bad)).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });
  it('builds a bounding-box query around the centre', () => {
    const q = overpassQuery({ lat: 18.5366, lon: 73.8933 }, 2500);
    expect(q).toMatch(/\[bbox:18\.51414,73\.86961,18\.55906,73\.91699\]/);
  });
});

import { OsmGeoProvider, nominatimToElements } from '../src/geo/osm.ts';

describe('Nominatim as the main place source', () => {
  const cfg = { userAgent: 'test', nominatimUrl: 'https://nominatim.example', overpassUrls: ['https://ovp.example/api'], footRoutingUrl: '', carRoutingUrl: '', transitousUrl: null, transitousPlanPath: '', timeoutMs: 2000 };
  // Shape of a real Nominatim jsonv2 search row with extratags=1.
  const row = (id: number, name: string, category: string, type: string, lat: string, lon: string, extratags: Record<string, string> | null = null) =>
    ({ place_id: id + 1000, osm_type: 'way', osm_id: id, lat, lon, category, type, name, display_name: `${name}, Koregaon Park, Pune`, extratags });

  it('keeps only outdoor kinds and carries OSM tags across', () => {
    const els = nominatimToElements([
      row(1, 'Osho Teerth Park', 'leisure', 'park', '18.5390', '73.8890', { opening_hours: 'Mo-Su 06:00-09:00,15:00-18:00', fee: 'no' }),
      row(2, 'Park Avenue Hotel', 'tourism', 'hotel', '18.5370', '73.8900'),
    ]);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ type: 'way', id: 1, tags: { name: 'Osho Teerth Park', leisure: 'park', fee: 'no' } });
  });

  it('returns real places from Nominatim even when every Overpass server fails', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('https://ovp.example')) return new Response('boom', { status: 500 });
      const q = new URL(url).searchParams.get('q');
      if (q === 'park') return new Response(JSON.stringify([row(1, 'Osho Teerth Park', 'leisure', 'park', '18.5390', '73.8890', { opening_hours: '06:00-21:00', fee: 'no' })]), { status: 200 });
      if (q === 'garden') return new Response(JSON.stringify([row(3, 'Bund Garden', 'leisure', 'garden', '18.5370', '73.8850')]), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const geo = new OsmGeoProvider(cfg, fetchImpl);
    const places = await geo.nearbyPlaces({ lat: 18.5366, lon: 73.8933 }, 2500);
    expect(places.map((p) => p.name).sort()).toEqual(['Bund Garden', 'Osho Teerth Park']);
    expect(places.find((p) => p.name === 'Osho Teerth Park')).toMatchObject({ fee: { value: 0 }, osmUrl: 'https://www.openstreetmap.org/way/1' });
    expect(places.find((p) => p.name === 'Osho Teerth Park')!.openingHours.parsed).not.toBeNull();
    expect(geo.lastSources).toEqual(['nominatim']);
  }, 15000);

  it('merges Overpass results when Overpass answers, without duplicates', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('https://ovp.example')) return new Response(JSON.stringify({ elements: [
        { type: 'way', id: 1, center: { lat: 18.539, lon: 73.889 }, tags: { leisure: 'park', name: 'Osho Teerth Park' } },
        { type: 'node', id: 9, lat: 18.54, lon: 73.895, tags: { tourism: 'viewpoint', name: 'River View' } },
      ] }), { status: 200 });
      const q = new URL(url).searchParams.get('q');
      return new Response(JSON.stringify(q === 'park' ? [row(1, 'Osho Teerth Park', 'leisure', 'park', '18.5390', '73.8890')] : []), { status: 200 });
    }) as unknown as typeof fetch;
    const geo = new OsmGeoProvider({ ...cfg, nominatimUrl: 'https://nominatim2.example' }, fetchImpl);
    const places = await geo.nearbyPlaces({ lat: 18.5366, lon: 73.8934 }, 2500);
    expect(places.map((p) => p.name).sort()).toEqual(['Osho Teerth Park', 'River View']);
  }, 15000);

  it('finds a named place for the organiser’s manual add', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify([row(5, 'Empress Garden', 'leisure', 'garden', '18.5040', '73.8970')]), { status: 200 })) as unknown as typeof fetch;
    const geo = new OsmGeoProvider({ ...cfg, nominatimUrl: 'https://nominatim3.example' }, fetchImpl);
    const found = await geo.placeByName('Empress Garden', { lat: 18.5366, lon: 73.8933 });
    expect(found[0]).toMatchObject({ name: 'Empress Garden', id: 'osm-w5' });
  });
});

describe('one-tap place picking', () => {
  it('turns unlisted hours and fee into visible assumptions instead of blocking plans', () => {
    const lake = PLACES.find((p) => p.opening === null)!;
    const built = buildPlaces([{ ...lake, fee: null }], '2026-10-09T06:00:00.000Z', '2026-10-09');
    const v = built.venues[0]!;
    expect(v.assumptions).toEqual(['Opening hours aren’t listed — check before you go.', 'Entry fee isn’t listed — assumed free.']);
    const ds = outingDataset('x', built.venues, built.evidence, []);
    const ctx = buildEvidenceContext(ds, Date.parse('2026-10-17T18:30:00Z'), Date.parse('2026-10-09T06:00:00Z'));
    expect(assessFact(v.opening, 'opening', ctx).usable).toBe(true);
    expect(assessFact(v.entryCost, 'entryCost', ctx)).toMatchObject({ usable: true, value: { upper: 0 } });
    // The evidence says plainly that this was the organiser's assumption, not OpenStreetMap.
    expect(v.opening.evidenceIds[0]).toMatch(/-org$/);
  });
});
