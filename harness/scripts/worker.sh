#!/usr/bin/env bash
# worker.sh -- one full cycle: pick -> invoke worker -> verify -> commit.
# Idempotent on failure: aborted cycles release their claim, capture
# evidence, and mark the task `needs-review`. Never force-pushes; never
# rewrites history.
set -euo pipefail

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="${RUNS}/${RUN_ID}"
OUTCOME_FILE="${RUN_DIR}/outcome.json"
DIAGNOSTICS_FILE="${RUN_DIR}/diagnostics.json"
TRACE_FILE="${RUN_DIR}/trace.jsonl"
HARNESS_LEASE_SECONDS="${HARNESS_LEASE_SECONDS:-1800}"
HARNESS_HEARTBEAT_SECONDS="${HARNESS_HEARTBEAT_SECONDS:-30}"
HARNESS_WORKER_TIMEOUT_SECONDS="${HARNESS_WORKER_TIMEOUT_SECONDS:-3600}"
mkdir -p "${RUN_DIR}"
export RUN_ID RUN_DIR HARNESS_LEASE_SECONDS HARNESS_WORKER_TIMEOUT_SECONDS

. "${SCRIPTS}/runtime.sh"

log() { echo "[harness:${RUN_ID}] $*"; }

TARGET=""
DISPOSITION="aborted"
FAILURE_MODE="not_started"
HEARTBEAT_PID=""
harness_write_outcome "${OUTCOME_FILE}" "failed" "${DISPOSITION}" "${FAILURE_MODE}" "0"
harness_write_diagnostics "${DIAGNOSTICS_FILE}" "not_started" "${FAILURE_MODE}" "0"
harness_trace_event "${TRACE_FILE}" "worker_initialized" "default-fail outcome written"

# Single-instance guard. flock(1) keeps the lockfile open for the lifetime
# of the worker process when available. macOS does not ship flock(1), so use
# an atomic mkdir fallback there.
LOCK_DIR=""
LOCK_ACQUIRED=0
cleanup_lock() {
	if [ "${LOCK_ACQUIRED}" -eq 1 ] && [ -n "${LOCK_DIR}" ]; then
		rm -f "${LOCK_DIR}/pid" 2>/dev/null || true
		rmdir "${LOCK_DIR}" 2>/dev/null || true
	fi
}
trap cleanup_lock EXIT

if command -v flock >/dev/null 2>&1; then
	exec 9>"${LOCK}"
	if ! flock -n 9; then
		log "another harness worker is running; aborting"
		harness_trace_event "${TRACE_FILE}" "worker_skipped" "repo lock already held"
		exit 0
	fi
else
	LOCK_DIR="${LOCK}.d"
	if [ -d "${LOCK_DIR}" ] && [ -f "${LOCK_DIR}/pid" ]; then
		OLD_PID="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
		if [ -n "${OLD_PID}" ] && ! kill -0 "${OLD_PID}" 2>/dev/null; then
			rm -f "${LOCK_DIR}/pid" 2>/dev/null || true
			rmdir "${LOCK_DIR}" 2>/dev/null || true
		fi
	elif [ -d "${LOCK_DIR}" ]; then
		rmdir "${LOCK_DIR}" 2>/dev/null || true
	fi
	if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
		log "another harness worker is running; aborting"
		harness_trace_event "${TRACE_FILE}" "worker_skipped" "repo lock already held"
		exit 0
	fi
	LOCK_ACQUIRED=1
	printf '%s\n' "$$" > "${LOCK_DIR}/pid"
fi

cd "${REPO_DIR}"

# Fail fast if the working tree is not clean -- we will not stack changes
# on top of an unrelated WIP. The HARNESS_ALLOW_DIRTY escape hatch is
# intended only for the smoke test that runs the noop worker; it
# captures a snapshot of the dirty state into the run dir so the
# integrity property is still observable.
if [ -n "$(git status --porcelain)" ]; then
	if [ "${HARNESS_ALLOW_DIRTY:-0}" = "1" ]; then
		git status --short > "${RUN_DIR}/dirty-tree.txt"
		log "working tree is dirty but HARNESS_ALLOW_DIRTY=1; proceeding (smoke-test mode)"
	else
		FAILURE_MODE="dirty_tree"
		log "working tree is dirty; aborting (run \`git stash\` first or commit your WIP)"
		git status --short > "${RUN_DIR}/dirty-tree.txt"
		harness_write_diagnostics "${DIAGNOSTICS_FILE}" "failed" "${FAILURE_MODE}" "1"
		harness_write_outcome "${OUTCOME_FILE}" "failed" "${DISPOSITION}" "${FAILURE_MODE}" "1"
		harness_trace_event "${TRACE_FILE}" "worker_failed" "${FAILURE_MODE}"
		exit 1
	fi
fi

# 1) Pick a task. If --task was provided, use it. Otherwise, scan
# TASKS.md for the first pending task with no live claim.
if [ -n "${TASK_SLUG:-}" ]; then
	TARGET="${TASK_SLUG}"
else
	TARGET=$(python3 - "${HARNESS_DIR}/TASKS.md" "${CLAIMS}" <<'PY'
import json, re, sys, os, time
tasks_path, claims_path = sys.argv[1:3]
with open(tasks_path) as f:
    src = f.read()
with open(claims_path) as f:
    claims = json.load(f)
now = int(time.time())
# Reap stale claims.
# os.kill(0, 0) targets the whole process group of the caller, which
# would succeed for a claim missing its pid and prevent reaping. Treat
# non-positive pids as already-dead.
for slug in list(claims):
    c = claims[slug]
    if c.get("expires_epoch", 0) <= now:
        del claims[slug]
        continue
    try:
        pid = int(c.get("pid", 0))
    except (TypeError, ValueError):
        pid = 0
    if pid <= 0:
        del claims[slug]
        continue
    try:
        os.kill(pid, 0)
    except OSError:
        del claims[slug]
if claims != json.load(open(claims_path, encoding="utf-8")):
    with open(claims_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(claims, f, indent=2)
    os.replace(claims_path + ".tmp", claims_path)
# Walk tasks. First level-2 heading whose status is pending and slug
# is not claimed -> our pick.
blocks = re.split(r"^## ", src, flags=re.M)[1:]
for block in blocks:
    slug = block.split("\n", 1)[0].strip()
    m = re.search(r"\*\*Status\*\*: *([a-zA-Z_-]+)", block)
    status = m.group(1) if m else ""
    if status == "pending" and slug not in claims:
        print(slug); sys.exit(0)
sys.exit(0)
PY
)
fi

if [ -z "${TARGET}" ]; then
	log "no claimable task available"
	harness_write_diagnostics "${DIAGNOSTICS_FILE}" "skipped" "no_claimable_task" "0"
	harness_write_outcome "${OUTCOME_FILE}" "failed" "no-work" "no_claimable_task" "0"
	harness_trace_event "${TRACE_FILE}" "worker_skipped" "no claimable task"
	exit 0
fi
log "picked task: ${TARGET}"

# 2) Claim it.
if [ "${DRY_RUN}" -eq 1 ]; then
	log "DRY RUN -- would claim ${TARGET} and invoke ${WORKER}"
	harness_write_diagnostics "${DIAGNOSTICS_FILE}" "skipped" "dry_run" "0"
	harness_write_outcome "${OUTCOME_FILE}" "failed" "dry-run" "dry_run" "0"
	harness_trace_event "${TRACE_FILE}" "worker_skipped" "dry run"
	exit 0
fi
HARNESS_CLAIM_PID="$$" HARNESS_RUN_ID="${RUN_ID}" "${SCRIPTS}/claim.sh" "${TARGET}" > "${RUN_DIR}/claim.json"
harness_start_heartbeat "${CLAIMS}" "${TARGET}" "$$" "${RUN_ID}" "${HARNESS_LEASE_SECONDS}" "${HARNESS_HEARTBEAT_SECONDS}" "${RUN_DIR}"
HEARTBEAT_PID="${HARNESS_HEARTBEAT_PID}"
for _ in 1 2 3 4 5; do
	[ -f "${RUN_DIR}/heartbeat.json" ] && break
	sleep 0.2
done
harness_trace_event "${TRACE_FILE}" "task_claimed" "${TARGET}"

# Always release the claim and fire the notify hook on exit, no matter
# how we got here. notify.sh is safe-by-default (no webhook configured
# = stdout only), so this is purely additive.
release_on_exit() {
	local rc=$?
	if [ -n "${HEARTBEAT_PID}" ]; then
		kill "${HEARTBEAT_PID}" 2>/dev/null || true
		wait "${HEARTBEAT_PID}" 2>/dev/null || true
	fi
	"${SCRIPTS}/release.sh" "${TARGET}" "${DISPOSITION}" || true
	echo "${DISPOSITION}" > "${RUN_DIR}/disposition.txt"
	if [ "${DISPOSITION}" = "completed" ]; then
		harness_write_diagnostics "${DIAGNOSTICS_FILE}" "completed" "${FAILURE_MODE}" "${rc}"
		harness_write_outcome "${OUTCOME_FILE}" "passed" "${DISPOSITION}" "${FAILURE_MODE}" "${rc}"
	else
		harness_write_diagnostics "${DIAGNOSTICS_FILE}" "failed" "${FAILURE_MODE}" "${rc}"
		harness_write_outcome "${OUTCOME_FILE}" "failed" "${DISPOSITION}" "${FAILURE_MODE}" "${rc}"
	fi
	"${SCRIPTS}/notify.sh" "${TARGET}" "${DISPOSITION}" "${RUN_ID}" || true
	cleanup_lock
	exit "${rc}"
}
trap release_on_exit EXIT

# Mark in_progress in TASKS.md while the worker is running.
python3 - "${HARNESS_DIR}/TASKS.md" "${TARGET}" "in_progress" <<'PY'
import re, sys
path, task, status = sys.argv[1:4]
with open(path) as f: src = f.read()
new, n = re.subn(rf"(^## {re.escape(task)}\s*\n+\*\*Status\*\*: )([a-zA-Z_-]+)",
                 rf"\g<1>{status}", src, flags=re.M)
if n: open(path, "w").write(new)
PY

# 3) Extract description for the worker.
DESC_FILE="${RUN_DIR}/description.md"
python3 - "${HARNESS_DIR}/TASKS.md" "${TARGET}" "${DESC_FILE}" <<'PY'
import re, sys
path, task, out = sys.argv[1:4]
src = open(path).read()
blocks = re.split(r"^## ", src, flags=re.M)
desc = ""
for b in blocks[1:]:
    if b.startswith(task + "\n") or b.startswith(task + " "):
        desc = b
        break
open(out, "w").write(desc)
PY

log "invoking worker=${WORKER}"
INVOKER="${SCRIPTS}/invoke-${WORKER}.sh"
if [ ! -x "${INVOKER}" ]; then
	FAILURE_MODE="missing_invoker"
	log "no invoker found for worker=${WORKER} (expected ${INVOKER})"
	exit 1
fi

set +e
harness_with_timeout "${HARNESS_WORKER_TIMEOUT_SECONDS}" "${INVOKER}" "${DESC_FILE}" > "${RUN_DIR}/worker.stdout" 2> "${RUN_DIR}/worker.stderr"
WORKER_RC=$?
set -e

log "worker exit=${WORKER_RC}"
git diff --stat > "${RUN_DIR}/diff.stat" || true
git diff > "${RUN_DIR}/diff.patch" || true

if [ "${WORKER_RC}" -ne 0 ]; then
	FAILURE_MODE="worker_failed"
	if [ "${WORKER_RC}" -eq 124 ]; then
		FAILURE_MODE="worker_timeout"
	fi
	log "worker failed -- stashing WIP, marking needs-review"
	git stash push --include-untracked -m "harness-aborted-${RUN_ID}" > "${RUN_DIR}/stash.log" 2>&1 || true
	DISPOSITION="needs-review"
	exit 1
fi

# 4) Diff-size guard.
#
# An autonomous worker can occasionally produce a wildly outsized diff
# (e.g. an accidental find-and-replace) and the harness will happily
# verify+commit+push it. Cap the diff before the verifier runs so a
# runaway worker is caught early and a human reviews the patch. The
# raw patch is preserved in run-dir/diff.patch for inspection.
#
# Override with HARNESS_DIFF_LINE_LIMIT=<n> (0 disables the guard).
HARNESS_DIFF_LINE_LIMIT="${HARNESS_DIFF_LINE_LIMIT:-1500}"
if [ "${HARNESS_DIFF_LINE_LIMIT}" -gt 0 ] 2>/dev/null; then
	# `git diff HEAD --numstat` includes both staged and unstaged changes
	# relative to the last commit, so a worker that has already run
	# `git add` is still subject to the cap. Format: added\tdeleted\tpath
	# (binary files report "-\t-"). Sum the added column over text files.
	DIFF_ADDED=$(git diff HEAD --numstat 2>/dev/null | awk '$1 ~ /^[0-9]+$/ { sum += $1 } END { print sum + 0 }')
	if [ "${DIFF_ADDED}" -gt "${HARNESS_DIFF_LINE_LIMIT}" ]; then
		FAILURE_MODE="diff_too_large"
		log "diff added ${DIFF_ADDED} lines (cap ${HARNESS_DIFF_LINE_LIMIT}) -- stashing WIP, marking needs-review"
		printf 'added=%s limit=%s\n' "${DIFF_ADDED}" "${HARNESS_DIFF_LINE_LIMIT}" > "${RUN_DIR}/diff-size.txt"
		git stash push --include-untracked -m "harness-diff-too-large-${RUN_ID}" > "${RUN_DIR}/stash.log" 2>&1 || true
		DISPOSITION="needs-review"
		exit 1
	fi
fi

# 5) Verify.
#
# HARNESS_SMOKE_MODE=1 short-circuits the verify+commit+push phases so
# tests/harness/smoke.test.sh can exercise the claim/release loop end-
# to-end without depending on a clean working tree or network access.
# In smoke mode the cycle is considered "complete" once the worker has
# returned cleanly.
if [ "${HARNESS_SMOKE_MODE:-0}" = "1" ]; then
	log "HARNESS_SMOKE_MODE=1 -- skipping verifier, commit, and push"
	FAILURE_MODE="smoke_completed"
	DISPOSITION="completed"
	exit 0
fi

log "running verifier"
if ! "${SCRIPTS}/verify.sh"; then
	FAILURE_MODE="verifier_failed"
	log "verifier failed -- stashing WIP, marking needs-review"
	git stash push --include-untracked -m "harness-verify-failed-${RUN_ID}" > "${RUN_DIR}/stash.log" 2>&1 || true
	DISPOSITION="needs-review"
	exit 1
fi

# 6) Commit + push.
if [ -z "$(git status --porcelain)" ]; then
	log "no changes produced -- task complete with no diff"
	FAILURE_MODE="no_diff_completed"
	DISPOSITION="completed"
	exit 0
fi

git add -A
FAILURE_MODE="commit_failed"
git commit -m "harness(${TARGET}): autonomous cycle ${RUN_ID}

Verifier: npm run verify:all + test:e2e green.
Worker: ${WORKER}
Run ID: ${RUN_ID}
" > "${RUN_DIR}/commit.log" 2>&1

# Pull --rebase to integrate any upstream changes; re-verify if rebase
# applied. Never force-push.
FAILURE_MODE="push_failed"
if ! git push origin HEAD > "${RUN_DIR}/push.log" 2>&1; then
	log "push rejected -- rebasing and retrying verifier"
	FAILURE_MODE="rebase_failed"
	git pull --rebase origin HEAD > "${RUN_DIR}/rebase.log" 2>&1 || {
		log "rebase failed"
		DISPOSITION="needs-review"
		exit 1
	}
	FAILURE_MODE="post_rebase_verifier_failed"
	if ! "${SCRIPTS}/verify.sh"; then
		log "post-rebase verifier failed"
		DISPOSITION="needs-review"
		exit 1
	fi
	FAILURE_MODE="push_retry_failed"
	git push origin HEAD >> "${RUN_DIR}/push.log" 2>&1
fi

FAILURE_MODE="completed"
DISPOSITION="completed"
log "task ${TARGET} completed and pushed"
