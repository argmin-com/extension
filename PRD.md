# AI Cost & Usage Tracker
# Product Requirements Document v2.0

**Status:** Working reference derived from v9.0.0 codebase
**Last Updated:** 2026-04-07
**Codebase:** 8,509 lines of JavaScript across 31 files, plus 2 HTML, 3 Markdown (including this PRD), 2 JSON manifests, 1 CSS, 4 images, 1 license, 1 patchnotes. Total: 51 files in the shipped zip.

---

## 1. Product Overview

### 1.1 What It Is

A Chrome (and Firefox-compatible) browser extension that intercepts AI platform traffic across Claude, ChatGPT, Gemini, and Mistral to provide real-time token usage tracking, cost estimation, rate limit forecasting, energy/carbon impact estimation, and decision-time intelligence (live cost preview, model recommendations, anomaly detection, and budget alerts). All data stays local. The only external communication is an opt-in Anthropic API call for more accurate Claude token counting.

The extension automatically detects which AI platform is active via URL-based hostname matching in the content script initialization (`content_utils.js:130-139`). Each platform tab loads the correct content scripts from the manifest's per-platform `content_scripts` entries. No manual switching is required.

### 1.2 Target Users

- AI power users who want to understand and optimize their consumption patterns
- Teams managing shared AI budgets who need per-platform cost visibility
- Sustainability-conscious users who want to understand the environmental impact of their AI usage
- Claude Pro/Max subscribers who want to avoid hitting rate limits unexpectedly

### 1.3 Growth Target

10,000 users within 30 days of Chrome Web Store listing.

### 1.4 Competitive Positioning

| Capability | lugia19/Claude-Usage | Claude Track & Export | Claude Usage Monitor | **This Extension** |
|---|---|---|---|---|
| Claude usage tracking | Yes | Yes | Yes | **Yes** |
| Multi-platform (4 platforms) | No | No | No | **Yes** |
| Cost estimation | Claude-only | No | No | **All platforms (14 models)** |
| Energy/carbon estimation | No | No | No | **Yes (9 regions)** |
| Limit forecasting with ETA | No | No | Partial | **Yes** |
| Output token counting | Post-response (API) | No | No | **Real-time (SSE stream)** |
| Live cost preview (as-you-type) | No | No | No | **Yes** |
| Model recommendations | No | No | No | **Yes (heuristic)** |
| Anomaly detection | No | No | No | **Yes (7-day baseline)** |
| Budget limits (cost + carbon) | No | No | No | **Yes** |
| Tokenizer sandbox | No | No | No | **Yes** |
| Model comparison engine | No | No | No | **Yes** |
| Conversation export | No | Yes (Markdown) | No | **Phase 2** |
| Cross-device sync | Yes (Firebase) | No | No | **Phase 2** |
| Per-platform tier selection | No | No | No | **Yes (12 tiers)** |
| Custom user limits | No | No | No | **Yes** |
| Datacenter region selection | No | No | No | **Yes (9 regions)** |
| Badge icon cycling | No | No | Yes (usage %) | **Yes (cost + tokens)** |
| Privacy-hardened debug logging | No | N/A | N/A | **Yes** |

Notes on competitive claims:
- lugia19 counts output tokens from the Claude API response after completion; our extension counts them in real-time by intercepting the SSE stream during generation.
- lugia19 has full cost estimation for Claude models; the limitation is single-platform coverage, not capability depth.

---

## 2. Architecture

### 2.1 System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    BROWSER (Chrome / Firefox)                     │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                SERVICE WORKER (background.js)              │   │
│  │                                                            │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌────────────┐  │   │
│  │  │ utils.js │ │claude-api│ │ tokenMgmt │ │  carbon-   │  │   │
│  │  │ CONFIG   │ │ ClaudeAPI│ │ tokenCtr  │ │  energy.js │  │   │
│  │  │StoredMap │ │ ConvoAPI │ │ tokenStr  │ │ EnergyEng  │  │   │
│  │  │Log/Debug │ │          │ │           │ │ CarbonEng  │  │   │
│  │  └──────────┘ └──────────┘ └───────────┘ └────────────┘  │   │
│  │                                                            │   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────────────┐    │   │
│  │  │platform- │ │intercept-│ │   decision-engine.js   │    │   │
│  │  │base.js   │ │patterns  │ │ ModelRecommendations   │    │   │
│  │  │UsageStore│ │URL filter│ │ AnomalyDetection       │    │   │
│  │  │Forecaster│ │PlatformID│ │ BudgetSystem           │    │   │
│  │  └──────────┘ └──────────┘ │ EfficiencyScoring      │    │   │
│  │                             │ PreSendPreview         │    │   │
│  │  MESSAGE REGISTRY           └────────────────────────┘    │   │
│  │  (41 handlers: 36 string + 5 function)                    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                          │                                        │
│              browser.runtime.sendMessage                          │
│                          │                                        │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              CONTENT SCRIPTS (per platform tab)            │   │
│  │                                                            │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │   │
│  │  │content_  │ │platform_ │ │adapters  │ │ smart_ui   │  │   │
│  │  │utils.js  │ │content   │ │.js       │ │ .js        │  │   │
│  │  │Globals   │ │Badge     │ │DOM hooks │ │CostPreview │  │   │
│  │  │Init      │ │(non-CL)  │ │Composer  │ │RecoChip    │  │   │
│  │  │Log/Debug │ │          │ │Observer  │ │AnomalyToast│  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────┘  │   │
│  │                                                            │   │
│  │  Claude-only: usage_ui.js, length_ui.js, notification_card │   │
│  └───────────────────────────────────────────────────────────┘   │
│                          │                                        │
│              CustomEvent dispatch                                 │
│                          │                                        │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │           PAGE-CONTEXT INJECTIONS (per tab)                │   │
│  │  stream-token-counter.js (fetch wrapper, SSE parser x4)   │   │
│  │  webrequest-polyfill.js (Electron only)                    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  popup.html/js (Today + History + Tools tabs)                    │
│  debug.html/js (log viewer, light/dark mode)                     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 File Inventory

| File | Lines | Agent Domain | Purpose |
|------|-------|-------------|---------|
| `background.js` | 847 | Core | Service worker: request interception, message routing, task queue, badge cycling |
| `bg-components/utils.js` | 447 | Core | CONFIG, StoredMap, logging, sanitizer, platform detection |
| `bg-components/claude-api.js` | 688 | Claude | Claude API client: conversations, usage, caching, sync |
| `bg-components/tokenManagement.js` | 294 | Claude | Token counting: local o200k + Anthropic API opt-in |
| `bg-components/carbon-energy.js` | 285 | Carbon | Energy estimation, carbon accounting, receipts, model comparison |
| `bg-components/decision-engine.js` | 244 | Decision | Recommendations, anomaly detection, budgets, efficiency, cost preview |
| `bg-components/platforms/platform-base.js` | 318 | Platform | PlatformUsageStore, LimitForecaster, calibration factors |
| `bg-components/platforms/intercept-patterns.js` | 118 | Platform | URL patterns for webRequest per platform |
| `bg-components/electron-compat.js` | 81 | Compat | Electron/desktop app compatibility layer |
| `platform-adapters/adapters.js` | 166 | Adapter | Unified DOM selector maps + query helpers for all 4 platforms |
| `content-components/content_utils.js` | 573 | Content | Globals, helpers, initialization, sanitized logging |
| `content-components/platform_content.js` | 268 | Content | Floating badge for ChatGPT/Gemini/Mistral |
| `content-components/smart_ui.js` | 281 | Decision UI | Live cost preview, recommendation chips, anomaly toasts |
| `content-components/usage_ui.js` | 808 | Claude UI | Claude sidebar usage display + forecast |
| `content-components/length_ui.js` | 494 | Claude UI | Claude conversation length/cost display |
| `content-components/notification_card.js` | 564 | Claude UI | Settings panel, version/donation cards |
| `content-components/ui_dataclasses.js` | 266 | Shared | Generated: UsageData/ConversationData for content scripts |
| `content-components/electron_receiver.js` | 34 | Compat | Electron event bridge |
| `injections/stream-token-counter.js` | 257 | Injection | Page-context SSE parser: output token counting |
| `injections/webrequest-polyfill.js` | 73 | Injection | Page-context fetch wrapper for Electron |
| `injections/rate-limit-watcher.js` | 67 | Dead Code | Legacy (unused, superseded by stream-token-counter) |
| `shared/dataclasses.js` | 265 | Shared | ES module source for UsageData/ConversationData |
| `popup.js` | 338 | UI | Extension popup: Today + History + Tools tabs |
| `debug.js` | 148 | UI | Debug log viewer with light/dark mode |
| `scripts/build.js` | 59 | Build | Cross-platform build script |
| `scripts/build-dataclasses.js` | 23 | Build | Generates ui_dataclasses.js from shared/dataclasses.js |
| `scripts/audit-debug-privacy.js` | 21 | QA | Regression guard for debug-log privacy |

### 2.3 Data Flows

#### Input Token Counting
```
webRequest.onBeforeRequest (background.js:72)
  → parseRequestBody (background.js:458)
  → GPTTokenizer_o200k_base.countTokens (background.js:595)
  → platform calibration (platform-base.js:6-12)
  → platformUsageStore.recordRequest (platform-base.js:69)
  → estimateImpact → platformUsageStore.addImpact (platform-base.js:97)
  → sendTabMessage → content script → UI update
```

#### Output Token Counting
```
stream-token-counter.js (page context, wraps window.fetch)
  → platform-specific SSE parser
  → dispatches CustomEvent('streamOutputComplete')
content_utils.js (content script, line 481)
  → GPTTokenizer_o200k_base.countTokens
  → sendBackgroundMessage('recordOutputTokens')
background.js (line 250)
  → platform calibration → recordOutputTokens
  → estimateImpact → addImpact
```

#### Decision Intelligence
```
Live Cost Preview:
  adapters.js observeComposer → text change
  → smart_ui.js updatePreview (300ms debounce)
  → sendBackgroundMessage('previewCost')
  → decision-engine.js previewCost (local tokenizer + pricing + recommendation)
  → smart_ui.js showPreview (floating card, bottom-right)

Model Recommendation:
  platformUsageUpdate message → smart_ui.js (every 3rd response)
  → sendBackgroundMessage('getRecommendation')
  → decision-engine.js getModelRecommendation (heuristic: cost tier + prompt length)
  → smart_ui.js showChip (auto-dismiss 6s)

Anomaly Detection:
  smart_ui.js checkAnomaly (every 60s)
  → sendBackgroundMessage('checkAnomaly')
  → decision-engine.js detectAnomaly (7-day mean + stddev, z-score ≥ 2 or multiplier ≥ 2)
  → smart_ui.js showToast (1-hour cooldown, severity-colored border)
```

### 2.4 Storage Schema

**Per-day platform usage** (key: `platform:YYYY-MM-DD`, TTL: 8 days):
```json
{
  "requests": 42,
  "inputTokens": 150000,
  "outputTokens": 80000,
  "estimatedCostUSD": 1.23,
  "totalEnergyWh": 0.045,
  "totalCarbonGco2e": 0.017,
  "models": { "Sonnet": { "requests": 30, "inputTokens": 100000, "outputTokens": 60000 } },
  "firstRequestAt": 1712500000000,
  "lastRequestAt": 1712540000000
}
```

**User budgets** (key: `userBudgets`):
```json
{ "dailyCostLimit": 5.00, "weeklyCostLimit": null, "dailyCarbonLimit": 10.0, "weeklyCarbonLimit": null }
```

**Other preferences**: `carbonRegion`, `subscriptionTier:platform`, `userLimits:platform`, `apiKey`, `resetNotifEnabled`, `debug_mode_until`, `debug_logs`

---

## 3. Feature Requirements

### 3.1 Core Tracking (10 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| CT-001 | Intercept Claude completion requests via webRequest | background.js:72, intercept-patterns.js |
| CT-002 | Intercept ChatGPT, Gemini, Mistral requests | background.js:549, intercept-patterns.js |
| CT-003 | Parse request bodies for model name and message content | background.js:458 |
| CT-004 | Count input tokens locally with o200k tokenizer | background.js:595 |
| CT-005 | Count output tokens via SSE stream interception | stream-token-counter.js, content_utils.js:481 |
| CT-006 | Apply per-platform token calibration factors | platform-base.js:6-12 |
| CT-007 | Record per-day per-platform per-model usage | platform-base.js:69-95 |
| CT-008 | Accumulate cost estimates from published pricing | platform-base.js:59-67, utils.js:57 |
| CT-009 | Track velocity (tokens/hr, requests/hr, cost/hr) | platform-base.js:141-165 |
| CT-010 | 8-day usage data retention with TTL cleanup | platform-base.js:92 |

### 3.2 Rate Limit Forecasting (8 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| RF-001 | Claude: API-reported session + weekly limits | background.js:268 |
| RF-002 | ChatGPT: 4 tiers (Free/Plus/Pro/Team) | platform-base.js:19-24 |
| RF-003 | Gemini: 2 tiers (Free/Advanced) | platform-base.js:26-29 |
| RF-004 | Mistral: 2 tiers (Free/Pro) | platform-base.js:30-33 |
| RF-005 | Project exhaustion time from velocity | platform-base.js:229-234 |
| RF-006 | Rolling window support (ChatGPT 3h) | platform-base.js:221 |
| RF-007 | User-configurable custom limits | platform_content.js settings panel |
| RF-008 | Per-platform subscription tier selector | popup.js, platform_content.js |

### 3.3 Energy & Carbon Estimation (15 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| EC-001 | AI Energy Score benchmarks for Claude models | carbon-energy.js ENERGY_BENCHMARKS |
| EC-002 | Parametric fallback for unknown models | carbon-energy.js parametricEnergyWh() |
| EC-003 | Token-scaled energy: 2x tokens ~ 2x energy | carbon-energy.js estimateEnergy() |
| EC-004 | PUE factor (default 1.2) | carbon-energy.js DEFAULT_PUE |
| EC-005 | Overhead factor (default 2.0) | carbon-energy.js DEFAULT_OVERHEAD |
| EC-006 | 9 datacenter regions with published grid intensity | carbon-energy.js GRID_INTENSITY |
| EC-007 | Carbon = energy x grid intensity with uncertainty | carbon-energy.js estimateCarbon() |
| EC-008 | Immutable calculation receipts | carbon-energy.js generateReceipt() |
| EC-009 | Model comparison (ranked by energy efficiency) | carbon-energy.js compareModels() |
| EC-010 | Methodology transparency endpoint | carbon-energy.js getMethodology() |
| EC-011 | Region selector in popup UI | popup.js region-sel |
| EC-012 | Energy/carbon display in platform cards + badge | popup.js, platform_content.js |
| EC-013 | Carbon column in history tab | popup.js history rendering |
| EC-014 | Reasoning variant multiplier (3x) | carbon-energy.js REASONING_MULTIPLIER |
| EC-015 | +/-30% uncertainty bounds on all estimates | carbon-energy.js UNCERTAINTY_PCT |

### 3.4 Decision Intelligence (8 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| DI-001 | Live cost preview (as-you-type, 300ms debounce) | smart_ui.js, decision-engine.js previewCost() |
| DI-002 | Model switching recommendations (heuristic, every 3rd response) | smart_ui.js, decision-engine.js getModelRecommendation() |
| DI-003 | Anomaly detection (7-day rolling baseline, z-score + multiplier) | smart_ui.js, decision-engine.js detectAnomaly() |
| DI-004 | Daily budget limits (cost + carbon) | popup.js Tools tab, decision-engine.js getBudgets/setBudgets |
| DI-005 | Budget threshold alerts (80%+ triggers notification) | decision-engine.js checkBudgets() |
| DI-006 | Prompt efficiency scoring (output/input ratio) | decision-engine.js computeEfficiency() |
| DI-007 | Badge icon cycling (cost/tokens every 4s, color-coded) | background.js updateBadge() |
| DI-008 | Tokenizer sandbox (standalone token counter in popup) | popup.js Tools tab, countTokensLocal handler |

### 3.5 Platform Adapters (implemented)

| ID | Feature | Files |
|----|---------|-------|
| PA-001 | Unified DOM selector maps (4 platforms x 5 roles) | adapters.js PLATFORM_SELECTORS |
| PA-002 | Ordered fallback selectors per role | adapters.js adapterQuery() |
| PA-003 | Composer text observation (contenteditable + textarea) | adapters.js observeComposer() |
| PA-004 | Portal root UI isolation (fixed, pointer-events:none) | smart_ui.js createPortalRoot() |


### 3.9 Tier Auto-Detection (implemented)

| ID | Feature | Files |
|----|---------|-------|
| TD-001 | Claude tier detection via billing API bridge | background.js, claude-api.js:146 |
| TD-002 | ChatGPT tier detection via /backend-api/me | adapters.js TIER_DETECTION.chatgpt |
| TD-003 | Gemini tier detection via DOM model indicators | adapters.js TIER_DETECTION.gemini |
| TD-004 | Mistral tier detection via DOM "Le Chat Pro" | adapters.js TIER_DETECTION.mistral |
| TD-005 | Auto-set tier on content script initialization | content_utils.js initGenericPlatform() |

### 3.6 Claude-Specific Features (11 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| CL-001 | Sidebar usage panel with session/weekly progress bars | usage_ui.js |
| CL-002 | Conversation length display with cost | length_ui.js |
| CL-003 | Cache duration tracking and display | length_ui.js |
| CL-004 | Peak hours detection | usage_ui.js |
| CL-005 | Organization ID detection from cookies | background.js:178 |
| CL-006 | Subscription tier detection from billing API | claude-api.js |
| CL-007 | Profile/style/memory token overhead tracking | claude-api.js:136 |
| CL-008 | Google Drive sync content token counting | tokenManagement.js:44 |
| CL-009 | GitHub sync content token counting | claude-api.js:240 |
| CL-010 | API key consent dialog with full disclosure | notification_card.js:375 |
| CL-011 | Reset notification with deduplication | background.js:89-148 |

### 3.7 UI & UX (8 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| UX-001 | Popup with Today + History + Tools tabs | popup.html, popup.js |
| UX-002 | Per-platform cards with color coding | popup.js |
| UX-003 | Floating badge on non-Claude platforms | platform_content.js |
| UX-004 | Keyboard shortcuts (Alt+Shift+U, Alt+Shift+T) | manifest.json commands |
| UX-005 | Debug page with light/dark mode | debug.html, debug.js |
| UX-006 | Extension invalidation banner after update | content_utils.js |
| UX-007 | Visibility-aware update loops | usage_ui.js:791 |
| UX-008 | Model comparison engine in Tools tab | popup.js |

### 3.8 Privacy & Security (13 requirements, all implemented)

| ID | Feature | Files |
|----|---------|-------|
| PS-001 | Two-step debug log sanitizer (string + object) | utils.js:134-185, content_utils.js:33-60 |
| PS-002 | API key / UUID / orgId / URL redaction in logs | sanitizeStringForDebug |
| PS-003 | Log entry cap at 2,000 chars | utils.js, content_utils.js |
| PS-004 | 1-hour time-bounded debug mode only | debug.js |
| PS-005 | No page titles in debug sender label | content_utils.js:66 |
| PS-006 | Structured logging at all high-risk callsites | claude-api.js, background.js |
| PS-007 | Explicit API key consent with full content enumeration | notification_card.js:375 |
| PS-008 | No Firebase / no external analytics / no telemetry | PRIVACY.md |
| PS-009 | Regression guard script | scripts/audit-debug-privacy.js |
| PS-010 | Cookies permission declared and used | manifest.json, background.js:178 |
| PS-011 | Web-accessible resources scoped to platform domains | manifest.json |
| PS-012 | Decision intelligence features documented as local-only | PRIVACY.md |
| PS-013 | Carbon estimation limitations disclosed | PRIVACY.md |

---


### 3.10 Decision System Pipeline (implemented in v9.0.0)

| ID | Feature | Files |
|----|---------|-------|
| DS-001 | Unified evaluateDecision() replacing 5 separate handlers | decision-orchestrator.js |
| DS-002 | Task classification (10 task families, local rules) | task-classifier.js |
| DS-003 | Policy engine (5 action classes: silent/hint/recommend/gate/rewrite) | policy-engine.js |
| DS-004 | Request-level event store (14-day retention, 500 events) | event-store.js |
| DS-005 | Session summaries with cost/intervention tracking | event-store.js |
| DS-006 | User profile with fatigue decay and preference learning | event-store.js |
| DS-007 | Unified decision panel (replaces separate toast/chip/preview) | smart_ui.js |
| DS-008 | User action recording (accept/dismiss feedback loop) | smart_ui.js, background.js |

## 4. Phase 2 Features (Not Yet Implemented)

### 4.1 Cross-Device Sync

**Priority:** High
**Recommended:** Chrome Storage Sync API. A single day-platform record is ~290 bytes. 4 platforms x 8 days = 32 records = ~9.3 KB, well within 100 KB limit with 91 KB headroom. No external service needed.

**Agent Domain:** Sync Engineer
**Files to create:** `bg-components/sync.js`

### 4.2 Conversation Export to Markdown

**Priority:** High
**Complexity warning:** Claude lazily renders messages in long conversations. Implementation must use the Claude API `/chat_conversations/{id}?tree=True` endpoint or scroll-trigger rendering.

**Agent Domain:** Export Engineer
**Files to create:** `content-components/export_ui.js`, `bg-components/markdown-formatter.js`

### 4.3 Workflow/Project Tagging

**Priority:** High (enables cost attribution to deliverables)
**Approach:** Session-level dropdown in smart_ui.js or popup allowing user to tag current activity ("Work", "Research", "Personal"). Tags stored locally, cost/carbon aggregated per tag.

**Agent Domain:** Decision Engineer
**Files to modify:** `decision-engine.js`, `platform-base.js`, `popup.js`

### 4.4 Pre-Send Guardrails (Full Interception)

**Priority:** Medium (opt-in only; the live preview already delivers most of the value)
**Approach:** Hook send button click, show confirmation card if cost exceeds user threshold. 2-second auto-send timeout (fail-open). Default off; enable at onboarding.

**Agent Domain:** Adapter Engineer + Decision UI Engineer
**Files to modify:** `adapters.js`, `smart_ui.js`

### 4.5 Per-Message Inline Cost Indicator

**Priority:** Medium
**Approach:** Inject cost/tokens/carbon below each assistant response in the chat stream. Requires per-platform response DOM selectors (already in adapters.js).

**Agent Domain:** Adapter Engineer + Decision UI Engineer

### 4.6 Context Window Utilization Scoring

**Priority:** Low
**Approach:** Compute ratio of current prompt length to model's max context. Requires maintaining a model-to-context-window mapping that changes frequently.

### 4.7 Configurable PUE and Overhead Factors

**Priority:** Low
**Agent Domain:** Carbon Engineer
**Files to modify:** `carbon-energy.js`, `popup.js`

### 4.8 Real-Time Grid Intensity

**Priority:** Low (Phase 3)
**Approach:** WattTime or Electricity Maps API. Requires API key and external network call.

---

## 5. Platform-Specific Implementation Details

### 5.1 Auto-Detection

Platform detection is automatic via `detectCurrentPlatform()` in `content_utils.js:130-139`:
```
claude.ai → 'claude'
chatgpt.com / chat.openai.com → 'chatgpt'
gemini.google.com → 'gemini'
chat.mistral.ai → 'mistral'
```
The manifest loads platform-specific content script sets per hostname. No manual switching is needed.

### 5.2 Platform Adapter DOM Selectors

Each adapter role has ordered fallback selectors (first match wins):

| Role | Claude | ChatGPT | Gemini | Mistral |
|------|--------|---------|--------|---------|
| composerRoot | `form:has(textarea)` | `form:has(textarea)`, `[data-testid="composer"]` | `form:has(textarea)` | `form:has(textarea)` |
| textarea | `div[contenteditable][role="textbox"]`, `textarea` | `#prompt-textarea`, `form textarea` | `textarea`, `div[contenteditable]` | `textarea`, `[contenteditable]` |
| sendButton | `form button[type="submit"]` | `button[data-testid*="send"]`, `form button[aria-label*="Send"]` | `button[aria-label*="Send"]` | `button[type="submit"]` |
| lastAssistantTurn | `main article:last-of-type` | `[data-message-author-role="assistant"]:last-of-type` | `message-content:last-of-type` | `main article:last-of-type` |

Full selector lists in `platform-adapters/adapters.js`.

### 5.3 Pricing Tables

Values from `CONFIG.PRICING` (bg-components/utils.js:57). All prices $/MTok.

| Platform | Model | Input | Output |
|----------|-------|-------|--------|
| Claude | Opus | 15.00 | 75.00 |
| Claude | Sonnet | 3.00 | 15.00 |
| Claude | Haiku | 0.25 | 1.25 |
| ChatGPT | gpt-4o | 2.50 | 10.00 |
| ChatGPT | gpt-4o-mini | 0.15 | 0.60 |
| ChatGPT | gpt-4.1 | 2.00 | 8.00 |
| ChatGPT | o3 | 2.00 | 8.00 |
| ChatGPT | o4-mini | 1.10 | 4.40 |
| Gemini | gemini-2.5-pro | 1.25 | 10.00 |
| Gemini | gemini-2.5-flash | 0.15 | 0.60 |
| Gemini | gemini-2.0-flash | 0.10 | 0.40 |
| Mistral | mistral-large | 2.00 | 6.00 |
| Mistral | mistral-medium | 2.70 | 8.10 |
| Mistral | mistral-small | 0.20 | 0.60 |

### 5.4 Model Recommendation Tiers

| Platform | Low Cost | Medium Cost | High Cost |
|----------|----------|-------------|-----------|
| Claude | Haiku ($0.25) | Sonnet ($3.00) | Opus ($15.00) |
| ChatGPT | gpt-4o-mini ($0.15) | gpt-4.1, gpt-4o, o4-mini | o3 ($2.00) |
| Gemini | gemini-2.0-flash ($0.10) | gemini-2.5-flash ($0.15) | gemini-2.5-pro ($1.25) |
| Mistral | mistral-small ($0.20) | mistral-large, mistral-medium | - |

Recommendations trigger when: savings >= 20%, shown every 3rd response, auto-dismiss after 6s.

---

## 6. Agent Domains for Multi-Agent Orchestration

### 6.1 Core Engineer
**Files:** `background.js`, `bg-components/utils.js`, `bg-components/electron-compat.js`
**Owns:** Service worker lifecycle, message registry, webRequest, StoredMap, badge cycling, task queue

### 6.2 Platform Engineer
**Files:** `bg-components/platforms/platform-base.js`, `bg-components/platforms/intercept-patterns.js`
**Owns:** Per-platform usage storage, cost calculation, velocity, forecasting, calibration

### 6.3 Claude Engineer
**Files:** `bg-components/claude-api.js`, `bg-components/tokenManagement.js`
**Owns:** Claude API integration, conversation parsing, usage data, token counting, sync

### 6.4 Carbon Engineer
**Files:** `bg-components/carbon-energy.js`
**Owns:** Energy estimation, carbon calculation, grid intensity, receipts, model comparison, methodology

### 6.5 Decision Engineer
**Files:** `bg-components/decision-engine.js`
**Owns:** Model recommendations, anomaly detection, budget system, efficiency scoring, cost preview

### 6.6 Adapter Engineer
**Files:** `platform-adapters/adapters.js`
**Owns:** DOM selector maps, composer observation, platform-specific query helpers

### 6.7 Content Engineer
**Files:** `content-components/content_utils.js`, `content-components/platform_content.js`
**Owns:** Content script init, stream counter injection, message passing, floating badge

### 6.8 Decision UI Engineer
**Files:** `content-components/smart_ui.js`
**Owns:** Cost preview card, recommendation chip, anomaly toast, portal root, budget alerts

### 6.9 Claude UI Engineer
**Files:** `content-components/usage_ui.js`, `content-components/length_ui.js`, `content-components/notification_card.js`
**Owns:** Claude sidebar, conversation length, settings panel, API key consent

### 6.10 Injection Engineer
**Files:** `injections/stream-token-counter.js`, `injections/webrequest-polyfill.js`
**Owns:** Page-context fetch wrapping, SSE parsing, rate limit detection, Gemini DOM fallback

### 6.11 UI Engineer
**Files:** `popup.html`, `popup.js`, `debug.html`, `debug.js`
**Owns:** Popup (Today/History/Tools), tokenizer sandbox, budget UI, debug viewer

### 6.12 Privacy Engineer
**Cross-cut:** All files containing `Log()` calls
**Owns:** Sanitizer maintenance, debug restrictions, privacy docs, regression guards

### 6.13 Build Engineer
**Files:** `scripts/*`, `manifest.json`, `manifest_chrome.json`
**Owns:** Build scripts, manifest integrity, permission scope, version management

---

## 7. Non-Functional Requirements

| ID | Requirement | Target | Status |
|----|-------------|--------|--------|
| NF-001 | Extension popup load time | <200ms | Not measured |
| NF-002 | Stream interception latency | <1ms per chunk | Achieved |
| NF-003 | StoredMap write debounce | 100ms batching | Achieved |
| NF-004 | Debug log cap | 1,000 entries, 2,000 chars/entry | Achieved |
| NF-005 | Usage data retention | 8 days TTL | Achieved |
| NF-006 | Service worker restart resilience | Critical state in storage | Achieved. 7 in-memory variables recover on restart. |
| NF-007 | No external network calls (default) | Zero outbound except to AI platforms | Achieved |
| NF-008 | Syntax validation | 0 failures across all JS files | Achieved (27/27 pass) |
| NF-009 | Message handler parity | 0 unhandled, 0 dead | Achieved (41/41: 36 string + 5 function) |
| NF-010 | Decision UI non-blocking | Never blocks send, all dismissible, fail-open | Achieved |
| NF-011 | Cost preview debounce | 300ms minimum | Achieved (smart_ui.js) |
| NF-012 | Anomaly toast cooldown | Max 1 per hour | Achieved (smart_ui.js) |
| NF-013 | Recommendation fatigue control | Max 1 per 3 responses | Achieved (smart_ui.js) |

---

## 8. Known Limitations

| # | Limitation | Severity | Mitigation |
|---|-----------|----------|------------|
| 1 | No automated test suite | Medium | Manual checklist; regression guard script |
| 2 | Carbon estimates are directional, not measured | Inherent | Documented; +/-30% bounds; methodology transparency |
| 3 | Gemini protobuf responses | Low | DOM fallback observer |
| 4 | `rate-limit-watcher.js` is dead code | Cosmetic | Safe to remove |
| 5 | Stream counter injection timing | Low | Now injected via `world: "MAIN"` at `document_start`; wraps fetch before platform JS loads; `__aiTrackerStreamWrapped` guard prevents double-wrap |
| 6 | ChatGPT `model: "auto"` | Low | Falls back to gpt-4o pricing |
| 7 | No automated pricing table updates | Low | Manual update |
| 8 | Platform DOM selectors may drift | Medium | Ordered fallback selectors; geometric fallback planned |
| 9 | Composer observation may not connect on first load | Low | Retry every 5s for 30s |

### 8.1 Security Posture (per independent review)

| Item | Status | Notes |
|------|--------|-------|
| Message sender validation | Fixed (v8.3.0) | Rejects messages from non-extension origins |
| Page-context fetch wrapping | Acknowledged risk | Required for SSE stream interception; no Chrome API alternative |
| Debug UI in production | Accepted | 1-hour time-bounded; requires explicit activation |
| Privacy claims | Documented honestly | PRIVACY.md states limitations; no "zero data exposure" claims |
| Permissions scope | Narrowed where possible | Host permissions limited to 4 AI platform domains |

---

## 9. Release Checklist

- [ ] All 27 JS files pass `node --check`
- [ ] `scripts/audit-debug-privacy.js` passes
- [ ] `manifest.json` at zip root with correct version
- [ ] Version consistent in manifest, filename, patchnotes
- [ ] PRIVACY.md accurate (including decision intelligence disclosure)
- [ ] Extension loads in Chrome without errors
- [ ] Claude sidebar renders on claude.ai
- [ ] Floating badge renders on chatgpt.com, gemini.google.com, chat.mistral.ai
- [ ] Popup: Today, History, and Tools tabs functional
- [ ] Region selector shows 9 regions
- [ ] Cost preview appears when typing on any platform
- [ ] Recommendation chip appears after 3rd response (when savings >= 20%)
- [ ] Badge icon cycles cost/tokens
- [ ] Tokenizer sandbox returns token count and cost
- [ ] Budget save/load works
- [ ] Debug page light/dark toggle works
- [ ] API key consent dialog appears before save

---

## 10. Appendix: Message Registry (41 Handlers)

### String-keyed (36)

| Handler | Purpose |
|---------|---------|
| `getConfig` | Load CONFIG to content script |
| `getMonkeypatchPatterns` | URL patterns for Electron |
| `initOrg` | Register organization ID |
| `isElectron` | Detect Electron environment |
| `getAPIKey` / `setAPIKey` | API key CRUD |
| `getResetNotifEnabled` / `setResetNotifEnabled` | Notification toggle |
| `getPlatformUsageToday` | All-platform daily usage |
| `getPlatformHistory` | 7-day daily breakdown |
| `recordOutputTokens` | Record SSE output tokens + energy/carbon |
| `recordRateLimit` | Record 429 hit |
| `getForecast` / `getAllForecasts` | Limit forecasts |
| `getSubscriptionTier` / `setSubscriptionTier` | Tier CRUD |
| `getVelocity` | Token/request velocity |
| `getUserLimits` / `setUserLimits` | Custom limit CRUD |
| `getRegions` / `getRegion` / `setRegion` | Carbon region CRUD |
| `getMethodology` | Carbon methodology info |
| `compareModels` | Model comparison engine |
| `previewCost` | Live pre-send cost estimate |
| `getRecommendation` | Model switching recommendation |
| `checkAnomaly` | Anomaly detection for platform |
| `checkBudgets` | Budget threshold check |
| `getBudgets` / `setBudgets` | Budget CRUD |
| `computeEfficiency` | Prompt efficiency scoring |
| `countTokensLocal` | Standalone tokenizer for sandbox |
| `electronTabActivated` / `Deactivated` / `Removed` | Tab lifecycle |
| `electron-alarm` | Electron alarm events |

### Function-keyed (5)

| Handler | Purpose |
|---------|---------|
| `openDebugPage` | Open debug tab |
| `requestData` | Claude usage data for tab |
| `getTotalTokensTracked` | Lifetime token total |
| `interceptedRequest` / `interceptedResponse` | Electron request proxy |
