# Evaluation

## Automated (what `npm test` proves)

Domain rules, privacy boundaries of the API, concurrency, versioning, restart persistence (file adapter), explorer behaviour, telemetry scrubbing (against a local fake Sentry ingest), and AI **plumbing** — all on clearly labelled test-only fake places and routes, so tests run offline. AI tests inject fake model outputs: they verify validation and fallbacks, not model quality.

## Real Gemma inference (`npm run eval:gemma`)

Run on the laptop with Ollama running and `gemma3:4b` pulled. The script:

- measures warm-up (model load) separately, then per-request latency (p50/p90/max);
- reports loaded model size and VRAM use from Ollama;
- runs 15 interpretation cases: plain statements, paraphrases of the same limits, hour/rupee wording, total-vs-continuous walking, an ambiguous time ("Home by 6"), vague limits, a contradiction, a "total travel is not one-way" trap, Hinglish, an access need and a zero budget;
- scores each case: correct / wrong / missing fields, unexpected fields, fields set that must not be set, and whether a clarifying question appeared where needed;
- runs grounded summaries for 3 synthetic plan sets and reports how many were accepted vs replaced by the template, with the rejection reason;
- writes everything to `eval-results/gemma-eval-<timestamp>.json`.

Report the actual numbers from that file. Do not tune prompts endlessly — record the result, fix only clear failures, and re-run once.

## Real OpenStreetMap services (`npm run check:osm -- "<area>"`)

Area search, nearby places with their mapped hours/fees, and walking/driving (and opt-in transit) routes, timed, from the machine that runs the app.

## Real MongoDB Atlas (`npm run check:mongo`)

Concurrent compare-and-swap updates, reconnect (restart) persistence, TTL index, delete.

## Field trial (to do)

Real participants on their own phones: independently submit requirements, review the plan, confirm, use the exported card outside. Measure form time, planning time, known estimate errors, and ask whether anyone felt excluded and what they'd change. Publish feedback only with permission.
