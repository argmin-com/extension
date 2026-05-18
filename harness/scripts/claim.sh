#!/usr/bin/env bash
# claim.sh -- atomically claim a task with a 30-minute lease.
# Reads/writes harness/state/claims.json. Rejects if the task is already
# claimed by a live process within its lease window.
#
# Concurrency: takes an exclusive flock on harness/state/claims.lock for
# the whole read-modify-write cycle so two concurrent invocations
# (e.g. `harnessctl pick` called twice in parallel) cannot both pass the
# "no live claim" check and both write a claim. worker.sh already holds
# a repo-level flock that serializes worker cycles, but claim.sh can be
# called standalone via `harnessctl pick`, and that path needs its own
# guarantee.
set -euo pipefail

TASK="${1:?task slug required}"
LEASE_SEC="${HARNESS_LEASE_SECONDS:-$((30 * 60))}"
CLAIM_PID="${HARNESS_CLAIM_PID:-$PPID}"
CLAIM_RUN_ID="${HARNESS_RUN_ID:-manual}"
CLAIMS_LOCK="${CLAIMS}.lock"

# Serialize the read-modify-write cycle on claims.json. Two transports:
#   1. flock (Linux + most Unixes) -- preferred, kernel-level advisory lock.
#   2. atomic mkdir lockdir (portable, including macOS where flock(1)
#      ships only via Homebrew) -- spin with a short bounded backoff.
# HARNESS_CLAIMS_LOCKED prevents infinite recursion when flock re-execs.
acquire_claims_lock() {
	local lockdir="${CLAIMS_LOCK}.d"
	local attempt
	for attempt in 1 2 3 4 5 6 7 8 9 10; do
		# Reap a stale lockdir whose holder is no longer alive.
		if [ -d "${lockdir}" ] && [ -f "${lockdir}/pid" ]; then
			local old_pid
			old_pid="$(cat "${lockdir}/pid" 2>/dev/null || true)"
			if [ -n "${old_pid}" ] && ! kill -0 "${old_pid}" 2>/dev/null; then
				rm -f "${lockdir}/pid" 2>/dev/null || true
				rmdir "${lockdir}" 2>/dev/null || true
			fi
		fi
		if mkdir "${lockdir}" 2>/dev/null; then
			printf '%s\n' "$$" > "${lockdir}/pid"
			# shellcheck disable=SC2064  # expand now, not on trap fire
			trap "rm -f '${lockdir}/pid' 2>/dev/null; rmdir '${lockdir}' 2>/dev/null || true" EXIT
			return 0
		fi
		sleep 0.2
	done
	echo "claim: could not acquire ${lockdir} after 10 attempts" >&2
	return 1
}

if [ -z "${HARNESS_CLAIMS_LOCKED:-}" ]; then
	if command -v flock >/dev/null 2>&1; then
		exec env HARNESS_CLAIMS_LOCKED=1 flock "${CLAIMS_LOCK}" "$0" "$@"
	else
		acquire_claims_lock
		export HARNESS_CLAIMS_LOCKED=1
	fi
fi
read -r NOW_EPOCH EXPIRES NOW_ISO EXP_ISO < <(python3 - "${LEASE_SEC}" <<'PY'
from datetime import datetime, timezone
import sys

lease_seconds = int(sys.argv[1])
now_epoch = int(datetime.now(timezone.utc).timestamp())
expires = now_epoch + lease_seconds

def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

print(now_epoch, expires, iso(now_epoch), iso(expires))
PY
)

# Verify task exists in TASKS.md.
if ! grep -q "^## ${TASK}$" "${HARNESS_DIR}/TASKS.md"; then
	echo "claim: task slug not found in TASKS.md: ${TASK}" >&2
	exit 1
fi

# Compact JSON read/write via python3 (no external deps; python3 is in CI).
python3 - "${CLAIMS}" "${TASK}" "${NOW_EPOCH}" "${EXPIRES}" "${NOW_ISO}" "${EXP_ISO}" "${WORKER}" "${CLAIM_PID}" "${CLAIM_RUN_ID}" <<'PY'
import json, os, sys, time
claims_path, task, now_epoch, expires, now_iso, exp_iso, worker, claim_pid, run_id = sys.argv[1:10]
now_epoch = int(now_epoch); expires = int(expires)
claim_pid = int(claim_pid)
with open(claims_path, encoding="utf-8") as f:
    claims = json.load(f)
existing = claims.get(task)
if existing:
    if existing.get("expires_epoch", 0) > now_epoch:
        # Still live -- check PID is alive. os.kill(0, 0) signals the
        # caller's process group and would falsely report a missing-pid
        # claim as alive, so treat non-positive pids as already-dead.
        try:
            pid = int(existing.get("pid", 0))
        except (TypeError, ValueError):
            pid = 0
        alive = False
        if pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
        if alive:
            sys.stderr.write(f"claim: {task} already claimed by pid={pid} until {existing.get('expires_iso')}\n")
            sys.exit(3)
claims[task] = {
    "pid": claim_pid,
    "worker": worker,
    "run_id": run_id,
    "claimed_epoch": now_epoch,
    "claimed_iso": now_iso,
    "heartbeat_epoch": now_epoch,
    "heartbeat_iso": now_iso,
    "expires_epoch": expires,
    "expires_iso": exp_iso
}
tmp = claims_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(claims, f, indent=2)
os.replace(tmp, claims_path)
print(json.dumps(claims[task], indent=2))
PY
