// tests/unit/url-sanitizer-roundtrip.test.mjs
//
// v9.7.0 regression guard. Focused, byte-level round-trip assertion
// for sanitizeConversationUrl() in bg-components/utils.js: a URL that
// carries a sensitive query param (e.g. ?token=secret) must come back
// as origin + path only -- no query, no fragment, no trailing slash
// when the path is non-root.
//
// The existing findings-provenance suite covers the broader shape of
// sanitizeConversationUrl (rejects javascript: URIs, caps length,
// strips fragments, trims trailing slash). This file is the narrow
// canary: if the sanitizer ever stops stripping query strings, the
// privacy contract is broken and findings provenance starts leaking
// share tokens, auth tokens, and tracking params into local storage.
// That should fail loudly and on its own row in the test report.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils.js touches browser.storage at import time -- install a no-op
// shim before importing so the module loads cleanly under node --test.
globalThis.chrome = globalThis.chrome || {
	action: {},
	storage: {
		local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
		onChanged: { addListener() {}, removeListener() {} }
	},
	runtime: { id: 'test-extension-id' }
};
globalThis.browser = globalThis.browser || {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: { addListener() {}, removeListener() {} }
	},
	cookies: undefined,
	webRequest: { onBeforeSendHeaders: { addListener: () => {} } }
};

const { sanitizeConversationUrl } = await import(
	new URL('../../bg-components/utils.js', import.meta.url).href
);

test('sanitizeConversationUrl: ?token=secret round-trips as origin + path', () => {
	const input = 'https://claude.ai/chat/abc-123?token=secret';
	const cleaned = sanitizeConversationUrl(input);
	assert.equal(cleaned, 'https://claude.ai/chat/abc-123');

	// Round-trip stability: re-sanitizing the cleaned value yields the
	// same string byte-for-byte.
	assert.equal(sanitizeConversationUrl(cleaned), cleaned);
});

test('sanitizeConversationUrl: query, fragment, and multi-param mixes all collapse to origin+path', () => {
	const variants = [
		'https://chatgpt.com/c/abc-123?model=gpt-5&token=xyz',
		'https://chatgpt.com/c/abc-123#frag',
		'https://chatgpt.com/c/abc-123?model=gpt-5#frag',
		'https://chatgpt.com/c/abc-123?utm_source=twitter&utm_medium=share&token=top-secret-abc'
	];
	for (const v of variants) {
		assert.equal(
			sanitizeConversationUrl(v),
			'https://chatgpt.com/c/abc-123',
			`expected origin+path for ${v}`
		);
	}
});

test('sanitizeConversationUrl: token-bearing URL never leaks the token substring', () => {
	const token = 'leaked-secret-token-do-not-store';
	const input = `https://gemini.google.com/app/chat-id-9?auth=${token}&sid=42`;
	const out = sanitizeConversationUrl(input);
	assert.equal(out, 'https://gemini.google.com/app/chat-id-9');
	assert.ok(!out.includes(token), 'cleaned URL must not contain the auth token substring');
	assert.ok(!out.includes('?'), 'cleaned URL must not contain a query string');
	assert.ok(!out.includes('#'), 'cleaned URL must not contain a fragment');
});
