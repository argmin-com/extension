// tests/unit/sanitizer.test.js
// Unit tests for the debug sanitizer functions in bg-components/utils.js.
// They live inside a module that imports browser/chrome globals, so we extract
// the functions via a vm sandbox the same way sse-parsers.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../../bg-components/utils.js'), 'utf8');

function extractFn(name) {
	// Each sanitizer function is declared at column 0 and terminated by a `}` at column 0.
	// Avoid brace-counting because the function body contains regex literals with `}` inside
	// character classes (e.g. `[^"',\s}]`) that would confuse a naive depth counter.
	const lines = src.split('\n');
	const startIdx = lines.findIndex(l => l.startsWith(`function ${name}(`));
	assert.ok(startIdx !== -1, `${name} not found`);
	let endIdx = startIdx;
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (lines[i] === '}') { endIdx = i; break; }
	}
	return lines.slice(startIdx, endIdx + 1).join('\n');
}

// Expose the URL constructor; sanitizeStringForDebug uses it to extract origin.
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(extractFn('sanitizeStringForDebug') + '\n' + extractFn('sanitizeForDebug') + '\nthis.sanitizeStringForDebug = sanitizeStringForDebug; this.sanitizeForDebug = sanitizeForDebug;', sandbox);
const { sanitizeStringForDebug: sanitize, sanitizeForDebug: sanitizeObj } = sandbox;

test('non-string input is returned unchanged', () => {
	assert.equal(sanitize(42), 42);
	assert.equal(sanitize(null), null);
	assert.equal(sanitize(undefined), undefined);
});

test('Anthropic sk-ant-* API keys are redacted', () => {
	const s = sanitize('key=sk-ant-api03-AbCdEf123456_test-key-X');
	assert.ok(!s.includes('sk-ant-api03-AbCdEf'));
	assert.ok(s.includes('[redacted-api-key]'));
});

test('OpenAI sk-proj-* API keys are redacted', () => {
	const s = sanitize('Authorization: Bearer sk-proj-abc123def456');
	// Both the Bearer wrapper and the inner key should be redacted; we check the key was scrubbed.
	assert.ok(!s.includes('sk-proj-abc'));
});

test('OpenRouter sk-or-* keys are redacted', () => {
	const s = sanitize('sk-or-v1-aabbcc');
	assert.equal(s, '[redacted-api-key]');
});

test('Bearer tokens of meaningful length are redacted', () => {
	const s = sanitize('Bearer abcdefghijklmnopqrstuvwxyz123');
	assert.ok(s.includes('Bearer [redacted]'));
});

test('short Bearer-like strings are not over-redacted', () => {
	const s = sanitize('Bearer xyz');
	assert.equal(s, 'Bearer xyz');
});

test('full URLs collapse to origin + redacted path', () => {
	const s = sanitize('GET https://claude.ai/api/organizations/abc-123/chat_conversations/def');
	assert.ok(s.includes('https://claude.ai/[redacted-path]'));
	assert.ok(!s.includes('abc-123'));
	assert.ok(!s.includes('chat_conversations'));
});

test('UUIDs are redacted', () => {
	const s = sanitize('conversation 550e8400-e29b-41d4-a716-446655440000 started');
	assert.ok(!s.includes('550e8400'));
	assert.ok(s.includes('[redacted-uuid]'));
});

test('orgId and conversationId labels are redacted', () => {
	const s1 = sanitize('orgId: 12345abc');
	assert.match(s1, /orgId=\[redacted\]/);
	const s2 = sanitize('conversationId="abc-def"');
	assert.match(s2, /conversationId=\[redacted\]/);
});

test('org-prefixed identifiers are redacted', () => {
	const s = sanitize('hello org-abc_123 world');
	assert.match(s, /\[redacted-org-id\]/);
});

test('very long strings get truncated rather than leak content', () => {
	const big = 'x'.repeat(1000);
	const s = sanitize(big);
	assert.match(s, /^\[redacted-long-string:\d+\]$/);
});

test('Error-like values get URL paths redacted via string sanitization', () => {
	// We can't pass a host-realm Error and have `instanceof Error` match in the
	// sandbox realm, so verify the string-path that the Error case ultimately uses.
	const s = sanitize('Error: failed to fetch https://api.anthropic.com/secret');
	assert.ok(!s.includes('/secret'));
	assert.ok(s.includes('[redacted-path]'));
});

test('object sensitive keys are redacted by name', () => {
	const out = sanitizeObj({
		apiKey: 'sk-ant-xxx',
		authorization: 'Bearer xxx',
		cookie: 'session=abc',
		text: 'the prompt text',
		safe: 'visible value'
	});
	assert.equal(out.apiKey, '[redacted]');
	assert.equal(out.authorization, '[redacted]');
	assert.equal(out.cookie, '[redacted]');
	assert.equal(out.text, '[redacted]');
	assert.equal(out.safe, 'visible value');
});

test('nested objects are walked', () => {
	const out = sanitizeObj({ outer: { url: 'https://x.com/secret', value: 1 } });
	assert.equal(out.outer.url, '[redacted]');
	assert.equal(out.outer.value, 1);
});

test('arrays are slice-capped to bound output size', () => {
	const big = Array(100).fill('item');
	const out = sanitizeObj(big);
	assert.ok(out.length <= 20);
});

test('depth is capped to prevent runaway recursion', () => {
	let nested = { v: 'leaf' };
	for (let i = 0; i < 10; i++) nested = { next: nested };
	const out = sanitizeObj(nested);
	let depth = 0;
	let cur = out;
	while (cur && typeof cur === 'object' && cur.next) { cur = cur.next; depth++; }
	assert.ok(depth <= 4, `expected depth cap ~4, got ${depth}`);
});

test('strings without sensitive content pass through unchanged', () => {
	assert.equal(sanitize('hello world'), 'hello world');
	assert.equal(sanitize('count=42 status=ok'), 'count=42 status=ok');
});
