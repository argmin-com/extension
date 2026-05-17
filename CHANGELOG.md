# Changelog

All notable changes to AI Cost & Usage Tracker.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [9.8.1] - 2026-05-17

### Fixed
- Harness operator paths now work on macOS as well as Linux: claim timestamps no longer depend on GNU `date -d`, and `worker.sh` falls back to an atomic lock directory when `flock(1)` is unavailable.
- `harness/TASKS.md` backlog entries are well-formed again; the completed Perplexity/Grok tier-detection task has its own description and acceptance criteria, and `stabilize-full-suite-e2e` no longer carries duplicated metadata.
- Popup, README, privacy, and usage-insights copy now reflect all eight supported platforms and disclose every optional non-telemetry network endpoint: `api.anthropic.com`, `raw.githubusercontent.com`, and `api.frankfurter.app`.
- Node unit tests no longer emit ES-module reparsing warnings for `bg-components` and `shared` modules. Release zips explicitly exclude those test/runtime package markers.
- `package-lock.json`, `package.json`, and all source manifests are back in version sync for release packaging.

### Validation
- Added release-hygiene unit coverage for harness task metadata, supported-platform copy, optional network-call disclosure, and non-page host permission documentation.
- Re-ran `npm run verify:all`, `npm run test:harness`, and `npm run test:e2e` locally before cutting the release.

## [9.6.3] - 2026-05-14

### Fixed
- Page-context capture tests seed `tier:platform` / `tierSource:platform`
  as `manual` upfront so the SW isn't racing with auto-detection's
  storage writes during the explicit fetch. Pre-seeded for claude /
  perplexity / grok specs (the consistently flaky ones; chatgpt
  already passes reliably without this).
- Storage poll timeout on page-context capture assertions bumped from
  15s to 20s. Reflects realistic SW wake-up latency in chromium
  contention. CI Release does not include the Playwright suite, so
  this longer timeout only affects local stability runs.

### Residual risk (honest)
- Full Playwright suite still shows ~40% flake on the page-context
  capture tests under stress. Three substantial fixes have shipped
  (TOCTOU race in handleClaudeBeforeRequest, sendBackgroundMessage
  retry hardening, isContextLostError pattern narrowing), plus per-
  test isolation, longer polls, and now upfront tier seeding. Each
  has measurably reduced the flake but none has eliminated it. The
  remaining race is a SW-timing artifact in Claude's dual-handler
  design (webRequest's slow `api.getUsageData` path vs. the fast
  page-context path) and would require a substantial refactor of
  handleClaudeBeforeRequest to defer the slow snapshot work
  asynchronously. Tracked as `stabilize-full-suite-e2e` in
  `harness/TASKS.md`. Does not block CI Release.

## [9.6.2] - 2026-05-14

### Fixed
- **E2E test isolation.** Switched the Playwright `extensionContext`
  fixture from worker-scope to test-scope. Each test now gets its own
  chromium instance + service worker, eliminating cross-test SW state
  pollution. Cold-start adds ~3-5s per test (full suite ~50-60s vs
  ~25s before); worth it for reliability.
- Storage poll timeout on page-context capture assertions bumped to
  15s (was the Playwright default of 10s). The SW occasionally needs
  longer to process a `recordPlatformRequest` message under contention.

### Internal
- Multilingual keyword coverage extended in **both** classifiers
  (`bg-components/codeburn-classifier.js` and `task-classifier.js`):
  writing / summarization / translation / debugging recognized in
  French, Spanish, German, Portuguese, Italian, plus CJK markers
  (Japanese 翻訳 / Korean 번역 / Chinese 翻译) for translation. New
  unit tests cover each language.
- `notify.sh` reports outcome distinctly: `webhook ok` (HTTP 2xx),
  `webhook non-2xx`, or `webhook unreachable` (curl error). Previously
  all failures were silently swallowed by `|| true`.
- `getDebugMinLevel` / `setDebugMinLevel` validation hardened against
  prototype-pollution-style storage values (`__proto__`, etc.) and
  non-string types. Uses `Object.prototype.hasOwnProperty.call` and
  explicit `typeof === 'string'` checks.

### Residual risk
- Page-context capture e2e tests still show ~30% flake when run as a
  full suite even with per-test isolation and 15s storage poll. The
  TOCTOU race between webRequest and page-context handlers is fixed
  (v9.6.1) but a subtler SW-timing race remains, possibly between MV3
  service-worker wake-up and message dispatch under chromium e2e
  contention. Reproduction is intermittent; does not block release
  workflow (which excludes Playwright). Tracked as
  `stabilize-full-suite-e2e` in `harness/TASKS.md`.

## [9.6.1] - 2026-05-14

### Fixed
- Treat transient `browser.runtime.sendMessage` failures (`Failed to fetch`,
  `Receiving end does not exist`, closed message ports) as retryable instead of
  permanent extension-context loss. This prevents one temporary MV3 service
  worker handoff from silencing the content script for the rest of the page.
- Deduplicate Claude page-context and webRequest captures using the stable
  request identity instead of tab ID, preventing one browser call from being
  counted twice when MV3 handoff metadata differs or Claude's API snapshot
  fallback resolves after the page-context capture.
- Updated the context-loss unit test to distinguish definitive runtime
  invalidation from retryable sendMessage errors.

## [9.6.0] - 2026-05-14

### Added
- **Per-level debug filtering.** New "Minimum level" dropdown in the Tools
  tab (debug / warn+error / error only). When debug mode is on, entries
  below the chosen threshold are dropped at the gate instead of filling
  the buffer. Default `debug` preserves prior behavior.
- **Multilingual upsell-text filter** in `tierFromText` strict mode.
  Covers English (existing), French, Spanish, German, Portuguese,
  Italian, Japanese (アップグレード, プランを変更), Korean
  (업그레이드), and Chinese Simplified (升级到, 更改方案). Conservative
  by design -- prefers to miss an upsell match than to wrongly suppress
  account-menu text on a paid user.
- **Harness integration smoke test** (`tests/harness/smoke.test.sh`,
  wired as `npm run test:harness`). Exercises the operator entrypoint,
  atomic claim with live-PID rejection, release back to pending, and
  one full cycle through the noop worker. Runs anywhere -- no API
  keys, no network, no clean tree required.
- **Noop worker adapter** (`harness/scripts/invoke-noop.sh`) used by
  the smoke test. Always exits zero with no diff.

### Changed
- `worker.sh` now fires `notify.sh` from the release-on-exit trap so
  cycle outcomes (completed / aborted / needs-review) actually emit a
  notification when `ARGMIN_HARNESS_WEBHOOK` is configured. Safe-by-
  default behavior unchanged when no webhook is set.
- `worker.sh` honors two test-only escape hatches:
  `HARNESS_ALLOW_DIRTY=1` lets the smoke test run against a dirty
  working tree; `HARNESS_SMOKE_MODE=1` skips the verifier + commit +
  push phases so the smoke test does not depend on network or a green
  codebase. Production runs (no env vars) keep the strict gates.
- E2E content-script capture tests assert `>= 1` rather than `=== 1`
  on the page-context event count. Some platforms make a hydration
  fetch before the test's explicit fetch lands; the storage-side
  `requests` assertion remains strict so background-side dedupe is
  still verified. Stabilizes the full Playwright suite (9/9 reliably).

### Internal
- New `tests/unit/classifier-alignment.test.mjs` asserts that the
  typing-time `task-classifier` and the post-turn `codeburn-classifier`
  agree on the primary category for 11 representative consumer prompts.
  Catches divergence between the two without forcing a behavioral
  refactor.

### Residual risk
- Full Playwright suite still shows intermittent failures (~30%) on
  the page-context-capture tests for claude / perplexity / grok where
  the storage `requests` assertion times out at 0. Each test passes
  reliably in isolation; the flake appears when the suite runs together
  and a downstream SW write doesn't land within the poll window. Event-
  count assertions and unit tests are stable. CI Release workflow does
  not include the Playwright e2e suite, so this does not block releases.
  Open task `stabilize-full-suite-e2e` in `harness/TASKS.md` tracks the
  next investigation step.

## [9.5.0] - 2026-05-14

### Added
- **Time-boxed debug logging.** New Tools-tab panel with four preset
  durations (15 min / 1 h / 4 h / 24 h) plus an Off button. Stamps
  `debug_mode_until` in storage; `isDebugEnabled()` automatically flips
  back to off once the deadline passes. No rolling timer needed.
- **Opt-in sanitized error reports.** New Tools-tab panel that captures
  every warn-/error-level log entry to a sanitized ring buffer (max 500
  entries) when the user explicitly enables it. The user can download
  the buffer as a JSON file to share when filing a bug. Disabling
  clears the buffer. Per AGENTS.md rule #1, there is no automatic
  upload -- delivery is a manual download by the user. Captures persist
  across SW restarts and are independent of debug-mode duration.
- **Lightweight autonomous harness.** New `harness/` directory with
  `HARNESS.md` (operating doctrine), `TASKS.md` (durable backlog),
  `harnessctl.sh` (operator entrypoint), `scripts/worker.sh` (one full
  cycle: claim → invoke worker → verify → commit + push), `loop.sh`,
  `claim.sh` (30-minute lease with PID liveness check), `release.sh`,
  `verify.sh`, and adapter scripts for both Claude Code (`invoke-claude.sh`)
  and Codex (`invoke-codex.sh`). Workers are interchangeable; the
  harness owns scheduling, gates, and promotion. New
  `.github/workflows/harness.yml` supports manual dispatch and guarded
  nightly runs when `HARNESS_NIGHTLY_ENABLED=true` (worker / task slug /
  max cycles).
- One-shot legacy migration that strips `promptPreview` from any
  pre-v9.4.0 `pendingRequests` entries still sitting in
  `chrome.storage.local` after upgrade. Idempotent.
- Added first-class **Perplexity** and **Grok** platform support across
  manifests, page-context fetch / XHR capture, webRequest URL patterns,
  popup tier controls, in-page badges, platform limits, local pricing,
  model aliases, and carbon / energy model mapping.
- Added Perplexity Sonar request-fee accounting so Sonar / Sonar Pro
  estimates include both token cost and the documented per-request search
  fee instead of undercounting search-backed calls.
- Added a platform-coverage audit (`scripts/check-platform-coverage.js`)
  to fail CI if a future provider is added to one surface without matching
  manifests, interception, popup, tier, and content-script support.
- Added time-boxed Debug Mode controls and an opt-in sanitized Error Report
  buffer that users can download locally when filing bugs. Reports are never
  uploaded by the extension.
- Added a verifier-gated extension harness with task claims, local run
  evidence, manual dispatch, and guarded nightly workflow support for future
  autonomous maintenance cycles.
- Added Playwright page-context capture coverage for Perplexity and Grok,
  plus unit coverage for their SSE parsers, tier detection, aliases, and
  request-fee accounting.

### Changed
- Updated ChatGPT pricing/model comparison tables for GPT-5.5, GPT-5.4,
  and GPT-5.4 mini based on the current public API rate card.
- The Today overview platform count now uses the actual configured
  platform total instead of a stale hard-coded `/4` denominator.

## [9.4.1] - 2026-05-13

### Added
- Subscription-tier auto-detection now exposes its **source** (`auto` /
  `manual` / `unset`) via a new `getSubscriptionTierSource` background
  handler. The popup renders a small badge next to each Plan select so
  the user can tell at a glance where the current value came from.
- API-based tier detection added for **Gemini** and **Mistral** (both
  were DOM-only before). Each platform now probes multiple plausible
  account/entitlement endpoints with credentials, falls back to
  scraping visible account/plan UI, and only writes a value when the
  signal is conclusive. Inconclusive runs leave the prior value in
  place rather than guessing.
- Claude API path now recognizes **Enterprise** via `org_growthbook.org`
  signals (`isEnterprise`, `is_enterprise`, `subscription_tier ===
  'enterprise'`, `account_type === 'enterprise'`, `product ===
  'enterprise'`, `plan === 'enterprise'`). Multiple shapes covered
  because the field has migrated across releases.

### Changed
- **Manual overrides are now sticky.** When the user picks a tier in the
  popup, that selection is marked `source: 'manual'` and auto-detection
  on subsequent page loads refuses to overwrite it. A `warn` log records
  the auto-detect skip so we can see when detection disagrees with the
  user. The user changes it back by picking a different value (or the
  same one) in the popup, which re-writes with `source: 'manual'`.
- Unified tier cache TTL across all platforms to **1 hour** (was: 6h for
  ChatGPT, 24h for Claude, none for Gemini / Mistral). Short enough that
  a plan upgrade is reflected on the next page load within the hour,
  long enough to absorb cross-tab churn.
- Strict-mode upsell-text filtering generalized to catch
  brand-interrupted CTAs ("Get Claude Pro today", "Try Gemini Advanced
  for free") in addition to contiguous variants. Every platform now has
  strict-mode filtering on its DOM-fallback path.
- Tier-detection storage now records a sibling `tierSource:${platform}`
  field and a `tierSetAt:${platform}` timestamp so the UI and any future
  diagnostics can distinguish a stale auto value from a fresh manual one.

### Residual risk
- DOM-fallback detection remains heuristic. If a provider redesigns its
  account menu, ships a new tier name we don't recognize, or pushes a
  language we don't have keywords for, the fallback can return `null`
  (which preserves the prior value) but cannot self-correct. The
  authoritative-API paths reduce reliance on this fallback to roughly
  the failure modes where the provider's account endpoints themselves
  reject the request.

## [9.4.0] - 2026-05-13

### Security & Privacy
- Stopped persisting the user's raw Claude prompt text to `chrome.storage.local`
  via `pendingRequests`. The capture path now holds prompt text in an in-memory
  Map keyed by `org:conversation` and reclaimed after activity classification
  (or after a 10-minute TTL). Closes a regression of AGENTS.md rule #2 ("no
  content capture") that the prior comment claimed was already in force.
- Added a regression guard in `scripts/audit-debug-privacy.js` and a unit test
  in `tests/unit/privacy-invariants.test.mjs` that fail the build if any
  background-side `StoredMap.set` object literal carries a raw-content field
  (`promptPreview`, `promptText`, `completion`, `responseText`, etc.).

### Added
- Activity classifier now recognizes consumer / knowledge-worker intents:
  `writing` (email drafting, replies, polish), `summarization`, `translation`,
  `research`, `learning`, `creative`, and `data_analysis`. These flow into the
  popup's existing Activity Breakdown so adoption-rate-style percentages are
  visible without UI changes. Model-fit suitability is tuned per new category.
- Added an Insights tab with a daily digest, provider mix, 30-day model
  leaderboard, capture reliability, data-quality warnings, plan/budget status,
  privacy posture, and configurable local retention without storing prompt or
  completion text.
- Added capture-source attribution for platform usage records (`webRequest`,
  page context, output stream, Claude API, fallback, and legacy) so users can
  see whether totals came from primary interception paths or fallbacks.
- Added a local retention cleanup action for stale platform days, session turns,
  session metadata, and decision events.
- Typing-time `task-classifier` now mirrors the post-turn `codeburn-classifier`
  consumer categories (writing, translation, research, learning, data_analysis),
  so the Smart-UI cost-preview recommendation and the Activity Breakdown agree
  on what kind of work a prompt represents.
- Distinct **Enterprise** tier for ChatGPT and `claude_enterprise` for Claude,
  detected separately from Team so SAML / custom-contract workspaces are no
  longer collapsed into the Team bucket. Limit defaults and popup tier dropdown
  updated to match.
- Unit coverage for tier-detection helpers (`tierFromText`, `collectPlanSignals`,
  `tierFromPayload`) including realistic ChatGPT `/backend-api/me` payload
  shapes and strict-mode upsell-text filtering.

### Changed
- `collectPlanSignals` now recurses into object children regardless of key
  hint, which lets `tierFromPayload` see plan info nested under non-plan
  wrapper keys (e.g. ChatGPT's `accounts.default.entitlement.subscription_plan`).
  Previously enterprise / pro shapes from real account payloads were silently
  dropped at the `default` wrapper.
- `parseRequestBody` now understands `webRequest`'s pre-parsed
  `requestBody.formData` shape, so URL-encoded POSTs no longer fall through
  to the "body could not be parsed" warning.
- Body-parse failure log now includes URL pathname, capture source
  (`webRequest` vs `page-context`), body shape (`json-text` / `urlencoded` /
  `multipart` / `binary` / `empty`), raw byte length, and tab id. Empty,
  multipart, and binary bodies are demoted to `debug` since they are common
  and not actionable; only genuinely unexpected shapes raise a warning.
- Skip the body-parse path entirely for known non-inference endpoints
  (`/ces/v1/*`, `/sentinel/*`, `/backend-api/files`) so telemetry traffic
  no longer produces parse warnings.
- Content-script `window.error` / `unhandledrejection` listeners now detect
  extension-context-lost patterns (`Failed to fetch`, `Extension context
  invalidated`, `Receiving end does not exist`, `Could not establish
  connection`, `The message port closed`) and emit a single summary line
  instead of one error per polling tick.
- `LengthUI.checkConversationChange` now `await`s `sendBackgroundMessage` and
  swallows the rejection locally, removing the unhandled-rejection cascade
  that the page-level error listener used to loop on.
- Background `logError` coalesces error + stack into one structured log
  entry (was three lines) and short-circuits once the runtime is invalidated.
- Alarm-fired log demoted to `debug`. Reset-notification check logs only when
  it has work to do (scheduled entries to evaluate) or when a notification
  actually fires.
- Service-worker initialization now emits a single structured checkpoint
  (`version`, `isElectron`, registered platforms, drained pending-task count)
  so debug logs make it possible to tell from one line whether the SW
  reached steady state.

### Fixed
- Added a page-context capture path for ChatGPT, Gemini, and Mistral browser
  inference requests so usage can still be recorded when provider endpoints or
  `webRequest` body visibility drift.
- Added Claude page-context request capture plus a local `webRequest` fallback
  so Claude browser calls are still counted when the Claude API usage snapshot
  or follow-up conversation read is unavailable.
- Extended page-context XHR capture to Claude and Mistral, matching the existing
  fetch capture path.
- Hardened ChatGPT stream parsing for JSON-patch response chunks and object
  content parts.
- Expanded service-provider tier detection from account payloads and visible UI
  so ChatGPT, Gemini, and Mistral plan settings are inferred more reliably.
- Kept live `StoredMap` caches synchronized when extension storage is cleared,
  preventing stale service-worker state from leaking between browser sessions
  or tests.
- Unified popup cost rendering and plan/budget spend calculations around the
  canonical platform usage store so Today, History, Plan, and decision budget
  totals agree for the same moment.
- Added TTLs and post-response local fallback handling for Claude pending
  requests so failed Claude API follow-up reads do not leave stale pending
  entries or drop usage.
- Hardened platform usage accounting against older stored records that do not
  contain per-model buckets.
- Corrected stale popup copy that referred to a non-existent Settings tab and
  fixed the History empty-state retention claim.

## [9.3.2] - 2026-05-12

### Removed
- Removed obsolete Electron-only content bridge and request polyfill files from
  the Chrome and Firefox manifests and release packages.
- Removed the stale legacy `scripts/build.js` packaging wrapper; `npm run
  release` is now the single package builder for Chrome and Firefox zips.

### Changed
- Release-package validation now fails if obsolete Electron-only bridge assets
  or the retired legacy build script are bundled again.

## [9.3.1] - 2026-05-12

### Fixed
- Corrected the package metadata description so the public package no longer
  describes unrelated vendored dependency documentation.
- Removed stale upstream release links from update notifications; release notes
  now point to `argmin-com/extension`.
- Replaced the CI message-handler count dependency on internal assistant docs
  with a dedicated `npm run check:handlers` guard.

### Changed
- GitHub Releases now publish both Chrome and Firefox zip packages.
- `npm run release` now builds both browser packages; `release:chrome` and
  `release:firefox` remain available for single-target builds.
- Browser manifest author metadata now reflects Argmin.
- Removed donation and cross-promotion UI from the popup and Claude sidebar so
  the extension presents as a focused product surface.
- Removed internal PRD, agent, and orchestration harness documentation from the
  public repository surface while preserving validation and release tooling.

### Validation
- Release validation now installs dev tooling, builds both browser packages,
  checks zip integrity/content, and runs Firefox `web-ext lint` with warnings
  as errors.

## [9.3.0] - 2026-05-04

### Visual polish
- **Header redesigned** with a gradient brand mark, accent rule across the
  top (Claude → ChatGPT → Gemini → Mistral), tighter typography, and
  banner-role landmark.
- **Tabs redesigned** as an underline indicator instead of a fill — more
  refined, easier to read, and less visually noisy.
- **Platform cards** on the Today tab now show a colored glyph (rounded
  square with the platform initial) alongside the platform name. Each
  card uses a CSS custom property for its accent color, so its left
  rule, hover ring, and cost figure all stay in sync.
- **Empty state** on the Today tab now has a subtle SVG glyph, a strong
  title, and a short detail line, instead of two stacked sentences.
- **Skeleton loaders** replace the bare "Loading..." text on first paint
  of the Today tab; shimmer respects `prefers-reduced-motion`.
- **Buttons** redesigned: gradient primary / secondary, deeper shadow,
  inset highlight, refined hover and active states.
- **Tab content** fades and slides in on activation; respects
  `prefers-reduced-motion`.
- **Popup body** does the same fade-in on cold open.
- **Focus-visible** rings now use the accent color across tabs, selects,
  inputs, textareas, and buttons.

### Light theme parity
- Replaced every hard-coded dark-mode literal (`rgba(11,18,34,…)`,
  `rgba(15,23,42,…)`, `rgba(19,32,60,…)`, `rgba(255,255,255,0.04|0.08)`)
  in `popup.html` with CSS custom properties. New `--bg-tint` and
  `--bg-tint-strong` tokens swap to dark-on-light values when the user
  selects the light theme, so cards and hover states no longer look
  washed out or invisible in light mode.

### In-page UI polish
- **Smart UI decision panel** now has a layered gradient background,
  inset highlight, accent-aware recommendation block, refined Switch /
  Dismiss buttons, an ARIA `role="status"` + `aria-live="polite"` so
  the cost is announced as it changes, and an `opacity` + `transform`
  transition with reduced-motion respect.
- **Platform usage badge** (ChatGPT / Gemini / Mistral) gets a layered
  gradient, inset highlight, refined header divider, and a subtle hover
  shadow.

### Build / housekeeping
- `package.json` and both manifests bumped to `9.3.0`.
- All validation gates green: `node --check`, `npm run audit` (zero
  warnings, strict-fail on every UI surface), `npm test` (27/27),
  `messageRegistry.register` count = 69, JSON parse on both manifests
  and `_locales/en/messages.json`.

## [9.2.0] - 2026-05-04

### UX
- New light theme alongside dark, plus an "Auto" mode that follows
  `prefers-color-scheme`. Theme is selectable from the Settings tab and
  persisted in popup-origin localStorage so it applies before paint
  (`theme-init.js`) and avoids a flash of the wrong theme.
- Loading failures now render a real error block (`role="alert"`) with the
  failure message and a "Try again" button that re-runs the original
  loader, instead of bare `Error: ...` text. Wired up to the Sessions,
  Optimize, Compare, and Plan tabs.

### Internationalization
- `_locales/en/messages.json` scaffolded. `manifest.json` and
  `manifest_chrome.json` now reference `__MSG_extName__`,
  `__MSG_extDescription__`, `__MSG_actionTitle__`,
  `__MSG_openPopupShortcut__`, and `__MSG_toggleBadgeShortcut__` with
  `default_locale: "en"`. The Chrome Web Store will pick up the
  description from `_locales/`, and adding new locales is now a
  drop-in operation.

### Privacy regression guard
- `popup.js` and `debug.js` are now in the strict-fail set of the
  `innerHTML` template-literal scanner. Every interpolation in
  `popup.js` was rewritten to either `textContent` /
  `createElement` (when building HTML chunks) or to wrap values in
  `escapeHtml` / `Number` / formatter helpers. The audit no longer
  emits warnings for any UI surface.

### Build
- `scripts/release-build.js` now bundles `_locales/` and
  `theme-init.js` into the Chrome zip.

## [9.1.0] - 2026-05-04

### Security & Privacy
- Replace `innerHTML` template-literal interpolation with `textContent` /
  `createElement` in `content-components/length_ui.js`,
  `content-components/usage_ui.js`, and `content-components/platform_content.js`.
  Dynamic values can no longer carry HTML on the AI-platform DOMs.
- `content-components/content_utils.js`: cap and validate the page-controlled
  `localStorage` `personalized_style` read used by the `getStyleId` message
  channel, so a malicious page cannot smuggle attacker data through it.
- `injections/stream-token-counter.js`: gate page-context console logging
  behind `window.__aiTrackerDebug` so fetch URLs no longer leak to the
  platform's DevTools by default.
- Manifest CSP: add `style-src`, `img-src`, `font-src`, `frame-ancestors`,
  `base-uri`, and a tight `connect-src` allowlist
  (`api.anthropic.com`, `raw.githubusercontent.com`, `api.frankfurter.app`).
- `web_accessible_resources`: scope the update patchnotes asset to `claude.ai`
  only (the only origin that loads `notification_card.js`).

### Privacy regression guard
- `scripts/audit-debug-privacy.js`: new `innerHTML` template-literal scanner.
  Strict-fail for `content-components/*` (high-risk: runs on platform DOMs);
  warn-only for `popup.js` / `debug.js`. Allowlist covers `escapeHtml`,
  `fmt*` / `format*` helpers, `Math` / `Number` / `parseInt` / `parseFloat`
  calls, `.toFixed` / `.toLocaleString` tails, and bare numeric literals.
  Each pattern is anchored `^...$` so unsafe content cannot be appended.

### Build hygiene
- `package.json` is now the single source of truth for the extension version.
  `scripts/build.js` reads it and writes it into whichever per-target
  manifest is being copied, so `manifest.json` and `manifest_chrome.json`
  cannot drift again.
- `scripts/release-build.js`: new dependency-free release builder
  (`npm run release`) that produces a Chrome zip directly via `zip` without
  needing a network install of `web-ext`.
- `scripts/check-dataclasses.js`: new CI guard that fails if
  `content-components/ui_dataclasses.js` is out of sync with
  `shared/dataclasses.js`.
- `npm run audit` aggregates `audit-debug-privacy.js` and
  `check-dataclasses.js` for one-shot pre-commit validation.

### Performance
- `bg-components/decision-orchestrator.js`: cache today's total spend across
  platforms for one second. `evaluateDecision()` runs on every keystroke;
  before this cache it re-summed `platformUsageToday` from storage on each
  call.

### UX
- `content-components/smart_ui.js`: always-visible `×` close button on the
  decision panel so the cost preview can be dismissed without click-outside.
- `popup.html`: rename the "Tools" tab to "Settings" so users can find
  budget, region, and API key controls.

### Tests
- New `tests/unit/` suite (run with `npm test`):
  - `task-classifier.test.js`: 10 cases covering empty input, code fences,
    summarization / debugging / analysis keywords, long context, confidence
    bounds, and signal cap.
  - `sse-parsers.test.js`: 17 cases covering Claude / ChatGPT / Gemini /
    Mistral SSE delta shapes. Parsers are extracted from the injection IIFE
    via `node:vm` so the tests track the shipping code byte-for-byte.

### Known limitations (deferred)
- ChatGPT and Gemini webRequest URL patterns flagged stale in internal audit notes
  ("0 requests intercepted") still need a live DevTools network capture to
  update; cannot be fixed in a headless / CI environment.
- ChatGPT SSE parser likely misses the current JSON-Patch shape on
  `message.content.parts`. Same dependency.
- `popup.js` (1140 lines) full `innerHTML` cleanup and per-tab lazy-load
  split deferred to a follow-up release.

## [9.0.1-audit] - 2026-04-09

Security audit fixes and bug fixes — see the
[GitHub release notes](https://github.com/argmin-com/extension/releases/tag/v9.0.1-audit).

## [9.0.0-audit] - 2026-04-09

Initial audited release — see the
[GitHub release notes](https://github.com/argmin-com/extension/releases/tag/v9.0.0-audit).
