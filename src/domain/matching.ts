/**
 * Deterministic, evidence-aware matching. No LLM is involved in any check,
 * arithmetic or ranking here. Every check returns pass / fail / unknown;
 * missing or weak data can only ever produce "unknown", never "pass".
 */
import { assessEvidenceIds, assessFact, buildEvidenceContext, type EvidenceContext } from './evidence.ts';
import type {
  Dataset, Facility, OpeningRules, ParticipantPreferences, SharedSettings, SoftPreference, TransportMode, TravelEstimate, Venue,
} from './schemas.ts';
import { FACILITIES, SOFT_PREFERENCES, TRANSPORT_MODES } from './schemas.ts';
import { hhmmToMinutes, localToInstant, minutesToHHmm, MINUTE_MS, weekdayOfLocalDate } from './time.ts';

export type CheckStatus = 'pass' | 'fail' | 'unknown';
export type CheckCode =
  | 'VENUE_OUTDOOR' | 'VENUE_OPEN'
  | 'TRAVEL_OUTBOUND' | 'TRAVEL_RETURN'
  | 'DEPARTURE_TIME' | 'RETURN_TIME' | 'ONE_WAY_TRAVEL'
  | 'TOTAL_WALK' | 'CONTINUOUS_WALK' | 'BUDGET' | 'FACILITY' | 'LOW_CROWD';

export interface CheckResult {
  code: CheckCode;
  status: CheckStatus;
  /** Internal reason code, e.g. NO_COVERED_ROUTE, STALE_EVIDENCE, OVER_BUDGET. */
  reason: string;
  evidenceIds: string[];
  /** Private numeric detail; never part of shared responses. */
  detail?: Record<string, number | string | null>;
  facility?: Facility;
}

export interface Slot { venueId: string; meetingTime: string; durationMinutes: number }
export const slotKey = (s: Slot) => `${s.venueId}@${s.meetingTime.replace(':', '')}+${s.durationMinutes}`;

export interface ParticipantInput { participantId: string; preferences: ParticipantPreferences }

export interface LegChoice {
  estimateId: string;
  durationUpper: number;
  costUpper: number | null;
  walkTotalUpper: number | null;
  walkContinuousUpper: number | null;
  startInstant: number;
  endInstant: number;
  evidenceIds: string[];
  limitations: string;
}

export interface ParticipantAssessment {
  participantId: string;
  status: CheckStatus;
  mode: TransportMode | null;
  checks: CheckResult[];
  outbound: LegChoice | null;
  return: LegChoice | null;
  costUpper: number | null;
  /** Largest relative load (0..1) when status is pass; otherwise null. Never published. */
  burden: number | null;
  totalTravelMinutes: number | null;
}

export interface CandidateEvaluation {
  key: string;
  slot: Slot;
  status: CheckStatus;
  venueChecks: CheckResult[];
  participants: ParticipantAssessment[];
  burden: number | null;
  softScore: number;
  totalTravelMinutes: number | null;
  unknownCount: number;
}

export interface MatchOptions {
  timeZone: string;
  now: number;
  /** Override enumeration (used by the change explorer). */
  venueIds?: string[];
  meetingTimes?: string[];
  durations?: number[];
}

/* ------------------------------------------------------------------ */

const worst = (statuses: CheckStatus[]): CheckStatus =>
  statuses.includes('fail') ? 'fail' : statuses.includes('unknown') ? 'unknown' : 'pass';

const pass = (code: CheckCode, reason = 'OK', evidenceIds: string[] = [], detail?: CheckResult['detail']): CheckResult =>
  ({ code, status: 'pass', reason, evidenceIds, detail });
const fail = (code: CheckCode, reason: string, evidenceIds: string[] = [], detail?: CheckResult['detail']): CheckResult =>
  ({ code, status: 'fail', reason, evidenceIds, detail });
const unknown = (code: CheckCode, reason: string, evidenceIds: string[] = [], detail?: CheckResult['detail']): CheckResult =>
  ({ code, status: 'unknown', reason, evidenceIds, detail });

/** Load = usage / cap, safe for zero caps (zero usage → 0; positive usage has already failed). */
export function relativeLoad(usage: number, cap: number): number {
  if (cap <= 0) return usage <= 0 ? 0 : Number.POSITIVE_INFINITY;
  return usage / cap;
}

/** Times when the slot's venue is open on `date`, as [openMin, closeMin] pairs; or a status if not determinable. */
export function openingIntervals(rules: OpeningRules, date: string): { kind: 'closed'; reason: string } | { kind: 'unknown'; reason: string } | { kind: 'open'; intervals: Array<[number, number]> } {
  const exceptions = rules.exceptions.filter((e) => e.date === date);
  if (exceptions.length > 0) {
    if (exceptions.some((e) => e.closed) && exceptions.some((e) => !e.closed)) return { kind: 'unknown', reason: 'CONFLICTING_DATE_EXCEPTION' };
    if (exceptions.every((e) => e.closed)) return { kind: 'closed', reason: 'CLOSED_ON_DATE' };
    const intervals: Array<[number, number]> = [];
    for (const e of exceptions) {
      if (!e.open || !e.close) return { kind: 'unknown', reason: 'INCOMPLETE_DATE_EXCEPTION' };
      intervals.push([hhmmToMinutes(e.open), hhmmToMinutes(e.close)]);
    }
    return { kind: 'open', intervals };
  }
  const weekday = weekdayOfLocalDate(date);
  const intervals = rules.weekly
    .filter((r) => r.days.includes(weekday))
    .map((r) => [hhmmToMinutes(r.open), hhmmToMinutes(r.close)] as [number, number]);
  if (intervals.length === 0) return { kind: 'closed', reason: 'CLOSED_ON_WEEKDAY' };
  return { kind: 'open', intervals };
}

function venueChecks(venue: Venue, settings: SharedSettings, slot: Slot, ctx: EvidenceContext): CheckResult[] {
  const out: CheckResult[] = [];
  const outdoor = assessFact(venue.outdoor, 'outdoor', ctx);
  if (!outdoor.usable) out.push(unknown('VENUE_OUTDOOR', outdoor.reason, outdoor.evidenceIds));
  else out.push(outdoor.value ? pass('VENUE_OUTDOOR', 'OK', outdoor.evidenceIds) : fail('VENUE_OUTDOOR', 'NOT_OUTDOOR', outdoor.evidenceIds));

  const opening = assessFact(venue.opening, 'opening', ctx);
  if (!opening.usable) {
    out.push(unknown('VENUE_OPEN', opening.reason, opening.evidenceIds));
  } else {
    const result = openingIntervals(opening.value, settings.date);
    const start = hhmmToMinutes(slot.meetingTime);
    const end = start + slot.durationMinutes;
    if (result.kind === 'closed') out.push(fail('VENUE_OPEN', result.reason, opening.evidenceIds));
    else if (result.kind === 'unknown') out.push(unknown('VENUE_OPEN', result.reason, opening.evidenceIds));
    else if (result.intervals.some(([o, c]) => start >= o && end <= c)) out.push(pass('VENUE_OPEN', 'OK', opening.evidenceIds));
    else out.push(fail('VENUE_OPEN', 'OUTSIDE_OPENING_HOURS', opening.evidenceIds));
  }
  return out;
}

type LegLookup = { ok: true; leg: LegChoice; estimate: TravelEstimate } | { ok: false; reason: string; evidenceIds: string[] };

function chooseLeg(
  estimates: TravelEstimate[], direction: 'outbound' | 'return', anchorInstant: number,
  settings: SharedSettings, ctx: EvidenceContext, timeZone: string,
): LegLookup {
  if (estimates.length === 0) return { ok: false, reason: 'NO_COVERED_ROUTE', evidenceIds: [] };
  const weekday = weekdayOfLocalDate(settings.date);
  const candidates: Array<{ leg: LegChoice; estimate: TravelEstimate }> = [];
  let lastReason = 'TRAVEL_NOT_APPLICABLE';
  let lastEvidence: string[] = [];
  for (const est of estimates) {
    lastEvidence = est.evidenceIds;
    if (est.durationUpperMinutes === null) { lastReason = 'TRAVEL_DURATION_UNKNOWN'; continue; }
    const a = est.applicability;
    if (a.validFrom && settings.date < a.validFrom) { lastReason = 'TRAVEL_NOT_APPLICABLE'; continue; }
    if (a.validUntil && settings.date > a.validUntil) { lastReason = 'TRAVEL_NOT_APPLICABLE'; continue; }
    if (a.days && !a.days.includes(weekday)) { lastReason = 'TRAVEL_NOT_APPLICABLE'; continue; }
    const durMs = est.durationUpperMinutes * MINUTE_MS;
    // Outbound legs end at the anchor (arrival); return legs start at the anchor.
    const start = direction === 'outbound' ? anchorInstant - durMs : anchorInstant;
    const end = start + durMs;
    const winStart = localToInstant(settings.date, a.startAfter, timeZone);
    const winEnd = localToInstant(settings.date, a.startBefore, timeZone);
    if (start < winStart || start > winEnd) { lastReason = 'TRAVEL_NOT_APPLICABLE'; continue; }
    const ev = assessEvidenceIds(est.evidenceIds, 'travel', ctx);
    if (!ev.usable) { lastReason = ev.reason; continue; }
    candidates.push({
      estimate: est,
      leg: {
        estimateId: est.id,
        durationUpper: est.durationUpperMinutes,
        costUpper: est.costUpper,
        walkTotalUpper: est.walkTotalUpperMinutes,
        walkContinuousUpper: est.walkContinuousUpperMinutes,
        startInstant: start,
        endInstant: end,
        evidenceIds: est.evidenceIds,
        limitations: est.limitations,
      },
    });
  }
  if (candidates.length === 0) return { ok: false, reason: lastReason, evidenceIds: lastEvidence };
  // Several applicable observations for the same leg: use the most conservative.
  candidates.sort((x, y) => y.leg.durationUpper - x.leg.durationUpper || x.estimate.id.localeCompare(y.estimate.id));
  return { ok: true, ...candidates[0]! };
}

const travelIndexCache = new WeakMap<Dataset, Map<string, TravelEstimate[]>>();
/** Travel estimates grouped by origin|venue|mode|direction (cached per dataset object). */
function travelIndex(dataset: Dataset): Map<string, TravelEstimate[]> {
  let idx = travelIndexCache.get(dataset);
  if (!idx) {
    idx = new Map();
    for (const t of dataset.travelEstimates) {
      const k = `${t.originAreaId}|${t.venueId}|${t.mode}|${t.direction}`;
      idx.set(k, [...(idx.get(k) ?? []), t]);
    }
    travelIndexCache.set(dataset, idx);
  }
  return idx;
}

function assessMode(
  mode: TransportMode, prefs: ParticipantPreferences, venue: Venue, slot: Slot, settings: SharedSettings,
  dataset: Dataset, ctx: EvidenceContext, timeZone: string,
): Omit<ParticipantAssessment, 'participantId'> {
  const checks: CheckResult[] = [];
  const meet = localToInstant(settings.date, slot.meetingTime, timeZone);
  const visitEnd = meet + slot.durationMinutes * MINUTE_MS;
  const arrivalAnchor = meet - settings.arrivalBufferMinutes * MINUTE_MS;
  const returnAnchor = visitEnd + settings.departureBufferMinutes * MINUTE_MS;
  const dayStart = localToInstant(settings.date, '00:00', timeZone);

  const index = travelIndex(dataset);
  const forLeg = (direction: 'outbound' | 'return') => index.get(`${prefs.originAreaId}|${venue.id}|${mode}|${direction}`) ?? [];

  const out = chooseLeg(forLeg('outbound'), 'outbound', arrivalAnchor, settings, ctx, timeZone);
  const ret = chooseLeg(forLeg('return'), 'return', returnAnchor, settings, ctx, timeZone);
  checks.push(out.ok ? pass('TRAVEL_OUTBOUND', 'OK', out.leg.evidenceIds) : unknown('TRAVEL_OUTBOUND', out.reason, out.evidenceIds));
  checks.push(ret.ok ? pass('TRAVEL_RETURN', 'OK', ret.leg.evidenceIds) : unknown('TRAVEL_RETURN', ret.reason, ret.evidenceIds));
  const outLeg = out.ok ? out.leg : null;
  const retLeg = ret.ok ? ret.leg : null;

  // 2. Departure not before earliest departure (and not on a previous day).
  const earliest = localToInstant(settings.date, prefs.earliestDepartureLocal, timeZone);
  if (!outLeg) checks.push(unknown('DEPARTURE_TIME', 'OUTBOUND_UNKNOWN'));
  else if (outLeg.startInstant < dayStart || outLeg.startInstant < earliest) checks.push(fail('DEPARTURE_TIME', 'DEPARTS_TOO_EARLY', outLeg.evidenceIds, { departInstant: outLeg.startInstant }));
  else checks.push(pass('DEPARTURE_TIME', 'OK', outLeg.evidenceIds, { departInstant: outLeg.startInstant }));

  // 3. Home by latest return.
  const latest = localToInstant(settings.date, prefs.latestReturnLocal, timeZone);
  if (returnAnchor > latest) checks.push(fail('RETURN_TIME', 'VISIT_ENDS_TOO_LATE', [], { homeInstant: null }));
  else if (!retLeg) checks.push(unknown('RETURN_TIME', 'RETURN_UNKNOWN'));
  else if (retLeg.endInstant > latest) checks.push(fail('RETURN_TIME', 'HOME_TOO_LATE', retLeg.evidenceIds, { homeInstant: retLeg.endInstant }));
  else checks.push(pass('RETURN_TIME', 'OK', retLeg.evidenceIds, { homeInstant: retLeg.endInstant }));

  // 4. Both directions within the one-way cap.
  const cap = prefs.maxOneWayTravelMinutes;
  const legDurations = [outLeg?.durationUpper, retLeg?.durationUpper];
  if (legDurations.some((d) => d !== undefined && d > cap)) checks.push(fail('ONE_WAY_TRAVEL', 'TRAVEL_TOO_LONG', [], { outbound: outLeg?.durationUpper ?? null, return: retLeg?.durationUpper ?? null, cap }));
  else if (legDurations.some((d) => d === undefined)) checks.push(unknown('ONE_WAY_TRAVEL', 'LEG_UNKNOWN'));
  else checks.push(pass('ONE_WAY_TRAVEL', 'OK', [], { outbound: outLeg!.durationUpper, return: retLeg!.durationUpper, cap }));

  // 5 & 6. Walking: total and continuous are separate checks.
  const walk = assessFact(venue.visitWalkProfile, 'walkProfile', ctx);
  const venueWalk = walk.usable ? walk.value : null;
  if (prefs.maxTotalWalkMinutes !== undefined) {
    const capW = prefs.maxTotalWalkMinutes;
    const parts = [outLeg?.walkTotalUpper ?? null, venueWalk?.totalMinutesUpper ?? null, retLeg?.walkTotalUpper ?? null];
    const known = parts.filter((p): p is number => p !== null).reduce((a, b) => a + b, 0);
    if (known > capW) checks.push(fail('TOTAL_WALK', 'TOO_MUCH_WALKING', walk.evidenceIds, { total: known, cap: capW }));
    else if (parts.some((p) => p === null)) checks.push(unknown('TOTAL_WALK', walk.usable ? 'LEG_WALK_UNKNOWN' : walk.reason, walk.evidenceIds));
    else checks.push(pass('TOTAL_WALK', 'OK', walk.evidenceIds, { total: known, cap: capW }));
  }
  if (prefs.maxContinuousWalkMinutes !== undefined) {
    const capC = prefs.maxContinuousWalkMinutes;
    const o = outLeg?.walkContinuousUpper ?? null;
    const v = venueWalk?.continuousMinutesUpper ?? null;
    const r = retLeg?.walkContinuousUpper ?? null;
    const knownMax = Math.max(0, ...[o, v, r].filter((x): x is number => x !== null));
    if (knownMax > capC) checks.push(fail('CONTINUOUS_WALK', 'WALK_SEGMENT_TOO_LONG', walk.evidenceIds, { longest: knownMax, cap: capC }));
    else if (o === null || v === null || r === null) checks.push(unknown('CONTINUOUS_WALK', walk.usable ? 'LEG_WALK_UNKNOWN' : walk.reason, walk.evidenceIds));
    else if (venueWalk!.restAtMeetingPoint === true) checks.push(pass('CONTINUOUS_WALK', 'OK', walk.evidenceIds, { longest: knownMax, cap: capC }));
    else {
      // Without a documented rest at the meeting point, adjacent walking may be one continuous stretch.
      const chained = Math.max(o + v, v + r);
      if (chained <= capC) checks.push(pass('CONTINUOUS_WALK', 'OK', walk.evidenceIds, { longest: chained, cap: capC }));
      else checks.push(unknown('CONTINUOUS_WALK', 'REST_BREAK_UNVERIFIED', walk.evidenceIds, { longestIfNoRest: chained, cap: capC }));
    }
  }

  // 7. Budget: transport both ways + mandatory entry/activity + parking.
  const entry = assessFact(venue.entryCost, 'entryCost', ctx);
  const costParts: Array<number | null> = [outLeg?.costUpper ?? null, retLeg?.costUpper ?? null, entry.usable ? entry.value.upper : null];
  let costReason = entry.usable ? 'COST_COMPONENT_UNKNOWN' : `ENTRY_${entry.reason}`;
  if (mode === 'own_vehicle') {
    const ov = out.ok ? out.estimate.ownVehicle : undefined;
    const ovRet = ret.ok ? ret.estimate.ownVehicle : undefined;
    if (!ov || !ovRet) { costParts.push(null); costReason = 'OWN_VEHICLE_COST_ASSUMPTION_MISSING'; }
    else if (ov.parkingStatus === 'unknown' || (ov.parkingStatus === 'paid' && ov.parkingCost === null)) { costParts.push(null); costReason = 'PARKING_COST_UNKNOWN'; }
    else costParts.push(ov.parkingStatus === 'paid' ? ov.parkingCost : 0); // parking counted once per visit
  }
  const knownCost = costParts.filter((p): p is number => p !== null).reduce((a, b) => a + b, 0);
  const costEvidence = [...(outLeg?.evidenceIds ?? []), ...(retLeg?.evidenceIds ?? []), ...entry.evidenceIds];
  let costUpper: number | null = null;
  if (knownCost > prefs.maxTotalCost) checks.push(fail('BUDGET', 'OVER_BUDGET', costEvidence, { knownCostUpper: knownCost, budget: prefs.maxTotalCost }));
  else if (costParts.some((p) => p === null)) checks.push(unknown('BUDGET', costReason, costEvidence, { knownCostUpper: knownCost }));
  else { costUpper = knownCost; checks.push(pass('BUDGET', 'OK', costEvidence, { costUpper: knownCost, budget: prefs.maxTotalCost })); }

  // 8. Required facilities need current supporting evidence; absence is never false.
  for (const facility of prefs.requiredFacilities) {
    const f = assessFact(venue.facilities[facility], 'facility', ctx);
    const r: CheckResult = !f.usable ? unknown('FACILITY', f.reason, f.evidenceIds)
      : f.value ? pass('FACILITY', 'OK', f.evidenceIds) : fail('FACILITY', 'FACILITY_ABSENT', f.evidenceIds);
    r.facility = facility;
    checks.push(r);
  }

  // Strict quiet: only verified time-specific low-crowd evidence passes; never a fail.
  if (prefs.requireVerifiedLowCrowd) {
    const lc = assessFact(venue.lowCrowdVerified, 'lowCrowd', ctx);
    if (!lc.usable) checks.push(unknown('LOW_CROWD', lc.reason, lc.evidenceIds));
    else {
      const wd = weekdayOfLocalDate(settings.date);
      const s = hhmmToMinutes(slot.meetingTime);
      const e = s + slot.durationMinutes;
      const covered = lc.value.windows.some((w) => w.days.includes(wd) && s >= hhmmToMinutes(w.from) && e <= hhmmToMinutes(w.to));
      checks.push(covered ? pass('LOW_CROWD', 'OK', lc.evidenceIds) : unknown('LOW_CROWD', 'NO_EVIDENCE_FOR_THIS_TIME', lc.evidenceIds));
    }
  }

  const status = worst(checks.map((c) => c.status));
  let burden: number | null = null;
  let totalTravel: number | null = null;
  if (status === 'pass' && outLeg && retLeg && costUpper !== null) {
    const loads = [
      relativeLoad(Math.max(outLeg.durationUpper, retLeg.durationUpper), prefs.maxOneWayTravelMinutes),
      relativeLoad(costUpper, prefs.maxTotalCost),
    ];
    if (prefs.maxTotalWalkMinutes !== undefined && venueWalk && outLeg.walkTotalUpper !== null && retLeg.walkTotalUpper !== null) {
      loads.push(relativeLoad(outLeg.walkTotalUpper + venueWalk.totalMinutesUpper + retLeg.walkTotalUpper, prefs.maxTotalWalkMinutes));
    }
    burden = Math.max(...loads);
    totalTravel = outLeg.durationUpper + retLeg.durationUpper;
  }
  return { status, mode, checks, outbound: outLeg, return: retLeg, costUpper, burden, totalTravelMinutes: totalTravel };
}

/**
 * Mode choice rule (documented): prefer a fully passing mode with the lowest
 * relative burden, then shortest total travel, then the fixed order
 * walk → public transport → own vehicle. If none pass, report the mode with
 * the fewest unknown checks (status unknown); if all fail, report a failing mode.
 */
export function assessParticipant(
  input: ParticipantInput, venue: Venue, slot: Slot, settings: SharedSettings,
  dataset: Dataset, ctx: EvidenceContext, timeZone: string,
): ParticipantAssessment {
  const modes = TRANSPORT_MODES.filter((m) => input.preferences.allowedModes.includes(m));
  const results = modes.map((m) => assessMode(m, input.preferences, venue, slot, settings, dataset, ctx, timeZone));
  const order = (m: TransportMode | null) => (m ? TRANSPORT_MODES.indexOf(m) : 99);
  const passing = results.filter((r) => r.status === 'pass')
    .sort((a, b) => a.burden! - b.burden! || a.totalTravelMinutes! - b.totalTravelMinutes! || order(a.mode) - order(b.mode));
  if (passing.length > 0) return { participantId: input.participantId, ...passing[0]! };
  const unknowns = results.filter((r) => r.status === 'unknown')
    .sort((a, b) => a.checks.filter((c) => c.status === 'unknown').length - b.checks.filter((c) => c.status === 'unknown').length || order(a.mode) - order(b.mode));
  if (unknowns.length > 0) return { participantId: input.participantId, ...unknowns[0]! };
  const failing = results[0];
  if (!failing) {
    return { participantId: input.participantId, status: 'fail', mode: null, checks: [fail('TRAVEL_OUTBOUND', 'NO_ALLOWED_MODE')], outbound: null, return: null, costUpper: null, burden: null, totalTravelMinutes: null };
  }
  return { participantId: input.participantId, ...failing };
}

/** Group soft-preference satisfaction in [0, 1]. */
export function softScore(venue: Venue, participants: ParticipantInput[]): number {
  let got = 0;
  let max = 0;
  for (const p of participants) {
    for (const pref of SOFT_PREFERENCES) {
      const w = p.preferences.softPreferences[pref];
      max += w;
      if (venue.preferenceTags.includes(pref)) got += w;
    }
  }
  return max === 0 ? 0 : got / max;
}

/** Tags of this venue that the group, in aggregate, asked for (no per-person attribution). */
export function sharedPreferenceTags(venue: Venue, participants: ParticipantInput[]): SoftPreference[] {
  const totals = SOFT_PREFERENCES.map((pref) => ({ pref, w: participants.reduce((a, p) => a + p.preferences.softPreferences[pref], 0) }));
  return totals.filter((t) => t.w > 0 && venue.preferenceTags.includes(t.pref)).sort((a, b) => b.w - a.w || a.pref.localeCompare(b.pref)).map((t) => t.pref);
}

export function evaluateSlot(
  slot: Slot, settings: SharedSettings, participants: ParticipantInput[], dataset: Dataset, ctx: EvidenceContext, timeZone: string,
): CandidateEvaluation {
  const venue = dataset.venues.find((v) => v.id === slot.venueId);
  if (!venue) {
    return { key: slotKey(slot), slot, status: 'unknown', venueChecks: [unknown('VENUE_OPEN', 'UNKNOWN_VENUE')], participants: [], burden: null, softScore: 0, totalTravelMinutes: null, unknownCount: 1 };
  }
  const vChecks = venueChecks(venue, settings, slot, ctx);
  const pAssess = participants.map((p) => assessParticipant(p, venue, slot, settings, dataset, ctx, timeZone));
  const status = participants.length === 0 ? 'unknown' : worst([...vChecks.map((c) => c.status), ...pAssess.map((p) => p.status)]);
  const burden = status === 'pass' ? Math.max(...pAssess.map((p) => p.burden!)) : null;
  const totalTravel = status === 'pass' ? pAssess.reduce((a, p) => a + p.totalTravelMinutes!, 0) : null;
  const unknownCount = vChecks.filter((c) => c.status === 'unknown').length
    + pAssess.reduce((a, p) => a + p.checks.filter((c) => c.status === 'unknown').length, 0);
  return { key: slotKey(slot), slot, status, venueChecks: vChecks, participants: pAssess, burden, softScore: softScore(venue, participants), totalTravelMinutes: totalTravel, unknownCount };
}

export function meetingTimesFor(settings: SharedSettings): string[] {
  const out: string[] = [];
  for (let m = hhmmToMinutes(settings.windowStart); m <= hhmmToMinutes(settings.windowEnd); m += settings.timeGridMinutes) out.push(minutesToHHmm(m));
  return out;
}

export function enumerateSlots(settings: SharedSettings, dataset: Dataset, opts: Pick<MatchOptions, 'venueIds' | 'meetingTimes' | 'durations'> = {}): Slot[] {
  const venues = dataset.venues
    .filter((v) => v.areaId === settings.coveredAreaId)
    .filter((v) => !opts.venueIds || opts.venueIds.includes(v.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const times = opts.meetingTimes ?? meetingTimesFor(settings);
  const durations = opts.durations ?? settings.durationOptions;
  const slots: Slot[] = [];
  for (const v of venues) for (const t of times) for (const d of [...durations].sort((a, b) => a - b)) {
    // Keep the visit inside the same day.
    if (hhmmToMinutes(t) + d < 24 * 60) slots.push({ venueId: v.id, meetingTime: t, durationMinutes: d });
  }
  return slots;
}

/** Ranking for fully passing candidates: minimax burden, then soft score, then total travel, then stable key. */
export function compareFitting(a: CandidateEvaluation, b: CandidateEvaluation): number {
  return (a.burden! - b.burden!) || (b.softScore - a.softScore) || (a.totalTravelMinutes! - b.totalTravelMinutes!) || a.key.localeCompare(b.key);
}

const compareNeedsVerification = (a: CandidateEvaluation, b: CandidateEvaluation) =>
  (a.unknownCount - b.unknownCount) || (b.softScore - a.softScore) || a.key.localeCompare(b.key);

/** Up to `n` options, preferring different venues before repeating a venue at another time. */
export function pickDiverse(sorted: CandidateEvaluation[], n: number): CandidateEvaluation[] {
  const picked: CandidateEvaluation[] = [];
  const venues = new Set<string>();
  for (const c of sorted) {
    if (picked.length >= n) break;
    if (!venues.has(c.slot.venueId)) { picked.push(c); venues.add(c.slot.venueId); }
  }
  for (const c of sorted) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

export interface MatchResult {
  evaluated: number;
  counts: Record<CheckStatus, number>;
  fitting: CandidateEvaluation[];
  needsVerification: CandidateEvaluation[];
  /** All evaluations, for the explorer and private views. */
  all: CandidateEvaluation[];
}

export function match(settings: SharedSettings, participants: ParticipantInput[], dataset: Dataset, opts: MatchOptions): MatchResult {
  const ctx = buildEvidenceContext(dataset, localToInstant(settings.date, '00:00', opts.timeZone), opts.now);
  const slots = enumerateSlots(settings, dataset, opts);
  const all = slots.map((s) => evaluateSlot(s, settings, participants, dataset, ctx, opts.timeZone));
  const counts = { pass: 0, fail: 0, unknown: 0 } as Record<CheckStatus, number>;
  for (const c of all) counts[c.status] += 1;
  const fitting = pickDiverse(all.filter((c) => c.status === 'pass').sort(compareFitting), 3);
  const needsVerification = pickDiverse(all.filter((c) => c.status === 'unknown').sort(compareNeedsVerification), 3);
  return { evaluated: all.length, counts, fitting, needsVerification, all };
}

export { FACILITIES };
