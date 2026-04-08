# CLAUDE.md
# AI Cost & Usage Tracker — Chrome Extension

## Quick Reference

- **Repo:** `argmin-com/extension`
- **Version:** 9.0.0
- **Language:** JavaScript (no build step, no bundler)
- **Runtime:** Chrome Extension Manifest V3
- **Total:** 31 JS files, 8,509 lines
- **Entry points:** `background.js` (service worker), `content_utils.js` (content scripts), `stream-token-counter.js` (page-context injection via `world: "MAIN"`)

## What This Extension Does

Multi-platform AI cost, usage, energy, and carbon tracker for Claude, ChatGPT, Gemini, and Mistral. Intercepts API traffic locally, counts tokens, estimates cost using published pricing, estimates energy/carbon using AI Energy Score benchmarks, and provides decision-time intelligence (cost preview, model recommendations, anomaly detection, budget alerts). All data stays in the browser. The only optional external call is to the Anthropic API for more accurate Claude token counting.

## Architecture

```
SERVICE WORKER (background.js, 847 lines)
├── bg-components/utils.js          — CONFIG, StoredMap, Log, sanitizer, MessageRegistry
├── bg-components/claude-api.js     — Claude API client, conversations, usage, sync
├── bg-components/tokenManagement.js — Token counting (local o200k + Anthropic API)
├── bg-components/carbon-energy.js  — Energy estimation, carbon, receipts, model comparison
├── bg-components/decision-engine.js — Recommendations, anomaly detection, budgets, preview
├── bg-components/platforms/
│   ├── platform-base.js            — PlatformUsageStore, LimitForecaster, calibration
│   └── intercept-patterns.js       — URL patterns for webRequest per platform
└── bg-components/electron-compat.js — Electron/desktop compatibility

CONTENT SCRIPTS (per platform tab, loaded by manifest)
├── content-components/content_utils.js — Init, globals, platform detection, messaging
├── content-components/platform_content.js — Floating badge (non-Claude platforms)
├── content-components/smart_ui.js  — Cost preview, recommendation chips, anomaly toasts
├── content-components/usage_ui.js  — Claude sidebar panel
├── content-components/length_ui.js — Claude conversation length display
├── content-components/notification_card.js — Claude settings panel
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
| **Claude** | `bg-components/claude-api.js`, `bg-components/tokenManagement.js` | Claude API, conversations, token counting, sync |
| **Carbon** | `bg-components/carbon-energy.js` | Energy, carbon, grid intensity, receipts, model comparison |
| **Decision** | `bg-components/decision-engine.js`, `bg-components/decision-orchestrator.js` | Recommendations, anomaly, budgets, efficiency, preview |
| **Adapter** | `platform-adapters/adapters.js` | DOM selectors, composer observation, tier detection |
| **Content** | `content-components/content_utils.js`, `content-components/platform_content.js` | Init, stream injection, messaging, floating badge |
| **Decision UI** | `content-components/smart_ui.js` | Cost preview, recommendation chips, anomaly toasts |
| **Claude UI** | `content-components/usage_ui.js`, `length_ui.js`, `notification_card.js` | Sidebar, conversation length, settings |
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

AI Energy Score benchmarks (Hugging Face, Dec 2025) for Claude models. Parametric FLOPs estimation for others: `E(Wh) = 0.0001 × params_billions^0.8 × (tokens / 500)`. Grid intensity from EPA eGRID, EEA, IEA. PUE 1.2, overhead 2.0. ±30% uncertainty on all estimates. Always display in gCO₂e (no unit switching).

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

## Multi-Agent Orchestration (Ralph-Style)

This section defines hat-based orchestration patterns for multi-agent development sessions, compatible with ralph-orchestrator or similar frameworks. Each hat maps to an Agent Domain above.

### Hat Definitions

```yaml
hats:
  planner:
    role: "Decompose work into domain-scoped sub-tasks"
    triggers: [task.start, feature.request]
    publishes: [plan.ready]
    instructions: |
      Break work into sub-tasks scoped to Agent Domains above.
      Each sub-task must specify: domain, files, acceptance criteria.
      Write plan to scratchpad before publishing plan.ready.

  core-engineer:
    role: "Service worker, message registry, webRequest, badge"
    triggers: [plan.ready]
    publishes: [core.done]
    domain_files: [background.js, bg-components/utils.js, bg-components/electron-compat.js]

  platform-engineer:
    role: "Usage storage, cost calculation, velocity, forecasting"
    triggers: [plan.ready]
    publishes: [platform.done]
    domain_files: [bg-components/platforms/platform-base.js, bg-components/platforms/intercept-patterns.js]

  claude-engineer:
    role: "Claude API, conversations, token counting, sync"
    triggers: [plan.ready]
    publishes: [claude.done]
    domain_files: [bg-components/claude-api.js, bg-components/tokenManagement.js]

  carbon-engineer:
    role: "Energy estimation, carbon, grid intensity, receipts"
    triggers: [plan.ready]
    publishes: [carbon.done]
    domain_files: [bg-components/carbon-energy.js]

  decision-engineer:
    role: "Recommendations, anomaly detection, budgets, cost preview"
    triggers: [plan.ready]
    publishes: [decision.done]
    domain_files: [bg-components/decision-engine.js, bg-components/decision-orchestrator.js]

  adapter-engineer:
    role: "DOM selectors, composer observation, tier detection"
    triggers: [plan.ready]
    publishes: [adapter.done]
    domain_files: [platform-adapters/adapters.js]

  content-engineer:
    role: "Content script init, stream injection, messaging, badge"
    triggers: [plan.ready]
    publishes: [content.done]
    domain_files: [content-components/content_utils.js, content-components/platform_content.js]

  ui-engineer:
    role: "Popup, history, tools, debug viewer"
    triggers: [plan.ready]
    publishes: [ui.done]
    domain_files: [popup.html, popup.js, debug.html, debug.js]

  reviewer:
    role: "Validate changes against constraints and security"
    triggers: ["*.done"]
    publishes: [review.done, review.rejected]
    instructions: |
      Check: node --check on all modified JS files.
      Check: no innerHTML with template literals containing non-constant values.
      Check: all Log() calls use sanitized arguments.
      Check: no external network calls added without documentation.
      Check: fail-open constraint preserved (no blocking UI).
      Reject with specific feedback if any check fails.

  finalizer:
    role: "Commit, push, document changes"
    triggers: [review.done]
    publishes: [LOOP_COMPLETE]
    instructions: |
      Run: node --check on all JS files.
      Run: node scripts/audit-debug-privacy.js.
      Commit with descriptive message. Push to feature branch.
```

### Event Flow (Default Pipeline)

```
task.start --> planner --> plan.ready
plan.ready --> [domain engineers in parallel] --> *.done
*.done --> reviewer --> review.done | review.rejected
review.rejected --> [relevant engineer] --> *.done (re-review)
review.done --> finalizer --> LOOP_COMPLETE
```

### Quality Gates

```bash
# Gate 1: Syntax (must pass before review.done)
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f"; done

# Gate 2: Privacy (must pass before review.done)
node scripts/audit-debug-privacy.js

# Gate 3: No innerHTML with interpolated variables (grep check)
# Allowed: innerHTML = '' (clearing) and innerHTML with only constants
# Rejected: innerHTML with ${variable} containing non-numeric, non-constant values

# Gate 4: Fail-open verification
# No added event.preventDefault() on send buttons
# No added await/blocking before message dispatch
# All UI overlays must be dismissible
```

### Constraints for All Hats

1. **Domain boundaries**: Do not modify files outside your domain without planner approval
2. **Fail-open**: Never block user's ability to send messages
3. **Local-only**: No new external network calls without PRIVACY.md update
4. **No ES modules in content scripts**: Content scripts use globals only
5. **Log through sanitizer**: All debug output via `Log()`, never `console.log` directly
6. **manifest.json is load-order-sensitive**: Do not reorder content_scripts entries

## Files Not to Modify Without Understanding

- `bg-components/utils.js` — CONFIG, StoredMap, sanitizer, and MessageRegistry are used everywhere
- `content-components/content_utils.js` — initialization order matters; stream counter injection must happen before DOM-dependent code
- `manifest.json` — content_scripts order and world:MAIN entries are load-order-sensitive
