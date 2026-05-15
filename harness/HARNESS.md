# HARNESS.md — argmin-com/extension

Operating doctrine for autonomous and semi-autonomous work on this repo. Mirrors the spirit of `argmin-com/platform`'s harness but scoped to a browser extension: no AWS, no Docker, no Helm, no Kubernetes — just a verifier-gated loop around `npm run verify:all` and the e2e suite, with task state in git.

## Purpose

Enable Claude Code, Codex, AND/OR Gemini CLI to make ongoing, recursive progress against a defined backlog without continuous human supervision. Every cycle is: pick a task → run the worker → verify → commit + push if green → release claim → repeat.

## Worker interchangeability

Claude Code, Codex, and Gemini CLI are interchangeable workers under this harness. The harness owns scheduling, claims, leases, verification, and promotion. Workers receive a task description and a worktree; they generate candidate changes. Whichever model is invoked, the gates are identical.

Pick the worker with `--worker claude|codex|gemini` (default: `claude`).

## Architecture

```
harness/
  HARNESS.md          # this file
  TASKS.md            # the backlog -- one task per heading
  harnessctl.sh       # operator entrypoint
  scripts/
    worker.sh         # one-shot: claim → run → verify → commit
    loop.sh           # repeat worker.sh until no claimable tasks
    claim.sh          # atomic claim with TTL lease
    release.sh        # release claim, optionally mark task complete
    verify.sh         # npm run verify:all + e2e
    invoke-claude.sh  # adapter for Claude Code CLI
    invoke-codex.sh   # adapter for Codex CLI
    invoke-gemini.sh  # adapter for Gemini CLI
    notify.sh         # optional outcome notification hook
  state/
    claims.json       # active claims with PID + timestamp + lease deadline
    runs/             # per-run evidence: stdout, verify output, diff stat
    .gitignore        # state is local; not committed
.github/workflows/
  harness.yml         # nightly cron + manual dispatch
```

## Hard rules

The harness enforces these. A violation aborts the cycle, captures evidence, and surfaces a `needs-review` marker on the task.

1. **Verify is mandatory before commit.** `npm run verify:all` must exit zero. `npm run test:e2e` must pass all specs. No exceptions, no `--no-verify`, no skipping gates. If verify fails, the cycle stops and the working tree changes are stashed under `harness/state/runs/<run-id>/wip.patch`.
2. **One commit per task.** Workers may stage incremental changes during the cycle, but the harness produces a single squashed commit at the end. Atomic.
3. **No force push.** Ever. To main or any other branch. If a push fails because of an upstream update, the cycle rebases and retries verify; if that fails, the cycle aborts.
4. **No destructive operations.** Reset --hard, branch -D, push --delete, rm -rf inside the repo — all blocked. The harness owns only forward-progress operations.
5. **AGENTS.md hard rules are inherited.** No telemetry, no off-device sync, no content capture, no eval, no dynamic Function constructor. Worker output that violates these gets rejected at the verifier.
6. **Lease TTL is honored.** A claim has a 30-minute lease deadline. Stale claims (process gone or deadline passed) are reclaimable. No silent overwriting of active claims.
7. **Single instance per repo.** A repo-level lockfile (`harness/state/repo.lock`) prevents two workers from clobbering each other. Concurrent invocations queue or refuse.
8. **Evidence per run.** Every cycle writes to `harness/state/runs/<timestamp>/`: the task picked, the worker stdout, the verify output, the diff stat, and the final disposition (committed | aborted | needs-review). Local-only — `state/` is gitignored.

## Operator commands

```bash
harness/harnessctl.sh status              # show claims, last 5 runs, queue depth
harness/harnessctl.sh tasks               # list TASKS.md backlog with current status
harness/harnessctl.sh pick <task-slug>    # manually claim a specific task
harness/harnessctl.sh once                # one cycle: pick → run → verify → commit
harness/harnessctl.sh loop                # repeat until no claimable tasks
harness/harnessctl.sh release <task-slug> # release a stuck claim
harness/harnessctl.sh verify              # run gates only (no commit)
```

All commands honor `--worker claude|codex|gemini` (default: `claude`) and `--dry-run` (print what would happen, don't execute).

## Task format

Tasks live in `harness/TASKS.md` as level-2 headings. Each task has:

```markdown
## task-slug

**Status**: pending | claimed | in_progress | completed | needs-review | abandoned
**Owner**: (set by claim)
**Lease**: (ISO timestamp, set by claim)
**Blocked by**: (other task-slugs, optional)
**Created**: (ISO timestamp)

### Description

Plain-language description of what needs to be done. The worker is given
this verbatim. Keep it focused -- one task should produce one commit.

### Acceptance

Bulleted list of what the verifier must see for this task to be considered done.
The verifier doesn't read this -- it only runs `verify:all` + e2e -- but the
worker is told these acceptance criteria and is expected to write tests that
encode them when applicable.
```

## CI integration

`.github/workflows/harness.yml` supports manual dispatch and a guarded nightly
cron. Nightly execution is disabled unless the repo variable
`HARNESS_NIGHTLY_ENABLED` is set to `true`. On a fresh checkout it:

1. Installs deps + Playwright chromium
2. Runs `harness/harnessctl.sh loop --worker codex` (Codex by default in CI; Claude Code CLI is interactive, Gemini CLI is also available via `--worker gemini`)
3. Captures `state/runs/` as a workflow artifact for inspection
4. Pushes successful commits to main (uses `GITHUB_TOKEN` with `contents: write` scope)

Manual dispatch is also enabled — operators can trigger a run from the Actions tab with parameters (worker, task-slug, max-cycles).

## Failure modes and recovery

| Failure | Harness response |
|---|---|
| Worker exits non-zero | Mark task `needs-review`, capture stdout, release claim, move on |
| Verify gate fails | Stash uncommitted changes to `state/runs/<id>/wip.patch`, log failure, release claim, move on |
| Push fails (upstream ahead) | `git pull --rebase`, re-run verify; if green push, else mark `needs-review` |
| Lease expires while running | Worker continues but cannot commit. Cycle marked stale, evidence preserved |
| `npm install` fails | Cycle aborts before any worker invocation; logs npm output, exits non-zero |
| Worker hangs | 60-minute hard timeout per cycle; kill, mark `needs-review` |

## Operating posture

The harness is intended to enable unattended overnight work, not just one-shot operator commands. It does not require permission for every action because the gates (verify, no-force-push, lease, single-instance) are the safety layer. The model of safety is **verifier-owned**: workers generate freely, the verifier rejects unsafe output.

Destructive operations (force-push, history rewrite, branch deletion, secret-bearing edits) are not in the worker's vocabulary. The harness will not invoke them and will fail loudly if a worker attempts them.

## Bootstrapping

```bash
# One-time setup
npm install
npm run test:e2e:install   # Playwright chromium

# Run a single cycle
./harness/harnessctl.sh once

# Run the loop
./harness/harnessctl.sh loop
```

## Differences from argmin-com/platform

- No AWS / Docker / Helm / Terraform — extension ships as zips
- No production promotion gate — extension stores releases as GitHub assets
- Lease TTL is shorter (30m vs 2h) — extension tasks are smaller-grained
- No native control plane (`harnessctl.py`) — shell scripts are sufficient for this scope; Python is overkill
- Verifier surface is the npm scripts (`verify:all`, `test:e2e`) — same gates a human PR has to clear

If extension complexity grows to the point where shell scripts strain, the documented escape hatch is to port `harnessctl.py` from platform and back this with the same Python orchestration runtime.
