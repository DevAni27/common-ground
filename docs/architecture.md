# Architecture and design decisions

## Real data per outing

Each outing carries its own dataset. When the outing is created, the organiser picks real places from OpenStreetMap (Overpass) and checks or fills in their facts. Each fact cites evidence: the OpenStreetMap element (third party), or an "entered by the organiser" record. Facts the organiser didn't confirm are proposals and can never support a fit. When a participant saves their limits, the server calculates their **private** travel estimates to every place, using free routing (FOSSGIS OSRM for walking and driving, Transitous for public transport when enabled) or their own usual time. The deterministic engine below then runs on that per-outing dataset.

## Evidence model

Evidence is attached to individual facts (`outdoor`, `opening`, `entryCost`, each facility, `visitWalkProfile`, `lowCrowdVerified`) and to each travel estimate. A fact with `value: null` is unknown, never false.

A fact supports a check only if **all** of these hold (`src/domain/evidence.ts`):

1. It has at least one evidence record, and every referenced record exists.
2. No referenced record is `conflicting` — conflicts block the fact until resolved.
3. Every referenced record is `reviewed` (AI-extracted or unreviewed facts are proposals).
4. Test-only synthetic records are never accepted in real outing data.
5. Confidence: `confirmed` is required for outdoor status, opening hours, entry cost, facilities and low-crowd evidence. `estimated` is accepted only for upper-bound estimates (venue walking profile, travel legs).
6. Freshness: the newest supporting check is within the policy below, measured to the outing date. Future-dated checks are malformed.

| Fact type | Max age (days) |
| --- | --- |
| Outdoor status | 730 |
| Opening hours | 120 |
| Entry / activity cost | 180 |
| Facilities | 365 |
| Venue walking profile | 365 |
| Travel estimates | 180 |
| Verified low-crowd conditions | 60 |

Freshness never makes weak evidence strong. Firsthand crowd observations should be recorded as `estimated`, so they never satisfy the strict "quiet is a must" setting on their own.

## Matching (`src/domain/matching.ts`)

Enumerates venue × meeting time (15-minute grid in the organiser's window) × allowed duration. For each participant and each allowed transport mode:

1. Venue outdoor and the whole visit inside an opening interval (date exceptions override weekly rules).
2. Departure = meeting − arrival buffer − outbound upper duration ≥ earliest departure.
3. Home = meeting + visit + departure buffer + return upper duration ≤ latest return. Outbound and return legs are separate records.
4. Both directions ≤ one-way cap.
5. Outbound + venue + return walking ≤ total-walk cap.
6. Longest continuous walking ≤ continuous cap. Without a verified rest at the meeting point, adjacent stretches (arrival walk + venue walk, venue walk + departure walk) are treated as one; if only that combination exceeds the cap the result is **unknown**, not pass.
7. Transport both ways + mandatory entry/activity + parking ≤ budget. Own vehicle requires an explicit per-person cost assumption and known parking status.
8. Required facilities confirmed by current evidence.

Each check returns pass / fail / unknown with a reason code and evidence ids. Any fail → does not fit. No fail but any unknown → needs verification. Missing routes, stale or conflicting evidence, malformed records and model failures can never produce a pass. Straight-line distance is never used.

Mode choice per participant: a fully passing mode with the lowest relative burden, then shortest travel, then walk → public transport → own vehicle.

## Ranking

Only fully passing candidates are ranked. For each participant: travel load = larger directional duration ÷ one-way cap; cost load = cost ÷ budget; walk load = total walking ÷ total-walk cap (when set). Zero caps: zero usage → load 0 (positive usage has already failed). Participant burden = largest load; candidate burden = largest participant burden.

Sort: lowest candidate burden → highest group soft-preference score → lowest total travel → stable key. This respects the person with the largest relative burden; it is a transparent design choice, not a proof of fairness. Loads are never published. Up to three options are shown, preferring different venues before repeating a venue at another time.

## "What would make this work?" (`src/domain/explore.ts`)

Re-runs the same engine over shared choices only — meeting times 06:00–19:00, durations {current} ∪ {30, 45, 60, 90, 120}, and venues in the covered area — with everyone's unchanged private requirements. Only calculated passing alternatives are returned, each with the minimal shared-settings patch it needs. Exploring never mutates the outing; applying a patch is a normal versioned settings change followed by re-planning.

## Versioning and confirmation

`planningVersion` increments on any change to membership, shared settings, private requirements, joining state, or the evidence snapshot (dataset digest). That clears the plan, the selection and all approvals. Plans are immutable for their version; `inputDigest` binds a plan to settings + requirements + dataset. Selections and confirmations carry version and digest; stale requests get 409. The outing is a single bounded document updated by compare-and-swap on a storage revision, so concurrent confirmations never overwrite each other. The card is available only when every active participant confirmed the selected passing candidate at the current version.

## Access

Three capability types — organiser, invite, participant — each a 256-bit random token stored only as a SHA-256 hash. Links carry tokens in the URL fragment (never sent to servers or referrers); the page exchanges them for HttpOnly, SameSite=Strict cookies scoped to `/api` and removes them from the address bar. Organiser access never grants access to private answers. Mutations require a custom header plus same-origin checks. Request bodies are capped at 16 KB; per-IP rate limits apply. Responses are built as explicit DTOs; stored documents are never serialised.

## AI

- **Setting suggestions**: Gemma returns structured JSON (Ollama `format` = JSON Schema, temperature 0, bounded output). Every value must be backed by a quote that appears in the person's text and must be derivable from that quote (numbers, unambiguous times). Ambiguous times ("home by 6"), vague limits and contradictions become questions. Nothing is saved until the person reviews the form and presses Save.
- **Grounded summaries**: input is the public projection only. Output is rejected (and replaced by a labelled template) if it contains numbers not in the facts, other venue names, crowd/weather/safety claims, or facility claims not confirmed by evidence. Only validated results are cached (in memory, keyed by model + prompt version + input digest).
- One local generation at a time; failures never change matching results.

## Orchestration and telemetry

The Mastra workflow `plan-outing` runs `snapshot-inputs → match → explain`. Each run appends a line to `.local-data/workflow-runs.jsonl` with a random run id, step statuses and timings, and counts — no outing ids or private content. Runs use Mastra's in-memory storage.

Sentry (optional): default integrations are disabled; only manual spans are sent, with an allow-list of attribute keys (step names, statuses, counts, model name, token counts). The SDK's hostname is replaced with a fixed value. No prompts, responses, URLs, cookies, requirements, locations or names.
