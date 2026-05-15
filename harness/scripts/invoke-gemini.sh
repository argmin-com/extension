#!/usr/bin/env bash
# invoke-gemini.sh -- adapter for Gemini CLI.
# Same contract as invoke-claude.sh: receives a task description file,
# runs the worker non-interactively in this repo, exits when done.
#
# Required: `gemini` on PATH (the @google/gemini-cli binary).
# Optional: GEMINI_API_KEY in env, or `gemini` already authenticated.
set -euo pipefail

DESC_FILE="${1:?description file required}"

if ! command -v gemini >/dev/null 2>&1; then
	echo "invoke-gemini: 'gemini' binary not on PATH" >&2
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

# Gemini CLI headless mode: -p sends the prompt non-interactively,
# --yolo auto-approves tool calls (the verifier is the safety layer),
# and --output-format json produces structured output for evidence
# capture. The harness runs single-instance with a clean working tree,
# so auto-approval is safe within this context.
exec gemini -p "${PROMPT}" --yolo --output-format json
