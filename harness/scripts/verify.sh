#!/usr/bin/env bash
# verify.sh -- the mandatory verifier gate. Runs `npm run verify:all` and
# the Playwright e2e suite. Captures all output to the run directory so
# evidence is preserved even when the worker is unattended.
set -euo pipefail

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RUN_DIR="${RUNS}/${RUN_ID}"
mkdir -p "${RUN_DIR}"

cd "${REPO_DIR}"

set +e
npm run verify:all > "${RUN_DIR}/verify-all.log" 2>&1
VERIFY_RC=$?
npm run test:e2e > "${RUN_DIR}/test-e2e.log" 2>&1
E2E_RC=$?
set -e

echo "verify:all exit=${VERIFY_RC}"
echo "test:e2e exit=${E2E_RC}"
echo "log dir: ${RUN_DIR}"

if [ "${VERIFY_RC}" -ne 0 ] || [ "${E2E_RC}" -ne 0 ]; then
	exit 1
fi
