#!/usr/bin/env node
// scripts/build.js - Cross-platform build script (FIX #15)
// Usage: node scripts/build.js [chrome|firefox|electron|all]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const targets = process.argv[2] || 'all';

// Step 1: Generate ui_dataclasses.js from shared/dataclasses.js
console.log('Building dataclasses...');
require('./build-dataclasses.js');

// Step 2: Build requested targets
const builds = {
	chrome: 'manifest_chrome.json',
	firefox: 'manifest_firefox.json',
	electron: 'manifest_electron.json'
};

const toBuild = targets === 'all' ? Object.keys(builds) : [targets];

for (const target of toBuild) {
	const manifestFile = builds[target];
	if (!manifestFile) {
		console.error(`Unknown target: ${target}`);
		continue;
	}

	const manifestPath = path.join(rootDir, manifestFile);
	if (!fs.existsSync(manifestPath)) {
		console.log(`Skipping ${target}: ${manifestFile} not found`);
		continue;
	}

	console.log(`\nBuilding ${target}...`);

	// Copy manifest
	const destManifest = path.join(rootDir, 'manifest.json');
	fs.copyFileSync(manifestPath, destManifest);

	// Run web-ext build
	try {
		execSync(
			`npx web-ext build --filename "{name}-{version}-${target}.zip" -o --source-dir "${rootDir}"`,
			{ stdio: 'inherit', cwd: rootDir }
		);
		console.log(`${target} build complete.`);
	} catch (e) {
		console.error(`${target} build failed:`, e.message);
	}

	// Clean up
	if (fs.existsSync(destManifest)) fs.unlinkSync(destManifest);
}

console.log('\nAll builds completed.');
