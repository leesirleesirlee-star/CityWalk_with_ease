# Data sources and attribution

The planner is only as trustworthy as its data. This page records where every kind of content comes from,
what its license is, and which parts are explicitly **not** verified.

## 1. Chengdu POI dataset

| Item | Value |
| --- | --- |
| File | `data/cities/chengdu/pois.geojson` |
| Features | 24 |
| With WGS84 coordinates | 19 |
| Without coordinates (`unmatched`) | 5 — kept on purpose, never invented |
| Coordinate system | WGS84 |
| Bounding box | `103.95, 30.55 → 104.20, 30.75` (downtown Chengdu) |

### Sources of coordinates

| Group | Count | Source | Notes |
| --- | --- | --- | --- |
| Original attractions (`cd-001`–`cd-010`) | 10 | OpenStreetMap / Overpass API | 5 matched, 5 `unmatched` |
| Route POIs (`cd-101`–`cd-114`) | 14 | Wikipedia / Wikidata / OSM Nominatim | Recorded per POI in `coord_source_detail` |

The 14 route POIs are: Du Fu Thatched Cottage, Qingyang Palace, Wenshu Monastery, Jinsha Site Museum,
Sichuan Museum, Chengdu Museum, Tianfu Square, Chunxi Road, Anshun Bridge, Huanhuaxi Park, Hejiang Pavilion,
Yongling Museum, Wenshufang and Pinganqiao Catholic Church.

### Knowledge files

| Directory | Contents |
| --- | --- |
| `knowledge/attractions/chengdu/` | 10 attraction summaries for the original POIs |
| `knowledge/route-pois/chengdu/` | 14 route-POI files with summary, tags, sources |
| `knowledge/reviewed/chengdu-sources.json` | Reviewed source registry |

Every newly added route POI carries `verification_status: "pending"`. The UI displays this status and
does not claim official verification. If you add POIs, keep the same discipline: record `source_urls`,
keep the status honest, and never invent coordinates.

## 2. Route contract

| Item | Value |
| --- | --- |
| Schema | `knowledge/tour_script.schema.json` |
| Version | `1.1.0` |
| Validator | `tools/schema-check.mjs` (zero dependencies) |

## 3. Map, photos and walking routes

| Item | Source | License / terms |
| --- | --- | --- |
| AMap basemap, markers, walking routes | AMap (高德地图) JS API 2.0 | AMap open-platform terms; requires a JS API key |
| Place photos, address, hours, rating | AMap Web service | AMap terms; photos are user-generated and fetched live, never redistributed here |
| Schematic fallback map | This project | MIT |

Screenshots in `docs/screenshots/` were captured from a local demo with AMap tiles and place photos.
They are documentation only; map data and place photos remain © AMap and are not re-licensed by this repository.

## 4. AI-generated content

- DeepSeek selects stops, orders them, writes a reason per stop and a 30–80 character intro.
- The intro is grounded in the POI summary provided in the prompt; it is **not** live web research and is
  labelled "not individually verified" in the UI.
- Narration and editorial copy are original content, not official guides.
- The final route order is the model's; deterministic rules only validate, compress or truncate.

## 5. Licenses of open data

| Data | License | Attribution |
| --- | --- | --- |
| OpenStreetMap data | ODbL 1.0 | © OpenStreetMap contributors |
| Wikipedia text | CC BY-SA 4.0 | Wikipedia contributors, per-article attribution in `source_urls` |
| Wikidata facts | CC0 | Wikidata contributors |
| OSM Nominatim geocoding | ODbL 1.0 | © OpenStreetMap contributors |

When reusing this repository's data in a product, keep the upstream attribution above and comply with each
upstream license. The repository's own source code is MIT-licensed (see `LICENSE`).

## 6. What this repository does not contain

- 3D city models, street-level 3D tiles or Gaussian splats.
- Helsinki / Lyon / Paris experiments from the original research repository.
- Panorama images; only publicly licensed or self-authored 360° images may ever be added.
- Any API key, secret or personal data.
