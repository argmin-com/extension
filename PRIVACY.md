# Privacy Policy for AI Cost & Usage Tracker

Last Updated: 2026/04/06

## Scope

This extension operates on the following platforms:
- claude.ai
- chatgpt.com and chat.openai.com
- gemini.google.com
- chat.mistral.ai

## What Data Is Collected

The extension collects and stores the following data locally in your browser
(via browser.storage.local):

- Token usage counts (input and output) per platform, per day
- Request counts per platform, per day
- Estimated cost figures derived from token counts and published pricing
- Usage velocity (tokens per hour, requests per hour)
- Subscription tier selections you make for each platform
- Custom usage limits you configure
- Your Claude organization ID (read from cookies for API access)
- An optional Anthropic API key, if you choose to provide one
  (stored locally in browser.storage.local)
- Debug logs, if you enable debug mode (see below)

The extension also reads, but does not store, the following:
- Conversation content, for the purpose of counting tokens
- Uploaded file content, for the purpose of estimating file token counts
- Claude profile preferences, style settings, and memory content, for
  the purpose of estimating their token overhead
- Google Drive document content and GitHub repository content, when these
  are attached to a Claude conversation, for token estimation. GitHub
  repository files are fetched directly from github.com using the
  extension's host permission for that domain.
- SSE streaming responses from all four platforms, for output token counting

## Energy and Carbon Estimation (Local-Only)

The extension estimates the energy consumption (Wh) and carbon emissions
(gCO₂e) of AI model invocations. All calculations are performed entirely
within your browser. No geolocation data is collected or used.

These estimates are directional, not measurements. They are based on:
- AI Energy Score benchmarks (published by Hugging Face) for Claude models
- Parametric scaling models for ChatGPT, Gemini, and Mistral models
- A user-selected datacenter region that determines the grid carbon intensity
  factor (published data from EPA eGRID, EEA, and IEA)
- Configurable PUE (Power Usage Effectiveness) and overhead factors

The extension does not know which datacenter actually served your request.
The region you select is an assumption, and all estimates should be treated
as approximate. The calculation methodology is documented at
https://github.com/argmin-com/ai-cost-usage-tracker and in the extension's
methodology viewer (accessible from the popup).

## Anthropic API Usage (Opt-In)

If you provide an Anthropic API key in the extension settings, the extension
will use the Anthropic /v1/messages/count_tokens endpoint for more accurate
token counting. When this feature is active, the extension may send the
following text content to api.anthropic.com for token counting only:

- Message text content
- Uploaded file content (as base64, when applicable)
- Claude profile preference text
- Claude style prompt text
- Claude memory text
- Google Drive document text attached to a Claude conversation
- GitHub repository file text attached to a Claude conversation

This data is sent solely for token counting and is subject to Anthropic's API
terms of service and data handling policies.

THIS FEATURE IS ENTIRELY OPT-IN. If you do not provide an API key, all token
counting is performed locally using the o200k_base tokenizer. No conversation
content, file content, or message text is transmitted to any external service
when no API key is configured.

If configured, the Anthropic API key is stored locally in browser.storage.local
and is not transmitted anywhere except to authenticate requests made directly
to api.anthropic.com.

## Currency Exchange Rates (Opt-In)

If you change the display currency in the Tools tab from its USD default, the
extension fetches the current USD-to-target exchange rate from Frankfurter
(https://api.frankfurter.app), a free, no-key service backed by European
Central Bank data. The rate is cached for 24 hours and only refreshed when it
expires or when the user explicitly triggers a refresh. The request contains
no usage data, prompts, session information, or identifiers of any kind; it
is a plain GET to `/latest?from=USD&to=<CODE>`. This feature is fully opt-in:
if the display currency stays at USD, no network call is made.

## Debug Mode

When you enable debug mode (via the debug page), the extension writes
operational logs to browser.storage.local. These logs are sanitized before
storage: sensitive fields and identifiers are redacted where possible,
request URLs are reduced to origin-only form, long strings are truncated,
page titles are not stored,
and individual log entries are capped at 2,000 characters.

Sanitized logs may still include:
- Redacted request destinations
- Token counts and cost calculations
- Platform and model identifiers
- Timestamps and error types

Debug logs are stored locally and are never transmitted. They are capped at
1,000 entries and can be cleared at any time from the debug page.

Debug mode is disabled by default and must be explicitly enabled. It is
time-bounded (maximum 1 hour) and cannot be set to persist permanently.

## Data Storage

All data is stored locally in your browser via browser.storage.local.
No data is sent to Firebase or any synchronization service.
No data is sent to any analytics, telemetry, or tracking service.
No data is sold to any third party.

The only third-party transmission performed by this extension is the explicit,
user-enabled call to api.anthropic.com for token counting when an Anthropic API
key is configured.

## Data Transmission Summary

| Destination         | When                | What                                                                 |
|--------------------|---------------------|----------------------------------------------------------------------|
| api.anthropic.com  | Only if API key set | Message text, uploaded file content, profile/style/memory text, and attached Google Drive / GitHub sync text used for token counting |
| No analytics / telemetry / tracking service | Never | Nothing |

## Permissions Explained

- **storage**: Store usage data, settings, and debug logs locally
- **alarms**: Schedule periodic checks for usage limit resets
- **webRequest**: Intercept AI platform requests to count tokens
- **tabs**: Send usage updates to open tabs
- **cookies**: Read Claude organization ID for API access
- **notifications**: Alert when usage limits reset
- **Host permissions**: Required to intercept requests on each platform

## Decision Intelligence Features (Local-Only)

The extension provides cost previews, model recommendations, anomaly detection,
and budget alerts. All of these features operate entirely within your browser:

- Cost previews are computed locally using the same tokenizer and pricing tables
  used for post-request tracking. No prompt text leaves your browser for this purpose.
- Model recommendations are rule-based heuristics comparing cost tiers within the
  same platform. No usage data is transmitted externally.
- Anomaly detection compares today's usage against a 7-day rolling average stored
  locally. No baseline data is shared externally.
- Budget limits are stored in browser.storage.local and checked locally after
  each request completes.

## Your Rights

- All data is stored locally and under your control
- You can clear all extension data via Chrome's extension settings
- You can disable debug mode at any time
- You can remove your API key at any time to stop all external data transmission
- You can uninstall the extension to remove all stored data

## Contact

For privacy questions: lugia19@lugia19.com
