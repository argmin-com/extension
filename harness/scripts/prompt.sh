#!/usr/bin/env bash
# prompt.sh -- build the worker prompt for any invoke-*.sh adapter.
# Sourced (or executed) by invoke-claude.sh / invoke-codex.sh / invoke-gemini.sh
# so the hard-rules block stays in one place. If a rule changes here, every
# worker sees it on the next cycle without three-file synchronization.
#
# Usage (sourced):
#   . "$(dirname "$0")/prompt.sh"
#   PROMPT="$(harness_build_worker_prompt "${DESC_FILE}")"
#
# Usage (executed):
#   "$(dirname "$0")/prompt.sh" "${DESC_FILE}" > prompt.txt
#
# Security note: the description file content is streamed directly via
# `cat` rather than interpolated into a heredoc. Heredoc interpolation of
# untrusted content would execute backticks and $(...) in the description,
# and a line containing only `EOF` would prematurely terminate the heredoc.
# Streaming sidesteps both issues.
set -euo pipefail

harness_build_worker_prompt() {
	local desc_file="${1:?description file required}"
	if [ ! -r "${desc_file}" ]; then
		echo "harness/prompt: description file not readable: ${desc_file}" >&2
		return 2
	fi
	# Header is a heredoc so $(pwd) interpolates. Body is streamed via cat
	# so untrusted content is treated as data, not shell code.
	cat <<EOF
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

EOF
	cat "${desc_file}"
}

# Direct execution: write the prompt to stdout.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	harness_build_worker_prompt "$@"
fi
