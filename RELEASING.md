# Releasing

Cutting a new release is three commands run from a maintainer machine.

## Why isn't this automated by Claude Code on the web?

The hosted Claude Code environment that produced most of the recent
9.x branches can push branches and merge PRs through the GitHub MCP
bridge, but the bridge does not expose the GitHub Releases API and the
git remote returns `HTTP 403` on tag pushes. The two existing
`v9.0.x-audit` tags were created by the maintainer, not by an
automated job. Until we wire up GitHub Actions for releases, the
finalize step is manual.

## Finalize steps

After the version bump and `CHANGELOG.md` entry have landed on `main`:

```bash
# 1. Pull main and verify the version on disk matches what you expect.
git checkout main && git pull
grep '"version"' package.json manifest.json manifest_chrome.json

# 2. Build the dependency-free Chrome zip. Output goes to
#    web-ext-artifacts/ai-cost-usage-tracker-<version>-chrome.zip
#    with manifest.json at the archive root.
npm run release

# 3. Create the tag and the GitHub Release. The CHANGELOG entry for
#    this version is the release body. Substitute <version> for the
#    package.json version, e.g. 9.3.0.
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
gh release create "v${VERSION}" \
	--title "v${VERSION}" \
	--notes-file <(awk -v v="${VERSION}" '
		$0 ~ "^## \\["v"\\]" { p = 1; next }
		p && /^## \[/                 { exit }
		p
	' CHANGELOG.md) \
	"web-ext-artifacts/ai-cost-usage-tracker-${VERSION}-chrome.zip"
```

The `awk` snippet pulls just the section between this version's
heading and the next `##` heading in `CHANGELOG.md`, so the release
notes always match exactly what's in the repo for that version.

If you don't have `gh` installed:

```bash
gh auth login          # one-time
# or use the web UI:
# https://github.com/argmin-com/extension/releases/new?tag=v<version>
# and upload the zip from web-ext-artifacts/ manually.
```

## What gets shipped

The Chrome zip from `npm run release` contains:

- `manifest.json` (Chrome variant, with `version` pinned from
  `package.json`), plus all the runtime files referenced from it.
- `_locales/en/messages.json` so the Chrome Web Store listing
  description and toolbar title come from i18n strings.
- `theme-init.js` (synchronous theme apply, no FOUC).
- `lib/`, `icon128.png`, `icon512.png`, `kofi-button.png`,
  `qol-badge.png`, `update_patchnotes.txt`, `LICENSE`, all the
  `bg-components/`, `content-components/`, `injections/`,
  `platform-adapters/`, `shared/` modules, plus `popup.html`,
  `popup.js`, `debug.html`, `debug.js`, `tracker-styles.css`.

Tests, scripts, and Firefox/Electron variants are excluded.

## Pre-release validation

These are the same gates listed in `CLAUDE.md`. Run them before the
finalize commands above:

```bash
for f in $(find . -name "*.js" -not -path "*/lib/*"); do node --check "$f" || echo "FAIL: $f"; done
npm run audit            # privacy + dataclasses regression
npm test                 # unit tests
grep -c "messageRegistry.register" background.js   # expect: 69
```
