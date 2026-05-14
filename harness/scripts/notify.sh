#!/usr/bin/env bash
# notify.sh -- optional outcome notification hook.
#
# This script is invoked by worker.sh / loop.sh at the end of each cycle
# with the disposition of the most recent run. By default it is a no-op
# so the harness ships safe-by-default (no off-host data leaving the
# user's machine without explicit configuration).
#
# To enable notifications, set ARGMIN_HARNESS_WEBHOOK in the environment
# (e.g. a Slack incoming webhook URL, a Discord webhook URL, or any
# endpoint that accepts a POST with a "text" field). The body posted is
# strictly limited to the cycle metadata -- run id, disposition, task
# slug -- never the worker output, never the diff, never log content.
#
# Inputs (positional):
#   $1  task slug
#   $2  disposition (completed | aborted | needs-review)
#   $3  run id
set -euo pipefail

TASK="${1:-unknown}"
DISPOSITION="${2:-unknown}"
RUN_ID="${3:-unknown}"

if [ -z "${ARGMIN_HARNESS_WEBHOOK:-}" ]; then
	# Default: no-op. Print to stdout so the operator can see what would
	# have been sent if a webhook were configured.
	echo "[harness:notify] task=${TASK} disposition=${DISPOSITION} run=${RUN_ID} (no webhook configured; not sending)"
	exit 0
fi

# Single text-only POST. No headers leak repo path, no body content
# leaks run output. Webhook failure is non-fatal.
TEXT="argmin-extension harness: ${TASK} -> ${DISPOSITION} (run ${RUN_ID})"
curl -sS -m 10 -X POST -H "Content-Type: application/json" \
	-d "{\"text\":$(printf '%s' "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
	"${ARGMIN_HARNESS_WEBHOOK}" >/dev/null 2>&1 || true
echo "[harness:notify] task=${TASK} disposition=${DISPOSITION} run=${RUN_ID} (webhook attempted)"
