# TASKS.md — argmin-com/extension harness backlog

Format: one task per level-2 heading. Status values: `pending`, `claimed`, `in_progress`, `completed`, `needs-review`, `abandoned`. The harness mutates these in place. Hand-add new tasks with status `pending`.

## seed-no-op

**Status**: completed
**Owner**: harness-bootstrap
**Lease**: 2026-05-13T00:00:00Z
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

Sentinel task that proves the harness loop can read and write this file without breaking it. Worker should do nothing and exit zero.

### Acceptance

- TASKS.md still parses
- No file changes outside this header block
- `npm run verify:all` passes

## audit-tier-detection-against-live-sites

**Status**: pending
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

The Gemini and Mistral account-API probe paths in `platform-adapters/adapters.js` are speculative (educated guesses). With a real authenticated session for each platform, verify which paths actually return JSON, and update the probe lists to reflect reality. Any path that returns a non-JSON or non-200 response in the typical authenticated flow should be removed. Add any newly discovered paths.

Same audit for Claude growthbook flag shapes in `bg-components/claude-api.js`: confirm which of the six candidate `isEnterprise`-style fields Anthropic actually exposes. Trim the list to what works.

### Acceptance

- `platform-adapters/adapters.js` probe lists contain only verified endpoints
- `bg-components/claude-api.js` enterprise detection uses the actual field Anthropic returns
- New regression tests in `tests/unit/tier-detection.test.mjs` covering whatever shapes get discovered
- `npm run verify:all` passes

## strengthen-strict-mode-upsell-filter

**Status**: pending
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

The current strict-mode upsell filter in `tierFromText` covers contiguous CTAs ("Get Plus", "Upgrade to Pro") and brand-interrupted variants ("Get Claude Pro today"). Add coverage for:

- Localized phrasings (French "Passer à Pro", Spanish "Actualizar a Pro", German "Upgrade auf Pro", Japanese "プロにアップグレード", Korean "프로로 업그레이드")
- Pricing-context phrasings ("Pro - $20/mo", "Plus from $20")
- Comparison-table phrasings ("Free | Plus | Pro" — adjacent tier names without verbs)

Each new pattern needs a unit test in `tests/unit/tier-detection.test.mjs`.

### Acceptance

- New regex patterns in `tierFromText` for each language above
- Each language has at least one unit test
- Existing tests still pass
- `npm run verify:all` passes

## extend-classifier-multilingual

**Status**: pending
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

`bg-components/codeburn-classifier.js` and `bg-components/task-classifier.js` recognize English keywords only. Add non-English variants for the highest-volume categories: `writing`, `summarization`, `translation`, `research`, `coding`, `debugging`. At minimum support: French, Spanish, German, Portuguese, Japanese, Chinese-simplified.

### Acceptance

- New keyword arrays per language per category
- Unit tests in `tests/unit/codeburn-classifier.test.mjs` and `tests/unit/task-classifier.test.mjs`
- `npm run verify:all` passes

## perplexity-and-grok-tier-detection

**Status**: completed
**Owner**: harness-parallel
**Lease**: (released)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

## stabilize-full-suite-e2e

**Status**: pending
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

`tests/e2e/content-script.spec.js` passes 5/5 when run in isolation (3 consecutive runs verified), but the claude and grok page-context-capture tests intermittently fail when the full Playwright suite runs together. Same pattern as the ChatGPT pollution issue resolved in v9.4.0 (250ms drain + StoredMap onChanged sync) — likely a debounced StoredMap write from one spec landing during another spec's fixture clear. Investigate which spec leaves state behind and either add the same drain pattern or harden the storage fixture to handle the race more robustly.

### Acceptance

- `npm run test:e2e` passes all specs across 10 consecutive runs
- No `page.waitForTimeout` added beyond what is structurally necessary
- `npm run verify:all` still passes
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: 2026-05-13T00:00:00Z

### Description

The manifests now include Perplexity and Grok in `content_scripts`, but `platform-adapters/adapters.js`'s `TIER_DETECTION` map has no entry for either. Add detection for Perplexity (Free vs Pro) and Grok (Free vs SuperGrok vs Heavy) following the existing API-then-DOM pattern. Update `PLATFORM_LIMITS` and the popup tier dropdown to cover both.

### Acceptance

- Perplexity and Grok have `TIER_DETECTION` entries with API probes and DOM fallback
- `PLATFORM_LIMITS` populated for Perplexity (free / pro) and Grok (free / supergrok / heavy)
- Popup tier dropdown shows entries for both platforms
- Unit tests covering tier strings for both
- `npm run verify:all` passes
