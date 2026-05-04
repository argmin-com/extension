#!/usr/bin/env node
// scripts/release-build.js
// Build a Chrome release zip without web-ext, so cutting a release
// doesn't require a network install. Use `npm run release` (added to
// package.json) or `node scripts/release-build.js`.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const target = process.argv[2] || 'chrome';

const builds = {
	chrome: 'manifest_chrome.json',
	firefox: 'manifest_firefox.json'
};
const manifestFile = builds[target];
if (!manifestFile) {
	console.error(`Unknown target: ${target}. Use one of: ${Object.keys(builds).join(', ')}`);
	process.exit(1);
}
const manifestPath = path.join(rootDir, manifestFile);
if (!fs.existsSync(manifestPath)) {
	console.error(`${manifestFile} not found in repo root`);
	process.exit(1);
}

console.log(`Building ${target} release v${version}...`);

// Regenerate dataclasses, then verify they are in sync.
require('./build-dataclasses.js');

// Stage in a temp dir.
const stageDir = path.join(rootDir, 'web-ext-artifacts', `stage-${target}-${version}`);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

// Files and directories to include.
const include = [
	'background.js',
	'bg-components',
	'content-components',
	'debug.html',
	'debug.js',
	'icon128.png',
	'icon512.png',
	'injections',
	'kofi-button.png',
	'lib',
	'platform-adapters',
	'popup.html',
	'popup.js',
	'qol-badge.png',
	'shared',
	'tracker-styles.css',
	'update_patchnotes.txt',
	'LICENSE'
];
for (const entry of include) {
	const src = path.join(rootDir, entry);
	const dst = path.join(stageDir, entry);
	if (!fs.existsSync(src)) {
		console.warn(`  skip (missing): ${entry}`);
		continue;
	}
	fs.cpSync(src, dst, { recursive: true });
}

// Per-target manifest with version pinned from package.json.
const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifestObj.version = version;
fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifestObj, null, '\t') + '\n');

// Zip from inside the staging dir so manifest.json sits at the archive
// root. Chrome Web Store and Firefox Add-ons reject packages that have a
// top-level wrapper directory.
const zipName = `ai-cost-usage-tracker-${version}-${target}.zip`;
const zipPath = path.join(rootDir, 'web-ext-artifacts', zipName);
fs.rmSync(zipPath, { force: true });
execSync(`zip -r "${zipPath}" .`, {
	cwd: stageDir,
	stdio: 'inherit'
});

const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`\nBuilt ${zipName} (${sizeMB} MB)`);
console.log(`Path: ${zipPath}`);
console.log('\nTo finalize the release:');
console.log(`  1. git tag v${version} && git push origin v${version}`);
console.log(`  2. Create a GitHub Release for v${version} and attach the zip above.`);
