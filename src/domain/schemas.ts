import { z } from 'zod';
import { hhmmToMinutes, isHHmm, isLocalDate } from './time.ts';

/* ------------------------------------------------------------------ */
/* Primitive validators                                                */
/* ------------------------------------------------------------------ */

export const HHmm = z.string().refine(isHHmm, 'Use 24-hour HH:mm, e.g. 09:30');
export const LocalDate = z.string().refine(isLocalDate, 'Use a real date as YYYY-MM-DD');
export const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid id');

/** Same-day daytime outings only. */
export const DAY_START = '05:00';
export const DAY_END = '22:00';

export const TRANSPORT_MODES = ['walk', 'public_transport', 'own_vehicle'] as const;
export const TransportMode = z.enum(TRANSPORT_MODES);
export type TransportMode = z.infer<typeof TransportMode>;

export const FACILITIES = ['seating', 'step_free_access', 'toilet'] as const;
export const Facility = z.enum(FACILITIES);
export type Facility = z.infer<typeof Facility>;

export const SOFT_PREFERENCES = ['greenery', 'quiet', 'photography', 'conversation', 'exploring'] as const;
export type SoftPreference = (typeof SOFT_PREFERENCES)[number];

/* ------------------------------------------------------------------ */
/* Evidence and facts                                                  */
/* ------------------------------------------------------------------ */

export const Evidence = z.object({
  id: Id,
  sourceUrl: z.url().optional(),
  sourceKind: z.enum(['official', 'firsthand', 'third_party', 'synthetic']),
  excerpt: z.string().max(1000).optional(),
  checkedAt: z.iso.datetime({ offset: true }),
  observedForDate: LocalDate.optional(),
  confidence: z.enum(['confirmed', 'estimated', 'unknown', 'conflicting']),
  /** AI-extracted or unreviewed facts are proposals and never support a pass. */
  reviewStatus: z.enum(['reviewed', 'proposed']),
  notes: z.string().max(1000).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** A single fact with its own evidence. `value: null` means "not known". */
export const fact = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value: value.nullable(), evidenceIds: z.array(Id) });

export type Fact<T> = { value: T | null; evidenceIds: string[] };

export const OpeningRules = z.object({
  weekly: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1), // 0 = Sunday
    open: HHmm,
    close: HHmm,
  })),
  /** Date exceptions override the weekly rule for that date. */
  exceptions: z.array(z.object({
    date: LocalDate,
    closed: z.boolean(),
    open: HHmm.optional(),
    close: HHmm.optional(),
    note: z.string().max(300).optional(),
  })).default([]),
});
export type OpeningRules = z.infer<typeof OpeningRules>;

export const VisitWalkProfile = z.object({
  totalMinutesUpper: z.number().min(0).max(600),
  continuousMinutesUpper: z.number().min(0).max(600),
  /** Whether a documented rest opportunity exists at the meeting point. null = unknown. */
  restAtMeetingPoint: z.boolean().nullable(),
});

export const LowCrowdWindows = z.object({
  windows: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), from: HHmm, to: HHmm })),
});

export const Venue = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  areaId: Id,
  coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  meetingPointDescription: z.string().min(1).max(300),
  mapUrl: z.url().optional(),
  outdoor: fact(z.boolean()),
  opening: fact(OpeningRules),
  /** Mandatory per-person entry/activity cost upper bound (INR). */
  entryCost: fact(z.object({ upper: z.number().min(0).max(100000), note: z.string().max(300).optional() })),
  facilities: z.object({
    seating: fact(z.boolean()).optional(),
    step_free_access: fact(z.boolean()).optional(),
    toilet: fact(z.boolean()).optional(),
  }),
  visitWalkProfile: fact(VisitWalkProfile),
  lowCrowdVerified: fact(LowCrowdWindows).optional(),
  preferenceTags: z.array(z.enum(SOFT_PREFERENCES)),
  /** Optional refreshments etc. that are excluded from cost checks, shown publicly. */
  excludedOptionalCosts: z.array(z.string().max(200)).default([]),
  /** Public caveats the organiser accepted when facts were not listed (e.g. hours assumed). Shown on every plan and card. */
  assumptions: z.array(z.string().max(200)).default([]),
});
export type Venue = z.infer<typeof Venue>;

export const TravelEstimate = z.object({
  id: Id,
  originAreaId: Id,
  venueId: Id,
  mode: TransportMode,
  direction: z.enum(['outbound', 'return']),
  applicability: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    /** The leg's start time must fall within [startAfter, startBefore]. */
    startAfter: HHmm,
    startBefore: HHmm,
    validFrom: LocalDate.optional(),
    validUntil: LocalDate.optional(),
  }),
  durationUpperMinutes: z.number().min(0).max(600).nullable(),
  /** Per person, this direction only. */
  costUpper: z.number().min(0).max(100000).nullable(),
  walkTotalUpperMinutes: z.number().min(0).max(600).nullable(),
  walkContinuousUpperMinutes: z.number().min(0).max(600).nullable(),
  ownVehicle: z.object({
    perPersonCostAssumption: z.string().min(1).max(300),
    parkingCost: z.number().min(0).max(10000).nullable(),
    parkingStatus: z.enum(['free', 'paid', 'unknown', 'not_applicable']),
  }).optional(),
  evidenceIds: z.array(Id),
  limitations: z.string().max(500),
});
export type TravelEstimate = z.infer<typeof TravelEstimate>;

export const Area = z.object({ id: Id, name: z.string().min(1).max(120) });

export const Dataset = z.object({
  kind: z.enum(['synthetic_fixture', 'researched']),
  label: z.string().max(200),
  coveredAreas: z.array(Area),
  originAreas: z.array(Area),
  venues: z.array(Venue),
  travelEstimates: z.array(TravelEstimate),
  evidence: z.array(Evidence),
});
export type Dataset = z.infer<typeof Dataset>;

/* ------------------------------------------------------------------ */
/* Outing settings and participant requirements                        */
/* ------------------------------------------------------------------ */

export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const inDay = (t: string) => hhmmToMinutes(t) >= hhmmToMinutes(DAY_START) && hhmmToMinutes(t) <= hhmmToMinutes(DAY_END);

export const SharedSettings = z.object({
  title: z.string().trim().min(1).max(80),
  coveredAreaId: Id,
  date: LocalDate,
  windowStart: HHmm.refine(inDay, `Meeting window must be between ${DAY_START} and ${DAY_END}`),
  windowEnd: HHmm.refine(inDay, `Meeting window must be between ${DAY_START} and ${DAY_END}`),
  durationOptions: z.array(z.number().int().min(15).max(480).multipleOf(5)).min(1).max(5),
  expectedCount: z.number().int().min(2).max(8),
  timeGridMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
  arrivalBufferMinutes: z.number().int().min(0).max(60).default(10),
  departureBufferMinutes: z.number().int().min(0).max(60).default(10),
  /** IANA zone of the outing area; all time arithmetic happens in this zone. */
  timeZone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').default('UTC'),
  /** ISO 4217 code for all money amounts in this outing. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').default('EUR'),
}).refine((s) => hhmmToMinutes(s.windowStart) <= hhmmToMinutes(s.windowEnd), {
  message: 'The meeting window must start before it ends (overnight outings are not supported)',
  path: ['windowEnd'],
}).refine((s) => new Set(s.durationOptions).size === s.durationOptions.length, {
  message: 'Duration options must be distinct', path: ['durationOptions'],
});
export type SharedSettings = z.infer<typeof SharedSettings>;

export const SoftPreferences = z.object({
  greenery: z.number().int().min(0).max(3),
  quiet: z.number().int().min(0).max(3),
  photography: z.number().int().min(0).max(3),
  conversation: z.number().int().min(0).max(3),
  exploring: z.number().int().min(0).max(3),
});

const PreferenceFields = {
  earliestDepartureLocal: HHmm.refine(inDay, `Times must be between ${DAY_START} and ${DAY_END}`),
  latestReturnLocal: HHmm.refine(inDay, `Times must be between ${DAY_START} and ${DAY_END}`),
  allowedModes: z.array(TransportMode).min(1, 'Choose at least one way to travel'),
  maxOneWayTravelMinutes: z.number().int().min(0).max(240),
  maxTotalCost: z.number().int().min(0).max(100000),
  maxContinuousWalkMinutes: z.number().int().min(0).max(600).optional(),
  maxTotalWalkMinutes: z.number().int().min(0).max(600).optional(),
  requiredFacilities: z.array(Facility),
  /** Strict setting: only verified, time-specific low-crowd evidence passes. */
  requireVerifiedLowCrowd: z.boolean().default(false),
  softPreferences: SoftPreferences,
};

type PrefShape = { earliestDepartureLocal: string; latestReturnLocal: string; allowedModes: string[]; requiredFacilities: string[] };
const prefChecks = <T extends z.ZodType<PrefShape>>(schema: T) => schema
  .refine((p) => hhmmToMinutes(p.earliestDepartureLocal) < hhmmToMinutes(p.latestReturnLocal), {
    message: 'Be-home time must be after your leave time, on the same day', path: ['latestReturnLocal'],
  })
  .refine((p) => new Set(p.allowedModes).size === p.allowedModes.length, { message: 'Duplicate transport modes', path: ['allowedModes'] })
  .refine((p) => new Set(p.requiredFacilities).size === p.requiredFacilities.length, { message: 'Duplicate facilities', path: ['requiredFacilities'] });

/** Matching-engine view of one person's requirements. */
export const ParticipantPreferences = prefChecks(z.object({ originAreaId: Id, ...PreferenceFields }));

export const GeoPoint = z.object({
  label: z.string().trim().min(1).max(160),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * What a participant submits. The starting point is a neighbourhood-level
 * place they picked from search (not an address); travel estimates are
 * derived from it server-side and kept private.
 */
export const ParticipantAnswers = prefChecks(z.object({
  ...PreferenceFields,
  origin: GeoPoint,
  publicTransport: z.object({
    /** One-way fare in the outing currency; 0 for a pass; null = unknown. */
    fareOneWay: z.number().min(0).max(100000).nullable(),
    /** Their own usual door-to-area time, used when no timetable routing is available. */
    typicalMinutesToArea: z.number().int().min(1).max(240).nullable(),
  }).optional(),
  ownVehicle: z.object({
    /** Per-person cost each way (fuel, tolls) in the outing currency; null = unknown. */
    costEachWay: z.number().min(0).max(100000).nullable(),
    /** Per-person parking cost for the visit; null = unknown. */
    parkingCost: z.number().min(0).max(100000).nullable(),
  }).optional(),
}));
export type ParticipantAnswers = z.infer<typeof ParticipantAnswers>;
export type ParticipantPreferences = z.infer<typeof ParticipantPreferences>;
