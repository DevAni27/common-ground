import { describe, expect, it } from 'vitest';
import { syntheticDataset } from './fixtures/synthetic-dataset.ts';
import {
  compareFitting, evaluateSlot, match, pickDiverse, relativeLoad, type CandidateEvaluation, type ParticipantInput,
} from '../src/domain/matching.ts';
import { buildEvidenceContext } from '../src/domain/evidence.ts';
import { ParticipantPreferences, SharedSettings, type Dataset } from '../src/domain/schemas.ts';
import { localToInstant } from '../src/domain/time.ts';
import { toPublicCandidate } from '../src/domain/projection.ts';

const TZ = 'Asia/Kolkata';
const CHECKED = '2026-10-01T10:00:00+05:30';
const NOW = Date.parse('2026-10-09T12:00:00+05:30');
const SUNDAY = '2026-10-18';

const settings = (over: Partial<SharedSettings> = {}): SharedSettings => SharedSettings.parse({
  title: 'Test outing', coveredAreaId: 'fx-zone', date: SUNDAY, windowStart: '09:00', windowEnd: '11:00',
  durationOptions: [60], expectedCount: 3, ...over,
});

const prefs = (over: Partial<ParticipantPreferences> = {}): ParticipantPreferences => ParticipantPreferences.parse({
  originAreaId: 'fx-north', earliestDepartureLocal: '07:00', latestReturnLocal: '18:00', allowedModes: ['public_transport'],
  maxOneWayTravelMinutes: 60, maxTotalCost: 500, requiredFacilities: [],
  softPreferences: { greenery: 0, quiet: 0, photography: 0, conversation: 0, exploring: 0 }, ...over,
});

const person = (id: string, over: Partial<ParticipantPreferences> = {}): ParticipantInput => ({ participantId: id, preferences: prefs(over) });

function evalOne(ds: Dataset, s: SharedSettings, venueId: string, meetingTime: string, durationMinutes: number, people: ParticipantInput[]) {
  const ctx = buildEvidenceContext(ds, localToInstant(s.date, '00:00', TZ), NOW);
  return evaluateSlot({ venueId, meetingTime, durationMinutes }, s, people, ds, ctx, TZ);
}

const ds = syntheticDataset(CHECKED);
const check = (c: CandidateEvaluation, code: string, i = 0) => c.participants[i]!.checks.find((x) => x.code === code);

describe('time handling', () => {
  it('converts Asia/Kolkata wall time to an instant', () => {
    expect(new Date(localToInstant(SUNDAY, '09:00', TZ)).toISOString()).toBe('2026-10-18T03:30:00.000Z');
  });
  it('rejects overnight or reversed participant windows', () => {
    expect(ParticipantPreferences.safeParse({ ...prefs(), earliestDepartureLocal: '20:00', latestReturnLocal: '06:00' }).success).toBe(false);
    expect(ParticipantPreferences.safeParse({ ...prefs(), latestReturnLocal: '23:30' }).success).toBe(false);
    expect(ParticipantPreferences.safeParse({ ...prefs(), allowedModes: [] }).success).toBe(false);
    expect(ParticipantPreferences.safeParse({ ...prefs(), maxTotalCost: -1 }).success).toBe(false);
  });
});

describe('hard requirements', () => {
  it('fails when mandatory costs exceed one budget, regardless of preference score', () => {
    const people = [person('a', { maxTotalCost: 90, softPreferences: { greenery: 3, quiet: 3, photography: 3, conversation: 3, exploring: 3 } })];
    const c = evalOne(ds, settings(), 'fx-botanic-garden', '10:00', 60, people);
    // 30 + 30 transport + 40 entry = 100 > 90
    expect(check(c, 'BUDGET')!.status).toBe('fail');
    expect(c.status).toBe('fail');
    expect(c.softScore).toBeGreaterThan(0.5);
  });

  it('fails when the return trip gets someone home late, considering return separately from outbound', () => {
    // fx-east → riverside: outbound 25, return 40. Visit 10:00–11:00, +10 buffer, +40 = 11:50.
    const late = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { originAreaId: 'fx-east', latestReturnLocal: '11:45' })]);
    expect(check(late, 'RETURN_TIME')!.status).toBe('fail');
    expect(check(late, 'DEPARTURE_TIME')!.status).toBe('pass');
    const ok = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { originAreaId: 'fx-east', latestReturnLocal: '11:50' })]);
    expect(check(ok, 'RETURN_TIME')!.status).toBe('pass');
    expect(ok.participants[0]!.outbound!.durationUpper).toBe(25);
    expect(ok.participants[0]!.return!.durationUpper).toBe(40);
  });

  it('fails when departure would be before earliest departure', () => {
    // meet 09:00 − 10 buffer − 25 = 08:25
    const c = evalOne(ds, settings(), 'fx-riverside-walk', '09:00', 60, [person('a', { earliestDepartureLocal: '08:30' })]);
    expect(check(c, 'DEPARTURE_TIME')!.status).toBe('fail');
  });

  it('treats unknown required step-free access as needs verification, never fits', () => {
    const c = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { requiredFacilities: ['step_free_access'] })]);
    expect(c.status).toBe('unknown');
    const ok = evalOne(ds, settings(), 'fx-botanic-garden', '10:00', 60, [person('a', { requiredFacilities: ['step_free_access'] })]);
    expect(ok.status).toBe('pass');
  });

  it('fails a facility a checked source says is absent', () => {
    const c = evalOne(ds, settings(), 'fx-hill-trail', '10:00', 60, [person('a', { requiredFacilities: ['seating'] })]);
    expect(c.participants[0]!.checks.find((x) => x.code === 'FACILITY')!.status).toBe('fail');
  });
});

describe('venue facts and evidence', () => {
  it('fails on a closed weekday, a closed date exception, and outside opening hours', () => {
    const monday = evalOne(ds, settings({ date: '2026-10-19' }), 'fx-botanic-garden', '10:00', 60, [person('a')]);
    expect(monday.venueChecks.find((c) => c.code === 'VENUE_OPEN')).toMatchObject({ status: 'fail', reason: 'CLOSED_ON_WEEKDAY' });
    const holiday = evalOne(ds, settings({ date: '2026-10-20' }), 'fx-botanic-garden', '10:00', 60, [person('a')]);
    expect(holiday.venueChecks.find((c) => c.code === 'VENUE_OPEN')).toMatchObject({ status: 'fail', reason: 'CLOSED_ON_DATE' });
    const early = evalOne(ds, settings(), 'fx-botanic-garden', '08:30', 60, [person('a')]);
    expect(early.venueChecks.find((c) => c.code === 'VENUE_OPEN')).toMatchObject({ status: 'fail', reason: 'OUTSIDE_OPENING_HOURS' });
    const runsLate = evalOne(ds, settings(), 'fx-botanic-garden', '17:00', 60, [person('a')]);
    expect(runsLate.venueChecks.find((c) => c.code === 'VENUE_OPEN')!.status).toBe('fail');
  });

  it('keeps conflicting hours visible as unknown', () => {
    const c = evalOne(ds, settings(), 'fx-lake-promenade', '10:00', 60, [person('a')]);
    expect(c.venueChecks.find((x) => x.code === 'VENUE_OPEN')).toMatchObject({ status: 'unknown', reason: 'CONFLICTING_EVIDENCE' });
    expect(c.status).toBe('unknown');
  });

  it('turns stale facts into unknown', () => {
    const c = evalOne(ds, settings(), 'fx-heritage-lane', '10:00', 60, [person('a')]);
    expect(c.venueChecks.find((x) => x.code === 'VENUE_OPEN')).toMatchObject({ status: 'unknown', reason: 'STALE_EVIDENCE' });
  });

  it('never passes on unreviewed, missing, or synthetic-in-live evidence', () => {
    const unreviewed: Dataset = { ...ds, evidence: ds.evidence.map((e) => (e.id === 'fx-ev-riverside' ? { ...e, reviewStatus: 'proposed' as const } : e)) };
    expect(evalOne(unreviewed, settings(), 'fx-riverside-walk', '10:00', 60, [person('a')]).status).toBe('unknown');
    const missing: Dataset = { ...ds, evidence: ds.evidence.filter((e) => e.id !== 'fx-ev-riverside') };
    expect(evalOne(missing, settings(), 'fx-riverside-walk', '10:00', 60, [person('a')]).status).toBe('unknown');
    const live: Dataset = { ...ds, kind: 'researched' };
    expect(evalOne(live, settings(), 'fx-riverside-walk', '10:00', 60, [person('a')]).status).toBe('unknown');
  });

  it('treats a time-inapplicable travel estimate as unknown', () => {
    const expired: Dataset = { ...ds, travelEstimates: ds.travelEstimates.map((t) => ({ ...t, applicability: { ...t.applicability, validUntil: '2026-10-01' } })) };
    const c = evalOne(expired, settings(), 'fx-riverside-walk', '10:00', 60, [person('a')]);
    expect(check(c, 'TRAVEL_OUTBOUND')).toMatchObject({ status: 'unknown', reason: 'TRAVEL_NOT_APPLICABLE' });
    expect(c.status).toBe('unknown');
  });

  it('returns unknown with no covered route, not a straight-line shortcut', () => {
    const c = evalOne(ds, settings(), 'fx-hill-trail', '10:00', 60, [person('a', { originAreaId: 'fx-south' })]);
    expect(check(c, 'TRAVEL_OUTBOUND')).toMatchObject({ status: 'unknown', reason: 'NO_COVERED_ROUTE' });
    expect(c.status).toBe('unknown');
  });

  it('requires an explicit own-vehicle cost assumption', () => {
    const withCar: Dataset = { ...ds, travelEstimates: [...ds.travelEstimates, ...(['outbound', 'return'] as const).map((direction) => ({
      id: `fx-car-${direction}`, originAreaId: 'fx-north', venueId: 'fx-riverside-walk', mode: 'own_vehicle' as const, direction,
      applicability: { startAfter: '05:00', startBefore: '21:00' }, durationUpperMinutes: 15, costUpper: 30,
      walkTotalUpperMinutes: 3, walkContinuousUpperMinutes: 3, evidenceIds: ['fx-ev-travel'], limitations: 'synthetic',
    }))] };
    const c = evalOne(withCar, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { allowedModes: ['own_vehicle'] })]);
    expect(check(c, 'BUDGET')).toMatchObject({ status: 'unknown', reason: 'OWN_VEHICLE_COST_ASSUMPTION_MISSING' });
  });
});

describe('walking', () => {
  it('checks total and continuous walking separately', () => {
    const people = [person('a', { allowedModes: ['walk'], maxTotalWalkMinutes: 200, maxContinuousWalkMinutes: 20 })];
    const c = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, people);
    expect(check(c, 'TOTAL_WALK')!.status).toBe('pass');
    expect(check(c, 'CONTINUOUS_WALK')!.status).toBe('fail');
    const totalOnly = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { allowedModes: ['walk'], maxTotalWalkMinutes: 90 })]);
    expect(check(totalOnly, 'TOTAL_WALK')!.status).toBe('fail'); // 35 + 30 + 35 = 100
  });

  it('does not pass adjacent walking stretches without a verified rest', () => {
    // Heritage: venue continuous 25, no rest at meeting point; transport legs add 5 continuous each side.
    const c = evalOne(ds, settings(), 'fx-heritage-lane', '10:00', 60, [person('a', { maxContinuousWalkMinutes: 28 })]);
    expect(check(c, 'CONTINUOUS_WALK')).toMatchObject({ status: 'unknown', reason: 'REST_BREAK_UNVERIFIED' });
  });
});

describe('zero caps and ranking', () => {
  it('handles zero budgets and zero travel caps without division by zero', () => {
    expect(relativeLoad(0, 0)).toBe(0);
    const walkFree = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { allowedModes: ['walk'], maxTotalCost: 0 })]);
    expect(walkFree.status).toBe('pass');
    expect(Number.isFinite(walkFree.burden!)).toBe(true);
    const paid = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { maxTotalCost: 0 })]);
    expect(check(paid, 'BUDGET')!.status).toBe('fail');
    const noTravel = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, [person('a', { maxOneWayTravelMinutes: 0 })]);
    expect(check(noTravel, 'ONE_WAY_TRAVEL')!.status).toBe('fail');
    expect(noTravel.burden).toBeNull();
  });

  it('ranks by lowest maximum burden, then soft score, then travel, then stable key', () => {
    const mk = (key: string, burden: number, softScore: number, totalTravelMinutes: number, venueId = key): CandidateEvaluation => ({
      key, slot: { venueId, meetingTime: '10:00', durationMinutes: 60 }, status: 'pass', venueChecks: [], participants: [],
      burden, softScore, totalTravelMinutes, unknownCount: 0,
    });
    const sorted = [mk('d', 0.5, 0.9, 10), mk('c', 0.4, 0.1, 99), mk('b', 0.4, 0.5, 50), mk('a', 0.4, 0.5, 50), mk('e', 0.4, 0.5, 40)].sort(compareFitting);
    expect(sorted.map((x) => x.key)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('respects the person with the largest relative burden in a real match', () => {
    // fx-east → hill trail costs 45 each way: heavy for a ₹100 budget. Riverside costs 25 each way.
    const people = [person('a', { originAreaId: 'fx-east', maxTotalCost: 100, maxOneWayTravelMinutes: 70 }), person('b', { softPreferences: { greenery: 3, quiet: 0, photography: 0, conversation: 0, exploring: 3 } })];
    const r = match(settings({ windowStart: '10:00', windowEnd: '10:00' }), people, ds, { timeZone: TZ, now: NOW });
    expect(r.fitting.map((c) => c.slot.venueId)).toEqual(['fx-riverside-walk', 'fx-hill-trail']);
    expect(r.fitting[1]!.softScore).toBeGreaterThan(r.fitting[0]!.softScore);
  });

  it('prefers different venues before repeating a venue at another time', () => {
    const mk = (venueId: string, t: string): CandidateEvaluation => ({ key: `${venueId}${t}`, slot: { venueId, meetingTime: t, durationMinutes: 60 }, status: 'pass', venueChecks: [], participants: [], burden: 0, softScore: 0, totalTravelMinutes: 0, unknownCount: 0 });
    const picked = pickDiverse([mk('x', '1'), mk('x', '2'), mk('x', '3'), mk('y', '1')], 3);
    expect(picked.map((p) => p.slot.venueId)).toEqual(['x', 'y', 'x']);
  });

  it('returns an honest empty result when nothing fits', () => {
    const r = match(settings(), [person('a', { latestReturnLocal: '09:30' })], ds, { timeZone: TZ, now: NOW });
    expect(r.fitting).toEqual([]);
    expect(r.evaluated).toBeGreaterThan(0);
    expect(r.counts.pass).toBe(0);
  });
});

describe('public projection', () => {
  it('contains no private numbers or participant identifiers', () => {
    const people = [person('secret-participant-id', { maxTotalCost: 1234, originAreaId: 'fx-east', latestReturnLocal: '11:45' })];
    const c = evalOne(ds, settings(), 'fx-riverside-walk', '10:00', 60, people);
    const pub = toPublicCandidate(c, settings(), people, ds, NOW, TZ);
    const json = JSON.stringify(pub);
    expect(json).not.toContain('secret-participant-id');
    expect(json).not.toContain('1234');
    expect(json).not.toContain('fx-east');
    expect(json).not.toContain('11:45');
    expect(pub.groupNote).toBe('This option does not fit all submitted requirements.');
  });
});

import { explore, patchFor } from '../src/domain/explore.ts';

describe('change explorer', () => {
  it('suggests the nearest passing options outside the current settings when nothing fits', () => {
    const s = settings({ windowStart: '10:00', windowEnd: '10:00', durationOptions: [90] });
    const people = [person('a', { originAreaId: 'fx-south', latestReturnLocal: '11:45' }), person('b')];
    expect(match(s, people, ds, { timeZone: TZ, now: NOW }).fitting).toEqual([]);
    const r = explore(s, people, ds, { timeZone: TZ, now: NOW });
    expect(r.alternatives.length).toBeGreaterThan(0);
    for (const a of r.alternatives) {
      expect(a.evaluation.status).toBe('pass');
      expect(a.patch).not.toBeNull();
    }
  });

  it('returns no alternatives when no shared change can work, and never relaxes private limits', () => {
    const s = settings();
    const people = [person('a', { maxOneWayTravelMinutes: 5 })];
    const r = explore(s, people, ds, { timeZone: TZ, now: NOW, idea: { venueId: 'fx-riverside-walk', meetingTime: '10:00', durationMinutes: 60 } });
    expect(r.idea!.status).toBe('fail');
    expect(r.alternatives).toEqual([]);
    expect(people[0]!.preferences.maxOneWayTravelMinutes).toBe(5);
  });

  it('builds minimal settings patches', () => {
    const s = settings({ windowStart: '09:00', windowEnd: '11:00', durationOptions: [30, 45, 60, 90, 120] });
    expect(patchFor(s, { venueId: 'v', meetingTime: '10:00', durationMinutes: 60 })).toBeNull();
    expect(patchFor(s, { venueId: 'v', meetingTime: '08:00', durationMinutes: 60 })).toEqual({ windowStart: '08:00' });
    expect(patchFor(s, { venueId: 'v', meetingTime: '12:00', durationMinutes: 75 })).toEqual({ windowEnd: '12:00', durationOptions: [45, 60, 75, 90, 120] }); // drops the furthest option (tie → earlier)
  });
});
