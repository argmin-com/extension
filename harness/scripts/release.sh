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

# Same dual-transport strategy as claim.sh: flock where available,
# atomic-mkdir fallback elsewhere (notably macOS without Homebrew flock).
acquire_claims_lock() {
	local lockdir="${CLAIMS_LOCK}.d"
	local attempt
	for attempt in 1 2 3 4 5 6 7 8 9 10; do
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
	echo "release: could not acquire ${lockdir} after 10 attempts" >&2
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

python3 - "${CLAIMS}" "${TASK}" <<'PY'
import json, os, sys
claims_path, task = sys.argv[1:3]
with open(claims_path, encoding="utf-8") as f:
    claims = json.load(f)
if task in claims:
    del claims[task]
    tmp = claims_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
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
with open(path, encoding="utf-8") as f:
    src = f.read()
pattern = re.compile(rf"(^## {re.escape(task)}\s*\n+)(\*\*Status\*\*: )([A-Za-z_-]+)", re.M)
new, n = pattern.subn(rf"\g<1>\g<2>{status}", src)
if n:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"TASKS.md: {task} status -> {status}")
else:
    sys.stderr.write(f"release: could not update status for {task} (pattern not matched)\n")
PY
