// tests/unit/cross-platform-router.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildCrossPlatformOpen,
	listCrossPlatformTargets,
	TARGETS,
	MAX_QUERY_PARAM_CHARS
} from '../../bg-components/cross-platform-router.js';

test('returns null for unsupported target', () => {
	assert.equal(buildCrossPlatformOpen('hi', 'totally-bogus'), null);
});

test('open-bare-url when text is empty', () => {
	const r = buildCrossPlatformOpen('', 'chatgpt');
	assert.equal(r.useClipboard, false);
	assert.equal(r.url, TARGETS.chatgpt.url);
});

test('embeds short prompts in query param where supported', () => {
	const r = buildCrossPlatformOpen('what is 2+2?', 'chatgpt');
	assert.equal(r.useClipboard, false);
	const u = new URL(r.url);
	assert.equal(u.searchParams.get('q'), 'what is 2+2?');
});

test('embeds prompt in perplexity ?q=', () => {
	const r = buildCrossPlatformOpen('latest news on rust', 'perplexity');
	assert.equal(r.useClipboard, false);
	const u = new URL(r.url);
	assert.equal(u.searchParams.get('q'), 'latest news on rust');
});

test('embeds prompt in copilot ?q=', () => {
	const r = buildCrossPlatformOpen('debug this', 'copilot');
	const u = new URL(r.url);
	assert.equal(u.searchParams.get('q'), 'debug this');
});

test('falls back to clipboard when target lacks queryParam', () => {
	for (const target of ['claude', 'gemini', 'mistral', 'grok', 'meta']) {
		const r = buildCrossPlatformOpen('explain quantum entanglement', target);
		assert.equal(r.useClipboard, true, `${target} should use clipboard`);
		assert.equal(r.target, target);
	}
});

test('falls back to clipboard when prompt is too long for URL', () => {
	const tooLong = 'x'.repeat(MAX_QUERY_PARAM_CHARS + 1);
	const r = buildCrossPlatformOpen(tooLong, 'chatgpt');
	assert.equal(r.useClipboard, true);
	assert.equal(r.url, TARGETS.chatgpt.url, 'long prompt skips query-param embedding');
});

test('cap applies to ENCODED URL length, not raw char count', () => {
	// A short string of high-codepoint characters expands ~9x under
	// percent-encoding. The raw-length check let these through; the
	// post-encoding check must catch them.
	const expanded = '中'.repeat(800); // 800 CJK chars = 2400 encoded bytes plus URL header
	const r = buildCrossPlatformOpen(expanded, 'chatgpt');
	// Encoded length blows past MAX_QUERY_PARAM_CHARS + base URL
	// length, so the router must fall back to clipboard.
	assert.equal(r.useClipboard, true, 'encoded-length cap should kick in for non-ASCII');
	assert.equal(r.url, TARGETS.chatgpt.url, 'long-after-encoding prompt skips embed');
});

test('listCrossPlatformTargets covers all 8 platforms', () => {
	const targets = listCrossPlatformTargets();
	assert.equal(targets.length, 8);
	for (const expected of ['claude', 'chatgpt', 'gemini', 'mistral', 'perplexity', 'grok', 'meta', 'copilot']) {
		assert.ok(targets.includes(expected), `missing ${expected}`);
	}
});

test('trims whitespace from prompt before considering empty', () => {
	const r = buildCrossPlatformOpen('   \n\t  ', 'chatgpt');
	assert.equal(r.useClipboard, false);
	assert.equal(r.url, TARGETS.chatgpt.url, 'whitespace-only treated as empty');
});

test('URL encoding handles special characters', () => {
	const r = buildCrossPlatformOpen('a&b=c?d#e', 'chatgpt');
	const u = new URL(r.url);
	assert.equal(u.searchParams.get('q'), 'a&b=c?d#e');
});
