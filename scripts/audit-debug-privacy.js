// scripts/audit-debug-privacy.js
// Regression guard: fails if known debug-privacy leaks reappear.
const fs = require('fs');

const contentUtils = fs.readFileSync('content-components/content_utils.js', 'utf8');
const lengthUi = fs.readFileSync('content-components/length_ui.js', 'utf8');

let failed = false;

if (contentUtils.includes('document.title.substring')) {
	console.error('FAIL: content_utils.js still uses document.title in debug sender');
	failed = true;
}

if (lengthUi.includes('Ignoring stale conversation update for')) {
	console.error('FAIL: length_ui.js still logs stale conversation IDs directly');
	failed = true;
}

if (failed) process.exit(1);
console.log('PASS: debug privacy audit checks passed');
