/**
 * CLEARLY SYNTHETIC TEST FIXTURES. These places, routes, prices and hours are
 * invented for automated tests and UI development. They do not describe any
 * real venue and must never be presented as real or copied into data/researched.
 */
import type { Dataset, Evidence, TravelEstimate, Venue } from '../../src/domain/schemas.ts';

const ev = (id: string, checkedAt: string, extra: Partial<Evidence> = {}): Evidence => ({
  id, sourceKind: 'synthetic', checkedAt, confidence: 'confirmed', reviewStatus: 'reviewed',
  notes: 'Synthetic fixture — not a real observation.', ...extra,
});

const f = <T>(value: T | null, ...evidenceIds: string[]) => ({ value, evidenceIds });

/**
 * @param checkedAt ISO timestamp used for "fresh" synthetic evidence. Tests pass a
 * fixed value; the demo server passes a recent one so the fixtures stay usable.
 */
export function syntheticDataset(checkedAt: string): Dataset {
  const staleAt = new Date(Date.parse(checkedAt) - 800 * 86_400_000).toISOString();
  const evidence: Evidence[] = [
    ev('fx-ev-riverside', checkedAt),
    ev('fx-ev-botanic', checkedAt),
    ev('fx-ev-hill', checkedAt),
    ev('fx-ev-lake-a', checkedAt, { excerpt: 'Synthetic source A: open 06:00–19:00.', confidence: 'conflicting' }),
    ev('fx-ev-lake-b', checkedAt, { excerpt: 'Synthetic source B: open 08:00–12:00.', confidence: 'conflicting' }),
    ev('fx-ev-lake-cost', checkedAt),
    ev('fx-ev-heritage-old', staleAt, { notes: 'Synthetic fixture deliberately older than the freshness policy.' }),
    ev('fx-ev-heritage-cost', checkedAt),
    ev('fx-ev-travel', checkedAt, { confidence: 'estimated', notes: 'Synthetic travel estimate — not real routing.' }),
  ];

  const daily = [0, 1, 2, 3, 4, 5, 6];
  const venues: Venue[] = [
    {
      id: 'fx-riverside-walk', name: 'Riverside Walk (synthetic)', areaId: 'fx-zone',
      coordinates: { lat: 0.01, lng: 0.01 }, meetingPointDescription: 'Synthetic: north gate benches',
      outdoor: f(true, 'fx-ev-riverside'),
      opening: f({ weekly: [{ days: daily, open: '06:00', close: '20:00' }], exceptions: [] }, 'fx-ev-riverside'),
      entryCost: f({ upper: 0 }, 'fx-ev-riverside'),
      facilities: { seating: f(true, 'fx-ev-riverside'), toilet: f(true, 'fx-ev-riverside'), step_free_access: f<boolean>(null) },
      visitWalkProfile: f({ totalMinutesUpper: 30, continuousMinutesUpper: 15, restAtMeetingPoint: true }, 'fx-ev-riverside'),
      preferenceTags: ['greenery', 'conversation', 'photography'],
      excludedOptionalCosts: ['Snacks from stalls (optional)'],
      assumptions: [],
    },
    {
      id: 'fx-botanic-garden', name: 'Botanic Garden (synthetic)', areaId: 'fx-zone',
      coordinates: { lat: 0.02, lng: 0.01 }, meetingPointDescription: 'Synthetic: ticket counter',
      outdoor: f(true, 'fx-ev-botanic'),
      opening: f({ weekly: [{ days: [0, 2, 3, 4, 5, 6], open: '09:00', close: '17:30' }], exceptions: [{ date: '2026-10-20', closed: true, note: 'Synthetic holiday closure' }] }, 'fx-ev-botanic'),
      entryCost: f({ upper: 40 }, 'fx-ev-botanic'),
      facilities: { seating: f(true, 'fx-ev-botanic'), toilet: f(true, 'fx-ev-botanic'), step_free_access: f(true, 'fx-ev-botanic') },
      visitWalkProfile: f({ totalMinutesUpper: 45, continuousMinutesUpper: 20, restAtMeetingPoint: true }, 'fx-ev-botanic'),
      preferenceTags: ['greenery', 'quiet', 'photography'],
      excludedOptionalCosts: [],
      assumptions: [],
    },
    {
      id: 'fx-hill-trail', name: 'Hill Trail (synthetic)', areaId: 'fx-zone',
      coordinates: { lat: 0.03, lng: 0.02 }, meetingPointDescription: 'Synthetic: trailhead sign',
      outdoor: f(true, 'fx-ev-hill'),
      opening: f({ weekly: [{ days: daily, open: '05:30', close: '18:30' }], exceptions: [] }, 'fx-ev-hill'),
      entryCost: f({ upper: 0 }, 'fx-ev-hill'),
      facilities: { seating: f(false, 'fx-ev-hill'), toilet: f<boolean>(null) },
      visitWalkProfile: f({ totalMinutesUpper: 100, continuousMinutesUpper: 45, restAtMeetingPoint: null }, 'fx-ev-hill'),
      preferenceTags: ['greenery', 'exploring', 'photography'],
      excludedOptionalCosts: [],
      assumptions: [],
    },
    {
      id: 'fx-lake-promenade', name: 'Lake Promenade (synthetic)', areaId: 'fx-zone',
      coordinates: { lat: 0.04, lng: 0.0 }, meetingPointDescription: 'Synthetic: boat jetty',
      outdoor: f(true, 'fx-ev-lake-cost'),
      opening: f({ weekly: [{ days: daily, open: '06:00', close: '19:00' }], exceptions: [] }, 'fx-ev-lake-a', 'fx-ev-lake-b'),
      entryCost: f({ upper: 0 }, 'fx-ev-lake-cost'),
      facilities: {},
      visitWalkProfile: f({ totalMinutesUpper: 40, continuousMinutesUpper: 20, restAtMeetingPoint: true }, 'fx-ev-lake-cost'),
      preferenceTags: ['conversation', 'photography'],
      excludedOptionalCosts: [],
      assumptions: [],
    },
    {
      id: 'fx-heritage-lane', name: 'Heritage Lane (synthetic)', areaId: 'fx-zone',
      coordinates: { lat: 0.0, lng: 0.03 }, meetingPointDescription: 'Synthetic: clock tower',
      outdoor: f(true, 'fx-ev-heritage-cost'),
      opening: f({ weekly: [{ days: daily, open: '07:00', close: '19:00' }], exceptions: [] }, 'fx-ev-heritage-old'),
      entryCost: f({ upper: 25 }, 'fx-ev-heritage-cost'),
      facilities: {},
      visitWalkProfile: f({ totalMinutesUpper: 50, continuousMinutesUpper: 25, restAtMeetingPoint: false }, 'fx-ev-heritage-cost'),
      preferenceTags: ['exploring', 'photography'],
      excludedOptionalCosts: [],
      assumptions: [],
    },
  ];

  // [origin, venue, mode, outboundMin, returnMin, costEachWayINR, walkTotalEachWay, walkContinuousEachWay]
  const routes: Array<[string, string, TravelEstimate['mode'], number, number, number, number, number]> = [
    ['fx-north', 'fx-riverside-walk', 'public_transport', 25, 30, 20, 8, 5],
    ['fx-north', 'fx-riverside-walk', 'walk', 35, 35, 0, 35, 35],
    ['fx-north', 'fx-botanic-garden', 'public_transport', 35, 40, 30, 10, 6],
    ['fx-north', 'fx-hill-trail', 'public_transport', 50, 55, 40, 12, 8],
    ['fx-north', 'fx-lake-promenade', 'public_transport', 30, 30, 20, 8, 5],
    ['fx-north', 'fx-heritage-lane', 'public_transport', 30, 30, 20, 8, 5],
    ['fx-east', 'fx-riverside-walk', 'public_transport', 25, 40, 25, 6, 4],
    ['fx-east', 'fx-botanic-garden', 'public_transport', 45, 50, 35, 10, 6],
    ['fx-east', 'fx-hill-trail', 'public_transport', 60, 65, 45, 15, 10],
    ['fx-east', 'fx-lake-promenade', 'public_transport', 35, 35, 25, 8, 5],
    ['fx-east', 'fx-heritage-lane', 'public_transport', 35, 35, 25, 8, 5],
    ['fx-south', 'fx-riverside-walk', 'public_transport', 40, 45, 30, 10, 6],
    ['fx-south', 'fx-botanic-garden', 'public_transport', 30, 30, 25, 6, 4],
    // fx-south → fx-hill-trail deliberately has no covered route.
    ['fx-south', 'fx-lake-promenade', 'public_transport', 40, 40, 30, 8, 5],
    ['fx-south', 'fx-heritage-lane', 'public_transport', 40, 40, 30, 8, 5],
  ];
  const travelEstimates: TravelEstimate[] = routes.flatMap(([o, v, mode, outMin, retMin, cost, wt, wc]) => (['outbound', 'return'] as const).map((direction) => ({
    id: `fx-tr-${o}-${v}-${mode}-${direction}`.replace(/_/g, '-'),
    originAreaId: o, venueId: v, mode, direction,
    applicability: { startAfter: '05:00', startBefore: '21:00' },
    durationUpperMinutes: direction === 'outbound' ? outMin : retMin,
    costUpper: cost,
    walkTotalUpperMinutes: wt,
    walkContinuousUpperMinutes: wc,
    evidenceIds: ['fx-ev-travel'],
    limitations: 'Synthetic estimate for tests; no real routing, traffic or transit data.',
  })));

  return {
    kind: 'synthetic_fixture',
    label: 'Synthetic test fixtures — invented places, not real venues',
    coveredAreas: [{ id: 'fx-zone', name: 'Fixture Zone (synthetic)' }],
    originAreas: [
      { id: 'fx-north', name: 'Fixture North (synthetic)' },
      { id: 'fx-east', name: 'Fixture East (synthetic)' },
      { id: 'fx-south', name: 'Fixture South (synthetic)' },
    ],
    venues,
    travelEstimates,
    evidence,
  };
}
