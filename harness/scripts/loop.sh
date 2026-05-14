#!/usr/bin/env bash
# loop.sh -- run worker.sh in a loop until no claimable task remains
# or MAX_CYCLES is reached. Exit codes:
#   0  loop ran to natural completion (no work left)
#   1  a cycle aborted; loop bails out so the operator can inspect
set -euo pipefail

CYCLE=0
while [ "${CYCLE}" -lt "${MAX_CYCLES}" ]; do
	CYCLE=$((CYCLE + 1))
	echo "[harness:loop] cycle ${CYCLE}/${MAX_CYCLES}"
	if ! "${SCRIPTS}/worker.sh"; then
		echo "[harness:loop] cycle failed; bailing"
		exit 1
	fi
	# If worker.sh exited 0 with no task picked, we are done.
	LAST_RUN=$(ls -1t "${RUNS}" 2>/dev/null | head -1)
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
echo "[harness:loop] finished after ${CYCLE} cycle(s)"
