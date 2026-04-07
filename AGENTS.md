# AGENTS.md
# AI Cost & Usage Tracker — Chrome Extension

## Quick Reference

- **Repo:** `argmin-com/extension`
- **Version:** 9.0.0
- **Language:** JavaScript (no build step, no bundler)
- **Runtime:** Chrome Extension Manifest V3
- **Total:** 31 JS files, 8,509 lines
- **Entry points:** `background.js` (service worker), `content_utils.js` (content scripts), `stream-token-counter.js` (page-context injection via `world: "MAIN"`)

## What This Extension Does

Multi-platform AI cost, usage, energy, and carbon tracker for Codex, ChatGPT, Gemini, and Mistral. Intercepts API traffic locally, counts tokens, estimates cost using published pricing, estimates energy/carbon using AI Energy Score benchmarks, and provides decision-time intelligence (cost preview, model recommendations, anomaly detection, budget alerts). All data stays in the browser. The only optional external call is to the Anthropic API for more accurate Codex token counting.

## Architecture

```
SERVICE WORKER (background.js, 847 lines)
├── bg-components/utils.js          — CONFIG, StoredMap, Log, sanitizer, MessageRegistry
├── bg-components/Codex-api.js     — Codex API client, conversations, usage, sync
├── bg-components/tokenManagement.js — Token counting (local o200k + Anthropic API)
├── bg-components/carbon-energy.js  — Energy estimation, carbon, receipts, model comparison
├── bg-components/decision-engine.js — Recommendations, anomaly detection, budgets, preview
├── bg-components/platforms/
│   ├── platform-base.js            — PlatformUsageStore, LimitForecaster, calibration
│   └── intercept-patterns.js       — URL patterns for webRequest per platform
└── bg-components/electron-compat.js — Electron/desktop compatibility

CONTENT SCRIPTS (per platform tab, loaded by manifest)
├── content-components/content_utils.js — Init, globals, platform detection, messaging
├── content-components/platform_content.js — Floating badge (non-Codex platforms)
├── content-components/smart_ui.js  — Cost preview, recommendation chips, anomaly toasts
├── content-components/usage_ui.js  — Codex sidebar panel
├── content-components/length_ui.js — Codex conversation length display
├── content-components/notification_card.js — Codex settings panel
├── content-components/ui_dataclasses.js — Generated dataclasses
└── content-components/electron_receiver.js — Electron bridge

PLATFORM ADAPTERS
└── platform-adapters/adapters.js   — DOM selectors, composer observation, tier detection

PAGE-CONTEXT INJECTIONS (world: "MAIN", document_start)
├── injections/stream-token-counter.js — fetch() wrapper, SSE parser ×4 platforms
└── injections/webrequest-polyfill.js — Electron fetch wrapper

UI
├── popup.html / popup.js           — Today + History + Tools tabs
└── debug.html / debug.js           — Debug log viewer
```

## Message Registry

45 handlers total (40 string-keyed, 5 function-keyed). The message registry in `bg-components/utils.js` validates sender origin. All message types are documented in the PRD appendix.

## Key Technical Constraints

1. **Fail-open is absolute.** No code path may block, delay, or degrade the user's ability to send messages on any platform. All UI interventions must be non-blocking and dismissible.

2. **Local-only by default.** No external network calls except to the AI platforms themselves (via the user's own browser session). The optional Anthropic API call requires explicit opt-in with a consent dialog.

3. **world: "MAIN" injection.** `stream-token-counter.js` runs in the page context at `document_start` to wrap `window.fetch` before platform JS loads. This is the only way to intercept SSE streams for output token counting. The `__aiTrackerStreamWrapped` guard prevents double-wrapping.

4. **Content scripts are globals-based.** No ES modules in content scripts. All inter-file communication uses global variables and `browser.runtime.sendMessage`.

5. **Platform DOM selectors are fragile.** `platform-adapters/adapters.js` uses ordered fallback selectors. Platforms change their DOM frequently. When selectors break, features degrade silently.

## Known Critical Bugs (as of v9.0.0)

### ChatGPT: 0 requests intercepted
The webRequest URL patterns do not match ChatGPT's current API endpoints. The `[AI Tracker]` diagnostic logger in `stream-token-counter.js` should reveal the actual URLs in DevTools console. Fix requires updating `intercept-patterns.js` with the correct URL patterns.

### Gemini: 0 requests intercepted
Same issue as ChatGPT. The legacy `BardChatUi` path and the broader `app/_/` patterns still don't match. Needs runtime URL capture from DevTools.

### Output tokens: low or zero on all platforms
The `world: "MAIN"` injection should wrap fetch early enough, but platforms may use mechanisms other than `window.fetch` (e.g., `XMLHttpRequest`, WebSocket, or a pre-captured fetch reference from a module scope). Diagnostic: check DevTools console for `[AI Tracker] INTERCEPTING stream:` lines.

## Agent Domains (for multi-agent orchestration)

Each domain owns specific files. Agents should not modify files outside their domain without coordination.

| Domain | Files | Responsibility |
|--------|-------|---------------|
| **Core** | `background.js`, `bg-components/utils.js`, `bg-components/electron-compat.js` | Service worker, message registry, webRequest, badge |
| **Platform** | `bg-components/platforms/*` | Usage storage, cost calc, velocity, forecasting, calibration |
| **Codex** | `bg-components/Codex-api.js`, `bg-components/tokenManagement.js` | Codex API, conversations, token counting, sync |
| **Carbon** | `bg-components/carbon-energy.js` | Energy, carbon, grid intensity, receipts, model comparison |
| **Decision** | `bg-components/decision-engine.js` | Recommendations, anomaly, budgets, efficiency, preview |
| **Adapter** | `platform-adapters/adapters.js` | DOM selectors, composer observation, tier detection |
| **Content** | `content-components/content_utils.js`, `content-components/platform_content.js` | Init, stream injection, messaging, floating badge |
| **Decision UI** | `content-components/smart_ui.js` | Cost preview, recommendation chips, anomaly toasts |
| **Codex UI** | `content-components/usage_ui.js`, `length_ui.js`, `notification_card.js` | Sidebar, conversation length, settings |
| **Injection** | `injections/stream-token-counter.js`, `webrequest-polyfill.js` | Page-context fetch wrapping, SSE parsing |
| **UI** | `popup.html`, `popup.js`, `debug.html`, `debug.js` | Popup, history, tools, debug viewer |
| **Build** | `scripts/*`, `manifest.json`, `manifest_chrome.json` | Build scripts, manifest, version management |
| **Privacy** | Cross-cut (all files with `Log()` calls) | Sanitizer, debug restrictions, regression guard |

## Validation Commands

```bash
# Syntax check all JS files
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f" || echo "FAIL: $f"; done

# Privacy regression guard
node scripts/audit-debug-privacy.js

# Count handlers
grep -c "messageRegistry.register" background.js
```

## Pricing Data

All prices in `CONFIG.PRICING` (bg-components/utils.js). 14 models across 4 platforms. These are static and must be manually updated when providers change pricing.

## Carbon Methodology

AI Energy Score benchmarks (Hugging Face, Dec 2025) for Codex models. Parametric FLOPs estimation for others: `E(Wh) = 0.0001 × params_billions^0.8 × (tokens / 500)`. Grid intensity from EPA eGRID, EEA, IEA. PUE 1.2, overhead 2.0. ±30% uncertainty on all estimates. Always display in gCO₂e (no unit switching).

## Strategic Direction (from independent product review)

The extension should evolve from a **passive tracker** into a **local decision system**. The architectural target is a unified decision pipeline:

1. **Observation** — gather prompt text, platform, model, tier, spend, history
2. **Inference** — estimate tokens, cost, budget impact, viable cheaper models
3. **Policy** — decide action class: silent pass / passive hint / inline recommendation / confirmation gate / rewrite suggestion
4. **Feedback** — compare predicted vs actual, learn from user accept/reject behavior

Phase 1 (IMPLEMENTED in v9.0.0):
- `decision-orchestrator.js` — replaces separate previewCost/getRecommendation/checkBudgets/checkAnomaly with one `evaluateDecision(context)` call
- `task-classifier.js` — local rules-based prompt classification (summarization, coding, extraction, etc.)
- `policy-engine.js` — maps risk + recommendations + budgets to action classes
- `feedback-learner.js` — tracks prediction error and user responses
- `event-store.js` — request/session/user-profile state (replaces aggregate-only storage)

## Code Standards

- No em dashes in any output
- No ES modules in content scripts (globals only)
- All debug logging must go through `Log()` which applies the two-step sanitizer
- No `document.title` in debug sender labels
- No raw UUIDs/URLs in log callsites
- Every table cell in docx output must use `Paragraph` objects (not plain strings)
- `node --check` must pass on all JS files before any commit

## Files Not to Modify Without Understanding

- `bg-components/utils.js` — CONFIG, StoredMap, sanitizer, and MessageRegistry are used everywhere
- `content-components/content_utils.js` — initialization order matters; stream counter injection must happen before DOM-dependent code
- `manifest.json` — content_scripts order and world:MAIN entries are load-order-sensitive
