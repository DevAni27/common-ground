/**
 * Builds each outing's own real dataset:
 *  - places: real OpenStreetMap places the organiser selected and reviewed
 *  - travel: per-participant estimates from free routing services (private)
 * The deterministic matching engine then runs on this dataset unchanged.
 */
import { z } from 'zod';
import { GeoPoint, Id, OpeningRules, type Dataset, type Evidence, type ParticipantAnswers, type SharedSettings, type TravelEstimate, type Venue } from '../domain/schemas.ts';
import { hhmmToMinutes, localToInstant, minutesToHHmm } from '../domain/time.ts';
import type { Coord, RouteProvider } from '../geo/types.ts';

export const AreaInfo = GeoPoint.extend({ countryCode: z.string().max(3).nullable() });
export type AreaInfo = z.infer<typeof AreaInfo>;

const FACT_NAMES = ['opening', 'fee', 'toilet', 'stepFree', 'seating', 'walk', 'meetingPoint'] as const;

/** One place as reviewed by the organiser in the create wizard. */
export const PlaceInput = z.object({
  id: Id,
  name: z.string().trim().min(1).max(120),
  kind: z.string().max(40),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  osmUrl: z.url().refine((u) => u.startsWith('https://www.openstreetmap.org/'), 'Must be an OpenStreetMap link'),
  meetingPoint: z.string().trim().max(200).default(''),
  opening: OpeningRules.nullable(),
  fee: z.number().min(0).max(100000).nullable(),
  toilet: z.boolean().nullable(),
  stepFree: z.boolean().nullable(),
  seating: z.boolean().nullable(),
  /** Organiser's estimate of walking at the place, minutes. */
  walkMinutes: z.number().int().min(0).max(300).nullable(),
  preferenceTags: z.array(z.enum(['greenery', 'quiet', 'photography', 'conversation', 'exploring'])).max(5),
  /** Facts the organiser typed or changed (rather than kept from OpenStreetMap). */
  edited: z.array(z.enum(FACT_NAMES)).default([]),
  /** The organiser confirmed these facts look right. Unchecked facts are proposals and cannot support a fit. */
  checked: z.boolean(),
});
export type PlaceInput = z.infer<typeof PlaceInput>;

export function buildPlaces(inputs: PlaceInput[], nowIso: string, today: string): { venues: Venue[]; evidence: Evidence[] } {
  const venues: Venue[] = [];
  const evidence: Evidence[] = [];
  for (const p of inputs) {
    const review = p.checked ? 'reviewed' as const : 'proposed' as const;
    const osmEv = `${p.id}-osm`;
    const orgEv = `${p.id}-org`;
    evidence.push({
      id: osmEv, sourceUrl: p.osmUrl, sourceKind: 'third_party', checkedAt: nowIso, confidence: 'confirmed', reviewStatus: review,
      notes: p.checked ? 'OpenStreetMap data, checked by the organiser' : 'OpenStreetMap data, not yet checked by the organiser',
    });
    evidence.push({
      id: orgEv, sourceKind: 'firsthand', checkedAt: nowIso, observedForDate: today, confidence: 'confirmed', reviewStatus: review,
      notes: 'Entered by the organiser',
    });
    // Not listed on OpenStreetMap and not filled in: the organiser picked the place anyway, so use a
    // stated, visible assumption instead of blocking every plan. Shown on every plan and the card.
    const assumptions: string[] = [];
    const edited = new Set(p.edited);
    let opening = p.opening;
    if (opening === null) {
      opening = { weekly: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '00:00', close: '23:59' }], exceptions: [] };
      assumptions.push('Opening hours aren’t listed — check before you go.');
      edited.add('opening');
    }
    let fee = p.fee;
    if (fee === null) {
      fee = 0;
      assumptions.push('Entry fee isn’t listed — assumed free.');
      edited.add('fee');
    }
    const src = (fact: (typeof FACT_NAMES)[number]) => [edited.has(fact) ? orgEv : osmEv];
    const fact = <T>(value: T | null, name: (typeof FACT_NAMES)[number]) => ({ value, evidenceIds: value === null ? [] : src(name) });
    venues.push({
      id: p.id,
      name: p.name,
      areaId: 'area',
      coordinates: { lat: p.lat, lng: p.lon },
      meetingPointDescription: p.meetingPoint || `Main entrance of ${p.name} — agree the exact spot in your group chat`,
      mapUrl: p.osmUrl,
      outdoor: { value: true, evidenceIds: [osmEv] },
      opening: fact(opening, 'opening'),
      entryCost: fact({ upper: fee }, 'fee'),
      facilities: { toilet: fact(p.toilet, 'toilet'), step_free_access: fact(p.stepFree, 'stepFree'), seating: fact(p.seating, 'seating') },
      visitWalkProfile: fact(p.walkMinutes === null ? null : { totalMinutesUpper: p.walkMinutes, continuousMinutesUpper: p.walkMinutes, restAtMeetingPoint: null }, 'walk'),
      preferenceTags: p.preferenceTags,
      excludedOptionalCosts: [],
      assumptions,
    });
  }
  return { venues, evidence };
}

/* ------------------------------------------------------------------ */
/* Private travel estimates                                            */
/* ------------------------------------------------------------------ */

const up5 = (m: number) => Math.ceil(m / 5) * 5;

/** Conservative padding applied to free routing results (documented in the README). */
export const PADDING = {
  walk: (m: number) => up5(m * 1.2 + 2),
  car: (m: number) => up5(m * 1.4 + 10),
  transit: (m: number) => up5(m + 10),
  walkPart: (m: number) => Math.ceil(m * 1.2),
};

export interface TravelResult { estimates: TravelEstimate[]; evidence: Evidence[]; notes: string[] }

export async function computeTravel(
  participantId: string, answers: ParticipantAnswers, venues: Venue[], settings: SharedSettings, area: AreaInfo,
  routes: RouteProvider, nowIso: string,
): Promise<TravelResult> {
  const origin: Coord = { lat: answers.origin.lat, lon: answers.origin.lon };
  const originId = `p-${participantId}`;
  const estimates: TravelEstimate[] = [];
  const evidence = new Map<string, Evidence>();
  const notes = new Set<string>();
  const ev = (key: string, e: Omit<Evidence, 'id' | 'checkedAt' | 'reviewStatus'>) => {
    const id = `${originId}-${key}`;
    if (!evidence.has(id)) evidence.set(id, { id, checkedAt: nowIso, reviewStatus: 'reviewed', ...e });
    return id;
  };
  let venueIndex = 0;
  const both = (venueId: string, mode: TravelEstimate['mode'], base: Omit<TravelEstimate, 'id' | 'originAreaId' | 'venueId' | 'mode' | 'direction' | 'applicability'>) => {
    for (const direction of ['outbound', 'return'] as const) {
      estimates.push({ id: `${originId}-${venueIndex}-${mode.replace('_', '-')}-${direction}`, originAreaId: originId, venueId, mode, direction, applicability: { startAfter: '05:00', startBefore: '22:00' }, ...base });
    }
  };
  const mid = minutesToHHmm(Math.round((hhmmToMinutes(settings.windowStart) + hhmmToMinutes(settings.windowEnd)) / 2 / 15) * 15);
  const arriveBy = new Date(localToInstant(settings.date, mid, settings.timeZone)).toISOString();

  for (const v of venues) {
    venueIndex += 1;
    const dest: Coord = { lat: v.coordinates.lat, lon: v.coordinates.lng };
    const safe = async <T>(fn: () => Promise<T | null>): Promise<T | null> => { try { return await fn(); } catch { notes.add('Some route lookups failed (service unreachable); those options will show as "needs checking".'); return null; } };

    if (answers.allowedModes.includes('walk')) {
      const r = await safe(() => routes.foot(origin, dest));
      if (r) {
        const up = PADDING.walk(r.minutes);
        if (up <= 180) {
          both(v.id, 'walk', { durationUpperMinutes: up, costUpper: 0, walkTotalUpperMinutes: up, walkContinuousUpperMinutes: up,
            evidenceIds: [ev('foot', { sourceKind: 'third_party', sourceUrl: 'https://routing.openstreetmap.de/', confidence: 'estimated', notes: 'OpenStreetMap walking route, padded ×1.2 + 2 min' })],
            limitations: 'Walking route from OpenStreetMap; same estimate used both ways.' });
        }
      }
    }
    if (answers.allowedModes.includes('own_vehicle')) {
      const r = await safe(() => routes.car(origin, dest));
      if (r) {
        const ov = answers.ownVehicle;
        both(v.id, 'own_vehicle', { durationUpperMinutes: PADDING.car(r.minutes), costUpper: ov?.costEachWay ?? null, walkTotalUpperMinutes: 5, walkContinuousUpperMinutes: 5,
          ownVehicle: {
            perPersonCostAssumption: ov?.costEachWay != null ? `Your own estimate: ${ov.costEachWay} ${settings.currency} each way` : 'Cost not given',
            parkingCost: ov?.parkingCost ?? null,
            parkingStatus: ov?.parkingCost == null ? 'unknown' : ov.parkingCost === 0 ? 'free' : 'paid',
          },
          evidenceIds: [ev('car', { sourceKind: 'third_party', sourceUrl: 'https://routing.openstreetmap.de/', confidence: 'estimated', notes: 'OpenStreetMap driving route without live traffic, padded ×1.4 + 10 min (parking)' })],
          limitations: 'Driving route without live traffic; includes 10 min for parking; same estimate used both ways.' });
      }
    }
    if (answers.allowedModes.includes('public_transport')) {
      const fare = answers.publicTransport?.fareOneWay ?? null;
      const t = routes.transitAvailable ? await safe(() => routes.transit(origin, dest, arriveBy)) : null;
      if (t) {
        both(v.id, 'public_transport', {
          durationUpperMinutes: PADDING.transit(t.minutes), costUpper: fare,
          walkTotalUpperMinutes: t.walkTotalMinutes !== undefined ? PADDING.walkPart(t.walkTotalMinutes) : null,
          walkContinuousUpperMinutes: t.walkLongestMinutes !== undefined ? PADDING.walkPart(t.walkLongestMinutes) : null,
          evidenceIds: [ev('transit', { sourceKind: 'third_party', sourceUrl: 'https://transitous.org/sources/', confidence: 'estimated', notes: `Public transport timetable for arrival by ${mid}, +10 min` })],
          limitations: `Timetable checked for arriving around ${mid}; other times can differ. Same estimate used both ways.`,
        });
      } else if (answers.publicTransport?.typicalMinutesToArea) {
        const last = await safe(() => routes.foot({ lat: area.lat, lon: area.lon }, dest));
        if (last) {
          both(v.id, 'public_transport', {
            durationUpperMinutes: up5(answers.publicTransport.typicalMinutesToArea + PADDING.walkPart(last.minutes) + 5), costUpper: fare,
            walkTotalUpperMinutes: null, walkContinuousUpperMinutes: null,
            evidenceIds: [
              ev('own-transit', { sourceKind: 'firsthand', observedForDate: settings.date, confidence: 'estimated', notes: 'Your own usual public-transport time to the area' }),
              ev('foot', { sourceKind: 'third_party', sourceUrl: 'https://routing.openstreetmap.de/', confidence: 'estimated', notes: 'OpenStreetMap walking route, padded' }),
            ],
            limitations: 'Your own usual time to the area plus a walking route from the area centre. Walking amounts on public transport are not known.',
          });
        }
      } else if (!routes.transitAvailable) {
        notes.add('Public transport: add your usual time to the area so bus/metro trips can be checked.');
      }
      if (fare === null) notes.add('Public transport: add your one-way fare (0 if you have a pass) so your budget can be checked.');
    }
  }
  return { estimates, evidence: [...evidence.values()], notes: [...notes] };
}

export function outingDataset(label: string, venues: Venue[], placeEvidence: Evidence[], participants: Array<{ id: string; travel: TravelEstimate[]; travelEvidence: Evidence[] }>): Dataset {
  return {
    kind: 'researched',
    label,
    coveredAreas: [{ id: 'area', name: label }],
    originAreas: participants.map((p) => ({ id: `p-${p.id}`, name: 'private' })),
    venues,
    travelEstimates: participants.flatMap((p) => p.travel),
    evidence: [...placeEvidence, ...participants.flatMap((p) => p.travelEvidence)],
  };
}
