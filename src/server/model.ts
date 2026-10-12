import type { CandidateEvaluation, CheckStatus } from '../domain/matching.ts';
import type { Evidence, ParticipantAnswers, ParticipantPreferences, SharedSettings, TravelEstimate, Venue } from '../domain/schemas.ts';
import type { AreaInfo } from './outing-data.ts';

/** Internal outing aggregate. Never serialised directly into an HTTP response. */
export interface ParticipantRecord {
  id: string;
  nickname: string | null;
  tokenHash: string;
  joinKeyHash: string;
  joinedAt: string;
  /** What they submitted (private, includes their starting point). */
  answers: ParticipantAnswers | null;
  /** Matching-engine view derived from answers. */
  preferences: ParticipantPreferences | null;
  /** Private travel estimates from free routing services, computed on save. */
  travel: TravelEstimate[];
  travelEvidence: Evidence[];
  travelNotes: string[];
  submittedAt: string | null;
}

export interface PlanSnapshot {
  version: number;
  inputDigest: string;
  datasetDigest: string;
  computedAt: string;
  evaluated: number;
  counts: Record<CheckStatus, number>;
  /** Contains private per-participant assessments; internal only. */
  fitting: CandidateEvaluation[];
  needsVerification: CandidateEvaluation[];
  /**
   * Candidates evaluated later at the same version and inputs because someone
   * asked for them (e.g. from the explorer). Deterministic, so this does not
   * change any existing result.
   */
  pinned?: CandidateEvaluation[];
}

export interface Selection { candidateKey: string; version: number; inputDigest: string; selectedAt: string }
export interface Confirmation { participantId: string; candidateKey: string; version: number; inputDigest: string; confirmedAt: string }

export interface OutingDoc {
  id: string;
  /** Storage revision for compare-and-swap; distinct from planningVersion. */
  rev: number;
  createdAt: string;
  /** Retention: the outing is unusable after this instant and is deleted by the sweeper. */
  expiresAt: string;
  planningVersion: number;
  settings: SharedSettings;
  joiningClosed: boolean;
  organiserTokenHash: string;
  inviteTokenHash: string;
  participants: ParticipantRecord[];
  /** The searched area (public within the outing). */
  area: AreaInfo;
  /** Real places chosen and reviewed by the organiser, with their evidence. */
  places: Venue[];
  placeEvidence: Evidence[];
  plan: PlanSnapshot | null;
  selection: Selection | null;
  confirmations: Confirmation[];
}

export const MAX_PARTICIPANTS = 8;
