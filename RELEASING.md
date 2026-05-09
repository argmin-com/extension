# Releasing

Cutting a release is now a single command from a maintainer machine.
The `Release` GitHub Actions workflow takes over from there.

## Cutting a release

```bash
# 1. Make sure main is green and everything you want is merged.
git checkout main && git pull

# 2. Decide the new version number, bump it everywhere, and write the
#    CHANGELOG entry. The build pulls the version from package.json,
#    so this is the single source of truth.
VERSION=9.4.0
npm version --no-git-tag-version "$VERSION"
# Manually bump version in manifest.json + manifest_chrome.json so the
# source files stay in sync with package.json. (`npm run release` does
# pin the staged manifest, but local "Load unpacked" reads from the
# source manifest, so leaving them stale shows the wrong version in dev.)
# Add a "## [$VERSION] - YYYY-MM-DD" section to CHANGELOG.md.

# 3. Commit, push, merge to main via PR. Once the bump commit is on
#    main, push the tag. The Release workflow runs from there.
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

That's it. The workflow:

1. Checks out the tagged commit.
2. Verifies `package.json` version matches the tag (fails the run if
   they drift).
3. Runs the same validation gates CI runs on PRs (`node --check`,
   `npm run audit`, `npm test`).
4. Runs `npm run release` to produce the Chrome zip.
5. Extracts the matching `## [$VERSION]` section from `CHANGELOG.md`
   as the release notes.
6. Creates the GitHub Release and attaches the zip.

If any step fails, the release is not created, the tag still exists,
and the run is visible in the Actions tab so you can fix and re-run
via the manual `workflow_dispatch` trigger.

## Manual fallback (no Actions available)

If you ever need to skip the workflow:

```bash
VERSION=9.4.0
npm run release
gh release create "v${VERSION}" \
	--title "v${VERSION}" \
	--notes-file <(awk -v v="${VERSION}" '
		$0 ~ "^## \\["v"\\]" { p = 1; next }
		p && /^## \[/         { exit }
		p
	' CHANGELOG.md) \
	"web-ext-artifacts/ai-cost-usage-tracker-${VERSION}-chrome.zip"
```

## Pre-release gates (also enforced by CI)

```bash
find . -name "*.js" -not -path "*/lib/*" -not -path "*/node_modules/*" -exec node --check {} \;
npm run audit            # privacy + dataclasses regression
npm test                 # unit tests
grep -c "messageRegistry.register" background.js   # check against 'expect: N' in CLAUDE.md
```

## What's in the zip

The `npm run release` Chrome zip contains:

- `manifest.json` (Chrome variant, with `version` pinned from
  `package.json`), at the archive root.
- `_locales/en/messages.json` so the Chrome Web Store listing
  description and toolbar title come from i18n strings.
- `theme-init.js` (synchronous theme apply, no FOUC).
- `lib/`, `icon128.png`, `icon512.png`, `kofi-button.png`,
  `qol-badge.png`, `update_patchnotes.txt`, `LICENSE`, all the
  `bg-components/`, `content-components/`, `injections/`,
  `platform-adapters/`, `shared/` modules, plus `popup.html`,
  `popup.js`, `debug.html`, `debug.js`, `tracker-styles.css`.

Tests, scripts, the `.github/` directory, and Firefox/Electron
variants are excluded.
