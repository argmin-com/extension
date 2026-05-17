#!/usr/bin/env bash
# Shared runtime helpers for the extension harness. This file is sourced by
# worker.sh and intentionally has no external dependencies beyond python3.

harness_iso_now() {
	date -u +"%Y-%m-%dT%H:%M:%SZ"
}

harness_trace_event() {
	local trace_file="$1"
	local event="$2"
	local message="${3:-}"
	python3 - "${trace_file}" "${event}" "${message}" <<'PY'
from datetime import datetime, timezone
import json
import sys

trace_file, event, message = sys.argv[1:4]
record = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "event": event,
    "message": message,
}
with open(trace_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, sort_keys=True) + "\n")
PY
}

harness_write_diagnostics() {
	local diagnostics_file="$1"
	local state="$2"
	local failure_mode="$3"
	local exit_code="$4"
	python3 - "${diagnostics_file}" "${state}" "${failure_mode}" "${exit_code}" "${REPO_DIR}" "${RUN_ID}" "${TARGET:-}" "${WORKER}" <<'PY'
from datetime import datetime, timezone
import json
import subprocess
import sys

path, state, failure_mode, exit_code, repo_dir, run_id, task, worker = sys.argv[1:9]

def git(args):
    try:
        return subprocess.check_output(["git", *args], cwd=repo_dir, text=True, stderr=subprocess.STDOUT).strip()
    except Exception as exc:
        return f"unavailable: {exc}"

record = {
    "schemaVersion": 1,
    "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "state": state,
    "failureMode": failure_mode,
    "exitCode": int(exit_code),
    "runId": run_id,
    "task": task,
    "worker": worker,
    "branch": git(["rev-parse", "--abbrev-ref", "HEAD"]),
    "worktree": git(["rev-parse", "--show-toplevel"]),
    "gitStatus": git(["status", "--short"]).splitlines(),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(record, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

harness_write_outcome() {
	local outcome_file="$1"
	local status="$2"
	local disposition="$3"
	local failure_mode="$4"
	local exit_code="$5"
	python3 - "${outcome_file}" "${status}" "${disposition}" "${failure_mode}" "${exit_code}" "${RUN_DIR}" "${RUN_ID}" "${TARGET:-}" "${WORKER}" "${HARNESS_WORKER_TIMEOUT_SECONDS:-3600}" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import json
import sys

(
    outcome_file,
    status,
    disposition,
    failure_mode,
    exit_code,
    run_dir,
    run_id,
    task,
    worker,
    worker_timeout_seconds,
) = sys.argv[1:11]

run_path = Path(run_dir)
worker_stdout = run_path / "worker.stdout"
worker_stderr = run_path / "worker.stderr"
verify_all = run_path / "verify-all.log"
test_e2e = run_path / "test-e2e.log"
smoke_mode = disposition == "completed" and not verify_all.exists() and not test_e2e.exists()
criteria = {
    "taskClaimed": (run_path / "claim.json").is_file(),
    "heartbeatRecorded": (run_path / "heartbeat.json").is_file(),
    "workerExitZero": status == "passed",
    "workerEvidenceCaptured": worker_stdout.is_file() and worker_stderr.is_file(),
    "verifierEvidenceCaptured": smoke_mode or (verify_all.is_file() and test_e2e.is_file()),
    "dispositionRecorded": (run_path / "disposition.txt").is_file(),
}
record = {
    "schemaVersion": 1,
    "contractVersion": "2026-05-17.ratchet.v1",
    "status": status,
    "disposition": disposition,
    "failureMode": failure_mode,
    "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "exitCode": int(exit_code),
    "runId": run_id,
    "task": task,
    "worker": worker,
    "criteria": criteria,
    "budgets": {
        "workerTimeoutSeconds": int(worker_timeout_seconds),
        "maxCycles": int(__import__("os").environ.get("MAX_CYCLES", "10")),
    },
    "modelCapabilityAssumption": "Workers can stall, exit early, or self-report completion; the shell harness owns leases, heartbeats, verifier evidence, and default-fail outcomes.",
}
with open(outcome_file, "w", encoding="utf-8") as f:
    json.dump(record, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

harness_with_timeout() {
	local timeout_seconds="$1"
	shift
	if ! [[ "${timeout_seconds}" =~ ^[0-9]+$ ]] || [ "${timeout_seconds}" -le 0 ]; then
		"$@"
		return $?
	fi

	local marker
	marker="$(mktemp)"
	"$@" &
	local child_pid=$!
	(
		sleep "${timeout_seconds}"
		if kill -0 "${child_pid}" 2>/dev/null; then
			echo timeout > "${marker}"
			kill "${child_pid}" 2>/dev/null || true
			sleep 2
			kill -9 "${child_pid}" 2>/dev/null || true
		fi
	) &
	local watchdog_pid=$!

	local rc=0
	wait "${child_pid}" || rc=$?
	kill "${watchdog_pid}" 2>/dev/null || true
	wait "${watchdog_pid}" 2>/dev/null || true

	if [ -s "${marker}" ]; then
		rm -f "${marker}"
		return 124
	fi
	rm -f "${marker}"
	return "${rc}"
}

harness_start_heartbeat() {
	local claims_file="$1"
	local task="$2"
	local owner_pid="$3"
	local run_id="$4"
	local lease_seconds="$5"
	local interval_seconds="$6"
	local run_dir="$7"
	(
		while true; do
			python3 - "${claims_file}" "${task}" "${owner_pid}" "${run_id}" "${lease_seconds}" "${run_dir}" <<'PY'
from datetime import datetime, timezone
import json
import os
import sys

claims_file, task, owner_pid, run_id, lease_seconds, run_dir = sys.argv[1:7]
owner_pid = int(owner_pid)
lease_seconds = int(lease_seconds)
now = int(datetime.now(timezone.utc).timestamp())

def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

with open(claims_file, encoding="utf-8") as f:
    claims = json.load(f)
claim = claims.get(task)
if not claim or int(claim.get("pid", -1)) != owner_pid:
    sys.exit(0)
claim["heartbeat_epoch"] = now
claim["heartbeat_iso"] = iso(now)
claim["expires_epoch"] = now + lease_seconds
claim["expires_iso"] = iso(now + lease_seconds)
claim["run_id"] = run_id
tmp = claims_file + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(claims, f, indent=2)
os.replace(tmp, claims_file)
heartbeat = {
    "task": task,
    "pid": owner_pid,
    "runId": run_id,
    "heartbeatIso": claim["heartbeat_iso"],
    "expiresIso": claim["expires_iso"],
}
with open(os.path.join(run_dir, "heartbeat.json"), "w", encoding="utf-8") as f:
    json.dump(heartbeat, f, indent=2)
    f.write("\n")
PY
			sleep "${interval_seconds}"
		done
	) &
	HARNESS_HEARTBEAT_PID="$!"
}
