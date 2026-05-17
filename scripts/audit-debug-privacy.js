// scripts/audit-debug-privacy.js
// Regression guard: fails if known debug-privacy leaks reappear.
const fs = require('fs');

const contentUtils = fs.readFileSync('content-components/content_utils.js', 'utf8');
const lengthUi = fs.readFileSync('content-components/length_ui.js', 'utf8');
const bgUtils = fs.readFileSync('bg-components/utils.js', 'utf8');
const streamCounter = fs.readFileSync('injections/stream-token-counter.js', 'utf8');

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

if (/dispatchOutput\(([^;]+)\);\s*dispatchOutput\(\1\);/.test(streamCounter)) {
	console.error('FAIL: stream-token-counter.js contains duplicate adjacent output dispatches');
	failed = true;
}

if (/document\.documentElement\.dataset\.aiTrackerNonce\s*=/.test(contentUtils)) {
	console.error('FAIL: content_utils.js must not persist the tracker event nonce on documentElement.dataset');
	failed = true;
}

// Sanitizer sync check: verify both copies define the same redaction patterns
const bgSanitizer = bgUtils.match(/sk-ant-\[A-Za-z0-9_-\]\+/);
const contentSanitizer = contentUtils.match(/sk-ant-\[A-Za-z0-9_-\]\+/);
if (!bgSanitizer || !contentSanitizer) {
	console.error('FAIL: sanitizeStringForDebug API key pattern missing from bg-components/utils.js or content_utils.js');
	failed = true;
}

// UI-helper parity: popup.js and content_utils.js each define their own
// escapeHtml + replaceInnerHtml because they live in separate JS realms
// (extension page vs content script). If one realm drops a helper or
// renames it, audit-allowlisted call sites in that realm silently break.
// Require both helpers to exist in both files.
const popupSrc = fs.readFileSync('popup.js', 'utf8');
for (const helper of ['escapeHtml', 'replaceInnerHtml']) {
	const re = new RegExp(`function\\s+${helper}\\s*\\(`);
	if (!re.test(popupSrc)) {
		console.error(`FAIL: popup.js is missing the ${helper} helper`);
		failed = true;
	}
	if (!re.test(contentUtils)) {
		console.error(`FAIL: content-components/content_utils.js is missing the ${helper} helper`);
		failed = true;
	}
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
	.filter(f => f.endsWith('.js')
		&& !f.includes('lib/')
		&& !f.includes('node_modules/')
		&& !f.includes('scripts/')
		&& !f.includes('web-ext-artifacts/')
		&& !f.includes('playwright-report/')
		&& !f.includes('test-results/'));
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

// Privacy regression guard: AGENTS.md hard rule #2 says raw prompt text,
// completions, and page DOM content must never reach chrome.storage.local.
// `StoredMap` is the canonical wrapper around chrome.storage.local in this
// codebase; any value-shape we persist there must be free of suspicious raw
// content fields (promptPreview, promptText, completion, responseText, etc.).
//
// We scan every background-side module for object literals passed to a
// StoredMap.set call. If a literal contains a key matching the deny-list
// AND the value is not an obvious hash/length/category, we fail.
const STORED_MAP_FILES = [
	'background.js',
	...fs.readdirSync('bg-components').filter(f => f.endsWith('.js')).map(f => `bg-components/${f}`),
	...(fs.existsSync('bg-components/platforms')
		? fs.readdirSync('bg-components/platforms').filter(f => f.endsWith('.js')).map(f => `bg-components/platforms/${f}`)
		: [])
];
// Match raw-content names only when used as object property names (`name:`).
// Without the colon anchor, references inside value expressions would
// false-positive (e.g. `String(promptText).slice(...)` inside an in-memory
// Map.set is fine).
const RAW_CONTENT_KEYS = /\b(promptPreview|promptText|completion|completionText|responseText|messageText|rawPrompt|rawCompletion|page(Title|Url|Content|Dom)?Text)\s*:/;
for (const file of STORED_MAP_FILES) {
	if (!fs.existsSync(file)) continue;
	const src = fs.readFileSync(file, 'utf8');
	// Match `<map>.set(<key>, {<literal>})` and grab the object literal text.
	const setCallRe = /\b(?:[A-Za-z_$][\w$]*)?\.set\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*[,)]/g;
	let m;
	while ((m = setCallRe.exec(src)) !== null) {
		const literal = m[1];
		if (!RAW_CONTENT_KEYS.test(literal)) continue;
		const lineNo = src.slice(0, m.index).split('\n').length;
		console.error(`FAIL: ${file}:${lineNo} StoredMap.set object literal contains a raw-content key (${literal.match(RAW_CONTENT_KEYS)[0]}). Hold prompt/completion text in an in-memory Map only.`);
		failed = true;
	}
}

// Enforce the repository UI-safety rule: any HTML-rendering call whose
// template literal interpolates a non-allowlisted ${...} expression fails
// the build. Strict mode covers content-components (run on AI-platform DOMs)
// and the extension's own popup/debug pages (render trusted internal state
// but should not regress).
//
// Allowed shapes for each ${expr}:
//   - escapeHtml(...)            user-controlled, escaped
//   - fmtMoney(...) / fmtPct(...) / fmtNumber(...) / formatX(...)
//   - expressions starting with Math.*, Number(, parseInt(, parseFloat(
//   - expressions ending in .toFixed(...), .toLocaleString(...)
//   - bare numeric literals
// Anything else: prefer textContent / createElement.
const strictInnerHtmlFiles = [
	...fs.readdirSync('content-components')
		.filter(f => f.endsWith('.js'))
		.map(f => `content-components/${f}`),
	'popup.js',
	'debug.js'
];
const warnInnerHtmlFiles = [];
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
	const htmlRenderRe = /(?:\.innerHTML\s*=\s*|replaceInnerHtml\s*\([^,]+,\s*)`([^`]*)`/g;
	let match;
	while ((match = htmlRenderRe.exec(src)) !== null) {
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
			const msg = `${file}:${lineNo} HTML interpolation \${${unsafe}} not in allowlist`;
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

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function auditManifest(file, target) {
	if (!fs.existsSync(file)) {
		console.error(`FAIL: ${file} is required for ${target} packaging`);
		failed = true;
		return;
	}
	const manifest = readJson(file);
	if (target === 'chrome') {
		if (!manifest.background?.service_worker) {
			console.error(`FAIL: ${file} must use background.service_worker for Chrome MV3`);
			failed = true;
		}
		if (manifest.background?.scripts) {
			console.error(`FAIL: ${file} must not use background.scripts for Chrome MV3`);
			failed = true;
		}
		if (manifest.browser_specific_settings) {
			console.error(`FAIL: ${file} must not include Firefox-specific browser_specific_settings`);
			failed = true;
		}
	}
	if (target === 'firefox') {
		if (!Array.isArray(manifest.background?.scripts)) {
			console.error(`FAIL: ${file} must use background.scripts for Firefox MV3`);
			failed = true;
		}
		if (manifest.background?.service_worker) {
			console.error(`FAIL: ${file} must not use background.service_worker; Firefox MV3 does not support it`);
			failed = true;
		}
		if (!manifest.browser_specific_settings?.gecko?.id) {
			console.error(`FAIL: ${file} must include browser_specific_settings.gecko.id`);
			failed = true;
		}
		const dataPermissions = manifest.browser_specific_settings?.gecko?.data_collection_permissions;
		if (!dataPermissions?.required?.includes('none')) {
			console.error(`FAIL: ${file} must disclose no required external data collection for Firefox`);
			failed = true;
		}
		for (const optionalType of ['authenticationInfo', 'personalCommunications', 'websiteContent']) {
			if (!dataPermissions?.optional?.includes(optionalType)) {
				console.error(`FAIL: ${file} must disclose optional Firefox data collection type ${optionalType}`);
				failed = true;
			}
		}
		if (manifest.incognito) {
			console.error(`FAIL: ${file} must not include Chrome-only incognito mode settings`);
			failed = true;
		}
	}

	const policy = manifest.content_security_policy?.extension_pages || '';
	const scriptSrc = policy.split(';')
		.map(part => part.trim())
		.find(part => part.startsWith('script-src')) || '';
	if (/\bhttps?:/i.test(scriptSrc) || scriptSrc.includes("'unsafe-eval'")) {
		console.error(`FAIL: ${file} extension_pages script-src must not allow remote code or unsafe eval`);
		failed = true;
	}

	const hosts = new Set(manifest.host_permissions || []);
	for (const requiredHost of [
		'https://api.anthropic.com/*',
		'https://raw.githubusercontent.com/*',
		'https://api.frankfurter.app/*'
	]) {
		if (!hosts.has(requiredHost)) {
			console.error(`FAIL: ${file} missing documented host permission ${requiredHost}`);
			failed = true;
		}
	}
}

auditManifest('manifest_chrome.json', 'chrome');
auditManifest('manifest_firefox.json', 'firefox');

if (failed) process.exit(1);
console.log('PASS: debug privacy audit checks passed');
