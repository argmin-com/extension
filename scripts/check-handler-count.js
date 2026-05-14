#!/usr/bin/env node
// scripts/check-handler-count.js
// Guards the documented background.js message handler count. The CLAUDE.md
// validation step says the count should match `messageRegistry.register` calls.
// Updating the expected count here is a deliberate decision documented in PRs,
// not a silent drift.
const fs = require('fs');

const EXPECTED = 71;
const src = fs.readFileSync('background.js', 'utf8');
const matches = src.match(/messageRegistry\.register/g) || [];

if (matches.length !== EXPECTED) {
	console.error(`FAIL: background.js has ${matches.length} messageRegistry.register calls, expected ${EXPECTED}.`);
	console.error('If this is an intentional change, update EXPECTED in scripts/check-handler-count.js and CLAUDE.md.');
	process.exit(1);
}
console.log(`PASS: background.js has ${EXPECTED} message handlers`);
