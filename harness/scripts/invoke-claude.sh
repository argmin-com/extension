#!/usr/bin/env bash
# invoke-claude.sh -- adapter for Claude Code CLI.
# Receives a task description file and runs Claude Code in print-only
# (non-interactive) mode against the repo. Claude Code's `--print`
# / `-p` mode streams its work and exits when done.
#
# Required: `claude` on PATH (the Claude Code CLI binary).
# Optional: ANTHROPIC_API_KEY in env, or `claude` already authenticated.
#
# Prompt construction (hard rules + task description) is shared with the
# other invokers via prompt.sh so all three workers see identical
# instructions.
set -euo pipefail

DESC_FILE="${1:?description file required}"

if ! command -v claude >/dev/null 2>&1; then
	echo "invoke-claude: 'claude' binary not on PATH" >&2
	exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./prompt.sh
. "${SCRIPT_DIR}/prompt.sh"
PROMPT="$(harness_build_worker_prompt "${DESC_FILE}")"

# --dangerously-skip-permissions is intentional inside the harness: the
# verifier is the safety layer, and the worker runs inside a single-
# instance lock on a clean working tree. Operators who want the
# interactive prompt path should run claude directly, not via the
# harness.
exec claude --dangerously-skip-permissions --print "${PROMPT}"
