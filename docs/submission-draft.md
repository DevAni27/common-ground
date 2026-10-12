# Submission draft (skeleton — fill only with things that actually happened)

> Every `TODO` must be replaced with real results or removed. Do not publish invented quotes, numbers or outcomes.

## The problem

Planning a simple outing with friends often fails quietly: someone can't spend much, has to be home early, can't walk far, or can't travel long — and doesn't want to explain why in the group chat. The plan that "everyone agreed to" is the one the quietest person couldn't actually do.

## What Common Ground does

Each person enters their limits privately. The app checks every place × time × duration against everyone's limits with checked evidence, shows only options that fit, and — the key moment — answers **"What would make this work?"** by recalculating shared choices (time, length, place) without loosening anyone's private limits. Everyone confirms the same version, and the group goes outside with a printable card.

## Demo

TODO: link to the video. Show: separate private forms (synthetic participants or consenting friends), a failing idea, the calculated shared change, confirmations from separate phones, the card, footage of the actual outing.

## Why open, local AI

TODO: actual results from `eval-results/` (sample count, field accuracy, questions on ambiguous input, latency p50/p90 on an RTX 3060 6 GB laptop, summary acceptance rate). Explain the design: the model proposes, deterministic checks verify, the person decides; private text never leaves the laptop.

## Sponsor tools — only what was actually used

- Gemma via Ollama: TODO (real eval numbers).
- Mastra: planning workflow `snapshot-inputs → match → explain`; in-memory runs; TODO run evidence.
- MongoDB Atlas: TODO only if `npm run check:mongo` and a real Atlas-backed run succeeded.
- Sentry: TODO only if real traces were received; include one issue it helped diagnose.

## Field feedback

TODO (with permission).

## Limitations

See README "Limitations". TODO: add anything learned outdoors (estimate errors, confusing screens).

## Setup

See README.
