---
name: platform-adapter
description: "Adding or updating platform adapters and intercept patterns"
triggers:
  - "platform-adapters/adapters.js modified"
  - "bg-components/platforms/* modified"
  - "task mentions adding a new platform"
  - "task mentions DOM selectors or tier detection"
  - "task mentions intercept patterns or URL patterns"
agent: platform-engineer
---

# Platform Adapter Skill

## Context

Platform adapters handle DOM interaction for each AI platform (Claude, ChatGPT,
Gemini, Mistral). They provide selectors for composer elements, send buttons,
model indicators, and tier detection. Intercept patterns define the URL patterns
used by webRequest to capture API traffic.

## Key Files

- `platform-adapters/adapters.js` -- DOM selectors, composer observation, tier detection
- `bg-components/platforms/intercept-patterns.js` -- URL patterns for webRequest
- `bg-components/platforms/platform-base.js` -- PlatformUsageStore, LimitForecaster

## Step-by-Step: Updating Existing Platform Selectors

1. **Identify the broken selector.** Platform DOM changes frequently. Use
   DevTools Elements panel on the live platform to find current selectors.

2. **Use ordered fallback selectors.** adapters.js uses arrays of selectors
   tried in order. Add the new selector at the beginning, keep old ones as
   fallbacks.

3. **Test on the live platform.** Selector changes cannot be verified in CI.
   Flag as requiring browser testing.

4. **Run gates:**
   ```bash
   node --check platform-adapters/adapters.js
   node scripts/audit-debug-privacy.js
   npm test
   ```

## Step-by-Step: Adding a New Platform

Follow the checklist from CLAUDE.md in order:

1. `bg-components/platforms/intercept-patterns.js` -- add URL patterns
2. `bg-components/utils.js` -- add to CONFIG.PLATFORMS and CONFIG.PRICING
3. `platform-adapters/adapters.js` -- add DOM selectors and tier detection
4. `injections/stream-token-counter.js` -- add SSE parser case
5. Browser manifests -- add content_scripts entries (world:MAIN + content context)
   in `manifest.json`, `manifest_chrome.json`, and `manifest_firefox.json`
6. `bg-components/carbon-energy.js` -- add MODEL_MAPPING entries
7. `bg-components/decision-engine.js` -- add MODEL_TIERS entries

## Non-Negotiables

- Platform selectors are fragile. Always use fallback arrays.
- Features must degrade silently when selectors break.
- Fail-open: never block user send actions even if detection fails.
- URL pattern changes require browser testing to verify.
