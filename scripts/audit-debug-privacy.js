// scripts/audit-debug-privacy.js
// Regression guard: fails if known debug-privacy leaks reappear.
const fs = require('fs');

const contentUtils = fs.readFileSync('content-components/content_utils.js', 'utf8');
const lengthUi = fs.readFileSync('content-components/length_ui.js', 'utf8');
const bgUtils = fs.readFileSync('bg-components/utils.js', 'utf8');

let failed = false;

// Original checks
if (contentUtils.includes('document.title.substring')) {
	console.error('FAIL: content_utils.js still uses document.title in debug sender');
	failed = true;
}

if (lengthUi.includes('Ignoring stale conversation update for')) {
	console.error('FAIL: length_ui.js still logs stale conversation IDs directly');
	failed = true;
}

// Sanitizer sync check: verify both copies define the same redaction patterns
const bgSanitizer = bgUtils.match(/sk-ant-\[A-Za-z0-9_-\]\+/);
const contentSanitizer = contentUtils.match(/sk-ant-\[A-Za-z0-9_-\]\+/);
if (!bgSanitizer || !contentSanitizer) {
	console.error('FAIL: sanitizeStringForDebug API key pattern missing from bg-components/utils.js or content_utils.js');
	failed = true;
}

// Ensure no raw conversation IDs in log callsites (content scripts)
const contentFiles = [
	'content-components/content_utils.js',
	'content-components/usage_ui.js',
	'content-components/length_ui.js',
	'content-components/smart_ui.js',
	'content-components/platform_content.js',
	'content-components/notification_card.js'
];
for (const file of contentFiles) {
	if (!fs.existsSync(file)) continue;
	const src = fs.readFileSync(file, 'utf8');
	// Check for raw UUID logging (not inside sanitizer definitions or string literals)
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip sanitizer function definitions and comments
		if (line.includes('sanitize') || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
		// Flag direct logging of conversationId variables (not via sanitizer)
		if (/\bLog\b.*\bconversationId\b/.test(line) && !line.includes('sanitize') && !line.includes('[redacted]')) {
			console.error(`FAIL: ${file}:${i + 1} may log raw conversationId: ${line.trim()}`);
			failed = true;
		}
	}
}

// Ensure no eval() or Function() constructor in any JS file
const jsFiles = fs.readdirSync('.', { recursive: true })
	.filter(f => f.endsWith('.js') && !f.includes('lib/') && !f.includes('node_modules/') && !f.includes('scripts/'));
for (const file of jsFiles) {
	const src = fs.readFileSync(file, 'utf8');
	if (/\beval\s*\(/.test(src)) {
		console.error(`FAIL: ${file} contains eval() call`);
		failed = true;
	}
	if (/\bnew\s+Function\s*\(/.test(src)) {
		console.error(`FAIL: ${file} contains new Function() constructor`);
		failed = true;
	}
}

if (failed) process.exit(1);
console.log('PASS: debug privacy audit checks passed');
