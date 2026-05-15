This repository's agent guidance lives in `AGENTS.md` at the repo root — a single source of truth shared across Claude Code, Codex, Gemini CLI, Cursor, Aider, and other agentic CLIs.

Read `AGENTS.md` before making changes. Highlights:

- **Local-first, privacy-preserving Chrome MV3 + Firefox extension.** No telemetry, no analytics, no off-device sync.
- **No build tooling** — plain JS, vendored deps only.
- **Verify before opening a PR**: `npm run verify:all`.

For product, permissions, and architecture context, see `README.md` and `PRIVACY.md`.
