# Security Policy

## Supported versions

CityWalk with Ease (云径) is currently at **1.0.0**, released on 2026-11-24.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

Only the latest 1.0.x release receives security fixes. If you run a fork, rebase onto the
latest release before testing the issue.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public issues, pull requests or
any other public channel.

- **Preferred:** open a private GitHub Security Advisory at
  <https://github.com/leesirleesirlee-star/CityWalk_with_ease/security/advisories/new>.
- **Alternative:** email **leesirleesirlee@gmail.com** with the subject
  `CityWalk with Ease security report`.

Please include:

- a description of the issue and the affected component (for example
  `server/agent/*`, `/api/agent/*`, the UI or the POI data pipeline);
- the affected version or commit, and your environment (OS, Node.js version, browser);
- minimal reproduction steps or a proof of concept;
- the impact you believe it has (confidentiality, integrity, availability);
- any suggested remediation, and whether you plan to disclose publicly.

Do not include real API keys, personal data or third-party confidential information in
the report; redact them.

## What to expect

- We will acknowledge your report within **72 hours** (usually much sooner).
- We will investigate, keep you informed of triage and progress, and coordinate a fix.
- We will disclose the issue after a fix is available, with affected versions and
  remediation guidance. Please do not publish details before that.
- We will credit reporters in the advisory unless you ask us not to.

Security research must be good-faith and limited to the project itself. Do not access
other people's data, degrade service, or test against infrastructure you do not own.

## Security model

CityWalk with Ease is a local application: a Vite dev/preview server plus local Node
middleware, visited at `http://127.0.0.1:5178/` (dev) or `http://127.0.0.1:5179/`
(preview). The security-relevant design is summarized below.

### Secrets stay on the server

- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `AMAP_WEB_KEY` and
  `AMAP_SECURITY_CODE` are read from the environment / `.env.local` by server-side code
  (`server/agent/config.js` and the Vite `/_AMapService` proxy). They are never included
  in the browser bundle and are never returned by an API response.
- Error messages sent to clients are sanitized: any API key appearing in an upstream
  error is replaced with `***`, and stack traces are not returned.
- `.env.local` is **git-ignored**. Only `.env.example`, with empty placeholders, is
  committed. The settings panel writes keys through `POST /api/agent/config`, which
  accepts loopback requests only (`127.0.0.1` / `::1`), never echoes the keys back, and
  refuses any other environment variable.

### Client-side values are public by design

- Any variable prefixed with `VITE_` is bundled into the browser build. Only
  `VITE_AMAP_KEY` (an AMap JS API key that must be restricted by domain/Referer in the
  AMap console) and `VITE_AMAP_3D` are permitted there. The AMap web-service key stays
  server-side.
- `/_AMapService` is a local proxy that appends the server-side `AMAP_SECURITY_CODE`; the
  security code is never shipped to the browser.

### Untrusted model output

- LLM output is treated as untrusted input. Proposed stops must exist in the local POI
  catalog and have coordinates; stay durations are clamped; budget, timing and walking
  distances are recomputed locally before a tour script reaches the UI. A manipulated
  prompt can influence generated narration text, but cannot inject arbitrary stops or
  coordinates.
- Incoming request bodies are size-limited (64 KB for `/api/agent/plan`, 8 KB for
  `/api/agent/config`) and `/api/agent/plan` is rate-limited to 20 requests per minute
  per process.

### Third-party content, images and keys

- Review screenshots, logs and demo images before committing them. They must not contain
  API keys, tokens, personal data, local file paths or browser profile information; if
  they do, retake or redact the image.
- Map tiles, place photos and walking routes come from AMap at runtime; POI summaries
  cite their sources (OpenStreetMap, Wikipedia, Wikidata, OSM Nominatim). Only commit
  media you have the right to redistribute, and keep the required attribution.
- Keep AMap JS API keys restricted to your local origins and rotate them if a domain
  restriction changes.

### If a key is exposed

**Rotate exposed keys immediately.** Revoke and regenerate the key in the DeepSeek or
AMap console, update `.env.local`, and review usage/billing for abuse. If the key was
committed, remove it from the repository history (for example with `git filter-repo`);
deleting it in a later commit does not undo the exposure. Then report the exposure so the
project can check for leaked material.

## Out of scope

- Issues that require control of the user's machine, local network or browser extensions.
- Vulnerabilities in third-party services (DeepSeek, AMap, OpenStreetMap, Wikipedia):
  report those to the respective provider.
- Hardening for public internet exposure. The middleware is intended for local use on the
  loopback interface; running it as a public service without additional authentication,
  rate limiting and secret management is not supported.
- Missing security headers or TLS on the local development server.
