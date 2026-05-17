#!/usr/bin/env bash
# release.sh -- drop a claim and optionally mark the task complete.
# Usage: release.sh <task-slug> [status]
#   status: pending | completed | needs-review | abandoned (default: pending)
#
# Concurrency: holds the same exclusive flock on claims.lock that
# claim.sh takes, so a release cannot interleave with a fresh claim on
# the same task.
set -euo pipefail

TASK="${1:?task slug required}"
NEW_STATUS="${2:-pending}"
CLAIMS_LOCK="${CLAIMS}.lock"

if [ -z "${HARNESS_CLAIMS_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
	exec env HARNESS_CLAIMS_LOCKED=1 flock "${CLAIMS_LOCK}" "$0" "$@"
fi

python3 - "${CLAIMS}" "${TASK}" <<'PY'
import json, os, sys
claims_path, task = sys.argv[1:3]
with open(claims_path) as f:
    claims = json.load(f)
if task in claims:
    del claims[task]
    tmp = claims_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(claims, f, indent=2)
    os.replace(tmp, claims_path)
    print(f"released claim on {task}")
else:
    print(f"no active claim on {task}")
PY

# Mutate TASKS.md status line for the named task.
python3 - "${HARNESS_DIR}/TASKS.md" "${TASK}" "${NEW_STATUS}" <<'PY'
import re, sys
path, task, status = sys.argv[1:4]
with open(path) as f:
    src = f.read()
pattern = re.compile(rf"(^## {re.escape(task)}\s*\n+)(\*\*Status\*\*: )([A-Za-z_-]+)", re.M)
new, n = pattern.subn(rf"\g<1>\g<2>{status}", src)
if n:
    with open(path, "w") as f:
        f.write(new)
    print(f"TASKS.md: {task} status -> {status}")
else:
    sys.stderr.write(f"release: could not update status for {task} (pattern not matched)\n")
PY
