#!/usr/bin/env bash
# worker.sh -- one full cycle: pick → invoke worker → verify → commit.
# Idempotent on failure: aborted cycles release their claim, capture
# evidence, and mark the task `needs-review`. Never force-pushes; never
# rewrites history.
set -euo pipefail

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="${RUNS}/${RUN_ID}"
mkdir -p "${RUN_DIR}"
export RUN_ID RUN_DIR

log() { echo "[harness:${RUN_ID}] $*"; }

# Single-instance guard. flock(1) keeps the lockfile open for the lifetime
# of the worker process.
exec 9>"${LOCK}"
if ! flock -n 9; then
	log "another harness worker is running; aborting"
	exit 0
fi

cd "${REPO_DIR}"

# Fail fast if the working tree is not clean -- we will not stack changes
# on top of an unrelated WIP.
if [ -n "$(git status --porcelain)" ]; then
	log "working tree is dirty; aborting (run \`git stash\` first or commit your WIP)"
	git status --short > "${RUN_DIR}/dirty-tree.txt"
	exit 1
fi

# 1) Pick a task. If --task was provided, use it. Otherwise, scan
# TASKS.md for the first pending task with no live claim.
if [ -n "${TASK_SLUG:-}" ]; then
	TARGET="${TASK_SLUG}"
else
	TARGET=$(python3 - "${HARNESS_DIR}/TASKS.md" "${CLAIMS}" <<'PY'
import json, re, sys, os, time
tasks_path, claims_path = sys.argv[1:3]
with open(tasks_path) as f:
    src = f.read()
with open(claims_path) as f:
    claims = json.load(f)
now = int(time.time())
# Reap stale claims.
for slug in list(claims):
    c = claims[slug]
    if c.get("expires_epoch", 0) <= now:
        del claims[slug]
        continue
    pid = c.get("pid", 0)
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        del claims[slug]
if claims != json.load(open(claims_path)):
    with open(claims_path + ".tmp", "w") as f:
        json.dump(claims, f, indent=2)
    os.replace(claims_path + ".tmp", claims_path)
# Walk tasks. First level-2 heading whose status is pending and slug
# is not claimed -> our pick.
blocks = re.split(r"^## ", src, flags=re.M)[1:]
for block in blocks:
    slug = block.split("\n", 1)[0].strip()
    m = re.search(r"\*\*Status\*\*: *([a-zA-Z_-]+)", block)
    status = m.group(1) if m else ""
    if status == "pending" and slug not in claims:
        print(slug); sys.exit(0)
sys.exit(0)
PY
)
fi

if [ -z "${TARGET}" ]; then
	log "no claimable task available"
	exit 0
fi
log "picked task: ${TARGET}"

# 2) Claim it.
if [ "${DRY_RUN}" -eq 1 ]; then
	log "DRY RUN -- would claim ${TARGET} and invoke ${WORKER}"
	exit 0
fi
"${SCRIPTS}/claim.sh" "${TARGET}" > "${RUN_DIR}/claim.json"

# Always release the claim and fire the notify hook on exit, no matter
# how we got here. notify.sh is safe-by-default (no webhook configured
# = stdout only), so this is purely additive.
DISPOSITION="aborted"
release_on_exit() {
	"${SCRIPTS}/release.sh" "${TARGET}" "${DISPOSITION}" || true
	echo "${DISPOSITION}" > "${RUN_DIR}/disposition.txt"
	"${SCRIPTS}/notify.sh" "${TARGET}" "${DISPOSITION}" "${RUN_ID}" || true
}
trap release_on_exit EXIT

# Mark in_progress in TASKS.md while the worker is running.
python3 - "${HARNESS_DIR}/TASKS.md" "${TARGET}" "in_progress" <<'PY'
import re, sys
path, task, status = sys.argv[1:4]
with open(path) as f: src = f.read()
new, n = re.subn(rf"(^## {re.escape(task)}\s*\n+\*\*Status\*\*: )([a-zA-Z_-]+)",
                 rf"\g<1>{status}", src, flags=re.M)
if n: open(path, "w").write(new)
PY

# 3) Extract description for the worker.
DESC_FILE="${RUN_DIR}/description.md"
python3 - "${HARNESS_DIR}/TASKS.md" "${TARGET}" "${DESC_FILE}" <<'PY'
import re, sys
path, task, out = sys.argv[1:4]
src = open(path).read()
blocks = re.split(r"^## ", src, flags=re.M)
desc = ""
for b in blocks[1:]:
    if b.startswith(task + "\n") or b.startswith(task + " "):
        desc = b
        break
open(out, "w").write(desc)
PY

log "invoking worker=${WORKER}"
INVOKER="${SCRIPTS}/invoke-${WORKER}.sh"
if [ ! -x "${INVOKER}" ]; then
	log "no invoker found for worker=${WORKER} (expected ${INVOKER})"
	exit 1
fi

set +e
"${INVOKER}" "${DESC_FILE}" > "${RUN_DIR}/worker.stdout" 2> "${RUN_DIR}/worker.stderr"
WORKER_RC=$?
set -e

log "worker exit=${WORKER_RC}"
git diff --stat > "${RUN_DIR}/diff.stat" || true
git diff > "${RUN_DIR}/diff.patch" || true

if [ "${WORKER_RC}" -ne 0 ]; then
	log "worker failed -- stashing WIP, marking needs-review"
	git stash push --include-untracked -m "harness-aborted-${RUN_ID}" > "${RUN_DIR}/stash.log" 2>&1 || true
	DISPOSITION="needs-review"
	exit 1
fi

# 4) Verify.
log "running verifier"
if ! "${SCRIPTS}/verify.sh"; then
	log "verifier failed -- stashing WIP, marking needs-review"
	git stash push --include-untracked -m "harness-verify-failed-${RUN_ID}" > "${RUN_DIR}/stash.log" 2>&1 || true
	DISPOSITION="needs-review"
	exit 1
fi

# 5) Commit + push.
if [ -z "$(git status --porcelain)" ]; then
	log "no changes produced -- task complete with no diff"
	DISPOSITION="completed"
	exit 0
fi

git add -A
git commit -m "harness(${TARGET}): autonomous cycle ${RUN_ID}

Verifier: npm run verify:all + test:e2e green.
Worker: ${WORKER}
Run ID: ${RUN_ID}
" > "${RUN_DIR}/commit.log" 2>&1

# Pull --rebase to integrate any upstream changes; re-verify if rebase
# applied. Never force-push.
if ! git push origin HEAD; then
	log "push rejected -- rebasing and retrying verifier"
	git pull --rebase origin HEAD > "${RUN_DIR}/rebase.log" 2>&1 || {
		log "rebase failed"
		DISPOSITION="needs-review"
		exit 1
	}
	if ! "${SCRIPTS}/verify.sh"; then
		log "post-rebase verifier failed"
		DISPOSITION="needs-review"
		exit 1
	fi
	git push origin HEAD > "${RUN_DIR}/push.log" 2>&1
fi

DISPOSITION="completed"
log "task ${TARGET} completed and pushed"
