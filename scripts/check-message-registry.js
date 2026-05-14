#!/usr/bin/env node
// CI guard: keep the background message surface intentional.
const fs = require('fs');

const EXPECTED_HANDLER_COUNT = 84;
const src = fs.readFileSync('background.js', 'utf8');
const actual = (src.match(/messageRegistry\.register/g) || []).length;

if (actual !== EXPECTED_HANDLER_COUNT) {
	console.error(
		`FAIL: background.js has ${actual} messageRegistry.register handlers; expected ${EXPECTED_HANDLER_COUNT}. ` +
		'Update scripts/check-message-registry.js if this change is intentional.'
	);
	process.exit(1);
}

console.log(`PASS: messageRegistry.register handler count is ${actual}`);
