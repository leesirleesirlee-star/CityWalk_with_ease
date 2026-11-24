# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog 1.1.0, and this project adheres to Semantic
Versioning.

## [1.0.0] - 2026-11-24

First public release of CityWalk with Ease (云径), an AI-powered Chengdu city-walk
planner.

### Added

- One-sentence route planning: a user describes a time budget, interests, constraints and
  companions in a single sentence, and a DeepSeek model selects the stops, orders them
  and writes a reason plus a short introduction for each stop.
- Deterministic planning and validation: budget, timing, walking and schema rules check
  every generated route locally before it is shown.
- Offline-first fallback: with no API key, or when the model is unavailable, a
  deterministic local pipeline produces the route, a schematic SVG map and text-only
  place details, so the app remains fully usable without any key.
- Chengdu knowledge pack with 24 POIs, 19 of them carrying WGS84 coordinates, sourced
  from OpenStreetMap (ODbL 1.0), Wikipedia (CC BY-SA 4.0), Wikidata (CC0) and OSM
  Nominatim, with per-POI source tracking and verification status.
- Optional AMap (Gaode) integration: basemap, markers, walking-route geometry and place
  photos. Without a key the map falls back to the schematic SVG view and details fall
  back to text.
- Local middleware at `server/agent/*` exposing `/api/agent/health`,
  `/api/agent/plan` and `/api/agent/place`.
- Bilingual user interface (Chinese / English) with light and dark themes, a responsive
  layout and a built-in sample route.
- `tour_script` JSON Schema 1.1.0 contract for the Chengdu planner, kept alongside the
  frozen 1.0.0 contract so existing scripts stay valid.
- 122 `node:test` tests covering the planner, validation, route ordering, UI layout and
  AMap walking-route handling.
- English documentation and README screenshots under `docs/screenshots/`.
- MIT license.

### Changed

- The browser UI and the Node middleware share one set of ES modules (Node built-ins are
  shimmed for the browser), so tests exercise the same deterministic fallback the UI
  runs.
- Tour scripts are consumed through a single schema contract: 1.1.0 adds the city budget,
  dropped-stops, agent trace and per-leg walking data while the 1.0.0 format remains
  accepted.
- API failures standardize on the `{ ok: false, code, message }` shape instead of ad-hoc
  error payloads.

### Security

- API keys are read server-side only and are never part of the client bundle.
- `.env.local` is git-ignored; only `.env.example` with empty placeholders is committed.
- `/api/agent/config` accepts loopback requests only and never echoes keys back.
- LLM output is validated against the local POI catalog and the planning rules; model
  output is not trusted for coordinates, budget or walking times.
