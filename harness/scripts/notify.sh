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
# leaks run output. Webhook failure is non-fatal but is reported with
# distinct outcomes so an operator can tell what happened:
#   webhook ok       -- HTTP 2xx
#   webhook non-2xx  -- HTTP 3xx / 4xx / 5xx
#   webhook unreachable -- curl exit code != 0 (DNS, timeout, network)
TEXT="argmin-extension harness: ${TASK} -> ${DISPOSITION} (run ${RUN_ID})"
BODY=$(printf '%s' "$TEXT" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')

set +e
HTTP_STATUS=$(curl -sS -m 10 -X POST -H "Content-Type: application/json" \
	-d "${BODY}" \
	-o /dev/null -w '%{http_code}' \
	"${ARGMIN_HARNESS_WEBHOOK}" 2>/dev/null)
CURL_RC=$?
set -e

if [ "${CURL_RC}" -ne 0 ]; then
	echo "[harness:notify] task=${TASK} disposition=${DISPOSITION} run=${RUN_ID} (webhook unreachable; curl rc=${CURL_RC})" >&2
	exit 0
fi
if [ "${HTTP_STATUS}" -ge 200 ] && [ "${HTTP_STATUS}" -lt 300 ]; then
	echo "[harness:notify] task=${TASK} disposition=${DISPOSITION} run=${RUN_ID} (webhook ok ${HTTP_STATUS})"
else
	echo "[harness:notify] task=${TASK} disposition=${DISPOSITION} run=${RUN_ID} (webhook non-2xx ${HTTP_STATUS})" >&2
fi
