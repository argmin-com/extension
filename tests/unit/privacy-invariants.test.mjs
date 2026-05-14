// tests/unit/privacy-invariants.test.mjs
// Regression coverage for AGENTS.md hard rule #2: raw prompt text and
// completion text must never enter chrome.storage.local. The repo's
// canonical storage wrapper is StoredMap (bg-components/utils.js), so we
// scan every .set(key, { ... }) call in background-side modules for
// suspicious raw-content fields. This is a textual scan deliberately --
// we want the test to fail on regressions that no other runtime test
// could catch (a prompt body silently added to a persisted object).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// Match raw-content names ONLY when used as a property name (followed by `:`).
// Without the colon anchor, references inside value expressions like
// `String(promptText).slice(...)` would false-positive.
const RAW_CONTENT_KEYS = /\b(promptPreview|promptText|completion|completionText|responseText|messageText|rawPrompt|rawCompletion|page(Title|Url|Content|Dom)?Text)\s*:/;

function listJs(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
}

const targets = [
	path.join(root, 'background.js'),
	...listJs(path.join(root, 'bg-components')),
	...listJs(path.join(root, 'bg-components', 'platforms'))
];

test('StoredMap.set object literals contain no raw-content fields', () => {
	const offenders = [];
	for (const file of targets) {
		if (!fs.existsSync(file)) continue;
		const src = fs.readFileSync(file, 'utf8');
		const setCallRe = /\b(?:[A-Za-z_$][\w$]*)?\.set\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*[,)]/g;
		let m;
		while ((m = setCallRe.exec(src)) !== null) {
			const literal = m[1];
			if (!RAW_CONTENT_KEYS.test(literal)) continue;
			const lineNo = src.slice(0, m.index).split('\n').length;
			offenders.push(`${path.relative(root, file)}:${lineNo} — key ${literal.match(RAW_CONTENT_KEYS)[0]}`);
		}
	}
	assert.deepEqual(offenders, [], `Raw prompt/completion text must stay in-memory only:\n  ${offenders.join('\n  ')}`);
});

test('background.js routes prompt text through in-memory Map, not pendingRequests storage', () => {
	const src = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
	// rememberPendingPromptText/takePendingPromptText must exist and
	// pendingRequests.set must not include promptPreview in its persisted shape.
	assert.match(src, /function rememberPendingPromptText\(/, 'rememberPendingPromptText helper missing');
	assert.match(src, /function takePendingPromptText\(/, 'takePendingPromptText helper missing');

	// Any pendingRequests.set call must not contain promptPreview in its literal.
	const setCallRe = /pendingRequests\.set\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*[,)]/g;
	let m;
	while ((m = setCallRe.exec(src)) !== null) {
		assert.doesNotMatch(m[1], /promptPreview/, `pendingRequests.set literal at offset ${m.index} contains promptPreview`);
	}
});
