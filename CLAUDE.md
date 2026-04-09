# CLAUDE.md
# AI Cost & Usage Tracker -- Chrome Extension

## Quick Reference

- **Repo:** `argmin-com/extension`
- **Version:** 9.0.0
- **Language:** JavaScript (no build step, no bundler)
- **Runtime:** Chrome Extension Manifest V3
- **Total:** 30 JS files, ~8,600 lines
- **Entry points:** `background.js` (service worker), `content_utils.js` (content scripts), `stream-token-counter.js` (page-context injection via `world: "MAIN"`)

## What This Extension Does

Multi-platform AI cost, usage, energy, and carbon tracker for Claude, ChatGPT, Gemini, and Mistral. Intercepts API traffic locally, counts tokens, estimates cost using published pricing, estimates energy/carbon using AI Energy Score benchmarks, and provides decision-time intelligence (cost preview, model recommendations, anomaly detection, budget alerts). All data stays in the browser. The only optional external call is to the Anthropic API for more accurate Claude token counting.

## Architecture

```
SERVICE WORKER (background.js)
  bg-components/utils.js            -- CONFIG, StoredMap, Log, sanitizer, MessageRegistry
  bg-components/claude-api.js       -- Claude API client, conversations, usage, sync
  bg-components/tokenManagement.js  -- Token counting (local o200k + Anthropic API)
  bg-components/carbon-energy.js    -- Energy estimation, carbon, receipts, model comparison
  bg-components/decision-engine.js  -- Recommendations, anomaly detection, budgets, preview
  bg-components/decision-orchestrator.js -- Unified evaluateDecision() pipeline
  bg-components/task-classifier.js  -- Local rules-based prompt classification
  bg-components/policy-engine.js    -- Maps risk + recommendations to action classes
  bg-components/event-store.js      -- Request/session/user-profile state
  bg-components/platforms/
    platform-base.js                -- PlatformUsageStore, LimitForecaster, calibration
    intercept-patterns.js           -- URL patterns for webRequest per platform
  bg-components/electron-compat.js  -- Electron/desktop compatibility

CONTENT SCRIPTS (per platform tab, loaded by manifest)
  content-components/content_utils.js     -- Init, globals, platform detection, messaging
  content-components/platform_content.js  -- Floating badge (non-Claude platforms)
  content-components/smart_ui.js          -- Cost preview, recommendation chips, anomaly toasts
  content-components/usage_ui.js          -- Claude sidebar panel
  content-components/length_ui.js         -- Claude conversation length display
  content-components/notification_card.js -- Claude settings panel
  content-components/ui_dataclasses.js    -- Generated dataclasses (from shared/dataclasses.js)
  content-components/electron_receiver.js -- Electron bridge

PLATFORM ADAPTERS
  platform-adapters/adapters.js     -- DOM selectors, composer observation, tier detection

PAGE-CONTEXT INJECTIONS (world: "MAIN", document_start)
  injections/stream-token-counter.js  -- fetch() wrapper, SSE parser x4 platforms
  injections/webrequest-polyfill.js   -- Electron fetch wrapper

UI
  popup.html / popup.js             -- Today + History + Tools tabs
  debug.html / debug.js             -- Debug log viewer
```

## Key Technical Constraints

These five rules are non-negotiable. Every change must respect all of them.

1. **Fail-open.** No code path may block, delay, or degrade the user's ability to send messages on any platform. All UI overlays must be dismissible. No `event.preventDefault()` on send buttons.
2. **Local-only by default.** No external network calls except to AI platforms (user's own session). The optional Anthropic API call requires explicit opt-in consent dialog.
3. **world: "MAIN" injection.** `stream-token-counter.js` must run in page context at `document_start` to wrap `fetch()` before platform JS loads. Guard: `__aiTrackerStreamWrapped`.
4. **No ES modules in content scripts.** All inter-file communication uses global variables and `browser.runtime.sendMessage`. Only background scripts use ES module imports.
5. **manifest.json is load-order-sensitive.** Do not reorder `content_scripts` entries. The world:MAIN injection must come before content-context scripts.

## Known Issues Requiring Browser Testing

These bugs cannot be fixed in a headless/CI environment. They require live browser DevTools to capture actual API URLs.

- **ChatGPT/Gemini: 0 requests intercepted.** URL patterns in `intercept-patterns.js` are stale. Fix: load the platform with DevTools Network tab open, capture actual API URLs, update patterns.
- **Output tokens low/zero.** Platforms may bypass `window.fetch`. Check DevTools console for `[AI Tracker] INTERCEPTING stream:` lines to diagnose.

## Agent Domains

Each domain owns specific files. Do not modify files outside your domain without coordination.

| Domain | Files | Owns |
|--------|-------|------|
| **Core** | `background.js`, `bg-components/utils.js`, `bg-components/electron-compat.js` | Service worker, message registry, webRequest, badge |
| **Platform** | `bg-components/platforms/*` | Usage storage, cost calc, velocity, forecasting |
| **Claude** | `bg-components/claude-api.js`, `bg-components/tokenManagement.js` | Claude API, conversations, token counting |
| **Carbon** | `bg-components/carbon-energy.js` | Energy, carbon, grid intensity, receipts |
| **Decision** | `bg-components/decision-engine.js`, `decision-orchestrator.js`, `task-classifier.js`, `policy-engine.js`, `event-store.js` | Recommendations, anomaly, budgets, classification, pipeline |
| **Adapter** | `platform-adapters/adapters.js` | DOM selectors, composer observation, tier detection |
| **Content** | `content-components/content_utils.js`, `platform_content.js` | Init, stream injection, messaging, floating badge |
| **Decision UI** | `content-components/smart_ui.js` | Cost preview, recommendation chips, anomaly toasts |
| **Claude UI** | `content-components/usage_ui.js`, `length_ui.js`, `notification_card.js` | Sidebar, conversation length, settings |
| **Injection** | `injections/stream-token-counter.js`, `webrequest-polyfill.js` | Page-context fetch wrapping, SSE parsing |
| **UI** | `popup.html`, `popup.js`, `debug.html`, `debug.js` | Popup, history, tools, debug viewer |
| **Build** | `scripts/*`, `manifest.json`, `manifest_chrome.json` | Build scripts, manifest, version management |

## Validation (run before every commit)

```bash
# All three must pass:
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f" || echo "FAIL: $f"; done
node scripts/audit-debug-privacy.js
grep -c "messageRegistry.register" background.js  # expect: 45
```

## Code Standards

- All debug logging through `Log()` (applies two-step sanitizer). Never use `console.log` directly.
- No `document.title` in debug sender labels. No raw UUIDs/URLs in log callsites.
- No innerHTML with `${variable}` containing non-constant values. Use `textContent` or `createElement` for dynamic data.
- `node --check` must pass on all JS files before any commit.
- No em dashes in any output.

## Files Not to Modify Without Understanding

- `bg-components/utils.js` -- CONFIG, StoredMap, sanitizer, and MessageRegistry are used everywhere
- `content-components/content_utils.js` -- initialization order matters; stream counter injection must happen before DOM-dependent code
- `manifest.json` -- content_scripts order and world:MAIN entries are load-order-sensitive

## Pricing & Carbon Reference

- **Pricing:** `CONFIG.PRICING` in `bg-components/utils.js`. 14 models across 4 platforms. Static; manually updated.
- **Carbon:** AI Energy Score benchmarks (Hugging Face, Dec 2025) for Claude. Parametric FLOPs for others. Grid intensity from EPA eGRID, EEA, IEA. PUE 1.2, overhead 2.0, +/-30% uncertainty. Display in gCO2e.

## Multi-Agent Orchestration

Hat-based orchestration for multi-agent development, compatible with ralph-orchestrator or similar frameworks.

### Orchestration Config

```yaml
orchestration:
  max_iterations: 50
  timeout_seconds: 7200
  starting_event: task.start
  completion_event: LOOP_COMPLETE
  max_review_rejections: 3  # prevent infinite reject loops

hats:
  planner:
    role: "Decompose work into domain-scoped sub-tasks"
    triggers: [task.start, feature.request]
    publishes: [plan.ready]
    instructions: |
      Break work into sub-tasks scoped to Agent Domains above.
      Each sub-task: domain, files, acceptance criteria.
      If task requires browser testing (DOM selectors, URL patterns), flag it as BLOCKED and explain why.

  core-engineer:
    triggers: [plan.ready]
    publishes: [core.done]
    domain_files: [background.js, bg-components/utils.js, bg-components/electron-compat.js]

  platform-engineer:
    triggers: [plan.ready]
    publishes: [platform.done]
    domain_files: [bg-components/platforms/platform-base.js, bg-components/platforms/intercept-patterns.js]

  claude-engineer:
    triggers: [plan.ready]
    publishes: [claude.done]
    domain_files: [bg-components/claude-api.js, bg-components/tokenManagement.js]

  carbon-engineer:
    triggers: [plan.ready]
    publishes: [carbon.done]
    domain_files: [bg-components/carbon-energy.js]

  decision-engineer:
    triggers: [plan.ready]
    publishes: [decision.done]
    domain_files: [bg-components/decision-engine.js, bg-components/decision-orchestrator.js, bg-components/task-classifier.js, bg-components/policy-engine.js, bg-components/event-store.js]

  adapter-engineer:
    triggers: [plan.ready]
    publishes: [adapter.done]
    domain_files: [platform-adapters/adapters.js]

  content-engineer:
    triggers: [plan.ready]
    publishes: [content.done]
    domain_files: [content-components/content_utils.js, content-components/platform_content.js, content-components/smart_ui.js]

  ui-engineer:
    triggers: [plan.ready]
    publishes: [ui.done]
    domain_files: [popup.html, popup.js, debug.html, debug.js]

  reviewer:
    triggers: ["*.done"]
    publishes: [review.done, review.rejected]
    max_rejections: 3
    instructions: |
      Run: node --check on all modified JS files.
      Check: no innerHTML with ${variable} (non-constant).
      Check: no external network calls added without PRIVACY.md update.
      Check: fail-open constraint preserved.
      On pass: publish review.done.
      On fail: publish review.rejected with specific fix instructions.
      After 3 rejections of same file: escalate to planner.

  finalizer:
    triggers: [review.done]
    publishes: [LOOP_COMPLETE]
    instructions: |
      Run validation commands (see above).
      Commit with descriptive message. Push to feature branch.
```

### Event Flow

```
task.start -> planner -> plan.ready
plan.ready -> [domain engineers in parallel] -> *.done
*.done -> reviewer -> review.done | review.rejected
review.rejected -> [relevant engineer] -> *.done (max 3 cycles)
review.done -> finalizer -> LOOP_COMPLETE
```

### Quality Gates (reviewer checklist)

```bash
# Gate 1: Syntax
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f"; done

# Gate 2: Privacy
node scripts/audit-debug-privacy.js

# Gate 3: innerHTML safety
# grep for innerHTML with ${...} -- only allow innerHTML='' (clearing) or static HTML

# Gate 4: Fail-open
# No event.preventDefault() on send buttons, no blocking await before dispatch
```
