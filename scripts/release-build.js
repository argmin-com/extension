#!/usr/bin/env node
// scripts/release-build.js
// Build Chrome/Firefox release zips without web-ext, so cutting a release
// doesn't require a network install. Use `npm run release` or
// `node scripts/release-build.js all`.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const requestedTarget = process.argv[2] || 'chrome';

const builds = {
	chrome: 'manifest_chrome.json',
	firefox: 'manifest_firefox.json'
};

if (requestedTarget !== 'all' && !builds[requestedTarget]) {
	console.error(`Unknown target: ${requestedTarget}. Use one of: ${Object.keys(builds).join(', ')}, all`);
	process.exit(1);
}

// Regenerate dataclasses, then verify they are in sync.
require('./build-dataclasses.js');

// Files and directories to include.
const include = [
	'_locales',
	'background.js',
	'bg-components',
	'content-components',
	'debug.html',
	'debug.js',
	'icon128.png',
	'icon512.png',
	'injections',
	'lib',
	'platform-adapters',
	'popup.html',
	'popup.js',
	'shared',
	'theme-init.js',
	'tracker-styles.css',
	'update_patchnotes.txt',
	'LICENSE'
];

function buildTarget(target) {
	const manifestFile = builds[target];
	const manifestPath = path.join(rootDir, manifestFile);
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`${manifestFile} not found in repo root`);
	}

	console.log(`Building ${target} release v${version}...`);

	// Stage in a temp dir.
	const stageDir = path.join(rootDir, 'web-ext-artifacts', `stage-${target}-${version}`);
	fs.rmSync(stageDir, { recursive: true, force: true });
	fs.mkdirSync(stageDir, { recursive: true });

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
}

const targets = requestedTarget === 'all' ? Object.keys(builds) : [requestedTarget];
for (const target of targets) buildTarget(target);

console.log('\nReleasing: see RELEASING.md.');
console.log(`  Recommended:  git tag v${version} && git push origin v${version}`);
console.log('  The Release GitHub Actions workflow will then build, attach the release zips,');
console.log(`  and publish v${version} from the matching CHANGELOG.md section.`);
