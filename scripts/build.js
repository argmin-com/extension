#!/usr/bin/env node
// scripts/build.js - Cross-platform build script (FIX #15)
// Usage: node scripts/build.js [chrome|firefox|electron|all]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const targets = process.argv[2] || 'all';

// package.json version is the single source of truth for extension version.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

// Step 1: Generate ui_dataclasses.js from shared/dataclasses.js
console.log('Building dataclasses...');
require('./build-dataclasses.js');

// Step 2: Build requested targets
const builds = {
	chrome: 'manifest_chrome.json',
	firefox: 'manifest_firefox.json',
	electron: 'manifest_electron.json'
};

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
	'kofi-button.png',
	'lib',
	'platform-adapters',
	'popup.html',
	'popup.js',
	'qol-badge.png',
	'shared',
	'theme-init.js',
	'tracker-styles.css',
	'update_patchnotes.txt',
	'LICENSE'
];

const toBuild = targets === 'all' ? Object.keys(builds) : [targets];
let failed = false;

for (const target of toBuild) {
	const manifestFile = builds[target];
	if (!manifestFile) {
		console.error(`Unknown target: ${target}`);
		failed = true;
		continue;
	}

	const manifestPath = path.join(rootDir, manifestFile);
	if (!fs.existsSync(manifestPath)) {
		const message = `Skipping ${target}: ${manifestFile} not found`;
		if (targets === 'all') console.log(message);
		else {
			console.error(message);
			failed = true;
		}
		continue;
	}

	console.log(`\nBuilding ${target}...`);

	const stageDir = path.join(rootDir, 'web-ext-artifacts', `webext-stage-${target}-${pkgVersion}`);
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
	manifestObj.version = pkgVersion;
	fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifestObj, null, '\t') + '\n');

	// Run web-ext build
	try {
		execSync(
			`npx web-ext build --filename "{name}-{version}-${target}.zip" -o --source-dir "${stageDir}" --artifacts-dir "${path.join(rootDir, 'web-ext-artifacts')}"`,
			{ stdio: 'inherit', cwd: rootDir }
		);
		console.log(`${target} build complete.`);
	} catch (e) {
		console.error(`${target} build failed:`, e.message);
		failed = true;
	}
}

if (failed) {
	console.error('\nOne or more builds failed.');
	process.exit(1);
}

console.log('\nAll builds completed.');
