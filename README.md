# Common Ground

**A plan everyone can actually say yes to.**

Friends each add their limits privately: when they can leave, when they must be home, how they can travel, how far, their budget, and walking or access needs. Common Ground checks every place × meeting time × duration against everyone's limits, using **real places from OpenStreetMap, anywhere in the world**, and real routes. It shows only the options that work for everyone. If nothing fits, it shows which **shared** change (earlier, shorter, another place) would work. Everyone confirms, and the group heads out with a printable outing card.

Built for the DEV Hacktoberfest 2026 Week 1 challenge ("Touch Grass").

## How it works for people

1. **Plan an outing.** Search any area, pick 2–8 real parks, gardens or viewpoints that OpenStreetMap lists nearby, and quickly check their details (hours, fee, toilets). Then choose a day and time window.
2. **Share one link.** Friends open it on their phones and add their limits. They can type them in their own words and let Gemma fill in the form.
3. **See plans that fit everyone.** The organiser chooses one.
4. **Everyone says "I'm in".** Then open the outing card and go outside.

## Where the data comes from (all free, no API keys)

| What | Source | Notes |
| --- | --- | --- |
| Area search | OpenStreetMap Nominatim | Max 1 request/second, search on button press only (their usage policy) |
| Outdoor places | OpenStreetMap via Overpass (falls back to public mirrors when the main server is busy) | Named parks, gardens, nature reserves, commons, viewpoints, picnic sites, beaches within 1–5 km |
| Opening hours, fee, toilets, wheelchair access | OpenStreetMap tags | Often not mapped. The organiser confirms or fills them in; anything left "not sure" stays **needs checking** |
| Walking and driving times | FOSSGIS OSRM (`routing.openstreetmap.de`) | Padded to be cautious: walk ×1.2 + 2 min, drive ×1.4 + 10 min (parking), no live traffic |
| Bus / metro / train | Transitous timetables (**opt-in**, `TRANSITOUS_ENABLED=true`) or each person's own usual time | Transitous asks projects to contact them before using routing, so it's off by default |
| Fares, fuel, parking | Each person enters their own (private) | No free worldwide fare data exists |

Place data © OpenStreetMap contributors (ODbL). Attribution is shown on every page and on the card.

**Privacy note on routing:** to calculate travel times, the server sends each person's chosen starting point to the routing service. That point is a neighbourhood or landmark they picked from search, not their address. People are told this on the form.

## What works today, and how it was checked

| Area | Status | Evidence |
| --- | --- | --- |
| Landing page, light/dark theme, 3-step create wizard, share link, stepper outing page | Working | Scripted phone-size browser runs (light and dark) through the whole flow |
| Real-place import + organiser review, per-person travel estimates | **Code complete; live services not reachable from the build environment** | Parsing and padding tests on documented response formats. Run `npm run check:osm` on your machine to test the live services |
| Evidence-aware deterministic matching, ranking, "what would make it work" | Working | Domain + API tests |
| Version-bound confirmation, card export, file persistence + restart | Working | API, concurrency and restart tests |
| Gemma (Ollama) "say it your way" + plan descriptions | **Code complete; real model not yet evaluated** | Plumbing tests use injected fake outputs. Run `npm run eval:gemma` for real results |
| Mastra planning workflow, Sentry tracing (opt-in), MongoDB adapter | As before | See docs/evaluation.md |

Automated tests use clearly labelled **test-only** fake places and routes (in `tests/`), so they can run offline. The app itself never shows invented places.

## Quick start (Windows PowerShell or cmd, no `.ps1` scripts needed)

Requires Node 22.13+ and npm 10.

```
cd common-ground
npm install
npm run check:osm -- "Koregaon Park, Pune"
npm run build
npm start
```

Open http://127.0.0.1:8787. The `check:osm` step confirms this machine can reach the free OpenStreetMap services. It prints real places and route times for the area you give it.

For hot reload during development: `npm run dev` (web on 5173, API on 8787).

### Using phones on the same Wi-Fi

```
set APP_BIND_HOST=0.0.0.0          (cmd)
$env:APP_BIND_HOST="0.0.0.0"       (PowerShell)
npm start
```

The server prints `on your Wi-Fi: http://192.168.x.x:8787`. If Windows asks, allow Node.js on **private** networks. Ollama stays on `127.0.0.1`; phones only talk to the app server.

### Checks

```
npm test               # automated tests (offline; fake geo/routing and fake model outputs)
npm run typecheck
npm run check:osm      # live OpenStreetMap services from this machine
npm run eval:gemma     # REAL local Gemma evaluation (needs Ollama + gemma3:4b)
npm run check:mongo    # REAL MongoDB/Atlas check (needs MONGODB_URI)
```

## Configuration

Put overrides in a `.env` file (loaded automatically; never commit it). See `.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_PORT` / `APP_BIND_HOST` | 8787 / 127.0.0.1 | `0.0.0.0` for phones on the same Wi-Fi |
| `APP_CONTACT` | — | Your email or repo URL, sent in the User-Agent to the free OSM services (their policy asks apps to identify themselves) |
| `TRANSITOUS_ENABLED` | false | Public-transport timetables via Transitous. Contact the maintainers first: https://transitous.org/api/ |
| `STORE_ADAPTER` | file | `file` (./.local-data), `memory`, or `mongodb` (`MONGODB_URI`) |
| `AI_ENABLED`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | true, http://127.0.0.1:11434, gemma3:4b | Server-side only |
| `SENTRY_DSN` | — | Optional manual, scrubbed tracing |
| `RETENTION_DAYS_AFTER_OUTING` | 7 | Outings are deleted this many days after the outing date |

Each outing stores its own currency (suggested from the area's country) and time zone (taken from the organiser's browser, editable).

## What Gemma does

Gemma is Google's free, open model, run locally through Ollama on the organiser's computer. It does two small jobs:

1. **"Say it your way":** someone types "back by 1 pm, about 300 total, bus is fine". Gemma fills in the form, and the filled fields are marked ✦ for the person to check before saving. Every value must be traceable to their exact words. Ambiguous input like "home by 6" becomes a question, not a limit.
2. **Plan descriptions:** one line per plan, written only from the place's public facts. Any sentence with a number, place, facility or crowd claim that isn't in the facts is replaced by a plain description.

It never chooses plans. Matching is deterministic arithmetic, and the same inputs always give the same result.

## Privacy, in plain terms

- Your answers are visible only to you in the app. The organiser cannot read them. The person running the server could technically read the stored data, so this is not an anonymity guarantee.
- Shared plans show places, times, public facts and a generic "doesn't fit everyone", never who it doesn't fit or why.
- Personal links are keys, not logins. They are swapped for HttpOnly cookies and removed from the address bar, stored only as hashes, and never appear in exports or telemetry.
- Outings are deleted automatically a week after the outing date, or immediately by the organiser.

## Limitations

- Many places lack hours or fees in OpenStreetMap. Until someone fills them in, those plans show "needs checking" and can't be confirmed.
- Travel times are cautious estimates without live traffic. Without Transitous, bus and metro times come from each person's own estimate plus a walking route inside the area.
- Free public services can be slow or rate-limited. The app degrades to "needs checking" and never invents a route.
- A static host can't reach Gemma on your laptop. Remote use needs the app server running where Ollama is.

## Credits

New project created in the challenge window. Map data © OpenStreetMap contributors. Routing by FOSSGIS. Fonts: Bricolage Grotesque, Atkinson Hyperlegible (Braille Institute), both OFL.
