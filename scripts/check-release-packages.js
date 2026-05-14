#!/usr/bin/env node
// Verify generated release zips are installable browser-extension packages.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const targets = ['chrome', 'firefox'];
const forbidden = [
	/^stage-[^/]+\//,
	/^\.harness\//,
	/^orchestration\//,
	/^AGENTS\.md$/,
	/^CLAUDE\.md$/,
	/^HARNESS\.md$/,
	/^PRD\.md$/,
	/^config\/guardrails\.yaml$/,
	/^scripts\/collect_evidence\.py$/,
	/^scripts\/overnight_build\.sh$/,
	/^scripts\/build\.js$/,
	/^content-components\/electron_receiver\.js$/,
	/^injections\/webrequest-polyfill\.js$/,
	/^kofi-button\.png$/,
	/^qol-badge\.png$/,
];

function zipEntries(zipPath) {
	return runUnzip(['-Z1', zipPath]).split('\n').filter(Boolean);
}

function zipFile(zipPath, file) {
	return runUnzip(['-p', zipPath, file]);
}

function runUnzip(args) {
	const result = spawnSync('unzip', args, { encoding: 'utf8' });
	// Some sandboxed Node 24 builds set result.error=EPERM even when unzip
	// exits zero and stdout is complete. Treat the process exit status as
	// authoritative and only fail when unzip itself failed.
	if (result.status === 0) return result.stdout || '';
	if (result.error) throw result.error;
	throw new Error(`unzip ${args.join(' ')} failed with status ${result.status}: ${result.stderr || ''}`);
}

for (const target of targets) {
	const zipPath = path.join('web-ext-artifacts', `ai-cost-usage-tracker-${version}-${target}.zip`);
	if (!fs.existsSync(zipPath)) {
		console.error(`FAIL: missing ${zipPath}`);
		process.exit(1);
	}

	const entries = zipEntries(zipPath);
	if (!entries.includes('manifest.json')) {
		console.error(`FAIL: ${zipPath} is missing root manifest.json`);
		process.exit(1);
	}

	const badEntry = entries.find(entry => forbidden.some(pattern => pattern.test(entry)));
	if (badEntry) {
		console.error(`FAIL: ${zipPath} contains non-release artifact ${badEntry}`);
		process.exit(1);
	}

	const manifest = JSON.parse(zipFile(zipPath, 'manifest.json'));
	if (manifest.version !== version) {
		console.error(`FAIL: ${zipPath} manifest version ${manifest.version} does not match package ${version}`);
		process.exit(1);
	}
	if (manifest.author !== 'Argmin') {
		console.error(`FAIL: ${zipPath} manifest author is ${manifest.author}`);
		process.exit(1);
	}
	if (target === 'chrome' && !manifest.background?.service_worker) {
		console.error(`FAIL: ${zipPath} does not use Chrome service_worker background`);
		process.exit(1);
	}
	if (target === 'firefox' && !Array.isArray(manifest.background?.scripts)) {
		console.error(`FAIL: ${zipPath} does not use Firefox background scripts`);
		process.exit(1);
	}
}

console.log(`PASS: release packages are valid for ${version}`);
