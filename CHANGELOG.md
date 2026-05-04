# Changelog

All notable changes to AI Cost & Usage Tracker.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/).

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
- `web_accessible_resources`: scope the kofi / qol-badge / patchnotes assets
  to `claude.ai` only (the only origin that loads `notification_card.js`).

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
- ChatGPT and Gemini webRequest URL patterns flagged stale in `CLAUDE.md`
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
