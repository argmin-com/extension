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

// Enforce CLAUDE.md rule on content-script UI surfaces: any innerHTML assignment
// whose RHS template literal interpolates a non-allowlisted ${...} expression
// fails the build. Content scripts run on AI-platform DOMs and inherit those
// origins' privileges, so this is the high-risk surface.
//
// Allowed shapes for each ${expr}:
//   - escapeHtml(...)            user-controlled, escaped
//   - fmtMoney(...) / fmtPct(...) / fmtNumber(...) / formatX(...)
//   - expressions ending in .toFixed(...), .toLocaleString(...), .toString(...)
//   - expressions starting with Math.*, Number(, parseInt(, parseFloat(, String(
//   - bare numeric literals
// Anything else: prefer textContent / createElement.
//
// popup.js / debug.js render in the extension's own origin and primarily display
// trusted internal state through escapeHtml/fmt* helpers. We log warnings for
// them so regressions stay visible, but don't fail the build pending refactor.
const strictInnerHtmlFiles = fs.readdirSync('content-components')
	.filter(f => f.endsWith('.js'))
	.map(f => `content-components/${f}`);
const warnInnerHtmlFiles = ['popup.js', 'debug.js'];
// Each regex anchors to ^...$ so the WHOLE expression must be a call to a
// safe helper. Prefix-only matching would let payloads be appended, e.g.
// `${escapeHtml(x) + "<img onerror=...>"}`. String() and .toString() are
// excluded because they return the underlying string unchanged and would
// let attacker-controlled HTML through.
function isSafeInterp(expr) {
	const e = expr.trim();
	if (/^escapeHtml\s*\([^)]*\)$/.test(e)) return true;
	if (/^fmt[A-Z]\w*\s*\([^)]*\)$/.test(e)) return true;
	if (/^format[A-Z]\w*\s*\([^)]*\)$/.test(e)) return true;
	if (/^Math\.[a-zA-Z]+\s*\([^)]*\)$/.test(e)) return true;
	if (/^(Number|parseInt|parseFloat)\s*\([^)]*\)$/.test(e)) return true;
	// .toLocaleString on a Number or Date yields a safe locale-formatted
	// string; on a String it would pass content through, but our codebase
	// only chains it off numbers. Anchored to end-of-expression so nothing
	// can be appended after the call.
	if (/\.(toFixed|toLocaleString)\s*\([^)]*\)\s*$/.test(e)) return true;
	if (/^-?\d+(\.\d+)?$/.test(e)) return true;
	return false;
}
function scanInnerHtml(file, mode) {
	if (!fs.existsSync(file)) return;
	const src = fs.readFileSync(file, 'utf8');
	// Define the regex inside the function: a global-flag regex retains
	// `lastIndex` across calls, which would cause subsequent files to be
	// scanned starting from the wrong offset and miss findings.
	const innerHtmlAssignRe = /\.innerHTML\s*=\s*`([^`]*)`/g;
	let match;
	while ((match = innerHtmlAssignRe.exec(src)) !== null) {
		const tmpl = match[1];
		if (!tmpl.includes('${')) continue;
		const interpRe = /\$\{([^}]+)\}/g;
		let interp;
		let unsafe = null;
		while ((interp = interpRe.exec(tmpl)) !== null) {
			if (!isSafeInterp(interp[1])) {
				unsafe = interp[1].trim();
				break;
			}
		}
		if (unsafe) {
			const lineNo = src.slice(0, match.index).split('\n').length;
			const msg = `${file}:${lineNo} innerHTML interpolation \${${unsafe}} not in allowlist`;
			if (mode === 'fail') {
				console.error(`FAIL: ${msg}`);
				failed = true;
			} else {
				console.warn(`WARN: ${msg}`);
			}
		}
	}
}
for (const file of strictInnerHtmlFiles) scanInnerHtml(file, 'fail');
for (const file of warnInnerHtmlFiles) scanInnerHtml(file, 'warn');

if (failed) process.exit(1);
console.log('PASS: debug privacy audit checks passed');
