#!/usr/bin/env bash
# invoke-codex.sh -- adapter for Codex CLI.
# Same contract as invoke-claude.sh: receives a task description file,
# runs the worker non-interactively in this repo, exits when done.
#
# Required: `codex` on PATH.
#
# Prompt construction (hard rules + task description) is shared with the
# other invokers via prompt.sh.
set -euo pipefail

DESC_FILE="${1:?description file required}"

if ! command -v codex >/dev/null 2>&1; then
	echo "invoke-codex: 'codex' binary not on PATH" >&2
	exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./prompt.sh
. "${SCRIPT_DIR}/prompt.sh"
PROMPT="$(harness_build_worker_prompt "${DESC_FILE}")"

# Codex non-interactive mode runs through `codex exec`. Cwd is implicit;
# Codex picks up the current working directory.
exec codex exec --dangerously-bypass-approvals-and-sandbox "${PROMPT}"
