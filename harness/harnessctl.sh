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
		pick|release)
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
		echo "Valid: status | tasks | pick | release | once | loop | verify" >&2
		exit 2
		;;
esac
