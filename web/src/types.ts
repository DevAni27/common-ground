export type Status = 'pass' | 'fail' | 'unknown';
export interface PublicSource { id: string; url?: string; kind: string; checkedAt: string; confidence: string; excerpt?: string }
export interface PublicFact { label: string; status: 'known' | 'unknown'; text: string }
export interface PublicCandidate {
  key: string; status: Status; statusLabel: string;
  venue: { id: string; name: string; meetingPoint: string; mapUrl?: string };
  date: string; meetingTime: string; endTime: string; durationMinutes: number;
  venueNotes: string[]; groupNote: string | null; sharedPreferences: string[];
  facts: PublicFact[]; excludedOptionalCosts: string[]; assumptions: string[]; sources: PublicSource[];
}
export interface SharedSettings {
  title: string; coveredAreaId: string; coveredAreaName: string; date: string; windowStart: string; windowEnd: string;
  durationOptions: number[]; expectedCount: number; timeGridMinutes: number; arrivalBufferMinutes: number; departureBufferMinutes: number;
}
export interface SharedOuting {
  id: string; settings: SharedSettings & { currency: string; timeZone: string }; dataset: { kind: string; label: string };
  area: { label: string }; places: Array<{ id: string; name: string; mapUrl?: string; meetingPoint: string }>;
  joiningClosed: boolean; planningVersion: number;
  progress: { joined: number; submitted: number; expected: number };
  readyToPlan: boolean;
  viewer: { isOrganiser: boolean; isParticipant: boolean; hasSubmitted: boolean };
  members?: Array<{ id: string; nickname: string }>;
  plan: null | { version: number; computedAt: string; evaluated: number; counts: Record<Status, number>; noMatch: boolean; fitting: PublicCandidate[]; needsVerification: PublicCandidate[] };
  selection: null | { candidate: PublicCandidate; confirmedCount: number; activeCount: number; viewerConfirmed: boolean };
  cardReady: boolean; expiresAt: string;
}
export interface Reference {
  dataset: { kind: string; label: string; venueCount: number };
  coveredAreas: Array<{ id: string; name: string }>;
  originAreas: Array<{ id: string; name: string }>;
}
export interface GeoPoint { label: string; lat: number; lon: number }
export interface Answers {
  origin: GeoPoint | null;
  earliestDepartureLocal: string; latestReturnLocal: string;
  allowedModes: Array<'walk' | 'public_transport' | 'own_vehicle'>;
  maxOneWayTravelMinutes: number; maxTotalCost: number;
  maxContinuousWalkMinutes?: number; maxTotalWalkMinutes?: number;
  requiredFacilities: Array<'seating' | 'step_free_access' | 'toilet'>;
  requireVerifiedLowCrowd: boolean;
  softPreferences: { greenery: number; quiet: number; photography: number; conversation: number; exploring: number };
  publicTransport?: { fareOneWay: number | null; typicalMinutesToArea: number | null };
  ownVehicle?: { costEachWay: number | null; parkingCost: number | null };
}
export type Preferences = Answers;
export interface Me {
  participantId: string; nickname: string | null; answers: Answers | null; submittedAt: string | null; planningVersion: number;
  travelNotes: string[]; routes: Array<{ place: string; options: Array<{ mode: string; minutesUpper: number | null }> }>;
  transitRouting: boolean; currency: string;
}
export interface PrivateJourney {
  status: Status; statusLabel: string; mode: string | null; leaveBy: string | null; homeBy: string | null;
  outboundMinutesUpper: number | null; returnMinutesUpper: number | null; costUpper: number | null;
  checks: Array<{ label: string; status: Status; text: string }>; limitations: string[]; sources: PublicSource[];
}
export interface Card {
  title: string; date: string; venue: PublicCandidate['venue']; meetingTime: string; endTime: string; durationMinutes: number;
  schedule: Array<{ time: string; text: string }>; facts: PublicFact[]; excludedOptionalCosts: string[]; checkBeforeYouGo: string[]; sources: PublicSource[];
  assumptions: string[]; currency: string; confirmedBy: string; planningVersion: number;
}

export interface AreaResult { label: string; lat: number; lon: number; countryCode: string | null; currency: string | null }
export interface OpeningRules { weekly: Array<{ days: number[]; open: string; close: string }>; exceptions: unknown[] }
export interface PlaceDraft {
  id: string; name: string; kind: string; lat: number; lon: number; osmUrl: string; straightLineMetres: number;
  openingHours: { raw: string | null; parsed: OpeningRules | null; caveat: string | null };
  fee: { value: number | null; raw: string | null };
  toilet: boolean | null; stepFree: boolean | null; seating: boolean | null;
  preferenceTags: Array<'greenery' | 'quiet' | 'photography' | 'conversation' | 'exploring'>;
}
