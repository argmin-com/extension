#!/usr/bin/env python3
"""Evidence collection and manifest generation."""
import datetime
import json
import os
import subprocess
import sys
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SURFACES_CHECKED = [
    "syntax",
    "privacy",
    "unit_tests",
    "dataclasses",
    "handler_count",
    "release_packages",
    "firefox_lint",
]

def get_git_sha():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "unknown"

def collect(run_id=None):
    run_id = run_id or str(uuid.uuid4())[:8]
    evidence_dir = os.path.join(ROOT, "artifacts", "evidence", run_id)
    os.makedirs(evidence_dir, exist_ok=True)

    # Run all checks and capture results
    started = time.time()
    result = subprocess.run(
        [sys.executable, "scripts/run_checks.py", "all"],
        capture_output=True,
        text=True,
        cwd=ROOT
    )
    duration = round(time.time() - started, 3)

    manifest = {
        "run_id": run_id,
        "timestamp": datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z"),
        "git_sha": get_git_sha(),
        "status": "pass" if result.returncode == 0 else "fail",
        "stdout": result.stdout,
        "stderr": result.stderr,
        "surfaces_checked": SURFACES_CHECKED,
        "failures": [] if result.returncode == 0 else [{
            "surface": "all",
            "message": result.stderr or result.stdout,
            "command": "python3 scripts/run_checks.py all",
            "exit_code": result.returncode,
        }],
        "duration_seconds": duration,
    }

    manifest_path = os.path.join(evidence_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"Evidence written to {manifest_path}")
    print(f"Status: {manifest['status']}")
    return manifest["status"] == "pass"

if __name__ == "__main__":
    run_id = sys.argv[1] if len(sys.argv) > 1 else None
    sys.exit(0 if collect(run_id) else 1)
