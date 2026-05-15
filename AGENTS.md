# AGENTS.md: argmin-com/extension

Operating notes for coding assistants (Claude Code, Codex, Gemini CLI, Cursor, Aider, etc.) working in this repo. Keep changes small, privacy-preserving, and verifiable.

## What this is

A **local-first browser extension** (Chrome MV3 + Firefox) that tracks AI cost, token usage, energy, and carbon across Claude, ChatGPT, Gemini, Mistral, Perplexity, and Grok. Plain JavaScript — **no bundler, no transpiler, no framework**. Vendored deps only (see `package.json` `vendoredDependencies`).

Full product summary, permissions matrix, and architecture diagram: [`README.md`](README.md). Privacy policy: [`PRIVACY.md`](PRIVACY.md). Release process: [`RELEASING.md`](RELEASING.md).

## Quick reference

```bash
npm install                        # install dev tooling (Playwright, web-ext)
npm test                           # node --test unit suite
npm run audit                      # privacy + dataclasses + message-registry checks
npm run verify                     # quick gate (syntax + privacy + unit + dataclasses + handlers)
npm run verify:all                 # quick gate + release packages + Firefox lint
npm run test:e2e:install           # one-time Playwright chromium install
npm run test:e2e                   # Playwright end-to-end smoke
node scripts/build-dataclasses.js  # regenerate content-components/ui_dataclasses.js
npm run release:all                # build Chrome + Firefox zips into web-ext-artifacts/
```

## Hard rules — do not violate

1. **Privacy is non-negotiable.** No telemetry, no analytics, no off-device sync. Usage data lives in `browser.storage.local`. The only outbound endpoints permitted are (a) supported AI platform domains, (b) `https://api.anthropic.com/*` — **opt-in only**, user-supplied API key, and (c) `https://api.frankfurter.app/*` for currency conversion. Adding any other host permission requires explicit user-visible disclosure.
2. **No content capture.** Never store prompts, completions, or page DOM content. Token estimation works on counts and shapes, not text bodies.
3. **Sanitize debug logs.** Always route through the sanitizer in `bg-components/utils.js`. Debug logs stay local.
4. **Never block message send.** The decision engine surfaces warnings and recommendations; it must not prevent the user from sending a prompt.
5. **No build tooling.** Do not introduce webpack, vite, rollup, babel, typescript-compiled output, or runtime bundlers. The extension ships exactly what's in the repo, plus vendored libs in `lib/`. New deps must be vendored with source/license noted in `package.json` `vendoredDependencies`.
6. **Manifest discipline.** Edit `manifest_chrome.json` and `manifest_firefox.json` as the canonical sources. `manifest.json` is the local-development manifest. The release script stages versions into packaged manifests — **do not** hand-bump versions inside staged outputs.
7. **Dataclasses are generated.** `content-components/ui_dataclasses.js` is produced from `shared/dataclasses.js` by `scripts/build-dataclasses.js`. Edit the source, then regenerate. `npm run audit` and CI both check this is in sync.
8. **Cross-browser.** Every change must work in both Chrome (MV3 service worker) and Firefox (MV3 event-page). When in doubt, verify with `npm run release:all && npx web-ext lint --source-dir web-ext-artifacts/stage-firefox-<version>`.
9. **Message registry consistency.** Background-side handlers are registered through the `messageRegistry` pattern in `bg-components/utils.js`. `npm run check:handlers` validates the count matches expectations.
10. **No real user data in tests or fixtures.** Tests are local and deterministic.

## Code conventions

- **JS only.** Plain ES modules where supported by MV3; classic scripts in injected content where required. No JSX, no TypeScript source files.
- **Node 22+** for tooling (matches CI `actions/setup-node@v6` with `node-version: '22'`).
- **Tests**: `node --test` for unit (`tests/unit/*.test.mjs`), Playwright for e2e (`tests/e2e/`). New behavior in `bg-components/` should ship with a unit test.
- **Naming**: kebab-case filenames, camelCase exports. Match existing module style.
- **Storage keys**: namespace under platform or feature (e.g. `usage.claude.daily`), to keep migrations tractable.
- Do not pass `--no-verify` or otherwise skip hooks/CI.

## Repository structure

```
background.js                Service worker entry (request interception, storage, messaging)
bg-components/               Service-worker-side modules
  utils.js                     Config, storage helpers, sanitizer, logging, messageRegistry
  claude-api.js                Claude API access + conversation helpers
  tokenManagement.js           Local token counting + optional Anthropic counting
  carbon-energy.js             Energy/carbon/region/methodology
  decision-engine.js           Cost preview, model recs, anomaly, budgets
  decision-orchestrator.js     Unified decision evaluation pipeline
  task-classifier.js           Local prompt classification heuristics
  policy-engine.js             Action policy resolution for decision UI
  event-store.js               Request/session/profile event storage
  platforms/                   Per-platform usage storage, forecasting, calibration
content-components/          Content-script UI (badges, sidebar, decision overlay)
  ui_dataclasses.js          GENERATED — do not edit directly
platform-adapters/           Platform-specific DOM selectors / composer observers
injections/                  Page-context injection (fetch wrap, SSE parsing)
shared/dataclasses.js        Source of truth for ui_dataclasses generation
lib/                         Vendored deps (webextension-polyfill, gpt-tokenizer)
scripts/                     Build, audit, verify, release tooling
tests/unit/                  node --test specs
tests/e2e/                   Playwright specs
manifest.json                Local-dev manifest (Chrome)
manifest_chrome.json         Release manifest source (Chrome)
manifest_firefox.json        Release manifest source (Firefox event-page)
```

## CI gates (`.github/workflows/ci.yml`)

Every PR must pass:

- `node --check` on every `*.js` outside `lib/`, `node_modules/`, `web-ext-artifacts/`
- `npm run audit` (privacy audit + dataclasses freshness + message-registry handler count)
- `npm test` (unit)
- Manifest + locale JSON parses cleanly
- `npm run check:handlers` (handler count parity)
- `npm run release:all` (Chrome + Firefox zips build)
- `web-ext lint --warnings-as-errors` on the staged Firefox package

Reproduce locally with `npm run verify:all`. Don't open a PR until it's green.

## Working agreements

- Edit existing modules before creating new ones — the architecture is intentionally flat under `bg-components/` and `content-components/`.
- Keep `background.js` lean; new logic generally belongs in a `bg-components/` module.
- When adding a host permission, document why in README's permissions table and update `PRIVACY.md`.
- Version bumps go in `package.json`; the release script propagates into staged manifests.
- See [`CHANGELOG.md`](CHANGELOG.md) for prior-release context before non-trivial changes.

## Tool-specific notes

- **Claude Code** auto-loads `CLAUDE.md`, which points back to this file. Project-level review/PR-comment workflows already run via `.github/workflows/claude.yml` and `.github/workflows/claude-code-review.yml`.
- **Gemini CLI** auto-loads `GEMINI.md`, which points back to this file. Project-level settings live in `.gemini/settings.json`.
- **Codex** reads `.codex/instructions.md`, which points back to this file.
- **Cursor, Aider, Continue** — read this file directly; it is the single source of truth.

## Harness invocation patterns

All three supported harness runtimes share the same contract: receive a task description file, produce changes in the working tree, exit zero on success or non-zero on failure. The harness verifier (`npm run verify:all` + `npm run test:e2e`) gates promotion regardless of which runtime runs.

```bash
# Claude Code (non-interactive print mode)
claude --dangerously-skip-permissions --print "<prompt>"

# Codex (non-interactive exec mode)
codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"

# Gemini CLI (headless mode)
gemini -p "<prompt>" --yolo --output-format json
```

See `harness/scripts/invoke-claude.sh`, `invoke-codex.sh`, and `invoke-gemini.sh` for the full adapter implementations.
