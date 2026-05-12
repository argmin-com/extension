---
name: privacy-audit
description: "Privacy regression checks, sanitizer rules, and debug logging compliance"
triggers:
  - "node scripts/audit-debug-privacy.js fails"
  - "task mentions privacy, logging, sanitizer, or debug output"
  - "content-components/* modified"
  - "bg-components/utils.js modified (sanitizer changes)"
agent: reviewer
---

# Privacy Audit Skill

## Context

Privacy is a core promise of the extension. All data stays in the browser by
default. Feature-driven external calls are limited to opt-in Anthropic token
counting, optional Frankfurter currency rates, and raw GitHub content fetched
for Claude GitHub sync token estimation. Debug logging goes through a two-step
sanitizer in utils.js to prevent leaking sensitive content.

## Key Files

- `scripts/audit-debug-privacy.js` -- automated privacy regression guard
- `bg-components/utils.js` -- Log() function and two-step sanitizer
- `PRIVACY.md` -- privacy policy document

## Privacy Rules

1. **All logging through Log().** Never use `console.log` directly. Log()
   applies the sanitizer before output.

2. **No document.title in sender labels.** document.title may contain the
   user's conversation content.

3. **No raw UUIDs or URLs in log callsites.** These can identify specific
   conversations or sessions.

4. **No unsafe dynamic HTML rendering.** Use textContent, createElement, or the
   audited `setSafeHtml()` helper with escaped dynamic values.

5. **No em dashes in output.** Project style rule.

## Step-by-Step: Investigating a Privacy Audit Failure

1. **Run the audit:**
   ```bash
   node scripts/audit-debug-privacy.js
   ```

2. **Read the output.** The audit script reports specific file:line violations.

3. **Categorize the violation:**
   - Direct console.log -> Replace with Log()
   - document.title in label -> Use a static string identifier
   - Raw UUID/URL -> Truncate or hash before logging
   - HTML injection -> Refactor to DOM APIs or audited escaped rendering

4. **Fix the violation.** Apply the minimum change to resolve.

5. **Re-run the audit.** Verify the fix resolves the violation without
   introducing new ones.

6. **Run full gate suite:**
   ```bash
   node scripts/audit-debug-privacy.js
   npm test
   node --check <modified-files>
   ```

## Step-by-Step: Adding a New Privacy Rule

1. Define the rule in `scripts/audit-debug-privacy.js`.
2. Add a grep/regex pattern to detect violations.
3. Document the rule in this skill and in CLAUDE.md Code Standards.
4. Run the audit against the full codebase to find existing violations.
5. Fix any existing violations before merging the new rule.

## Non-Negotiables

- audit-debug-privacy.js must pass before any commit
- No external network calls without PRIVACY.md update and explicit feature scope
- Sanitizer in utils.js must not be weakened
