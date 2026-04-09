# AI Cost & Usage Tracker

AI Cost & Usage Tracker is a local-first browser extension for monitoring AI usage across Claude, ChatGPT, Gemini, and Mistral. It estimates token usage, request volume, cost, energy, and carbon impact, and adds decision support features such as live cost previews, model recommendations, anomaly detection, and budget alerts without sending telemetry or analytics off-device.

## Product Summary

- Multi-platform usage tracking for Claude, ChatGPT, Gemini, and Mistral
- Estimated input and output token counting with per-platform calibration
- Cost estimation based on locally stored pricing tables
- Usage velocity and rate-limit forecasting
- Energy and carbon estimation with region-aware methodology
- Decision-time guidance including live cost preview, model recommendations, and budget checks
- Local-only storage by default, with an optional Anthropic API integration for more accurate Claude token counting

## Supported Platforms

| Platform | Domains | Primary in-product experience |
|----------|---------|-------------------------------|
| Claude | `claude.ai` | Sidebar usage UI, conversation length display, settings card, decision UI |
| ChatGPT | `chatgpt.com`, `chat.openai.com` | Floating badge, popup reporting, decision UI |
| Gemini | `gemini.google.com` | Floating badge, popup reporting, decision UI |
| Mistral | `chat.mistral.ai` | Floating badge, popup reporting, decision UI |

## Key Capabilities

### Usage intelligence

- Tracks requests, input tokens, output tokens, and estimated spend per platform
- Stores per-day platform history in `browser.storage.local`
- Forecasts usage exhaustion based on velocity and subscription tier settings

### Decision support

- Evaluates prompt cost while the user is typing
- Suggests lower-cost models when the task appears compatible
- Detects spending anomalies against recent local history
- Checks local budget thresholds and surfaces warnings without blocking message send

### Energy and carbon estimation

- Estimates energy use and carbon emissions locally
- Supports region selection for grid intensity assumptions
- Exposes methodology and model comparison data through the popup tools experience

### Privacy model

- No telemetry or analytics
- No external synchronization service
- Optional Anthropic API counting is explicit opt-in only
- Debug logs are sanitized before local storage

## Repository Quick Start

1. Clone this repository.
2. Generate the content-script dataclasses with `node scripts/build-dataclasses.js`.

3. Open `chrome://extensions` and enable Developer Mode.
4. Click **Load unpacked** and select the cloned repository directory.
5. Open one of the supported platform URLs and confirm the extension activates.

## Build and Packaging

The repository includes a packaging script:

```bash
node scripts/build.js chrome
node scripts/build.js firefox
node scripts/build.js electron
node scripts/build.js all
```

Notes:

- The build script regenerates `content-components/ui_dataclasses.js`.
- It uses `npx web-ext build` to package the extension.
- It skips targets whose manifest file is not present in the repository.
- For local development, loading the unpacked directory is the fastest path.

## Architecture Overview

```text
background.js
  Service worker entry point for request interception, storage, messaging, and notifications

bg-components/
  utils.js                   Shared config, storage helpers, sanitizer, logging, message registry
  claude-api.js              Claude-specific API access and conversation helpers
  tokenManagement.js         Local token counting and optional Anthropic API counting
  carbon-energy.js           Energy, carbon, region, methodology, and model comparison logic
  decision-engine.js         Cost preview, recommendations, anomaly detection, and budgets
  decision-orchestrator.js   Unified decision evaluation pipeline
  task-classifier.js         Local prompt classification heuristics
  policy-engine.js           Action policy resolution for decision UI
  event-store.js             Request, session, and user-profile event storage
  platforms/
    platform-base.js         Platform usage storage, forecasting, and calibration
    intercept-patterns.js    URL matching rules for webRequest listeners
  electron-compat.js         Electron compatibility helpers

content-components/
  content_utils.js           Content-script initialization and messaging
  platform_content.js        Floating badge UI for non-Claude platforms
  smart_ui.js                Decision support overlay
  usage_ui.js                Claude sidebar usage experience
  length_ui.js               Claude conversation length and cost display
  notification_card.js       Claude settings and release messaging UI
  electron_receiver.js       Electron bridge
  ui_dataclasses.js          Generated dataclasses for content-script use

platform-adapters/
  adapters.js                Platform-specific DOM selectors and composer observation

injections/
  stream-token-counter.js    Page-context fetch wrapping and SSE parsing
  webrequest-polyfill.js     Electron fetch wrapper

popup.html / popup.js        Today, History, and Tools views
debug.html / debug.js        Sanitized local debug log viewer
manifest.json               Runtime manifest used for the current build target
manifest_chrome.json        Chrome-target manifest source
```

## Permissions and External Access

### Extension permissions

| Permission | Why it is needed |
|------------|------------------|
| `storage` | Persist usage data, settings, budgets, and debug logs locally |
| `alarms` | Schedule reset notification checks |
| `webRequest` | Observe supported platform traffic for usage tracking |
| `tabs` | Update active platform tabs and popup experiences |
| `notifications` | Surface reset and budget-related notifications |
| `cookies` | Read Claude organization ID from cookies for API authentication |

### Host permissions

| Host permission | Why it is needed |
|-----------------|------------------|
| Supported AI platform domains | Request interception and in-page UI activation |
| `https://api.anthropic.com/*` | Optional opt-in Claude token counting |
| `https://raw.githubusercontent.com/*` | Read GitHub repository files that a user has attached to a Claude workflow so the extension can estimate related token usage |

## Validation

There is no automated end-to-end test suite in this repository today. The documented validation workflow is:

```bash
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f" || echo "FAIL: $f"; done
node scripts/audit-debug-privacy.js
grep -c "messageRegistry.register" background.js
```

Expected result for the handler count check: `45`

Manual verification is still important because platform DOM structures and network endpoints can change over time.

## Privacy

See [PRIVACY.md](./PRIVACY.md) for the full policy. In summary:

- Usage data is stored locally in `browser.storage.local`
- No analytics, telemetry, or third-party sync service is used
- Anthropic API token counting is optional and requires explicit user action
- Debug logs remain local and are sanitized before storage

## License

See [LICENSE](./LICENSE).
