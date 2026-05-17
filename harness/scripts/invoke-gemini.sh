#!/usr/bin/env bash
# invoke-gemini.sh -- adapter for Gemini CLI.
# Same contract as invoke-claude.sh: receives a task description file,
# runs the worker non-interactively in this repo, exits when done.
#
# Required: `gemini` on PATH (the @google/gemini-cli binary).
# Optional: GEMINI_API_KEY in env, or `gemini` already authenticated.
#
# Prompt construction (hard rules + task description) is shared with the
# other invokers via prompt.sh.
set -euo pipefail

DESC_FILE="${1:?description file required}"

if ! command -v gemini >/dev/null 2>&1; then
	echo "invoke-gemini: 'gemini' binary not on PATH" >&2
	exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./prompt.sh
. "${SCRIPT_DIR}/prompt.sh"
PROMPT="$(harness_build_worker_prompt "${DESC_FILE}")"

# Gemini CLI headless mode: -p sends the prompt non-interactively,
# --yolo auto-approves tool calls (the verifier is the safety layer),
# and --output-format json produces structured output for evidence
# capture. The harness runs single-instance with a clean working tree,
# so auto-approval is safe within this context.
exec gemini -p "${PROMPT}" --yolo --output-format json
