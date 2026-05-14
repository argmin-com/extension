#!/usr/bin/env bash
# tests/harness/smoke.test.sh -- end-to-end smoke test for the harness.
# Verifies that the operator entrypoint + claim + worker + release loop
# all work together without invoking a real LLM worker. Uses the
# invoke-noop.sh adapter so this test runs anywhere (no API keys, no
# network).
#
# Exits zero on full success, non-zero with a diagnostic on any failure.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${REPO_DIR}/harness"
HARNESSCTL="${HARNESS}/harnessctl.sh"
TASKS="${HARNESS}/TASKS.md"

# Save state we will mutate, so the test does not leave the repo dirty.
TASKS_BACKUP="$(mktemp)"
cp "${TASKS}" "${TASKS_BACKUP}"
CLAIMS_BACKUP="$(mktemp)"
[ -f "${HARNESS}/state/claims.json" ] && cp "${HARNESS}/state/claims.json" "${CLAIMS_BACKUP}" || echo '{}' > "${CLAIMS_BACKUP}"
trap "cp '${TASKS_BACKUP}' '${TASKS}'; cp '${CLAIMS_BACKUP}' '${HARNESS}/state/claims.json'; rm -f '${TASKS_BACKUP}' '${CLAIMS_BACKUP}'" EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok   $*"; }

# 1) status command works
"${HARNESSCTL}" status > /dev/null || fail "status command failed"
ok "harnessctl status"

# 2) tasks command lists at least one task
TASK_COUNT=$("${HARNESSCTL}" tasks | wc -l)
[ "${TASK_COUNT}" -gt 0 ] || fail "tasks command returned nothing"
ok "harnessctl tasks lists ${TASK_COUNT} task(s)"

# 3) Add a pending sentinel task to claim.
SENTINEL="smoke-test-$(date -u +%s)"
cat >> "${TASKS}" <<EOF

## ${SENTINEL}

**Status**: pending
**Owner**: (unclaimed)
**Lease**: (none)
**Blocked by**: (none)
**Created**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Description

Sentinel injected by tests/harness/smoke.test.sh. The noop worker
should claim, do nothing, release.

### Acceptance

- Cycle exits zero with disposition=completed
- TASKS.md status flips to completed
EOF
ok "sentinel task injected: ${SENTINEL}"

# 4) Claim works (atomic, returns JSON)
CLAIM_JSON="$("${HARNESSCTL}" pick --task "${SENTINEL}" 2>&1)" || fail "claim failed: ${CLAIM_JSON}"
echo "${CLAIM_JSON}" | grep -q "expires_iso" || fail "claim JSON missing expires_iso: ${CLAIM_JSON}"
ok "claim taken atomically"

# 5) Second claim is rejected while a live process holds the claim.
# Each invocation of `harnessctl pick` exits, so its PID dies and the
# claim becomes reclaimable (this is the intended crashed-worker
# recovery path). Simulate a live holder by forging the claim to a PID
# that we know is alive (a long-running background sleep).
sleep 60 &
LIVE_PID=$!
python3 - "${HARNESS}/state/claims.json" "${SENTINEL}" "${LIVE_PID}" <<'PY'
import json, os, sys, time
claims_path, task, pid = sys.argv[1:4]
with open(claims_path) as f:
    claims = json.load(f)
now = int(time.time()); exp = now + 1800
claims[task] = {
    "pid": int(pid), "worker": "test-forge",
    "claimed_epoch": now, "claimed_iso": "now",
    "expires_epoch": exp, "expires_iso": "later"
}
tmp = claims_path + ".tmp"
with open(tmp, "w") as f: json.dump(claims, f, indent=2)
os.replace(tmp, claims_path)
PY
if "${HARNESSCTL}" pick --task "${SENTINEL}" > /dev/null 2>&1; then
	kill "${LIVE_PID}" 2>/dev/null || true
	fail "duplicate claim was permitted while live PID holds it"
fi
kill "${LIVE_PID}" 2>/dev/null || true
# Clean up the forged claim so the next step can re-claim.
python3 - "${HARNESS}/state/claims.json" "${SENTINEL}" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f: claims = json.load(f)
claims.pop(sys.argv[2], None)
with open(sys.argv[1] + ".tmp", "w") as f: json.dump(claims, f, indent=2)
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
PY
ok "duplicate claim rejected while live PID holds it"

# 6) Release returns the task to pending.
"${HARNESSCTL}" release --task "${SENTINEL}" > /dev/null || fail "release failed"
grep -A2 "^## ${SENTINEL}$" "${TASKS}" | grep -q "Status\*\*: pending" || fail "release did not return task to pending"
ok "release returned task to pending"

# 7) Verify the e2e contract of worker.sh with the noop worker.
# HARNESS_ALLOW_DIRTY lets the test run on a working tree that may have
# in-progress edits. HARNESS_SMOKE_MODE short-circuits verifier + commit
# + push so the test does not depend on network or a green codebase.
export HARNESS_WORKER=noop HARNESS_ALLOW_DIRTY=1 HARNESS_SMOKE_MODE=1
WORKER_OUT="$(mktemp)"
"${HARNESSCTL}" once --worker noop --task "${SENTINEL}" > "${WORKER_OUT}" 2>&1 || {
	echo "----- worker output -----"
	cat "${WORKER_OUT}"
	echo "-------------------------"
	rm -f "${WORKER_OUT}"
	fail "worker once failed"
}
rm -f "${WORKER_OUT}"
ok "worker once completed end-to-end"

# 8) Confirm the cycle marked the task completed.
grep -A2 "^## ${SENTINEL}$" "${TASKS}" | grep -q "Status\*\*: completed" || fail "task not marked completed after cycle"
ok "task status updated to completed"

# 9) v9.7.0 extension-side platform / Playwright sanity.
#
# This is a documentation-and-sanity step rather than a runtime check.
# CI does not install Playwright browser binaries (npm run test:e2e is
# not part of the quick gate), so we cannot actually drive the e2e
# specs here. What we CAN do:
#
#   - assert the in-repo platform list still contains every supported
#     platform (claude, chatgpt, gemini, mistral, perplexity, grok, and
#     the two v9.7.0 additions: meta + copilot)
#   - assert the new Playwright spec cases are present in the source so
#     they are not accidentally dropped during a refactor.
#
# Operators who want to drive the full e2e suite locally still run
# `npm run test:e2e:install && npm run test:e2e` from the repo root.

EXT_PLATFORMS=(claude chatgpt gemini mistral perplexity grok meta copilot)
for p in "${EXT_PLATFORMS[@]}"; do
	grep -q "\"${p}\":\|'${p}':\|\b${p}:" "${REPO_DIR}/popup.js" \
		|| fail "popup.js platform list is missing ${p}"
done
ok "extension platform list covers all ${#EXT_PLATFORMS[@]} supported platforms"

EXT_PLAYWRIGHT_CASES=(
	'copilot page injects floating badge'
	'meta.ai page injects floating badge'
	'gemini settings PATCH does not phantom-inflate output tokens'
	'optimize tab renders platform-pill and finding-sources'
	'tools tab exposes Reports panel'
)
for c in "${EXT_PLAYWRIGHT_CASES[@]}"; do
	grep -qF "${c}" "${REPO_DIR}/tests/e2e/content-script.spec.js" \
		"${REPO_DIR}/tests/e2e/popup.spec.js" \
		|| fail "Playwright case missing: ${c}"
done
ok "v9.7.0 Playwright cases present in tests/e2e/ (run via npm run test:e2e)"

echo "all harness smoke checks passed"
