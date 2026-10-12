/**
 * Public and private projections of match results. Shared projections carry
 * venue/time/evidence facts and a generic fit status only. Anything derived
 * from a participant's private requirements stays in the private projection.
 */
import { assessFact, buildEvidenceContext, type EvidenceContext, type FactReason } from './evidence.ts';
import type { CandidateEvaluation, CheckResult, CheckStatus, ParticipantAssessment } from './matching.ts';
import { sharedPreferenceTags, type ParticipantInput } from './matching.ts';
import type { Dataset, Evidence, Facility, SharedSettings, Venue } from './schemas.ts';
import { FACILITIES } from './schemas.ts';
import { hhmmToMinutes, instantToLocalTime, localToInstant, minutesToHHmm } from './time.ts';

export const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Fits the submitted limits',
  unknown: 'Needs verification',
  fail: 'Does not fit',
};

export const GENERIC_PRIVATE_FAIL = 'This option does not fit all submitted requirements.';
export const GENERIC_PRIVATE_UNKNOWN = 'Some private requirements could not be checked with the available data.';

const FACT_REASON_TEXT: Record<FactReason, string> = {
  FACT_UNKNOWN: 'not yet checked',
  NO_EVIDENCE: 'no source recorded',
  MALFORMED_EVIDENCE: 'source record is malformed',
  CONFLICTING_EVIDENCE: 'sources disagree',
  UNREVIEWED_EVIDENCE: 'not yet reviewed by a person',
  INSUFFICIENT_CONFIDENCE: 'only estimated, not confirmed',
  STALE_EVIDENCE: 'last checked too long ago',
  FUTURE_DATED_EVIDENCE: 'source record has an invalid date',
  SYNTHETIC_IN_LIVE_DATA: 'synthetic source in live data',
};
export const factReasonText = (r: string) => FACT_REASON_TEXT[r as FactReason] ?? 'needs verification';

const FACILITY_LABEL: Record<Facility, string> = { seating: 'Seating', step_free_access: 'Step-free access', toilet: 'Toilet' };

export interface PublicSource { id: string; url?: string; kind: Evidence['sourceKind']; checkedAt: string; confidence: Evidence['confidence']; excerpt?: string }
export interface PublicFact { label: string; status: 'known' | 'unknown'; text: string; evidenceIds: string[] }

export interface PublicCandidate {
  key: string;
  status: CheckStatus;
  statusLabel: string;
  venue: { id: string; name: string; meetingPoint: string; mapUrl?: string };
  date: string;
  meetingTime: string;
  endTime: string;
  durationMinutes: number;
  venueNotes: string[];
  groupNote: string | null;
  sharedPreferences: string[];
  facts: PublicFact[];
  excludedOptionalCosts: string[];
  assumptions: string[];
  sources: PublicSource[];
}

function venueNote(c: CheckResult): string | null {
  if (c.status === 'pass') return null;
  if (c.code === 'VENUE_OUTDOOR') return c.status === 'fail' ? 'Not an outdoor venue.' : `Outdoor status needs verification (${factReasonText(c.reason)}).`;
  if (c.code === 'VENUE_OPEN') {
    if (c.reason === 'CLOSED_ON_DATE') return 'Closed on this date.';
    if (c.reason === 'CLOSED_ON_WEEKDAY') return 'Closed on this day of the week.';
    if (c.reason === 'OUTSIDE_OPENING_HOURS') return 'The visit falls outside opening hours.';
    if (c.reason === 'CONFLICTING_DATE_EXCEPTION') return 'Sources disagree about opening on this date.';
    if (c.reason === 'INCOMPLETE_DATE_EXCEPTION') return 'Special hours on this date are incomplete.';
    if (c.reason === 'UNKNOWN_VENUE') return 'Venue record not found.';
    return `Opening hours need verification (${factReasonText(c.reason)}).`;
  }
  return null;
}

export function formatMoney(amount: number, currency: string): string {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount); } catch { return `${amount} ${currency}`; }
}

export function publicVenueFacts(venue: Venue, ctx: EvidenceContext, currency = 'EUR'): PublicFact[] {
  const facts: PublicFact[] = [];
  const entry = assessFact(venue.entryCost, 'entryCost', ctx);
  facts.push(entry.usable
    ? { label: 'Entry / activity cost', status: 'known', text: entry.value.upper === 0 ? 'Free' : `Up to ${formatMoney(entry.value.upper, currency)} per person${entry.value.note ? ` — ${entry.value.note}` : ''}`, evidenceIds: entry.evidenceIds }
    : { label: 'Entry / activity cost', status: 'unknown', text: `Needs verification (${factReasonText(entry.reason)})`, evidenceIds: entry.evidenceIds });
  const walk = assessFact(venue.visitWalkProfile, 'walkProfile', ctx);
  facts.push(walk.usable
    ? { label: 'Walking at the venue', status: 'known', text: `Up to ${walk.value.totalMinutesUpper} min in total; longest stretch up to ${walk.value.continuousMinutesUpper} min${walk.value.restAtMeetingPoint ? '; rest spot at meeting point' : ''}`, evidenceIds: walk.evidenceIds }
    : { label: 'Walking at the venue', status: 'unknown', text: `Needs verification (${factReasonText(walk.reason)})`, evidenceIds: walk.evidenceIds });
  for (const f of FACILITIES) {
    const a = assessFact(venue.facilities[f], 'facility', ctx);
    facts.push(a.usable
      ? { label: FACILITY_LABEL[f], status: 'known', text: a.value ? 'Available' : 'Not available', evidenceIds: a.evidenceIds }
      : { label: FACILITY_LABEL[f], status: 'unknown', text: `Unknown (${factReasonText(a.reason)})`, evidenceIds: a.evidenceIds });
  }
  return facts;
}

export function publicSources(ids: Iterable<string>, dataset: Dataset): PublicSource[] {
  const byId = new Map(dataset.evidence.map((e) => [e.id, e]));
  const out: PublicSource[] = [];
  for (const id of new Set(ids)) {
    const e = byId.get(id);
    if (e) out.push({ id: e.id, url: e.sourceUrl, kind: e.sourceKind, checkedAt: e.checkedAt, confidence: e.confidence, excerpt: e.excerpt });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function toPublicCandidate(c: CandidateEvaluation, settings: SharedSettings, participants: ParticipantInput[], dataset: Dataset, now: number, timeZone: string): PublicCandidate {
  const venue = dataset.venues.find((v) => v.id === c.slot.venueId);
  const ctx = buildEvidenceContext(dataset, localToInstant(settings.date, '00:00', timeZone), now);
  const statuses = c.participants.map((p) => p.status);
  const groupNote = statuses.includes('fail') ? GENERIC_PRIVATE_FAIL : statuses.includes('unknown') ? GENERIC_PRIVATE_UNKNOWN : null;
  const facts = venue ? publicVenueFacts(venue, ctx, settings.currency) : [];
  const evidenceIds = [...c.venueChecks.flatMap((v) => v.evidenceIds), ...facts.flatMap((f) => f.evidenceIds)];
  return {
    key: c.key,
    status: c.status,
    statusLabel: STATUS_LABEL[c.status],
    venue: { id: c.slot.venueId, name: venue?.name ?? 'Unknown venue', meetingPoint: venue?.meetingPointDescription ?? '', mapUrl: venue?.mapUrl },
    date: settings.date,
    meetingTime: c.slot.meetingTime,
    endTime: minutesToHHmm(hhmmToMinutes(c.slot.meetingTime) + c.slot.durationMinutes),
    durationMinutes: c.slot.durationMinutes,
    venueNotes: c.venueChecks.map(venueNote).filter((x): x is string => x !== null),
    groupNote,
    sharedPreferences: venue ? sharedPreferenceTags(venue, participants) : [],
    facts,
    excludedOptionalCosts: venue?.excludedOptionalCosts ?? [],
    assumptions: venue?.assumptions ?? [],
    sources: publicSources(evidenceIds, dataset),
  };
}

/* ------------------------------------------------------------------ */
/* Private, owner-only view                                            */
/* ------------------------------------------------------------------ */

const CHECK_LABEL: Record<CheckResult['code'], string> = {
  VENUE_OUTDOOR: 'Outdoor venue',
  VENUE_OPEN: 'Open during the visit',
  TRAVEL_OUTBOUND: 'Covered route there',
  TRAVEL_RETURN: 'Covered route back',
  DEPARTURE_TIME: 'Leave no earlier than your earliest departure',
  RETURN_TIME: 'Home by your latest return',
  ONE_WAY_TRAVEL: 'Each direction within your travel limit',
  TOTAL_WALK: 'Total walking within your limit',
  CONTINUOUS_WALK: 'Longest continuous walk within your limit',
  BUDGET: 'Total cost within your budget',
  FACILITY: 'Required facility',
  LOW_CROWD: 'Verified low-crowd conditions',
};

const PRIVATE_REASON_TEXT: Record<string, string> = {
  NO_COVERED_ROUTE: 'No checked travel estimate covers this route yet. Straight-line distance is not used as a substitute.',
  TRAVEL_NOT_APPLICABLE: 'The checked travel estimate does not apply to this day or time.',
  TRAVEL_DURATION_UNKNOWN: 'The travel duration for this route is unknown.',
  OUTBOUND_UNKNOWN: 'Depends on the outbound route, which is not covered.',
  RETURN_UNKNOWN: 'Depends on the return route, which is not covered.',
  LEG_UNKNOWN: 'At least one direction of travel is not covered.',
  DEPARTS_TOO_EARLY: 'You would need to leave before your earliest departure.',
  VISIT_ENDS_TOO_LATE: 'The visit itself ends after your latest return.',
  HOME_TOO_LATE: 'You would get home after your latest return.',
  TRAVEL_TOO_LONG: 'At least one direction exceeds your one-way travel limit.',
  TOO_MUCH_WALKING: 'Total walking exceeds your limit.',
  LEG_WALK_UNKNOWN: 'Walking time for part of the journey is unknown.',
  WALK_SEGMENT_TOO_LONG: 'One walking stretch is longer than your limit.',
  REST_BREAK_UNVERIFIED: 'Walking stretches may join up; a rest stop at the meeting point is not verified.',
  OVER_BUDGET: 'Known costs already exceed your budget.',
  COST_COMPONENT_UNKNOWN: 'Part of the cost is unknown.',
  OWN_VEHICLE_COST_ASSUMPTION_MISSING: 'No per-person cost assumption is recorded for driving this route.',
  PARKING_COST_UNKNOWN: 'Parking cost is unknown.',
  FACILITY_ABSENT: 'A checked source says this facility is not available.',
  NO_EVIDENCE_FOR_THIS_TIME: 'Low-crowd evidence does not cover this day and time.',
  NO_ALLOWED_MODE: 'No transport mode selected.',
};

export function privateReasonText(c: CheckResult): string {
  if (c.status === 'pass') return 'OK';
  if (PRIVATE_REASON_TEXT[c.reason]) return PRIVATE_REASON_TEXT[c.reason]!;
  if (c.reason.startsWith('ENTRY_')) return `The venue entry cost is ${factReasonText(c.reason.slice(6))}.`;
  return `Needs verification: ${factReasonText(c.reason)}.`;
}

export interface PrivateJourneyView {
  status: CheckStatus;
  statusLabel: string;
  mode: string | null;
  leaveBy: string | null;
  homeBy: string | null;
  outboundMinutesUpper: number | null;
  returnMinutesUpper: number | null;
  costUpper: number | null;
  checks: Array<{ label: string; status: CheckStatus; text: string }>;
  limitations: string[];
  sources: PublicSource[];
}

export function toPrivateView(p: ParticipantAssessment, dataset: Dataset, timeZone: string): PrivateJourneyView {
  return {
    status: p.status,
    statusLabel: STATUS_LABEL[p.status],
    mode: p.mode,
    leaveBy: p.outbound ? instantToLocalTime(p.outbound.startInstant, timeZone) : null,
    homeBy: p.return ? instantToLocalTime(p.return.endInstant, timeZone) : null,
    outboundMinutesUpper: p.outbound?.durationUpper ?? null,
    returnMinutesUpper: p.return?.durationUpper ?? null,
    costUpper: p.costUpper,
    checks: p.checks.map((c) => ({
      label: c.facility ? `${CHECK_LABEL[c.code]}: ${FACILITY_LABEL[c.facility]}` : CHECK_LABEL[c.code],
      status: c.status,
      text: privateReasonText(c),
    })),
    limitations: [p.outbound?.limitations, p.return?.limitations].filter((x): x is string => !!x),
    sources: publicSources([...(p.outbound?.evidenceIds ?? []), ...(p.return?.evidenceIds ?? [])], dataset),
  };
}
