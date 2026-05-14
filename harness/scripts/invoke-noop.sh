#!/usr/bin/env bash
# invoke-noop.sh -- test-only worker that does nothing and exits zero.
# Used by tests/harness/smoke.test.sh to exercise the harness loop
# without invoking a real worker (which would require ANTHROPIC_API_KEY
# or OPENAI_API_KEY plus network access). The harness contract is
# "worker reads a description file, makes changes if it wants, exits";
# this implementation makes no changes and exits cleanly. The verifier
# step that follows finds an empty working tree, which the harness
# treats as a successful no-diff cycle.
set -euo pipefail
DESC_FILE="${1:?description file required}"
[ -f "${DESC_FILE}" ] || { echo "noop: description file not found" >&2; exit 1; }
echo "noop worker: would have processed $(basename "${DESC_FILE}")"
exit 0
