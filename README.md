# AI Cost & Usage Tracker

Browser extension that tracks AI token usage, estimated costs, and rate limit
forecasts across Claude, ChatGPT, Gemini, and Mistral.

## Quick Start

1. Clone this repository
2. Run `node scripts/build-dataclasses.js` to generate `content-components/ui_dataclasses.js`
3. Open `chrome://extensions`, enable Developer Mode
4. Click "Load unpacked" and select this directory
5. The extension will activate on claude.ai, chatgpt.com, gemini.google.com, and chat.mistral.ai

## Build

```
node scripts/build.js chrome    # Chrome build
node scripts/build.js firefox   # Firefox build
node scripts/build.js all       # All targets
```

Requires `web-ext` (`npm install -g web-ext`).

The build script:
1. Generates `ui_dataclasses.js` from `shared/dataclasses.js` (strips ES module syntax for content script use)
2. Copies the platform-specific manifest to `manifest.json`
3. Runs `web-ext build` to produce a zip

## Architecture

```
background.js                    Service worker: request interception, message routing
bg-components/
  utils.js                       CONFIG, StoredMap, logging, platform detection
  claude-api.js                  Claude API client (conversations, usage, caching)
  tokenManagement.js             Token counting (o200k local + Anthropic API opt-in)
  electron-compat.js             Electron/desktop app compatibility layer
  platforms/
    platform-base.js             PlatformUsageStore, LimitForecaster, calibration
    intercept-patterns.js        URL patterns for webRequest per platform

content-components/
  content_utils.js               Globals, helpers, initialization (loads first)
  platform_content.js            Floating badge for ChatGPT/Gemini/Mistral
  electron_receiver.js           Electron event bridge
  ui_dataclasses.js              Generated: UsageData/ConversationData for content scripts
  notification_card.js           Settings panel, version/donation cards
  usage_ui.js                    Claude sidebar usage display + forecast
  length_ui.js                   Claude conversation length/cost display

injections/
  stream-token-counter.js        Page-context SSE parser: output token counting
  webrequest-polyfill.js         Page-context fetch wrapper for Electron
  rate-limit-watcher.js          Legacy (unused, superseded by stream-token-counter)

shared/
  dataclasses.js                 ES module source for UsageData/ConversationData

popup.html + popup.js            Extension popup: per-platform usage, history, forecasts
debug.html + debug.js            Debug log viewer with light/dark mode
```

## Data Flow

### Input tokens (non-Claude)
```
webRequest.onBeforeRequest -> handleGenericBeforeRequest
  -> parse request body -> extract model + message text
  -> o200k tokenizer -> platform calibration factor
  -> platformUsageStore.recordRequest
  -> notify content script
```

### Output tokens (all platforms)
```
stream-token-counter.js (page context)
  -> wraps fetch(), detects SSE responses
  -> platform-specific parser (claude/chatgpt/gemini/mistral)
  -> accumulates output text
  -> dispatches CustomEvent('streamOutputComplete')
content_utils.js (content script)
  -> receives event, counts with o200k tokenizer
  -> sends recordOutputTokens to background
background.js
  -> resolves model from lastModelByTab
  -> applies platform calibration
  -> platformUsageStore.recordOutputTokens
```

### Forecast
```
LimitForecaster.getForecast(platform)
  -> reads current usage, velocity, subscription tier
  -> for Claude: uses API-reported limits + estimated caps
  -> for others: uses PLATFORM_LIMITS[tier] definitions
  -> projects exhaustion: (limit - current) / velocity
  -> returns formatted time + timestamp
```

## Key Design Decisions

- **Calibration factors**: o200k tokenizer is exact for OpenAI but approximate for
  other platforms. Per-platform multipliers (Claude 1.05x, Gemini 1.12x, Mistral 1.08x)
  correct for tokenizer differences.

- **StoredMap debouncing**: All persistent maps batch writes with 100ms debounce to
  avoid thrashing browser.storage.local. Periodic cleanup purges expired TTL entries.

- **Anthropic API opt-in**: Token counting via api.anthropic.com requires an explicit
  API key + consent dialog. Depending on feature usage, this can include message text,
  uploaded file content, Claude profile/style/memory text, and attached Google Drive /
  GitHub sync text. Without an API key, all counting is local-only.

- **Gemini DOM fallback**: Gemini uses protobuf for some responses. When SSE parsing
  fails, a MutationObserver captures rendered response text as a fallback.

- **Carbon and energy estimation**: All calculations run locally using AI Energy Score
  benchmarks (Hugging Face, Dec 2025) for Claude models and parametric FLOPs estimation
  for other platforms. Grid carbon intensity uses published regional data (EPA eGRID,
  EEA, IEA). The user selects a datacenter region; the extension does not use
  geolocation. All estimates carry ±30% uncertainty bounds and should be treated as
  directional, not measured. Calculation receipts are generated for auditability.

- **Decision intelligence**: Live cost preview (as-you-type), model switching
  recommendations (heuristic, post-response), anomaly detection (7-day rolling
  baseline with z-score), and budget alerts. All local computation, no external calls.

- **Platform adapters**: Unified DOM selector system with ordered fallback candidates
  per platform. One UI component implementation, four adapter configurations.

## Permissions

| Permission    | Purpose                                          |
|---------------|--------------------------------------------------|
| storage       | Local usage data, settings, debug logs           |
| alarms        | Periodic reset notification checks               |
| webRequest    | Intercept AI platform requests for token counting|
| tabs          | Send usage updates to open platform tabs         |
| cookies       | Read Claude organization ID                      |
| contextMenus  | Extension icon right-click menu                  |
| notifications | Usage limit reset alerts                         |

## Privacy

See PRIVACY.md. Key points:
- All data stored locally in browser.storage.local
- No telemetry, no analytics, and no synchronization to any external service
- Anthropic API token counting is opt-in only (requires API key + consent)
- When enabled, data is sent directly to api.anthropic.com for token counting only
- Anthropic counting may include message text, uploaded file content,
  Claude profile/style/memory text, and attached Google Drive / GitHub sync text
- Debug logs are local-only, sanitized, and capped at 1,000 entries

## Testing

No automated test suite is currently included. Manual verification checklist:

1. Extension loads without errors on `chrome://extensions`
2. Claude sidebar usage display renders and updates on message send
3. ChatGPT/Gemini/Mistral floating badge appears and tracks requests
4. Popup shows per-platform usage, velocity, and forecasts
5. History tab shows daily breakdown
6. API key consent dialog appears before save
7. Debug page light/dark toggle works
8. Keyboard shortcuts (Alt+Shift+U, Alt+Shift+T) function
9. Extension update banner appears after version change
10. Run `node scripts/audit-debug-privacy.js` to verify debug-log privacy guards

## License

See LICENSE file.
