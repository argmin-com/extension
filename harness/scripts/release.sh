#!/usr/bin/env bash
# release.sh -- drop a claim and optionally mark the task complete.
# Usage: release.sh <task-slug> [status]
#   status: pending | completed | needs-review | abandoned (default: pending)
set -euo pipefail

TASK="${1:?task slug required}"
NEW_STATUS="${2:-pending}"

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
