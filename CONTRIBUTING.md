# Contributing to CityWalk with Ease

Thanks for your interest in improving CityWalk with Ease (云径), an AI-powered Chengdu
city-walk planner. The project is intentionally small and dependency-light, so focused
bug reports, data corrections and documentation fixes are just as valuable as large
features.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). If you
believe you found a security vulnerability, please do **not** open a public issue; follow
[SECURITY.md](SECURITY.md) instead.

GitHub Discussions are disabled for this repository. The issue tracker is the place for
questions, bug reports and feature proposals.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Coding conventions](#coding-conventions)
- [Tests and build](#tests-and-build)
- [Commit messages](#commit-messages)
- [Branches and pull requests](#branches-and-pull-requests)
- [Adding POI knowledge safely](#adding-poi-knowledge-safely)
- [Documentation language](#documentation-language)

## Ways to contribute

- Report a reproducible bug or a confusing interaction.
- Propose a feature, or comment on an existing proposal with real use cases.
- Correct or verify Chengdu POI knowledge using citable sources.
- Improve tests, accessibility, bilingual copy or documentation.
- Review pull requests, especially changes to the deterministic planner.

## Reporting bugs

Open an issue with the **Bug report** form. A report is actionable when it contains:

- a one-sentence description of what broke;
- exact steps to reproduce, including the prompt text you typed;
- expected versus actual behaviour;
- your environment: operating system, Node.js version, browser, and whether
  `DEEPSEEK_API_KEY` / `AMAP_WEB_KEY` were configured;
- console or server logs and screenshots where useful, with secrets removed.

Search existing issues first. Reports without a reproduction may be closed with a request
for more detail.

## Proposing features

Open an issue with the **Feature request** form and describe the problem before the
solution: who benefits, what currently happens, and what you would like to happen. Keep
the project's constraints in mind:

- the app must remain fully usable with **no API key**, through the deterministic local
  fallback pipeline, schematic SVG map and text-only place details;
- the front end stays framework-free (vanilla ES modules) and the runtime stays free of
  dependencies;
- Chengdu is the only supported city for now.

For larger changes, agree on the approach in an issue before writing code.

## Development setup

Requirements: **Node.js >= 20** and **npm >= 10**.

1. Clone the repository (fork it on GitHub first if you plan to push branches):

   ```bash
   git clone https://github.com/leesirleesirlee-star/CityWalk_with_ease.git
   cd CityWalk_with_ease
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Optionally create a local environment file. The app works without one:

   ```bash
   cp .env.example .env.local        # Windows: copy .env.example .env.local
   ```

4. Start the dev server at <http://127.0.0.1:5178/>:

   ```bash
   npm run dev
   ```

Useful commands:

| Command           | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| `npm run dev`     | Vite dev server with the local `/api/agent/*` middleware    |
| `npm run build`   | Production build into `dist/`                               |
| `npm run preview` | Serve the production build at <http://127.0.0.1:5179/>      |
| `npm test`        | Run the `node:test` suite (122 tests)                       |

Environment variables live in `.env.local`, which is **git-ignored**. Only
`.env.example` with empty placeholders is committed.

| Variable              | Side     | Purpose                                                        |
| --------------------- | -------- | -------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`    | server   | Enables LLM route planning via `/api/agent/plan`               |
| `DEEPSEEK_BASE_URL`   | server   | DeepSeek-compatible API base URL (optional)                  |
| `DEEPSEEK_MODEL`      | server   | Model name (default `deepseek-chat`)                           |
| `AMAP_WEB_KEY`        | server   | AMap web-service key for place details and photos              |
| `VITE_AMAP_KEY`       | browser  | AMap JS API key for the optional basemap; restrict it by domain |
| `AMAP_SECURITY_CODE`  | server   | AMap JS API security code, appended by the local `/_AMapService` proxy |
| `VITE_AMAP_3D`        | browser  | Optional flag to enable the AMap 3D view                       |

**Never commit API keys.** Any variable prefixed with `VITE_` is bundled into the browser
build and must be treated as public; server-only keys must never be exposed that way. The
settings panel can write `DEEPSEEK_API_KEY` and `AMAP_WEB_KEY` to `.env.local` through
`POST /api/agent/config`, which accepts loopback requests only.

## Project layout

| Path                        | Contents                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `server/agent/`             | Local Node middleware: `/api/agent/health`, `/plan`, `/place`, `/config`; DeepSeek client; plan validation and composition |
| `src/agent/citywalk/`       | Deterministic planner: preferences, budget, route order, guards, resilience |
| `src/ui/`                   | Rendering, i18n, AMap stage, schematic SVG map, settings — no framework  |
| `knowledge/`                | `tour_script` JSON Schema and Chengdu POI knowledge files               |
| `data/cities/chengdu/`      | `pois.geojson`, route catalog and tour-script fixtures                  |
| `tests/`                    | `node:test` suites                                                      |
| `tools/`                    | Dependency-free JSON Schema checker                                     |
| `docs/screenshots/`         | UI screenshots for documentation                                        |

## Coding conventions

- **Vanilla ES modules, no framework.** There is no TypeScript build step and no JSX.
  Keep modules small and prefer pure functions for planning logic.
- **Keep the deterministic fallback intact.** Every feature must work without API keys
  and without network access. The same modules run in Node (tests, middleware) and in the
  browser; Vite aliases Node built-ins to `src/ui/browser-node-shim.js`, so avoid adding
  Node APIs to shared code unless you shim them too.
- **Treat model output as untrusted.** The LLM only proposes stops and prose; stops must
  be validated against the local POI catalog and budget, timing and walking rules are
  recomputed locally. Never let the model supply coordinates that bypass validation.
- **Keep the API contract stable.** `/api/agent/*` returns JSON shaped
  `{ ok: true, ... }` or `{ ok: false, code, message }`. Do not return stack traces,
  secrets or unredacted upstream error text.
- **Every UI string is bilingual.** Add new copy through `src/ui/i18n.js` (the `L('中文',
  'English')` helper or `data-i18n` attributes) and keep both languages in sync. The UI
  supports light and dark themes; check both.
- **No new heavy dependencies without discussion.** The runtime has zero dependencies and
  Vite 5 is the only dev dependency. Open an issue before adding a package, explaining
  why the standard library or a small amount of code is not enough.
- Style: 2-space indentation, single quotes, semicolons; keep diffs focused and avoid
  unrelated reformatting.

## Tests and build

Before opening a pull request, both of the following must pass:

```bash
npm test
npm run build
```

- Add or update tests for every behaviour change; the suite uses `node:test`.
- Tests must be deterministic and offline. Inject a fake `fetch` instead of calling
  DeepSeek or AMap, and avoid depending on wall-clock timing.
- To validate a generated tour script against the contract, run:

  ```bash
  node tools/schema-check.mjs path/to/tour_script.json
  ```

  The checker uses `knowledge/tour_script.schema.json` by default.

## Commit messages

Use Conventional Commits: `<type>(<scope>): <imperative summary>`.

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`.

Examples:

```text
feat(agent): reject AI stops outside the POI catalog
fix(ui): keep the light theme when switching language
docs: document the POI verification workflow
```

Keep the subject under 72 characters, use the imperative mood, and explain *why* in the
body. Reference issues with `Refs #12` or `Closes #12`.

## Branches and pull requests

1. Create a topic branch from the default branch, for example
   `feat/poi-verification`, `fix/budget-clamp` or `docs/contributing`.
2. Open a pull request against the default branch and fill in the PR template.
3. Keep pull requests small and reviewable; put refactors in their own PR.
4. CI (`.github/workflows/ci.yml`) must be green before a pull request can be merged.
5. Address review comments and resolve conversations. At least one maintainer approval is
   required before merge.
6. PR titles follow Conventional Commits. Pull requests are usually squash-merged to keep
   history linear, so the PR title becomes the commit subject.

Maintainers may ask for a smaller scope or a design discussion before review continues.

## Adding POI knowledge safely

POI accuracy is the highest-risk part of this project. Follow these rules:

- **Where to add data.** General Chengdu attraction knowledge lives in
  `knowledge/attractions/chengdu/`; route-stop knowledge lives in
  `knowledge/route-pois/chengdu/`. Structured data lives in
  `data/cities/chengdu/pois.geojson` and `data/cities/chengdu/route-catalog.json`. Follow
  the field names and structure of the existing JSON files exactly.
- **New knowledge is `pending` until verified.** Set `verification_status: "pending"` (and
  an appropriate `content_status` / `confidence`) on every new or edited knowledge file.
  Only switch to `"verified"` after you have checked the claim against the source you
  list. Each source entry must include a `url`, `publisher`, `source_type`, `accessed_at`
  and its own `verification_status`.
- **Never invent coordinates.** Coordinates must be WGS84 values from a citable source
  (OpenStreetMap/Overpass, Wikipedia, Wikidata, OSM Nominatim or an official site). Record
  `coord_source`, `coord_source_detail` and `coordinate_system`. If you cannot source a
  coordinate, leave the geometry `null` — POIs without coordinates are intentionally
  excluded from AI planning. Do not guess from memory or copy a location from another
  city.
- **Cite and respect licenses.** OpenStreetMap data is ODbL 1.0 (attribute "©
  OpenStreetMap contributors"), Wikipedia text is CC BY-SA 4.0 (link the article you used
  and keep derived summaries share-alike), and Wikidata is CC0. Write short, original
  factual summaries; do not paste long copyrighted text.
- **Keep facts minimal.** Add opening hours, prices and access notes only when they come
  from a cited source, and say when they were accessed.
- Run `npm test` after changing data; the suite includes schema and contract checks.

## Documentation language

English is the language of this repository: README, `docs/`, CONTRIBUTING, CHANGELOG, pull
request descriptions, commit messages and issue reports are written in English. The
product UI itself is bilingual Chinese/English, so new UI copy must be added in both
languages. Improvements to existing documentation are always welcome.
