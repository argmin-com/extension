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

For a release zip without any network dependency:

```bash
npm run release            # Chrome zip in web-ext-artifacts/
node scripts/release-build.js firefox   # Firefox, when manifest_firefox.json is present
```

The legacy `web-ext`-backed packaging is also still available:

```bash
node scripts/build.js chrome
node scripts/build.js firefox
node scripts/build.js electron
node scripts/build.js all
```

Notes:

- The build scripts regenerate `content-components/ui_dataclasses.js`.
- The version is read from `package.json` and written into whichever per-target manifest is being copied, so `manifest.json` and `manifest_chrome.json` cannot drift.
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
| `https://raw.githubusercontent.com/*` | Read repository files from Claude GitHub sync sources so the extension can include synced content in Claude token estimation |
| `https://api.frankfurter.app/*` | Currency conversion for cost display (free public ECB-rate API; no key, no account) |

## Validation

The repository includes a lightweight Playwright end-to-end suite for popup and content-script smoke coverage.

Install the browser once:

```bash
npm install
npm run test:e2e:install
```

Run the suite:

```bash
npm run test:e2e
```

The full validation workflow is:

```bash
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f" || echo "FAIL: $f"; done
npm run audit          # privacy + dataclasses regression checks
npm test               # unit tests (task classifier, SSE parsers)
grep -c "messageRegistry.register" background.js
npm run test:e2e       # Playwright end-to-end smoke
```

Expected result for the handler count check: the count should match the total number of `messageRegistry.register` calls in `background.js`.

Manual verification is still important because platform DOM structures and network endpoints can change over time.

<a id="privacy"></a>
## Privacy

See [PRIVACY.md](./PRIVACY.md) for the full policy. In summary:

- The extension itself requires no account.
- Usage data is stored locally in `browser.storage.local`.
- No analytics, telemetry, or third-party sync service is used.
- Anthropic API token counting is optional and requires explicit user action with your own API key.
- Currency conversion uses the public, no-account Frankfurter API (ECB rates).
- Debug logs remain local and are sanitized before storage.

## License

See [LICENSE](./LICENSE).
