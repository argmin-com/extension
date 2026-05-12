---
name: stream-interception
description: "Working with world:MAIN fetch wrapping and SSE stream parsing"
triggers:
  - "injections/stream-token-counter.js modified"
  - "injections/webrequest-polyfill.js modified"
  - "task mentions fetch wrapping, SSE, or stream interception"
  - "task mentions output token counting"
agent: injection-engineer
---

# Stream Interception Skill

## Context

The extension intercepts AI platform API traffic by wrapping `window.fetch` in
the page context (world:MAIN) at `document_start`. This is the only reliable way
to count output tokens from SSE (Server-Sent Events) streams.

## Key Files

- `injections/stream-token-counter.js` -- fetch wrapper + SSE parsers for 4 platforms
- `injections/webrequest-polyfill.js` -- Electron fetch wrapper fallback
- `manifest.json`, `manifest_chrome.json`, `manifest_firefox.json` -- content_scripts entries with `"world": "MAIN"`

## Step-by-Step: Modifying the Fetch Wrapper

1. **Understand the guard.** The `__aiTrackerStreamWrapped` flag on `window`
   prevents double-wrapping. Never remove or bypass this guard.

2. **Locate the platform parser.** Each platform (Claude, ChatGPT, Gemini,
   Mistral) has its own SSE parsing branch inside the fetch wrapper. Find the
   platform-specific block before making changes.

3. **Test the URL pattern match.** The fetch wrapper checks request URLs against
   platform-specific patterns to decide whether to intercept. Verify your URL
   pattern matches actual API traffic (requires DevTools Network tab on a live
   platform page).

4. **Preserve the original response.** The wrapper must clone the response and
   return a transparent pass-through. The user must never see degraded behavior
   from interception.

5. **Handle stream errors gracefully.** Wrap SSE parsing in try/catch. On error,
   return the original (unwrapped) response. Never block the stream.

6. **Communicate via CustomEvent.** world:MAIN scripts cannot access browser.*
   APIs. Dispatch CustomEvents with the nonce created by `content_utils.js`.

## Step-by-Step: Adding a New Platform's SSE Parser

1. Capture actual API URLs from DevTools Network tab on the target platform.
2. Add URL pattern matching in the fetch wrapper's intercept logic.
3. Implement SSE chunk parsing specific to the platform's response format.
4. Dispatch extracted token counts through the existing CustomEvent path.
5. Update `bg-components/platforms/intercept-patterns.js` with webRequest patterns.
6. Update all browser manifests for the new platform's URL match patterns.
7. Run `node --check injections/stream-token-counter.js`.
8. Run `npm test` (SSE parser tests).

## Non-Negotiables

- `__aiTrackerStreamWrapped` guard must always be present
- Fail-open: never block or delay the platform's fetch response
- No ES module syntax (this runs in page context, not extension context)
- world:MAIN entries must come before content-context entries in every manifest
