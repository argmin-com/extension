#!/usr/bin/env node
// scripts/check-syntax.js
// Runs `node --check` on every .js file outside lib/, node_modules/, and .git/.
// Fails on the first syntax error.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const skipDirs = new Set(['node_modules', 'lib', '.git', 'web-ext-artifacts', 'playwright-report', 'test-results']);
let failed = false;

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skipDirs.has(entry.name)) continue;
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else if (entry.name.endsWith('.js')) {
			try {
				execSync(`node --check ${JSON.stringify(p)}`, { stdio: 'pipe' });
			} catch (e) {
				console.error(`FAIL: ${p}`);
				console.error(e.stderr ? e.stderr.toString() : e.message);
				failed = true;
			}
		}
	}
}

walk('.');
if (failed) process.exit(1);
console.log('PASS: syntax check on all .js files');
