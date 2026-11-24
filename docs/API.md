# HTTP API

The Chengdu planner exposes a small same-origin JSON API from the Vite middleware in `server/agent/`.
It is available while running `npm run dev` (port 5178) or `npm run preview` (port 5179). The prefix is
`/api/agent`; Vite strips it before the handler sees the path.

General rules:

- Requests and responses are JSON (`content-type: application/json; charset=utf-8`).
- Response bodies are never cached (`cache-control: no-store`).
- API keys are read from server-side environment variables and are never returned to the client.
- Request bodies are limited to 64 KB; the settings endpoint to 8 KB.
- `/plan` is rate-limited to 20 requests per minute per process (in-memory).
- Error messages are sanitized: keys are redacted and messages are capped at 300 characters.

---

## `GET /api/agent/health`

Reports whether the server has keys configured and how large the candidate catalog is.

```json
{
  "ok": true,
  "configured": true,
  "amap_configured": true,
  "model": "deepseek-chat",
  "catalog_size": 19,
  "coords_size": 19
}
```

| Field | Meaning |
| --- | --- |
| `configured` | `DEEPSEEK_API_KEY` is present |
| `amap_configured` | `AMAP_WEB_KEY` is present |
| `model` | Configured DeepSeek model name |
| `catalog_size` | POIs loaded from the Chengdu route catalog |
| `coords_size` | POIs with usable WGS84 coordinates (AI candidates) |

---

## `POST /api/agent/plan`

Turns one sentence into a validated `tour_script` 1.1.0.

### Request

```json
{
  "text": "成都4小时，多看历史人文景点，5个景点以上",
  "city": "chengdu",
  "lang": "en"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | 1–1000 characters; `prompt` and `query` are accepted as aliases |
| `city` | string | no | Only `chengdu` is supported in this edition |
| `lang` | string | no | `zh` (default) or `en`; controls the language of AI-written reasons and intros |

### Success response (`200`)

```json
{
  "ok": true,
  "source": "llm",
  "model": "deepseek-flash",
  "elapsed_ms": 1800,
  "ai_elapsed_ms": 1500,
  "intent": {
    "budget_min": 240,
    "interests": ["历史"],
    "constraints": [],
    "pace": "balanced",
    "min_stops": 5
  },
  "stops": [
    { "poi_id": "cd-106", "why": "…", "intro": "…", "stay_min": 25 }
  ],
  "route_reason": "…",
  "cut_stops": [],
  "script": { "schema_version": "1.1.0", "request": {}, "route": [], "meta": {} },
  "warnings": []
}
```

`script` is the complete, schema-validated document the browser renders. `cut_stops` lists stops dropped to
respect the budget. `warnings` may include things like "AMap walking unavailable, straight-line estimate used".

### Failure response (`200`)

Failures intentionally use HTTP 200 with `ok: false` so the front end can fall back without treating the
response as an exception.

```json
{ "ok": false, "code": "TIMEOUT", "message": "…", "elapsed_ms": 20001 }
```

| `code` | Meaning |
| --- | --- |
| `EMPTY_TEXT` | No planning text was provided |
| `TEXT_TOO_LONG` | Text exceeds 1000 characters |
| `CITY_UNSUPPORTED` | City other than `chengdu` requested |
| `NOT_CONFIGURED` | `DEEPSEEK_API_KEY` missing on the server |
| `CATALOG_FAILED` | The Chengdu catalog could not be loaded |
| `INVALID_JSON` | Request body or model output is not valid JSON |
| `NO_CANDIDATES` | Model returned too few usable stops |
| `SCHEMA_INVALID` | Composed script fails the `tour_script` schema |
| `COMPOSE_FAILED` | Composer could not assemble the script |
| `TIMEOUT` | DeepSeek request exceeded the timeout |
| `RATE_LIMITED` | More than 20 planning requests per minute |
| `METHOD_NOT_ALLOWED` | Wrong HTTP method |
| `INTERNAL` | Unexpected server error |

---

## `GET /api/agent/place?id=<poi_id>`

Returns live place details for one POI, looked up through the AMap Web service and merged with the local
POI knowledge summary.

### Example

```http
GET /api/agent/place?id=cd-101
```

```json
{
  "ok": true,
  "name": "成都杜甫草堂博物馆",
  "address": "青华路37号",
  "opening_hours": "周一至周日 09:00-18:00",
  "rating": 4.8,
  "tel": "028-68921800",
  "photos": [{ "url": "https://…", "source": "amap" }],
  "intro": "…",
  "source": "amap"
}
```

`photos` contains at most four entries. Results are cached in memory for 10 minutes. When AMap is
misconfigured or has no match, the endpoint still returns `200` with `ok: false` and an optional local
`intro`, so the detail panel can degrade gracefully.

| `code` | Meaning |
| --- | --- |
| `MISSING_ID` | No `id` query parameter |
| `POI_NOT_FOUND` | The id is not in the Chengdu catalog |
| `NO_AMAP_KEY` | `AMAP_WEB_KEY` is not configured |
| `AMAP_TIMEOUT` / `AMAP_ERROR` | AMap request failed |
| `NO_MATCH` | AMap returned no confident match |
| `NO_POI` / `PLACE_ERROR` | Invalid POI or unexpected error |

---

## `POST /api/agent/config`

Writes API keys to `.env.local` for the in-app settings dialog. **Only requests from loopback addresses are
accepted** (`127.0.0.1`, `::1`). Keys are written but never echoed back.

### Request

```json
{ "DEEPSEEK_API_KEY": "sk-…", "AMAP_WEB_KEY": "…" }
```

Only `DEEPSEEK_API_KEY` and `AMAP_WEB_KEY` are editable. Values are trimmed, length-limited and must not
contain newlines.

### Success response

```json
{
  "ok": true,
  "written": ["DEEPSEEK_API_KEY"],
  "configured": true,
  "amap_configured": true,
  "model": "deepseek-chat",
  "base_url": "https://api.deepseek.com"
}
```

| `code` | Meaning |
| --- | --- |
| `NO_KEYS` | Nothing to write |
| `BAD_VALUE` | A value is malformed (too long or contains newlines) |
| `INVALID_JSON` | Body is not a JSON object |
| `FORBIDDEN` / `LOCAL_ONLY` | Request did not come from loopback |
| `WRITE_FAILED` | `.env.local` could not be written |
| `CONFIG_ERROR` | Unexpected error while applying settings |

`VITE_AMAP_KEY` is a browser-side variable and is not editable through this endpoint; set it in `.env.local`
and restart the dev server, or paste it in the settings dialog (stored in `localStorage`).

---

## Security notes

- Keep `.env.local` out of git; it is already in `.gitignore`.
- `/api/agent/config` is loopback-only by design. Do not expose the dev/preview server to the public internet.
- If a key is ever committed or shared, rotate it immediately in the DeepSeek / AMap consoles.
- See [SECURITY.md](../SECURITY.md) for how to report a vulnerability.
