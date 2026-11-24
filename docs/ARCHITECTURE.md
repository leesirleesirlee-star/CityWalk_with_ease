# Architecture

This document describes how the standalone Chengdu edition is put together. It is intentionally small:
one HTML page, a handful of ES modules, a local Node middleware and a JSON knowledge base.

## 1. Layers

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser (index.html)                                                     │
│                                                                          │
│  src/app/chrome.js        theme + page chrome                            │
│  src/ui/mountTour.js      input, AI call, render scheduling              │
│  src/ui/tourView.js       left timeline · right detail · AI summary      │
│  src/ui/amapStage.js      AMap JS API 2.0 basemap, markers, polylines    │
│  src/ui/mapStage.js       schematic SVG map (no-key fallback)            │
│  src/ui/agentClient.js    /api/agent/* client                            │
│  src/ui/i18n.js           Chinese / English dictionary + live switching  │
│  src/ui/settings.js       in-app API key dialog                          │
│  src/agent/citywalk/*     deterministic local planner (fallback)         │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ fetch('/api/agent/…')
┌───────────────┴──────────────────────────────────────────────────────────┐
│ Node middleware (server/agent/*)                                         │
│                                                                          │
│  api.js          routing, body limits, rate limit, catalog loading       │
│  config.js       env loading, key handling (server-side only)            │
│  deepseek.js     DeepSeek chat/completions client                        │
│  prompt.js       system/user prompt construction                         │
│  validate-plan.js  structural validation of the model's plan            │
│  composer.js     tour_script 1.1.0 composer + schema validation          │
│  place.js        AMap Web service place details                          │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ HTTPS
     ┌──────────┴───────────┐
     │ DeepSeek API         │  AMap REST API (place details)
     └──────────────────────┘
```

The same `src/agent/citywalk` modules run in the browser and in tests. Node built-ins (`node:fs`,
`node:path`, `node:url`) are aliased to `src/ui/browser-node-shim.js` during the Vite build, so the
browser can read the schema and knowledge files bundled at build time.

## 2. Request lifecycle (`POST /api/agent/plan`)

1. **Intent parsing** — `parseMasterIntent()` turns the sentence into a deterministic intent
   (`budget_min`, `interests`, `constraints`, `pace`, `min_stops`). Budget never comes from the model.
2. **Candidate loading** — the 19 geocoded Chengdu POIs are loaded from `data/cities/chengdu/route-catalog.json`
   (with `pois.geojson` as fallback source), and each candidate's summary is loaded from its knowledge file.
3. **LLM call** — DeepSeek receives the candidates and returns `stops[]` (ids + per-stop reason + intro),
   `interests`, `constraints`, `pace` and a `route_reason`.
4. **Plan validation** — ids must exist, no duplicates, `stay_min` within 15–120, unknown stops dropped,
   fewer than two stops means failure. The model cannot invent coordinates or POIs.
5. **Sequencing** — `src/agent/routeSequence.js` keeps the AI's order and computes arrival times and
   walking legs (straight-line distance by default).
6. **Budget enforcement** — stops are compressed, and only then truncated from the tail, to fit the budget.
   A `cut_stops` list records what was removed.
7. **Composition** — `composer.js` assembles a `tour_script` **1.1.0** document with `meta.source = "llm"`,
   an agent trace and validation results, then validates it against `knowledge/tour_script.schema.json`.
8. **Response** — the browser renders the script; any failure returns `{ ok: false, code }` and the browser
   runs the local pipeline instead.

## 3. Fallback strategy

| Failure | Behaviour |
| --- | --- |
| No `DEEPSEEK_API_KEY` | Local pipeline; UI shows "AI not configured (local fallback)" |
| DeepSeek timeout / network error | Local pipeline; a notice is shown |
| Model returns invalid JSON | Local pipeline |
| Model plan fails validation | Local pipeline |
| No AMap JS key | Schematic SVG map; dashed straight-line legs |
| AMap walking query fails | Straight-line estimate per leg, labelled as such |

The deterministic pipeline (`masterPipeline.js` → `planner.js` → `routeGuard.js` → `resilience.js`)
produces the same `tour_script` contract, so the UI does not need two rendering paths.

## 4. Contract

`knowledge/tour_script.schema.json` (JSON Schema 2020-12 subset) is the single source of truth.
`tools/schema-check.mjs` is a zero-dependency validator used by both the server and the tests.
The top-level shape is:

```text
tour_script
├─ schema_version: "1.1.0"
├─ request        # raw text, city, budget, interests, constraints, pace
├─ city           # city id, display name, tagline
├─ route[]        # ordered stops: id, name, coords, stay, assets, commentary
├─ narration      # keyed by POI id: arrival / focus / transition / disclaimer
├─ scene_commands[] # presentation hints, aligned 1:1 with route[]
└─ meta           # source, generated_at, agent_trace, validation, stats, budget
```

## 5. Rendering and state

`mountTour.js` owns the session state: the current script, the active stop, and the request lifecycle.
`tourView.js` renders the timeline and the detail panel; `amapStage.js` mirrors the route onto the map.
When the language changes (`yunjing:lang`), static labels are refreshed and the dynamic views re-render;
when the theme changes, only CSS variables swap. No virtual DOM, no framework, no build step for development
beyond Vite's dev server.

## 6. Tests

`npm test` runs `node:test` suites in `tests/`. They import the same modules the browser and server use,
and read the same JSON files, so they genuinely exercise the shipped logic rather than mocks.
No network access and no API keys are needed.
