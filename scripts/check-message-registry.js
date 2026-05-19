#!/usr/bin/env node
// CI guard: keep the background message surface intentional.
const fs = require('fs');

// Bump when adding or removing a handler; reflects the intentional surface
// size of the background message API. Last bumped: PR C work-features added
// 5 prompt-template handlers, 2 cross-platform "try elsewhere" handlers,
// and 1 citation-extraction handler (+8 on top of PR B's 90).
const EXPECTED_HANDLER_COUNT = 98;
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
