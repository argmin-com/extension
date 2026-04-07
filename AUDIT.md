# Code Audit Report: AI Cost & Usage Tracker Extension
**Date:** 2026-04-07
**Scope:** Full codebase audit against PRD v2.0
**Auditor:** Claude (automated)
**Codebase version:** 9.0.0

---

## Executive Summary

The extension is well-architected with strong privacy foundations (local-only storage, sanitized debug logs, explicit API key consent). However, the audit identified **4 confirmed bugs**, **8 security concerns**, **5 code quality issues**, and **3 PRD discrepancies** that should be addressed before the Chrome Web Store listing targeting 10,000 users.

**Severity breakdown:**
- Critical: 1
- High: 4
- Medium: 10
- Low: 8

---

## 1. CONFIRMED BUGS

### BUG-1: `CONFIG` not imported in `carbon-energy.js` (CRITICAL)

**File:** `bg-components/carbon-energy.js:228`
**Impact:** `compareModels()` throws `ReferenceError: CONFIG is not defined` at runtime

The function references `CONFIG.PRICING` to calculate cost per model, but `carbon-energy.js` has zero import statements. Since these are ES modules, `CONFIG` from `utils.js` is not available in this scope.

```javascript
// Line 228 -- will crash
for (const [platform, pricingMap] of Object.entries(CONFIG.PRICING)) {
```

**Fix:** Add `import { CONFIG } from './utils.js';` at the top of `carbon-energy.js`.

**Affected features:** PRD EC-009 (Model comparison engine), UX-008 (Model comparison in Tools tab).

---

### BUG-2: Unsafe array indexing after `indexOf()` (HIGH)

**File:** `background.js:529, 531` (also 755, 757)
**Impact:** Silent data corruption -- wrong orgId or conversationId used as storage key

```javascript
const orgId = urlParts[urlParts.indexOf('organizations') + 1];        // line 529
const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]; // line 531
```

If the URL doesn't contain the expected path segment, `indexOf()` returns `-1`, and `urlParts[0]` is silently used as the orgId/conversationId. This could cause:
- Cross-org data leakage (usage attributed to wrong org)
- Request misattribution (wrong conversation gets token counts)
- Storage key collisions

**Fix:** Guard with `indexOf() !== -1` checks before accessing the next index.

---

### BUG-3: `lastModelByTab` memory leak for non-Electron tabs (MEDIUM)

**File:** `background.js:249, 469-471`
**Impact:** Unbounded memory growth in long-running sessions

The `lastModelByTab` Map is cleaned up only via the `electronTabRemoved` message handler. For standard browser tabs, there is no cleanup -- entries accumulate indefinitely. A user with many tabs open over 24+ hours will accumulate hundreds of orphaned entries.

**Fix:** Add a `browser.tabs.onRemoved` listener to clean up entries for standard browser tabs.

---

### BUG-4: Badge only shows cost, not tokens (MEDIUM -- PRD deviation)

**File:** `background.js:849-875`
**Impact:** Feature incomplete per PRD requirement DI-007

PRD specifies: "Badge icon cycling (cost/tokens every 4s, color-coded)". The actual implementation:
- Shows cost only (no token count)
- Updates every 10 seconds (not 4s cycling)
- Uses a single green color (not color-coded by threshold)

---

## 2. SECURITY CONCERNS

### SEC-1: `innerHTML` with message-derived data (HIGH)

**File:** `content-components/platform_content.js:253-259`
**Impact:** Potential XSS if background message data is compromised

```javascript
item.innerHTML = `
    <div class="ut-platform-badge-row"><span>${fc.limitName} (${fc.limitType})</span>...`;
```

`fc.limitName` and `fc.limitType` come from `sendBackgroundMessage('getAllForecasts')` responses. While these currently resolve to hardcoded strings in `platform-base.js`, the pattern is unsafe -- any future change that introduces user-controlled data into forecast objects would create an XSS vector.

**Also affected:** `usage_ui.js` (lines 114, 126, 198, 648, 662, 668, 700, 712), `length_ui.js` (lines 249, 282, 284, 291), `smart_ui.js` (line 132).

**Recommendation:** Use `textContent` for plain text values, or `document.createElement()` with property assignment instead of `innerHTML` with template literals.

---

### SEC-2: Direct browser-to-API key transmission (MEDIUM)

**File:** `bg-components/tokenManagement.js:160-173, 202-215`
**Impact:** API key exposed in browser fetch context

```javascript
headers: {
    "x-api-key": apiKey,
    "anthropic-dangerous-direct-browser-access": "true",
    ...
}
```

The `anthropic-dangerous-direct-browser-access` header is an explicit acknowledgment of risk. While the API key is user-provided and opt-in with consent dialog, direct browser-to-API calls are inherently riskier than proxied calls. This is an accepted tradeoff documented in the PRD (PS-007), but worth noting for the security posture assessment.

**Mitigating factor:** Opt-in only, requires explicit user consent (notification_card.js:375).

---

### SEC-3: Incomplete API key redaction patterns (MEDIUM)

**File:** `bg-components/utils.js:138`
**Impact:** Non-Anthropic API keys could leak into debug logs

The `sanitizeStringForDebug()` function only redacts the `sk-ant-` prefix pattern. If users paste other platform API keys or bearer tokens into debug-mode logs, those would not be redacted.

**Recommendation:** Add regex patterns for common API key formats (e.g., `sk-proj-`, `sk-or-`, generic `Bearer` tokens).

---

### SEC-4: Missing message property validation (MEDIUM)

**File:** `background.js:232-237, 239, 245-264` (20+ instances)
**Impact:** Malformed messages cause unpredictable behavior

Message handlers destructure properties without validation:
```javascript
messageRegistry.register('setAPIKey', async (message) => {
    const newKey = message.newKey;  // no validation that newKey exists
    ...
});
```

While the sender ID is validated (utils.js:430), individual message properties are not type-checked or validated for required fields.

**Mitigating factor:** Messages only accepted from the extension's own ID.

---

### SEC-5: User consent bypass edge case (LOW)

**File:** `content-components/notification_card.js:372-401`
**Impact:** `confirm()` dialog can be programmatically dismissed

The API key consent uses `window.confirm()` which can be auto-dismissed by page scripts in certain browser configurations. A custom modal dialog would be more robust.

---

### SEC-6: Cookie parsing without origin validation (LOW)

**File:** `content-components/content_utils.js:159`
**Impact:** Fragile org ID extraction

```javascript
const orgId = document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1];
```

Simple string splitting rather than proper cookie parsing. While functional, edge cases with encoded values or multiple cookies with similar prefixes could cause incorrect extraction.

---

### SEC-7: `https://github.com/*` host permission undocumented in PRIVACY.md (LOW)

**File:** `manifest.json:135`
**Impact:** Privacy policy incomplete; users/reviewers may question the permission

The permission is legitimately used by `claude-api.js:240` to fetch GitHub sync content for Claude conversations (token counting of synced repos). However, PRIVACY.md does not disclose this external access. Chrome Web Store reviewers will flag undocumented host permissions.

**Fix:** Add GitHub sync access disclosure to PRIVACY.md.

---

### SEC-8: XSS in popup.js via innerHTML with string fields (MEDIUM)

**File:** `popup.js:119-125`
**Impact:** Same class of issue as SEC-1, but in the popup context

```javascript
html += `<div class="fc-row"><span>${fc.limitName}</span>...`
```

`fc.limitName` from background message responses is injected without HTML escaping. While currently hardcoded strings, this is the same unsafe pattern as SEC-1.

---

## 3. CODE QUALITY ISSUES

### CQ-1: Dead code not removed (LOW)

**File:** `injections/rate-limit-watcher.js` (67 lines)
**PRD acknowledgment:** Known limitation #4 -- "dead code, safe to remove"

The file is loaded in the manifest but superseded by `stream-token-counter.js`. Should be removed from both the codebase and manifest to reduce attack surface and bundle size.

---

### CQ-2: Stale processing lock race condition (MEDIUM)

**File:** `background.js:791-798`
**Impact:** Theoretical double-processing of tasks

```javascript
if (processingLock) {
    const lockAge = Date.now() - processingLock;
    if (lockAge < LOCK_TIMEOUT) return;
    // Falls through to set new lock -- but another event could also fall through
}
processingLock = Date.now();
```

Between the stale-lock detection and setting the new lock, another event could also detect the stale lock and proceed. However, since JavaScript is single-threaded, this can only happen if the code yields (via `await`) between lines 794-798, which it doesn't. **Low practical risk**, but the 30-second LOCK_TIMEOUT is long enough to block legitimate task processing.

---

### CQ-3: Silent error swallowing (LOW)

**File:** `background.js:872`
**Impact:** Debugging difficulty

```javascript
catch (e) { /* ignore */ }
```

The `updateBadge()` function silently swallows all errors. While badge updates are non-critical, logging at debug level would aid troubleshooting.

---

### CQ-4: Model name substring matching (LOW)

**File:** `background.js:534-538`
**Impact:** Potential false matches on model names

```javascript
if (modelString.includes(modelType.toLowerCase())) { model = modelType; break; }
```

Since `CONFIG.MODELS` is `["Opus", "Sonnet", "Haiku"]`, `includes()` could theoretically match unintended model strings (e.g., a model named "opus-mini" would match "opus"). Currently safe given the known model name patterns, but fragile for future model additions.

---

### CQ-5: No fetch timeout on API calls (MEDIUM)

**File:** `bg-components/tokenManagement.js:160, 202`
**Impact:** Extension could hang on network issues

`fetch()` calls to `api.anthropic.com` have no `AbortController` timeout. On poor connections, these calls could block indefinitely, potentially freezing the token counting pipeline.

**Recommendation:** Add an `AbortController` with a 15-30 second timeout.

---

## 4. PRD DISCREPANCIES

### PRD-1: Badge cycling not implemented (DI-007)

**Expected:** Cost/tokens cycling every 4s with color-coded thresholds
**Actual:** Cost-only display, 10s refresh, single green color
**Severity:** Medium -- feature gap visible to users

### PRD-2: `smart_ui.js` decision panel (DS-007)

**Expected (PRD DS-007):** "Unified decision panel (replaces separate toast/chip/preview)"
**Actual:** `smart_ui.js` appears to be a legacy smart model detector, not the unified decision panel described in DS-007. The decision orchestrator (`decision-orchestrator.js`) and related files exist but the UI integration described in DS-007 may be incomplete.

### PRD-3: Weekly budget checks not implemented (DI-004)

**File:** `bg-components/decision-engine.js:146-186`
**Expected:** Both daily and weekly budget limits
**Actual:** `checkBudgets()` only checks `dailyCostLimit` and `dailyCarbonLimit`. The `weeklyCostLimit` and `weeklyCarbonLimit` fields exist in the schema (lines 131-134) but are never checked in `checkBudgets()`.

---

## 5. ARCHITECTURE OBSERVATIONS

### Positive patterns:
- **Privacy-first design:** All data local, sanitized debug logging, explicit API consent
- **Platform adapter pattern:** Clean abstraction for 4-platform support with fallback selectors
- **StoredMap debouncing:** 100ms write batching reduces storage I/O effectively
- **Message sender validation:** Rejects messages from non-extension origins (utils.js:430)
- **Structured error handling:** Most critical paths have try-catch with logging
- **Page-context injection via `world: "MAIN"`:** Correct approach for SSE interception

### Areas for improvement:
- **No automated test suite** (Known limitation #1) -- high risk for a 8,500-line codebase targeting 10,000 users
- **Feature cost constants are hardcoded** (claude-api.js:5-20) -- will drift as Claude updates features
- **No request deduplication** -- concurrent `updateAllTabsWithUsage()` calls can trigger redundant API fetches
- **Calibration factors are static** (platform-base.js:6-12) -- no mechanism to update them based on observed accuracy
- **manifest.json and manifest_chrome.json are identical** -- build.js expects platform-specific manifests but only one variant exists; Firefox/Electron builds would silently skip
- **Build process has no pre-build validation** -- no `node --check` or dataclass sync verification before packaging
- **API keys stored unencrypted** in `browser.storage.local` -- accessible to any code with storage access

---

## 6. LANDING PAGE REPO (`argmin-com/landing-page`)

The landing page is an Astro + Tailwind site deployed to Cloudflare Pages. It contains marketing pages (index, about, demo, platform, security, use-cases, team, contact) for the extension. This repo does not contain extension logic and is not directly covered by the PRD. No code quality issues specific to the PRD scope were identified in this repo.

---

## 7. RECOMMENDED FIX PRIORITY

| Priority | ID | Action |
|----------|----|--------|
| P0 (ship-blocker) | BUG-1 | Add `CONFIG` import to `carbon-energy.js` |
| P0 (ship-blocker) | BUG-2 | Guard `indexOf()` + 1 with bounds checks |
| P1 (pre-launch) | SEC-1, SEC-8 | Replace `innerHTML` with safe DOM construction for dynamic content |
| P1 (pre-launch) | CQ-5 | Add fetch timeout to API calls |
| P1 (pre-launch) | CQ-1 | Remove dead `rate-limit-watcher.js` |
| P1 (pre-launch) | SEC-7 | Document github.com permission in PRIVACY.md |
| P2 (post-launch) | BUG-3 | Add `tabs.onRemoved` cleanup for `lastModelByTab` |
| P2 (post-launch) | SEC-3 | Expand API key redaction patterns |
| P2 (post-launch) | SEC-4 | Add message property validation |
| P2 (post-launch) | PRD-1 | Implement badge cost/token cycling per DI-007 |
| P2 (post-launch) | PRD-3 | Implement weekly budget checks |
| P3 (backlog) | BUG-4 | Badge color-coding by threshold |
| P3 (backlog) | SEC-5 | Replace `confirm()` with custom modal |
| P3 (backlog) | CQ-3 | Replace silent catches with debug-level logging |
| P3 (backlog) | CQ-4 | Tighten model name matching |

---

## 8. SUMMARY

The codebase demonstrates strong architectural decisions (adapter pattern, privacy-first storage, structured message passing) and covers an impressive feature set across 4 AI platforms. The two P0 bugs (missing import causing `compareModels()` crash, and unsafe URL parsing) should be fixed before any public release. The `innerHTML` usage pattern (SEC-1/SEC-8) is the most significant security concern and should be systematically addressed across all content scripts and the popup. The missing weekly budget checks and incomplete badge cycling represent the largest gaps between the PRD and the actual implementation.
