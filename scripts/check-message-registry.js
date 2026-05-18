#!/usr/bin/env node
// CI guard: keep the background message surface intentional.
const fs = require('fs');

// Bump when adding or removing a handler; reflects the intentional surface
// size of the background message API. Last bumped: PR B work-features
// added `{get,set}DailyDigestSettings` and `{get,set}SensitiveScannerSettings`
// (+4 on top of PR A's +2).
const EXPECTED_HANDLER_COUNT = 90;
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
