/**
 * "What would make this work?" — recompute the same deterministic engine over
 * supported SHARED changes only: meeting time, visit duration, destination.
 * Private limits are never relaxed or even mentioned; only actually calculated
 * passing alternatives are returned.
 */
import { buildEvidenceContext } from './evidence.ts';
import {
  compareFitting, evaluateSlot, enumerateSlots, slotKey, type CandidateEvaluation, type ParticipantInput, type Slot,
} from './matching.ts';
import type { Dataset, SharedSettings } from './schemas.ts';
import { DAY_END, DAY_START } from './schemas.ts';
import { hhmmToMinutes, localToInstant, minutesToHHmm } from './time.ts';

export const EXPLORE_DURATIONS = [30, 45, 60, 90, 120];
/** Latest meeting time explored: leaves room for a visit before the daytime limit. */
const EXPLORE_LATEST_MEET = '19:00';
const EXPLORE_EARLIEST_MEET = '06:00';

export type ChangeKind = 'time' | 'duration' | 'time_and_duration' | 'venue' | 'outside_current_settings';

export interface SettingsPatch { windowStart?: string; windowEnd?: string; durationOptions?: number[] }

export interface Alternative {
  kind: ChangeKind;
  evaluation: CandidateEvaluation;
  /** Shared-settings change needed before this can be planned and confirmed; null if already inside current settings. */
  patch: SettingsPatch | null;
}

export interface ExploreResult {
  idea: CandidateEvaluation | null;
  alternatives: Alternative[];
  explored: number;
}

function exploreTimes(settings: SharedSettings): string[] {
  const out: string[] = [];
  const start = Math.max(hhmmToMinutes(EXPLORE_EARLIEST_MEET), hhmmToMinutes(DAY_START));
  const end = Math.min(hhmmToMinutes(EXPLORE_LATEST_MEET), hhmmToMinutes(DAY_END));
  for (let m = start; m <= end; m += settings.timeGridMinutes) out.push(minutesToHHmm(m));
  return out;
}

/** Minimal shared-settings change that brings `slot` inside the planning space. */
export function patchFor(settings: SharedSettings, slot: Slot): SettingsPatch | null {
  const patch: SettingsPatch = {};
  const t = hhmmToMinutes(slot.meetingTime);
  if (t < hhmmToMinutes(settings.windowStart)) patch.windowStart = slot.meetingTime;
  if (t > hhmmToMinutes(settings.windowEnd)) patch.windowEnd = slot.meetingTime;
  if (!settings.durationOptions.includes(slot.durationMinutes)) {
    let opts = [...settings.durationOptions, slot.durationMinutes];
    if (opts.length > 5) {
      // Keep at most five options: drop the existing option furthest from the new one.
      const drop = settings.durationOptions.reduce((a, b) => (Math.abs(b - slot.durationMinutes) > Math.abs(a - slot.durationMinutes) ? b : a));
      opts = opts.filter((d) => d !== drop);
    }
    patch.durationOptions = opts.sort((a, b) => a - b);
  }
  return Object.keys(patch).length ? patch : null;
}

export function explore(
  settings: SharedSettings, participants: ParticipantInput[], dataset: Dataset,
  opts: { timeZone: string; now: number; idea?: Slot; limit?: number },
): ExploreResult {
  const ctx = buildEvidenceContext(dataset, localToInstant(settings.date, '00:00', opts.timeZone), opts.now);
  const durations = [...new Set([...settings.durationOptions, ...EXPLORE_DURATIONS])].sort((a, b) => a - b);
  const slots = enumerateSlots(settings, dataset, { meetingTimes: exploreTimes(settings), durations });
  const evals = slots.map((s) => evaluateSlot(s, settings, participants, dataset, ctx, opts.timeZone));
  const passing = evals.filter((e) => e.status === 'pass');
  const limit = opts.limit ?? 6;
  const alt = (kind: ChangeKind, e: CandidateEvaluation): Alternative => ({ kind, evaluation: e, patch: patchFor(settings, e.slot) });

  if (opts.idea) {
    const idea = opts.idea;
    const ideaEval = evals.find((e) => e.key === slotKey(idea))
      ?? evaluateSlot(idea, settings, participants, dataset, ctx, opts.timeZone);
    const t0 = hhmmToMinutes(idea.meetingTime);
    const dt = (e: CandidateEvaluation) => Math.abs(hhmmToMinutes(e.slot.meetingTime) - t0);
    const dd = (e: CandidateEvaluation) => Math.abs(e.slot.durationMinutes - idea.durationMinutes);
    const sameVenue = passing.filter((e) => e.slot.venueId === idea.venueId && e.key !== ideaEval.key);
    const byTime = sameVenue.filter((e) => e.slot.durationMinutes === idea.durationMinutes).sort((a, b) => dt(a) - dt(b) || compareFitting(a, b)).slice(0, 2);
    const byDuration = sameVenue.filter((e) => e.slot.meetingTime === idea.meetingTime).sort((a, b) => dd(a) - dd(b) || compareFitting(a, b)).slice(0, 2);
    const both = byTime.length + byDuration.length === 0
      ? sameVenue.sort((a, b) => dt(a) + dd(a) - (dt(b) + dd(b)) || compareFitting(a, b)).slice(0, 1)
      : [];
    const byVenue = passing.filter((e) => e.slot.venueId !== idea.venueId && e.slot.meetingTime === idea.meetingTime && e.slot.durationMinutes === idea.durationMinutes)
      .sort(compareFitting).slice(0, 2);
    const alternatives = [
      ...byTime.map((e) => alt('time', e)), ...byDuration.map((e) => alt('duration', e)),
      ...both.map((e) => alt('time_and_duration', e)), ...byVenue.map((e) => alt('venue', e)),
    ].slice(0, limit);
    return { idea: ideaEval, alternatives, explored: evals.length };
  }

  // No specific idea: the nearest passing options that need a shared-settings change.
  const ws = hhmmToMinutes(settings.windowStart);
  const we = hhmmToMinutes(settings.windowEnd);
  const outside = (e: CandidateEvaluation) => {
    const t = hhmmToMinutes(e.slot.meetingTime);
    const timeGap = t < ws ? ws - t : t > we ? t - we : 0;
    const durGap = settings.durationOptions.includes(e.slot.durationMinutes) ? 0 : Math.min(...settings.durationOptions.map((d) => Math.abs(d - e.slot.durationMinutes)));
    return timeGap + durGap;
  };
  const candidates = passing.filter((e) => outside(e) > 0).sort((a, b) => outside(a) - outside(b) || compareFitting(a, b));
  const picked: CandidateEvaluation[] = [];
  const venues = new Set<string>();
  for (const e of candidates) { if (picked.length < 3 && !venues.has(e.slot.venueId)) { picked.push(e); venues.add(e.slot.venueId); } }
  for (const e of candidates) { if (picked.length < 3 && !picked.includes(e)) picked.push(e); }
  return { idea: null, alternatives: picked.map((e) => alt('outside_current_settings', e)), explored: evals.length };
}
