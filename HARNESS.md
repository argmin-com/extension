# Orchestration Harness

This repository includes a lightweight verification harness for agent-assisted
work on the AI Cost & Usage Tracker extension. It is a control-plane and
evidence layer, not a fully autonomous runtime. Agents may use it to plan,
verify, and record work, but promotion, push, release, and merge actions still
require explicit operator control.

## Retained Surfaces

- `scripts/run_checks.py` is the executable source of truth for verification.
- `scripts/collect_evidence.py` captures machine-verifiable output under
  `artifacts/evidence/<run_id>/`.
- `scripts/overnight_build.sh` runs the full verification suite once under a
  lock for unattended validation.
- `orchestration/check_registry.yaml` documents the same verification surfaces.
- `config/guardrails.yaml` records blocking and warning-level invariants.
- `.harness/agents/` and `.harness/skills/` provide scoped guidance for agents.

## Verification Levels

Use the narrowest check that proves the change, then expand when the change
touches shared behavior or packaging.

```bash
python3 scripts/run_checks.py quick      # syntax, audit, unit tests, dataclasses, handler count
python3 scripts/run_checks.py release    # Chrome/Firefox zips and Firefox lint
python3 scripts/run_checks.py all        # full harness gate
python3 scripts/collect_evidence.py run-id
```

Release validation builds curated packages from staged runtime files. The
Firefox lint gate treats warnings as failures.

## Browser Manifest Model

- `manifest.json` is the Chrome local-development manifest.
- `manifest_chrome.json` is the Chrome release manifest source.
- `manifest_firefox.json` is the Firefox release manifest source.
- Package scripts write the target manifest into the staged package only; root
  manifests must not be mutated as a side effect of packaging.
- The `world: MAIN` content scripts must remain before content-context scripts
  in every browser manifest.

## Guardrails

The extension must stay fail-open and local-first. Allowed feature-driven
network paths are supported platform session traffic, browser-extension local
assets, opt-in Anthropic token counting, optional Frankfurter currency rates,
and raw GitHub content used for Claude GitHub sync token estimation.

Dynamic HTML rendering must go through audited helpers or DOM APIs. Direct
dynamic `innerHTML` assignments are not acceptable.

## Evidence

Evidence records include the git SHA, timestamp, checked surfaces, status,
captured stdout/stderr, failures, and duration. Evidence files are generated
artifacts and are ignored by Git.

## Agent Use

Domain agents should stay within their declared scopes in `.harness/agents/`.
When a task spans domains, split it or escalate before editing. Reviewers should
run the applicable harness surfaces and block on failed machine checks. No agent
should claim a gate passed without captured command output.
