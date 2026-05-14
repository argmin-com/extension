# Changelog

All notable changes to AI Cost & Usage Tracker.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Added a page-context capture path for ChatGPT, Gemini, and Mistral browser
  inference requests so usage can still be recorded when provider endpoints or
  `webRequest` body visibility drift.
- Hardened ChatGPT stream parsing for JSON-patch response chunks and object
  content parts.
- Expanded service-provider tier detection from account payloads and visible UI
  so ChatGPT, Gemini, and Mistral plan settings are inferred more reliably.
- Kept live `StoredMap` caches synchronized when extension storage is cleared,
  preventing stale service-worker state from leaking between browser sessions
  or tests.

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
