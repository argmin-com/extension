#!/usr/bin/env bash
# claim.sh -- atomically claim a task with a 30-minute lease.
# Reads/writes harness/state/claims.json. Rejects if the task is already
# claimed by a live process within its lease window.
set -euo pipefail

TASK="${1:?task slug required}"
LEASE_SEC=$((30 * 60))
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
python3 - "${CLAIMS}" "${TASK}" "${NOW_EPOCH}" "${EXPIRES}" "${NOW_ISO}" "${EXP_ISO}" "${WORKER}" <<'PY'
import json, os, sys, time
claims_path, task, now_epoch, expires, now_iso, exp_iso, worker = sys.argv[1:8]
now_epoch = int(now_epoch); expires = int(expires)
with open(claims_path) as f:
    claims = json.load(f)
existing = claims.get(task)
if existing:
    if existing.get("expires_epoch", 0) > now_epoch:
        # Still live -- check PID is alive
        pid = existing.get("pid", 0)
        alive = False
        try:
            os.kill(int(pid), 0); alive = True
        except (OSError, ValueError):
            alive = False
        if alive:
            sys.stderr.write(f"claim: {task} already claimed by pid={pid} until {existing.get('expires_iso')}\n")
            sys.exit(3)
claims[task] = {
    "pid": os.getpid(),
    "worker": worker,
    "claimed_epoch": now_epoch,
    "claimed_iso": now_iso,
    "expires_epoch": expires,
    "expires_iso": exp_iso
}
tmp = claims_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(claims, f, indent=2)
os.replace(tmp, claims_path)
print(json.dumps(claims[task], indent=2))
PY
