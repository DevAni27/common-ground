import type { Dataset, Evidence, Fact } from './schemas.ts';
import { DAY_MS } from './time.ts';

/**
 * Freshness policy by fact type, in days between the newest supporting
 * evidence check and the outing date. Freshness never makes weak evidence
 * strong: it only turns otherwise-usable evidence into "unknown" once expired.
 */
export const FRESHNESS_DAYS = {
  outdoor: 730,
  opening: 120,
  entryCost: 180,
  facility: 365,
  walkProfile: 365,
  travel: 180,
  lowCrowd: 60,
} as const;
export type FactType = keyof typeof FRESHNESS_DAYS;

/** Fact types whose value must be backed by `confirmed` evidence. Estimates are acceptable only for upper-bound estimates. */
const REQUIRES_CONFIRMED: ReadonlySet<FactType> = new Set(['outdoor', 'opening', 'entryCost', 'facility', 'lowCrowd']);

export type FactReason =
  | 'FACT_UNKNOWN'
  | 'NO_EVIDENCE'
  | 'MALFORMED_EVIDENCE'
  | 'CONFLICTING_EVIDENCE'
  | 'UNREVIEWED_EVIDENCE'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'STALE_EVIDENCE'
  | 'FUTURE_DATED_EVIDENCE'
  | 'SYNTHETIC_IN_LIVE_DATA';

export type FactAssessment<T> =
  | { usable: true; value: T; evidenceIds: string[] }
  | { usable: false; reason: FactReason; evidenceIds: string[] };

export interface EvidenceContext {
  evidenceById: Map<string, Evidence>;
  datasetKind: Dataset['kind'];
  /** Instant at the start of the outing date; freshness is measured against it. */
  outingInstant: number;
  /** Current time; evidence "checked" in the future is malformed. */
  now: number;
}

export function buildEvidenceContext(dataset: Dataset, outingInstant: number, now: number): EvidenceContext {
  return {
    evidenceById: new Map(dataset.evidence.map((e) => [e.id, e])),
    datasetKind: dataset.kind,
    outingInstant,
    now,
  };
}

/** Assesses evidence ids directly (used for facts and for travel estimates). */
export function assessEvidenceIds(ids: string[], type: FactType, ctx: EvidenceContext): { usable: true } | { usable: false; reason: FactReason } {
  if (ids.length === 0) return { usable: false, reason: 'NO_EVIDENCE' };
  const items: Evidence[] = [];
  for (const id of ids) {
    const e = ctx.evidenceById.get(id);
    if (!e) return { usable: false, reason: 'MALFORMED_EVIDENCE' };
    items.push(e);
  }
  // Conflicts stay visible and block the fact until resolved.
  if (items.some((e) => e.confidence === 'conflicting')) return { usable: false, reason: 'CONFLICTING_EVIDENCE' };
  if (items.some((e) => e.reviewStatus !== 'reviewed')) return { usable: false, reason: 'UNREVIEWED_EVIDENCE' };
  if (ctx.datasetKind === 'researched' && items.some((e) => e.sourceKind === 'synthetic')) {
    return { usable: false, reason: 'SYNTHETIC_IN_LIVE_DATA' };
  }
  const supporting = items.filter((e) =>
    REQUIRES_CONFIRMED.has(type) ? e.confidence === 'confirmed' : e.confidence === 'confirmed' || e.confidence === 'estimated');
  if (supporting.length === 0) return { usable: false, reason: 'INSUFFICIENT_CONFIDENCE' };

  const times = supporting.map((e) => Date.parse(e.checkedAt));
  if (times.some((t) => Number.isNaN(t))) return { usable: false, reason: 'MALFORMED_EVIDENCE' };
  if (times.some((t) => t > ctx.now + DAY_MS)) return { usable: false, reason: 'FUTURE_DATED_EVIDENCE' };
  const newest = Math.max(...times);
  const ageDays = (ctx.outingInstant - newest) / DAY_MS;
  if (ageDays > FRESHNESS_DAYS[type]) return { usable: false, reason: 'STALE_EVIDENCE' };
  return { usable: true };
}

export function assessFact<T>(fact: Fact<T> | undefined, type: FactType, ctx: EvidenceContext): FactAssessment<T> {
  if (!fact) return { usable: false, reason: 'FACT_UNKNOWN', evidenceIds: [] };
  const evidenceIds = [...fact.evidenceIds];
  // Absence of a value is unknown, never false.
  if (fact.value === null || fact.value === undefined) return { usable: false, reason: 'FACT_UNKNOWN', evidenceIds };
  const result = assessEvidenceIds(evidenceIds, type, ctx);
  if (!result.usable) return { usable: false, reason: result.reason, evidenceIds };
  return { usable: true, value: fact.value, evidenceIds };
}
