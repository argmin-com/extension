---
name: build-release
description: "Build scripts, manifest management, and version bumps"
triggers:
  - "scripts/* modified"
  - "manifest.json modified"
  - "manifest_chrome.json modified"
  - "manifest_firefox.json modified"
  - "package.json version field modified"
  - "task mentions build, release, or version bump"
agent: core-engineer
---

# Build and Release Skill

## Context

The extension has no build step for normal development -- plain JS files are
loaded directly by Chrome. Build scripts handle cross-platform packaging
(Chrome/Firefox), dataclass generation, and privacy auditing.

## Key Files

- `scripts/build.js` -- cross-platform build (Chrome/Firefox)
- `scripts/build-dataclasses.js` -- generates ui_dataclasses.js from shared/dataclasses.js
- `scripts/release-build.js` -- release packaging
- `scripts/audit-debug-privacy.js` -- privacy regression guard
- `scripts/check-dataclasses.js` -- verifies dataclass sync
- `manifest.json` -- Chrome local-development manifest
- `manifest_chrome.json` -- Chrome release manifest source
- `manifest_firefox.json` -- Firefox release manifest source
- `package.json` -- version, scripts, dependencies

## Step-by-Step: Version Bump

1. Update `package.json`; it is the release version source of truth.
2. Update root manifests only if local-development metadata must visibly match.
3. Update CHANGELOG.md with release notes.
4. Run all gates:
   ```bash
   python3 scripts/run_checks.py all
   ```
5. Commit with message: "bump version to X.Y.Z"

## Step-by-Step: Modifying shared/dataclasses.js

1. Edit `shared/dataclasses.js` (ES module source).
2. Run `node scripts/build-dataclasses.js` to regenerate
   `content-components/ui_dataclasses.js`.
3. Run `node scripts/check-dataclasses.js` to verify sync.
4. Commit both files together.

## Step-by-Step: Manifest Changes

1. **Read the manifest carefully.** content_scripts order is load-order-sensitive.
2. **world:MAIN entries must come first.** The fetch wrapper must load before
   content scripts that depend on intercepted data.
3. **Update all relevant manifests.** Shared content-script, permission, CSP,
   and host-permission changes normally affect `manifest.json`,
   `manifest_chrome.json`, and `manifest_firefox.json`.
4. **Run syntax check.** Verify manifest is valid JSON:
   ```bash
   node -e "require('./manifest.json')"
   node -e "require('./manifest_chrome.json')"
   node -e "require('./manifest_firefox.json')"
   ```
5. **Run release validation.**
   ```bash
   python3 scripts/run_checks.py release
   ```

## Non-Negotiables

- Manifest content_scripts order must be preserved
- Chrome and Firefox manifest differences must remain explicit and intentional
- Dataclass changes require regeneration and sync check
- Release package versions are written from package.json during staging
