#!/usr/bin/env bash
# invoke-claude.sh -- adapter for Claude Code CLI.
# Receives a task description file and runs Claude Code in print-only
# (non-interactive) mode against the repo. Claude Code's `--print`
# / `-p` mode streams its work and exits when done.
#
# Required: `claude` on PATH (the Claude Code CLI binary).
# Optional: ANTHROPIC_API_KEY in env, or `claude` already authenticated.
set -euo pipefail

DESC_FILE="${1:?description file required}"

if ! command -v claude >/dev/null 2>&1; then
	echo "invoke-claude: 'claude' binary not on PATH" >&2
	exit 127
fi

# Compose a prompt that includes our hard rules so the worker stays
# within the harness's verifier-gated lanes.
PROMPT="$(cat <<EOF
You are the autonomous worker for the argmin-com/extension harness. The
repository is at $(pwd). The task you must complete is in the next
section, taken verbatim from harness/TASKS.md.

Hard rules:
- Never force-push, never rewrite history, never delete branches.
- Never disable git hooks or skip verify gates.
- Never persist raw prompt text, completion text, API keys, or
  conversation IDs to chrome.storage.local.
- Stop when the task acceptance criteria are met. The harness will run
  npm run verify:all and npm run test:e2e after you exit.
- If you cannot complete the task, leave the working tree clean and exit
  with a non-zero status.

Task description:

$(cat "${DESC_FILE}")
EOF
)"

# --dangerously-skip-permissions is intentional inside the harness: the
# verifier is the safety layer, and the worker runs inside a single-
# instance lock on a clean working tree. Operators who want the
# interactive prompt path should run claude directly, not via the
# harness.
exec claude --dangerously-skip-permissions --print "${PROMPT}"
