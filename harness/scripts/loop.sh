#!/usr/bin/env bash
# loop.sh -- run worker.sh in a loop until no claimable task remains
# or MAX_CYCLES is reached. Exit codes:
#   0  loop ran to natural completion (no work left)
#   1  strict mode was requested and a cycle failed
set -euo pipefail

CYCLE=0
FAILURES=0
while [ "${CYCLE}" -lt "${MAX_CYCLES}" ]; do
	CYCLE=$((CYCLE + 1))
	echo "[harness:loop] cycle ${CYCLE}/${MAX_CYCLES}"
	if ! "${SCRIPTS}/worker.sh"; then
		FAILURES=$((FAILURES + 1))
		LAST_RUN=$(ls -1t "${RUNS}" 2>/dev/null | head -1 || true)
		DISPOSITION_FILE="${RUNS}/${LAST_RUN}/disposition.txt"
		DISPOSITION="unknown"
		[ -f "${DISPOSITION_FILE}" ] && DISPOSITION="$(cat "${DISPOSITION_FILE}")"
		echo "[harness:loop] cycle failed with disposition=${DISPOSITION}; continuing to preserve forward progress"
		if [ "${HARNESS_STOP_ON_FAILURE:-0}" = "1" ]; then
			echo "[harness:loop] HARNESS_STOP_ON_FAILURE=1; stopping after failed cycle"
			exit 1
		fi
	fi
	# If worker.sh exited 0 with no task picked, we are done.
	LAST_RUN=$(ls -1t "${RUNS}" 2>/dev/null | head -1 || true)
	if [ -z "${LAST_RUN}" ]; then break; fi
	DISPOSITION_FILE="${RUNS}/${LAST_RUN}/disposition.txt"
	if [ ! -f "${DISPOSITION_FILE}" ]; then
		echo "[harness:loop] no disposition recorded; assuming no work left"
		break
	fi
	# Tasks completing produce a "completed" disposition. If the most
	# recent run had nothing to pick, no claim was made and no
	# disposition file was created -- the early exit above handles that.
done
echo "[harness:loop] finished after ${CYCLE} cycle(s), failures=${FAILURES}"
