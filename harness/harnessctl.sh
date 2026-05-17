#!/usr/bin/env bash
# harnessctl.sh -- operator entrypoint for the extension harness.
# Run with: ./harness/harnessctl.sh <command> [flags]
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${HARNESS_DIR}/.." && pwd)"
SCRIPTS="${HARNESS_DIR}/scripts"
STATE="${HARNESS_DIR}/state"
RUNS="${STATE}/runs"
CLAIMS="${STATE}/claims.json"
LOCK="${STATE}/repo.lock"

mkdir -p "${RUNS}"
[ -f "${CLAIMS}" ] || echo '{}' > "${CLAIMS}"

WORKER="${HARNESS_WORKER:-claude}"
DRY_RUN=0
TASK_SLUG=""
MAX_CYCLES="${HARNESS_MAX_CYCLES:-10}"

CMD="${1:-status}"; shift || true

if [ $# -gt 0 ] && [ -z "${TASK_SLUG}" ]; then
	case "${CMD}" in
		# prune-runs reuses the same positional slot for its retention-day
		# argument; the prune-runs handler validates it numerically.
		pick|release|prune-runs)
			case "$1" in
				--*) ;;
				*) TASK_SLUG="$1"; shift ;;
			esac
			;;
	esac
fi

while [ $# -gt 0 ]; do
	case "$1" in
		--worker) WORKER="$2"; shift 2 ;;
		--worker=*) WORKER="${1#*=}"; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		--task) TASK_SLUG="$2"; shift 2 ;;
		--task=*) TASK_SLUG="${1#*=}"; shift ;;
		--max-cycles) MAX_CYCLES="$2"; shift 2 ;;
		--max-cycles=*) MAX_CYCLES="${1#*=}"; shift ;;
		*) echo "harnessctl: unknown flag: $1" >&2; exit 2 ;;
	esac
done

export HARNESS_DIR REPO_DIR SCRIPTS STATE RUNS CLAIMS LOCK WORKER DRY_RUN TASK_SLUG MAX_CYCLES

case "${CMD}" in
	prune-runs)
		# Optional first positional arg = retention days. Default matches
		# the CI artifact retention so local and remote stay in sync.
		PRUNE_DAYS="${TASK_SLUG:-14}"
		if ! [[ "${PRUNE_DAYS}" =~ ^[0-9]+$ ]]; then
			echo "harnessctl: prune-runs days must be a non-negative integer, got: ${PRUNE_DAYS}" >&2
			exit 2
		fi
		python3 - "${RUNS}" "${PRUNE_DAYS}" <<'PY'
import os
import shutil
import sys
import time

runs_dir, days = sys.argv[1], int(sys.argv[2])
if not os.path.isdir(runs_dir):
    sys.exit(0)
cutoff = time.time() - days * 86400
removed = 0
kept = 0
for name in sorted(os.listdir(runs_dir)):
    path = os.path.join(runs_dir, name)
    if not os.path.isdir(path):
        continue
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        continue
    if mtime < cutoff:
        shutil.rmtree(path, ignore_errors=True)
        removed += 1
    else:
        kept += 1
print(f"pruned {removed} run dir(s) older than {days}d; kept {kept}")
PY
		exit 0
		;;
	reap)
		# Sweep claims.json for entries whose PID is gone or whose lease
		# has expired. The worker.sh task-picker already does this inline
		# during normal cycles, but an operator command is useful after
		# an external kill / crash so `harnessctl status` reflects reality.
		python3 - "${CLAIMS}" <<'PY'
import json
import os
import sys
import time

path = sys.argv[1]
if not os.path.exists(path):
    print("no claims file")
    sys.exit(0)
with open(path) as f:
    claims = json.load(f)
now = int(time.time())
reaped = []
for slug in list(claims):
    c = claims[slug]
    expired = c.get("expires_epoch", 0) <= now
    pid = c.get("pid", 0)
    alive = True
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        alive = False
    if expired or not alive:
        reaped.append((slug, "lease_expired" if expired else "pid_gone"))
        del claims[slug]
if reaped:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(claims, f, indent=2)
    os.replace(tmp, path)
    for slug, reason in reaped:
        print(f"reaped {slug} ({reason})")
else:
    print("no stale claims found")
PY
		exit 0
		;;
	status)
		echo "== claims =="
		cat "${CLAIMS}"
		echo
		echo "== recent runs (last 5) =="
		ls -1t "${RUNS}" 2>/dev/null | head -5
		echo
		echo "== recent outcomes =="
		for run in $(ls -1t "${RUNS}" 2>/dev/null | head -5); do
			if [ -f "${RUNS}/${run}/outcome.json" ]; then
				python3 - "${run}" "${RUNS}/${run}/outcome.json" <<'PY'
import json, sys
run_id, path = sys.argv[1:3]
with open(path) as f:
    data = json.load(f)
print(f"{run_id} {data.get('status')} {data.get('disposition')} {data.get('failureMode')}")
PY
			else
				printf '%s %s\n' "${run}" "outcome=missing"
			fi
		done
		echo
		echo "== TASKS.md summary =="
		grep -E "^(## |\*\*Status\*\*)" "${HARNESS_DIR}/TASKS.md" | awk '
			/^## / { if (slug) printf "%-50s %s\n", slug, status; slug=$0; sub(/^## /, "", slug); status="?" }
			/Status/ { gsub(/.*Status\*\*: */, ""); status=$0 }
			END { if (slug) printf "%-50s %s\n", slug, status }
		'
		;;
	tasks)
		grep -E "^## " "${HARNESS_DIR}/TASKS.md" | sed 's/^## /  /'
		;;
	pick)
		[ -z "${TASK_SLUG}" ] && { echo "Usage: harnessctl.sh pick --task <slug>" >&2; exit 2; }
		"${SCRIPTS}/claim.sh" "${TASK_SLUG}"
		;;
	release)
		[ -z "${TASK_SLUG}" ] && { echo "Usage: harnessctl.sh release --task <slug>" >&2; exit 2; }
		"${SCRIPTS}/release.sh" "${TASK_SLUG}"
		;;
	once)
		"${SCRIPTS}/worker.sh"
		;;
	loop)
		"${SCRIPTS}/loop.sh"
		;;
	verify)
		"${SCRIPTS}/verify.sh"
		;;
	*)
		echo "harnessctl: unknown command: ${CMD}" >&2
		echo "Valid: status | tasks | pick | release | once | loop | verify | prune-runs | reap" >&2
		exit 2
		;;
esac
