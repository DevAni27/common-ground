import { z } from 'zod';
import { evaluateSlot, match, type CandidateEvaluation, type ParticipantInput, type Slot } from '../domain/matching.ts';
import { explore, type Alternative } from '../domain/explore.ts';
import { buildEvidenceContext } from '../domain/evidence.ts';
import { hhmmToMinutes } from '../domain/time.ts';
import { HHmm } from '../domain/schemas.ts';
import { interpretFreeText, MAX_FREE_TEXT, type InterpretResult } from '../ai/interpret.ts';
import { summarisePlans, toSummaryInput } from '../ai/summary.ts';
import type { OllamaConfig } from '../ai/ollama.ts';
import type { PlanningEngine } from '../workflows/planning.ts';
import { toPrivateView, toPublicCandidate, type PublicCandidate, type PrivateJourneyView } from '../domain/projection.ts';
import { ParticipantAnswers, SharedSettings, type Dataset, type ParticipantPreferences } from '../domain/schemas.ts';
import { DAY_MS, localToInstant } from '../domain/time.ts';
import type { AppConfig } from './config.ts';
import { currencyForCountry, type GeoProvider, type RouteProvider } from '../geo/types.ts';
import { AreaInfo, buildPlaces, computeTravel, outingDataset, PlaceInput } from './outing-data.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.ts';
import { MAX_PARTICIPANTS, type OutingDoc, type ParticipantRecord, type PlanSnapshot } from './model.ts';
import type { OutingStore } from './store.ts';
import { digest, hashToken, newId, newToken, tokenMatches } from './tokens.ts';

export interface Auth { organiserToken?: string; participantToken?: string }
export interface Viewer { isOrganiser: boolean; participant: ParticipantRecord | null }

const ExpectedVersion = z.number().int().min(0);

export class OutingService {
  constructor(
    public store: OutingStore, public geo: GeoProvider, public routes: RouteProvider, public config: AppConfig,
    private clock: () => Date = () => new Date(), public planning: PlanningEngine | null = null,
  ) {}

  /** The outing's own real dataset: reviewed places + everyone's private travel estimates. */
  datasetFor(doc: OutingDoc): Dataset {
    return outingDataset(doc.area.label, doc.places, doc.placeEvidence, doc.participants);
  }

  private placesDigest(doc: OutingDoc) { return digest({ places: doc.places, evidence: doc.placeEvidence }); }

  /* ---------------- helpers ---------------- */

  private nowIso() { return this.clock().toISOString(); }

  private expiresAt(date: string, timeZone: string) {
    return new Date(localToInstant(date, '23:59', timeZone) + this.config.retentionDaysAfterOuting * DAY_MS).toISOString();
  }

  /** Loads an outing, enforcing access-time retention expiry. */
  async load(id: string): Promise<OutingDoc> {
    const doc = await this.store.get(id);
    if (!doc) throw notFound();
    // Outings saved by an older version (fixed test dataset, no real places) are not usable.
    if (!Array.isArray(doc.places) || !doc.area) throw notFound();
    if (Date.parse(doc.expiresAt) <= this.clock().getTime()) {
      await this.store.delete(id);
      throw notFound();
    }
    return doc;
  }

  viewer(doc: OutingDoc, auth: Auth): Viewer {
    return {
      isOrganiser: tokenMatches(auth.organiserToken, doc.organiserTokenHash),
      participant: auth.participantToken ? doc.participants.find((p) => tokenMatches(auth.participantToken, p.tokenHash)) ?? null : null,
    };
  }

  private requireMember(v: Viewer) { if (!v.isOrganiser && !v.participant) throw notFound(); }
  private requireOrganiser(v: Viewer) { if (!v.isOrganiser) { if (v.participant) throw forbidden(); throw notFound(); } }
  private requireParticipant(v: Viewer): ParticipantRecord { if (!v.participant) { if (v.isOrganiser) throw forbidden(); throw notFound(); } return v.participant; }

  private checkVersion(doc: OutingDoc, expected: unknown) {
    const parsed = ExpectedVersion.safeParse(expected);
    if (!parsed.success) throw badRequest('EXPECTED_VERSION_REQUIRED', 'expectedVersion is required.');
    if (parsed.data !== doc.planningVersion) throw conflict('STALE_VERSION', 'This outing changed since you loaded it. Reload to see the current version.');
  }

  /** Any change to inputs: new planning version, old plan/selection/approvals cleared. */
  private invalidate(doc: OutingDoc) {
    doc.planningVersion += 1;
    doc.plan = null;
    doc.selection = null;
    doc.confirmations = [];
  }

  private participantInputs(doc: OutingDoc): ParticipantInput[] {
    return doc.participants.filter((p) => p.preferences).map((p) => ({ participantId: p.id, preferences: p.preferences! }));
  }

  private toPreferences(participantId: string, a: ParticipantAnswers): ParticipantPreferences {
    const { origin: _o, publicTransport: _p, ownVehicle: _v, ...rest } = a;
    return { originAreaId: `p-${participantId}`, ...rest };
  }

  inputDigest(doc: OutingDoc) {
    return digest({
      settings: doc.settings,
      participants: [...doc.participants].sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({ id: p.id, preferences: p.preferences, travel: p.travel, travelEvidence: p.travelEvidence })),
      places: this.placesDigest(doc),
    });
  }

  private planIsCurrent(doc: OutingDoc): doc is OutingDoc & { plan: PlanSnapshot } {
    return !!doc.plan && doc.plan.version === doc.planningVersion && doc.plan.datasetDigest === this.placesDigest(doc) && doc.plan.inputDigest === this.inputDigest(doc);
  }

  private findCandidate(doc: OutingDoc, key: string): CandidateEvaluation | undefined {
    return doc.plan?.fitting.find((c) => c.key === key) ?? doc.plan?.needsVerification.find((c) => c.key === key) ?? doc.plan?.pinned?.find((c) => c.key === key);
  }

  publicCandidate(doc: OutingDoc, c: CandidateEvaluation): PublicCandidate {
    return toPublicCandidate(c, doc.settings, this.participantInputs(doc), this.datasetFor(doc), this.clock().getTime(), doc.settings.timeZone);
  }

  private slotFromKey(key: string): Slot | null {
    const m = /^([a-z0-9][a-z0-9_-]{0,63})@(\d{2})(\d{2})\+(\d{1,3})$/.exec(key);
    if (!m) return null;
    const meetingTime = `${m[2]}:${m[3]}`;
    return HHmm.safeParse(meetingTime).success ? { venueId: m[1]!, meetingTime, durationMinutes: Number(m[4]) } : null;
  }

  private slotInSettings(doc: OutingDoc, slot: Slot) {
    const t = hhmmToMinutes(slot.meetingTime);
    const venue = doc.places.find((v) => v.id === slot.venueId);
    return !!venue && venue.areaId === doc.settings.coveredAreaId
      && t >= hhmmToMinutes(doc.settings.windowStart) && t <= hhmmToMinutes(doc.settings.windowEnd)
      && (t - hhmmToMinutes(doc.settings.windowStart)) % doc.settings.timeGridMinutes === 0
      && doc.settings.durationOptions.includes(slot.durationMinutes);
  }

  private evaluate(doc: OutingDoc, slot: Slot): CandidateEvaluation {
    const data = this.datasetFor(doc);
    const ctx = buildEvidenceContext(data, localToInstant(doc.settings.date, '00:00', doc.settings.timeZone), this.clock().getTime());
    return evaluateSlot(slot, doc.settings, this.participantInputs(doc), data, ctx, doc.settings.timeZone);
  }

  private describe(a: Alternative, doc: OutingDoc, idea: Slot | undefined): string {
    const s = a.evaluation.slot;
    const name = doc.places.find((v) => v.id === s.venueId)?.name ?? s.venueId;
    switch (a.kind) {
      case 'time': return `Meet at ${s.meetingTime} instead of ${idea!.meetingTime}`;
      case 'duration': return `Stay ${s.durationMinutes} min instead of ${idea!.durationMinutes}`;
      case 'time_and_duration': return `Meet at ${s.meetingTime} and stay ${s.durationMinutes} min`;
      case 'venue': return `Go to ${name} at the same time instead`;
      default: {
        const parts: string[] = [];
        const t = hhmmToMinutes(s.meetingTime);
        if (t < hhmmToMinutes(doc.settings.windowStart) || t > hhmmToMinutes(doc.settings.windowEnd)) parts.push(`meet at ${s.meetingTime} (outside the current ${doc.settings.windowStart}–${doc.settings.windowEnd} window)`);
        else parts.push(`meet at ${s.meetingTime}`);
        if (!doc.settings.durationOptions.includes(s.durationMinutes)) parts.push(`stay ${s.durationMinutes} min (not a current duration option)`);
        else parts.push(`stay ${s.durationMinutes} min`);
        return `${name}: ${parts.join(', ')}`;
      }
    }
  }

  /** Previews shared changes. Never mutates the outing and never relaxes anyone's private limits. */
  async explore(id: string, body: { expectedVersion?: unknown; idea?: unknown }, auth: Auth) {
    const doc = await this.load(id);
    this.requireMember(this.viewer(doc, auth));
    this.checkVersion(doc, body.expectedVersion);
    if (!doc.joiningClosed || doc.participants.length < 2 || doc.participants.some((p) => !p.preferences)) {
      throw conflict('NOT_READY', 'Exploring needs everyone to have submitted and joining to be closed.');
    }
    let idea: Slot | undefined;
    if (body.idea !== undefined && body.idea !== null) {
      const parsed = z.object({ venueId: z.string().max(64), meetingTime: HHmm, durationMinutes: z.number().int().min(15).max(480) }).safeParse(body.idea);
      if (!parsed.success) throw badRequest('INVALID_IDEA', 'Choose a place, a meeting time and a duration.');
      const venue = doc.places.find((v) => v.id === parsed.data.venueId);
      if (!venue) throw badRequest('UNSUPPORTED_VENUE', 'That place is not in the covered area.');
      idea = parsed.data;
    }
    const result = explore(doc.settings, this.participantInputs(doc), this.datasetFor(doc), { timeZone: doc.settings.timeZone, now: this.clock().getTime(), idea });
    return {
      planningVersion: doc.planningVersion,
      explored: result.explored,
      idea: result.idea ? this.publicCandidate(doc, result.idea) : null,
      alternatives: result.alternatives.map((a) => ({
        kind: a.kind,
        description: this.describe(a, doc, idea),
        candidate: this.publicCandidate(doc, a.evaluation),
        patch: a.patch,
      })),
    };
  }

  ollamaConfig(): OllamaConfig | null {
    return this.config.aiEnabled ? { baseUrl: this.config.ollamaBaseUrl, model: this.config.ollamaModel, timeoutMs: 90_000 } : null;
  }

  /** Suggests settings from the participant's own words. Never saves; the text is not stored or logged. */
  async interpret(id: string, body: { text?: unknown }, auth: Auth, fetchImpl?: typeof fetch): Promise<InterpretResult> {
    const doc = await this.load(id);
    this.requireParticipant(this.viewer(doc, auth));
    const text = z.string().trim().min(3).max(MAX_FREE_TEXT).safeParse(body.text);
    if (!text.success) throw badRequest('INVALID_TEXT', `Write between 3 and ${MAX_FREE_TEXT} characters.`);
    const cfg = this.ollamaConfig();
    if (!cfg) return { source: 'unavailable', reason: 'AI_DISABLED', metrics: null };
    return interpretFreeText(cfg, text.data, fetchImpl);
  }

  /** Short summaries of the current recommended options, generated from public facts only. */
  async summaries(id: string, body: { expectedVersion?: unknown }, auth: Auth, fetchImpl?: typeof fetch) {
    const doc = await this.load(id);
    this.requireMember(this.viewer(doc, auth));
    this.checkVersion(doc, body.expectedVersion);
    if (!this.planIsCurrent(doc)) throw conflict('NO_CURRENT_PLAN', 'There is no current plan.');
    const inputs = doc.plan.fitting.map((c) => toSummaryInput(this.publicCandidate(doc, c)));
    const names = doc.places.map((v) => v.name);
    const r = await summarisePlans(this.ollamaConfig(), inputs, names, fetchImpl);
    return { source: r.source, items: r.items, failureReason: r.failureReason ?? null, model: r.source === 'gemma' ? this.config.ollamaModel : null, elapsedMs: r.metrics?.elapsedMs ?? null, cached: r.cached };
  }

  /* ---------------- operations ---------------- */

  /* ---------------- real-world lookups (OpenStreetMap) ---------------- */

  async searchArea(body: { query?: unknown }) {
    const q = z.string().trim().min(2).max(120).safeParse(body.query);
    if (!q.success) throw badRequest('INVALID_QUERY', 'Type a neighbourhood, town or landmark.');
    try { return { results: (await this.geo.searchArea(q.data)).map((r) => ({ ...r, currency: currencyForCountry(r.countryCode) })) }; } catch {
      throw new HttpError(502, 'GEO_UNAVAILABLE', 'Place search is unavailable right now (OpenStreetMap could not be reached). Check your internet connection and try again.');
    }
  }

  async nearbyPlaces(body: { lat?: unknown; lon?: unknown; radiusMetres?: unknown }) {
    const p = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), radiusMetres: z.number().min(300).max(8000).default(2500) }).safeParse(body);
    if (!p.success) throw badRequest('INVALID', 'Invalid location.');
    try { return { places: await this.geo.nearbyPlaces({ lat: p.data.lat, lon: p.data.lon }, p.data.radiusMetres) }; } catch {
      throw new HttpError(502, 'GEO_UNAVAILABLE', 'Could not load places from OpenStreetMap right now. Please try again in a minute.');
    }
  }

  async placeByName(body: { query?: unknown; lat?: unknown; lon?: unknown }) {
    const p = z.object({ query: z.string().trim().min(2).max(120), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).safeParse(body);
    if (!p.success) throw badRequest('INVALID', 'Type the name of a place.');
    try { return { places: await this.geo.placeByName(p.data.query, { lat: p.data.lat, lon: p.data.lon }) }; } catch {
      throw new HttpError(502, 'GEO_UNAVAILABLE', 'Place search is unavailable right now. Please try again in a minute.');
    }
  }

  /* ---------------- operations ---------------- */

  async create(input: { settings?: unknown; area?: unknown; places?: unknown; organiserNickname?: unknown; organiserJoins?: unknown }) {
    const settings = SharedSettings.safeParse({ ...(typeof input.settings === 'object' && input.settings ? input.settings : {}), coveredAreaId: 'area' });
    if (!settings.success) throw badRequest('INVALID_SETTINGS', 'Some outing settings are invalid.', settings.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const area = AreaInfo.safeParse(input.area);
    if (!area.success) throw badRequest('INVALID_AREA', 'Choose an area first.');
    const places = z.array(PlaceInput).min(1, 'Pick at least one place').max(10, 'Pick at most 10 places').safeParse(input.places);
    if (!places.success) throw badRequest('INVALID_PLACES', places.error.issues[0]?.message ?? 'Invalid places.', places.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    if (new Set(places.data.map((p) => p.id)).size !== places.data.length) throw badRequest('INVALID_PLACES', 'Each place can be picked once.');
    const nickname = z.string().trim().max(40).optional().safeParse(input.organiserNickname);
    const built = buildPlaces(places.data, this.nowIso(), new Date(this.clock()).toISOString().slice(0, 10));
    const organiserToken = newToken();
    const inviteToken = newToken();
    const doc: OutingDoc = {
      id: newId(), rev: 0, createdAt: this.nowIso(), expiresAt: this.expiresAt(settings.data.date, settings.data.timeZone),
      planningVersion: 1, settings: settings.data, joiningClosed: false,
      organiserTokenHash: hashToken(organiserToken), inviteTokenHash: hashToken(inviteToken),
      participants: [], area: area.data, places: built.venues, placeEvidence: built.evidence, plan: null, selection: null, confirmations: [],
    };
    // Most organisers are going too: give them their own participant place straight away.
    let participantToken: string | null = null;
    if (input.organiserJoins !== false) {
      participantToken = newToken();
      doc.participants.push(this.newParticipant(newId(), (nickname.success && nickname.data) || null, participantToken, newToken()));
    }
    await this.store.create(doc);
    return { doc, organiserToken, inviteToken, participantToken };
  }

  private newParticipant(id: string, nickname: string | null, token: string, joinKey: string): ParticipantRecord {
    return { id, nickname, tokenHash: hashToken(token), joinKeyHash: hashToken(joinKey), joinedAt: this.nowIso(), answers: null, preferences: null, travel: [], travelEvidence: [], travelNotes: [], submittedAt: null };
  }

  async exchange(id: string, role: 'organiser' | 'participant', token: string) {
    const doc = await this.load(id);
    const ok = role === 'organiser' ? tokenMatches(token, doc.organiserTokenHash) : doc.participants.some((p) => tokenMatches(token, p.tokenHash));
    if (!ok) throw notFound();
    return doc;
  }

  async join(id: string, body: { inviteToken?: unknown; nickname?: unknown; joinKey?: unknown }, auth: Auth) {
    const parsed = z.object({
      inviteToken: z.string().min(10).max(200),
      nickname: z.string().trim().max(40).optional().transform((v) => (v ? v : null)),
      joinKey: z.string().min(8).max(100),
    }).safeParse(body);
    if (!parsed.success) throw badRequest('INVALID_JOIN', 'Invalid join request.');
    const participantToken = newToken();
    let participantId = '';
    await this.store.update(id, (doc) => {
      if (!tokenMatches(parsed.data.inviteToken, doc.inviteTokenHash)) throw notFound();
      if (Date.parse(doc.expiresAt) <= this.clock().getTime()) throw notFound();
      if (doc.joiningClosed) throw conflict('JOINING_CLOSED', 'Joining is closed for this outing.');
      if (auth.participantToken && doc.participants.some((p) => tokenMatches(auth.participantToken, p.tokenHash))) {
        throw conflict('ALREADY_JOINED', 'This device has already joined this outing.');
      }
      const joinKeyHash = hashToken(parsed.data.joinKey);
      if (doc.participants.some((p) => p.joinKeyHash === joinKeyHash)) throw conflict('DUPLICATE_JOIN', 'This join request was already processed.');
      if (doc.participants.length >= Math.min(doc.settings.expectedCount, MAX_PARTICIPANTS)) throw conflict('OUTING_FULL', 'This outing already has the expected number of people.');
      participantId = newId();
      doc.participants.push({ ...this.newParticipant(participantId, parsed.data.nickname, participantToken, parsed.data.joinKey) });
      this.invalidate(doc);
      return doc;
    });
    return { participantId, participantToken };
  }

  async shared(id: string, auth: Auth) {
    const doc = await this.load(id);
    const v = this.viewer(doc, auth);
    this.requireMember(v);
    const current = this.planIsCurrent(doc);
    const submitted = doc.participants.filter((p) => p.preferences).length;
    const selected = doc.selection && current ? this.findCandidate(doc, doc.selection.candidateKey) : undefined;
    const validConfirmations = doc.selection ? doc.confirmations.filter((c) => c.candidateKey === doc.selection!.candidateKey && c.version === doc.planningVersion && doc.participants.some((p) => p.id === c.participantId)) : [];
    return {
      id: doc.id,
      settings: { ...doc.settings, coveredAreaName: doc.area.label },
      area: { label: doc.area.label },
      places: doc.places.map((v) => ({ id: v.id, name: v.name, mapUrl: v.mapUrl, meetingPoint: v.meetingPointDescription })),
      dataset: { kind: 'openstreetmap', label: 'Real places from OpenStreetMap, checked by the organiser' },
      joiningClosed: doc.joiningClosed,
      planningVersion: doc.planningVersion,
      progress: { joined: doc.participants.length, submitted, expected: doc.settings.expectedCount },
      readyToPlan: doc.joiningClosed && doc.participants.length >= 2 && submitted === doc.participants.length,
      viewer: { isOrganiser: v.isOrganiser, isParticipant: !!v.participant, hasSubmitted: !!v.participant?.preferences },
      members: v.isOrganiser ? doc.participants.map((p) => ({ id: p.id, nickname: p.nickname ?? 'Unnamed participant' })) : undefined,
      plan: current ? {
        version: doc.plan.version,
        computedAt: doc.plan.computedAt,
        evaluated: doc.plan.evaluated,
        counts: doc.plan.counts,
        noMatch: doc.plan.fitting.length === 0,
        fitting: doc.plan.fitting.map((c) => this.publicCandidate(doc, c)),
        needsVerification: doc.plan.needsVerification.map((c) => this.publicCandidate(doc, c)),
      } : null,
      selection: selected ? {
        candidate: this.publicCandidate(doc, selected),
        confirmedCount: validConfirmations.length,
        activeCount: doc.participants.length,
        viewerConfirmed: !!v.participant && validConfirmations.some((c) => c.participantId === v.participant!.id),
      } : null,
      cardReady: !!selected && validConfirmations.length === doc.participants.length && doc.participants.length > 0,
      expiresAt: doc.expiresAt,
    };
  }

  async me(id: string, auth: Auth) {
    const doc = await this.load(id);
    const p = this.requireParticipant(this.viewer(doc, auth));
    const routes = doc.places.map((v) => {
      const legs = p.travel.filter((t) => t.venueId === v.id && t.direction === 'outbound');
      return { place: v.name, options: legs.map((t) => ({ mode: t.mode, minutesUpper: t.durationUpperMinutes })) };
    });
    return { participantId: p.id, nickname: p.nickname, answers: p.answers, submittedAt: p.submittedAt, planningVersion: doc.planningVersion, travelNotes: p.travelNotes, routes, transitRouting: this.routes.transitAvailable, currency: doc.settings.currency };
  }

  async savePreferences(id: string, body: { expectedVersion?: unknown; answers?: unknown }, auth: Auth) {
    const answers = ParticipantAnswers.safeParse(body.answers);
    if (!answers.success) throw badRequest('INVALID_PREFERENCES', 'Some answers are invalid.', answers.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    // Check access and version before calling routing services.
    const before = await this.load(id);
    const me = this.requireParticipant(this.viewer(before, auth));
    this.checkVersion(before, body.expectedVersion);
    // Real travel estimates from free routing services, kept private to this participant.
    const travel = await computeTravel(me.id, answers.data, before.places, before.settings, before.area, this.routes, this.nowIso());
    const doc = await this.store.update(id, (doc) => {
      const p = this.requireParticipant(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      p.answers = answers.data;
      p.preferences = this.toPreferences(p.id, answers.data);
      p.travel = travel.estimates;
      p.travelEvidence = travel.evidence;
      p.travelNotes = travel.notes;
      p.submittedAt = this.nowIso();
      this.invalidate(doc);
      return doc;
    });
    return { planningVersion: doc.planningVersion, travelNotes: travel.notes, routesFound: travel.estimates.length / 2 };
  }

  async updateSettings(id: string, body: { expectedVersion?: unknown; settings?: unknown }, auth: Auth) {
    const doc = await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      const patch = typeof body.settings === 'object' && body.settings ? { ...(body.settings as Record<string, unknown>) } : {};
      // Area, currency and time zone are fixed at creation (travel estimates depend on them).
      delete patch.coveredAreaId; delete patch.currency; delete patch.timeZone;
      const merged = SharedSettings.safeParse({ ...doc.settings, ...patch });
      if (!merged.success) throw badRequest('INVALID_SETTINGS', 'Some outing settings are invalid.', merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      if (merged.data.expectedCount < doc.participants.length) throw badRequest('COUNT_BELOW_MEMBERS', 'Expected count cannot be lower than the number of people who joined.');
      doc.settings = merged.data;
      doc.expiresAt = this.expiresAt(merged.data.date, merged.data.timeZone);
      this.invalidate(doc);
      return doc;
    });
    return { planningVersion: doc.planningVersion };
  }

  async setJoining(id: string, body: { expectedVersion?: unknown; closed?: unknown }, auth: Auth) {
    const closed = z.boolean().safeParse(body.closed);
    if (!closed.success) throw badRequest('INVALID', 'closed must be true or false.');
    const doc = await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      if (doc.joiningClosed !== closed.data) { doc.joiningClosed = closed.data; this.invalidate(doc); }
      return doc;
    });
    return { planningVersion: doc.planningVersion, joiningClosed: doc.joiningClosed };
  }

  async removeParticipant(id: string, participantId: string, expectedVersion: unknown, auth: Auth) {
    const doc = await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      this.checkVersion(doc, expectedVersion);
      const before = doc.participants.length;
      doc.participants = doc.participants.filter((p) => p.id !== participantId);
      if (doc.participants.length === before) throw notFound();
      this.invalidate(doc);
      return doc;
    });
    return { planningVersion: doc.planningVersion };
  }

  async plan(id: string, body: { expectedVersion?: unknown }, auth: Auth) {
    // Phase 1: authorise, check readiness, and move to a new version if the evidence snapshot changed.
    const doc = await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      if (!doc.joiningClosed) throw conflict('JOINING_OPEN', 'Close joining before planning.');
      if (doc.participants.length < 2) throw conflict('TOO_FEW', 'At least two people need to join.');
      if (doc.participants.some((p) => !p.preferences)) throw conflict('NOT_ALL_SUBMITTED', 'Everyone needs to submit their requirements first.');
      return doc;
    });
    if (this.planIsCurrent(doc)) return this.shared(id, auth); // immutable snapshot for this version

    // Phase 2: run the planning pipeline (Mastra workflow when configured, otherwise the same steps inline).
    const inputDigest = this.inputDigest(doc);
    const input = { settings: doc.settings, participants: this.participantInputs(doc), dataset: this.datasetFor(doc) };
    const result = this.planning
      ? await this.planning.run(input)
      : { ...match(input.settings, input.participants, input.dataset, { timeZone: doc.settings.timeZone, now: this.clock().getTime() }), runId: null };

    // Phase 3: persist only if nothing changed meanwhile.
    await this.store.update(id, (d) => {
      if (d.planningVersion !== doc.planningVersion || this.inputDigest(d) !== inputDigest) {
        throw conflict('STALE_VERSION', 'Something changed while plans were being calculated. Please try again.');
      }
      if (this.planIsCurrent(d)) return d;
      d.plan = {
        version: d.planningVersion, inputDigest, datasetDigest: this.placesDigest(d), computedAt: this.nowIso(),
        evaluated: result.evaluated, counts: result.counts, fitting: result.fitting, needsVerification: result.needsVerification,
      };
      d.selection = null;
      d.confirmations = [];
      return d;
    });
    return this.shared(id, auth);
  }

  /** One click for the organiser: close joining (if open) and find plans. */
  async startPlanning(id: string, body: { expectedVersion?: unknown }, auth: Auth) {
    let v = body.expectedVersion;
    const doc = await this.load(id);
    this.requireOrganiser(this.viewer(doc, auth));
    if (doc.participants.length < 2) throw conflict('TOO_FEW', 'At least two people need to join first.');
    if (doc.participants.some((p) => !p.preferences)) throw conflict('NOT_ALL_SUBMITTED', 'Waiting for everyone to add their limits.');
    if (!doc.joiningClosed) v = (await this.setJoining(id, { expectedVersion: v, closed: true }, auth)).planningVersion;
    return this.plan(id, { expectedVersion: v }, auth);
  }

  async privateCandidate(id: string, key: string, auth: Auth): Promise<PrivateJourneyView> {
    const doc = await this.load(id);
    const p = this.requireParticipant(this.viewer(doc, auth));
    if (!this.planIsCurrent(doc)) throw conflict('NO_CURRENT_PLAN', 'There is no current plan.');
    const c = this.findCandidate(doc, key);
    const mine = c?.participants.find((a) => a.participantId === p.id);
    if (!c || !mine) throw notFound();
    return toPrivateView(mine, this.datasetFor(doc), doc.settings.timeZone);
  }

  async select(id: string, body: { expectedVersion?: unknown; candidateKey?: unknown }, auth: Auth) {
    const key = z.string().max(120).safeParse(body.candidateKey);
    if (!key.success) throw badRequest('INVALID', 'candidateKey is required.');
    await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      if (!this.planIsCurrent(doc)) throw conflict('NO_CURRENT_PLAN', 'Compute a current plan first.');
      let c = this.findCandidate(doc, key.data);
      if (!c) {
        const slot = this.slotFromKey(key.data);
        if (slot && this.slotInSettings(doc, slot)) {
          c = this.evaluate(doc, slot);
          if (c.status === 'pass') doc.plan.pinned = [...(doc.plan.pinned ?? []), c];
        }
      }
      if (!c || c.status !== 'pass') throw conflict('NOT_SELECTABLE', 'Only options that fit the submitted limits can be proposed.');
      if (doc.selection?.candidateKey !== c.key) {
        doc.selection = { candidateKey: c.key, version: doc.planningVersion, inputDigest: doc.plan.inputDigest, selectedAt: this.nowIso() };
        doc.confirmations = []; // a different candidate resets approvals
      }
      return doc;
    });
    return this.shared(id, auth);
  }

  async confirm(id: string, body: { expectedVersion?: unknown; candidateKey?: unknown }, auth: Auth) {
    await this.store.update(id, (doc) => {
      const p = this.requireParticipant(this.viewer(doc, auth));
      this.checkVersion(doc, body.expectedVersion);
      if (!this.planIsCurrent(doc) || !doc.selection) throw conflict('NOTHING_TO_CONFIRM', 'There is no current proposal to confirm.');
      if (doc.selection.candidateKey !== body.candidateKey || doc.selection.version !== doc.planningVersion || doc.selection.inputDigest !== doc.plan.inputDigest) {
        throw conflict('STALE_PROPOSAL', 'The proposal changed. Reload and review it again.');
      }
      doc.confirmations = doc.confirmations.filter((c) => c.participantId !== p.id);
      doc.confirmations.push({ participantId: p.id, candidateKey: doc.selection.candidateKey, version: doc.planningVersion, inputDigest: doc.plan.inputDigest, confirmedAt: this.nowIso() });
      return doc;
    });
    return this.shared(id, auth);
  }

  async card(id: string, auth: Auth) {
    const doc = await this.load(id);
    this.requireMember(this.viewer(doc, auth));
    const s = await this.shared(id, auth);
    if (!s.cardReady || !s.selection) throw conflict('NOT_CONFIRMED', 'The plan has not been confirmed by everyone at the current version.');
    const c = s.selection.candidate;
    return {
      title: doc.settings.title,
      date: c.date,
      venue: c.venue,
      meetingTime: c.meetingTime,
      endTime: c.endTime,
      durationMinutes: c.durationMinutes,
      schedule: [
        { time: c.meetingTime, text: `Meet at ${c.venue.meetingPoint}` },
        { time: c.meetingTime, text: `Outdoor time at ${c.venue.name} (${c.durationMinutes} min)` },
        { time: c.endTime, text: 'Wrap up and head home' },
      ],
      facts: c.facts,
      excludedOptionalCosts: c.excludedOptionalCosts,
      checkBeforeYouGo: c.assumptions,
      sources: c.sources,
      assumptions: [
        `Travel times are cautious estimates from free OpenStreetMap-based routing (padded, no live traffic), with ${doc.settings.arrivalBufferMinutes} min arrival and ${doc.settings.departureBufferMinutes} min departure buffers.`,
        'A fit means the plan fits everyone\'s limits with the available estimates; actual conditions can differ.',
        'Place data © OpenStreetMap contributors, checked by the organiser.',
      ],
      currency: doc.settings.currency,
      confirmedBy: `${s.selection.confirmedCount} of ${s.selection.activeCount} people`,
      planningVersion: doc.planningVersion,
    };
  }

  /** Issues a new invite link; the previous one stops working. Existing members are unaffected. */
  async rotateInvite(id: string, auth: Auth) {
    const inviteToken = newToken();
    await this.store.update(id, (doc) => {
      this.requireOrganiser(this.viewer(doc, auth));
      doc.inviteTokenHash = hashToken(inviteToken);
      return doc;
    });
    return { inviteToken };
  }

  async deleteOuting(id: string, auth: Auth) {
    const doc = await this.load(id);
    this.requireOrganiser(this.viewer(doc, auth));
    await this.store.delete(id);
  }
}

export { HttpError };
