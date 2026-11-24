## Summary

<!-- Describe the change in one or two sentences. What problem does it solve? -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behaviour)
- [ ] Documentation only
- [ ] Tests / CI / build
- [ ] POI data or knowledge (list sources and verification status below)
- [ ] Refactor (no functional change)

## Related issue

<!-- e.g. Closes #123, Refs #45. Write "None" if there is no related issue. -->

## How was this tested?

- [ ] `npm test` passes (122 tests)
- [ ] `npm run build` passes
- [ ] Manually checked in the browser with `npm run dev`
- [ ] Manually checked with no API keys configured (deterministic fallback, schematic map, text-only details)
- [ ] Manually checked with `DEEPSEEK_API_KEY` and/or `AMAP_WEB_KEY` configured, if the change touches the AI planner, map or photos
- [ ] Added or updated tests for the changed behaviour

## Screenshots (UI changes only)

<!-- Before / after screenshots help reviewers a lot. Remove secrets and personal data. -->

## Checklist

- [ ] The change is limited to the scope described above.
- [ ] No API keys, tokens or `.env.local` contents are committed, and `.env.local` is still git-ignored.
- [ ] The deterministic no-API-key fallback still works.
- [ ] Tests, the `tour_script` schema or POI data were updated where behaviour changed.
- [ ] New UI copy is added in both Chinese and English.
- [ ] AI output is still validated against the POI catalog; no invented coordinates were added.
- [ ] User-facing documentation and this PR description are in English.
- [ ] `npm test` and `npm run build` pass locally, and CI is green.
