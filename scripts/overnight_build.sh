#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

LOCK_DIR="/tmp/extension-overnight-verify.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another overnight verification run is active (lock: $LOCK_DIR). Exiting."
    exit 1
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
echo $$ > "$LOCK_DIR/pid"

echo "=== Extension Overnight Verification ==="
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Git SHA: $(git rev-parse HEAD)"

# Validate environment
command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found"; exit 1; }

# Collect evidence from all verification gates, including release packaging and Firefox lint.
python3 scripts/collect_evidence.py "overnight-$(date +%Y%m%d-%H%M%S)"

echo "=== Overnight Verification Complete ==="
echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
