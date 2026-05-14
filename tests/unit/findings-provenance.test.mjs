// tests/unit/findings-provenance.test.mjs
// Coverage for the two pieces of finding provenance:
//   1. every finding produced by optimize-engine has a `platforms` array
//      that aggregates the platforms whose turns contributed
//   2. every finding has a `conversationUrls` array (capped at 10) of
//      sanitized URLs from contributing turns
//
// Tests use the same chrome.storage.local mock pattern as the other
// unit suites (see usage-insights.test.mjs) so the real StoredMap is
// exercised end-to-end.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const storageData = {};
const listeners = new Set();

function clone(value) {
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function storageGet(keys) {
	if (keys == null) return clone(storageData);
	if (typeof keys === 'string') return { [keys]: clone(storageData[keys]) };
	if (Array.isArray(keys)) {
		const out = {};
		for (const key of keys) out[key] = clone(storageData[key]);
		return out;
	}
	const out = {};
	for (const [key, defaultValue] of Object.entries(keys || {})) {
		out[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? clone(storageData[key]) : defaultValue;
	}
	return out;
}

async function storageSet(items) {
	const changes = {};
	for (const [key, value] of Object.entries(items)) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: clone(value) };
		storageData[key] = clone(value);
	}
	for (const listener of listeners) listener(changes, 'local');
}

async function storageRemove(keys) {
	const list = Array.isArray(keys) ? keys : [keys];
	const changes = {};
	for (const key of list) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
		delete storageData[key];
	}
	for (const listener of listeners) listener(changes, 'local');
}

async function storageClear() {
	const changes = {};
	for (const key of Object.keys(storageData)) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
		delete storageData[key];
	}
	for (const listener of listeners) listener(changes, 'local');
}

globalThis.chrome = {
	action: {},
	storage: {
		local: { get: storageGet, set: storageSet, remove: storageRemove, clear: storageClear }
	}
};
globalThis.browser = {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: {
			addListener(listener) { listeners.add(listener); },
			removeListener(listener) { listeners.delete(listener); }
		}
	}
};

const utilsModule = await import('../../bg-components/utils.js');
const sessionModule = await import('../../bg-components/session-tracker.js');
const optimizeModule = await import('../../bg-components/optimize-engine.js');

const { sanitizeConversationUrl } = utilsModule;
const { sessionTracker } = sessionModule;
const { runOptimize } = optimizeModule;

after(() => {
	sessionTracker.turns.destroy();
	sessionTracker.sessionMeta.destroy();
});

async function resetStorage() {
	await storageClear();
}

// Helper: inject synthetic turns directly into the StoredMap. Bypasses
// recordTurn so we can pin timestamps, categories, and URLs precisely.
async function seedTurns(turns) {
	const entries = turns.map((t, i) => [
		`${t.sessionId || 'sess'}:${t.ts || i + 1}`,
		t
	]);
	const existing = await storageGet({ sessionTurns: [] });
	const next = (existing.sessionTurns || []).concat(entries);
	await storageSet({ sessionTurns: next });
}

function baseTurn(overrides = {}) {
	const ts = overrides.ts || Date.now() - 1000 * 60 * 60;
	return {
		ts,
		sessionId: 'sess-1',
		platform: 'claude',
		model: 'Opus',
		category: 'conversation',
		categoryLabel: 'Conversation',
		confidence: 0.9,
		promptHash: 'h',
		promptLength: 200,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUSD: 0.02,
		hadError: false,
		retryOf: null,
		similarity: 0,
		dayKey: new Date(ts).toISOString().slice(0, 10),
		conversationUrl: 'https://claude.ai/chat/conv-1',
		...overrides
	};
}

// ---------- URL sanitizer ----------

test('sanitizeConversationUrl strips query strings and fragments', () => {
	assert.equal(
		sanitizeConversationUrl('https://claude.ai/chat/abc-123?token=secret&user=42#frag'),
		'https://claude.ai/chat/abc-123'
	);
});

test('sanitizeConversationUrl preserves the conversation id path segment', () => {
	// /chat/abc-123 keeps abc-123 even though the query is stripped.
	assert.equal(
		sanitizeConversationUrl('https://chatgpt.com/c/abc-123?model=gpt-5'),
		'https://chatgpt.com/c/abc-123'
	);
});

test('sanitizeConversationUrl rejects non-http(s) and malformed URLs', () => {
	assert.equal(sanitizeConversationUrl('javascript:alert(1)'), null);
	assert.equal(sanitizeConversationUrl('not a url'), null);
	assert.equal(sanitizeConversationUrl(''), null);
	assert.equal(sanitizeConversationUrl(null), null);
	assert.equal(sanitizeConversationUrl(undefined), null);
});

test('sanitizeConversationUrl caps length at 500 chars', () => {
	const long = 'https://example.com/' + 'a'.repeat(1000);
	const out = sanitizeConversationUrl(long);
	assert.ok(out.length <= 500);
});

test('sanitizeConversationUrl trims trailing slash for canonical form', () => {
	assert.equal(
		sanitizeConversationUrl('https://claude.ai/chat/abc-123/'),
		'https://claude.ai/chat/abc-123'
	);
});

// ---------- session-tracker stores sanitized URL ----------

test('sessionTracker.recordTurn sanitizes and stores conversationUrl on the turn', async () => {
	await resetStorage();
	const turn = await sessionTracker.recordTurn({
		platform: 'claude',
		sessionId: 'sess-X',
		promptText: 'help me debug this issue with the tracker, please',
		model: 'Sonnet',
		inputTokens: 100,
		outputTokens: 50,
		costUSD: 0.01,
		conversationUrl: 'https://claude.ai/chat/abc-123?auth=secret-token&u=42#frag'
	});
	assert.ok(turn, 'recordTurn must return a turn');
	assert.equal(turn.conversationUrl, 'https://claude.ai/chat/abc-123');
});

test('sessionTracker.recordTurn drops bad URLs without throwing', async () => {
	await resetStorage();
	const turn = await sessionTracker.recordTurn({
		platform: 'claude',
		sessionId: 'sess-Y',
		promptText: 'classification placeholder text long enough to register',
		model: 'Sonnet',
		conversationUrl: 'javascript:bad()'
	});
	assert.equal(turn.conversationUrl, null);
});

// ---------- optimize-engine emits provenance ----------

test('every finding carries platforms[] and conversationUrls[]', async () => {
	await resetStorage();
	// Synthesize turns that trigger several scanners.
	const now = Date.now();
	const turns = [];
	// Opus on short turns + conversation category => scanOpusOnShort
	// Also dominates conversation share => scanConversationDominant
	for (let i = 0; i < 25; i++) {
		turns.push(baseTurn({
			ts: now - 1000 * 60 * (i + 1),
			sessionId: 'sess-c' + (i % 3),
			platform: i % 2 === 0 ? 'claude' : 'chatgpt',
			model: i % 2 === 0 ? 'Opus' : 'o3',
			category: 'conversation',
			inputTokens: 200,
			outputTokens: 100,
			costUSD: 0.05,
			conversationUrl: i % 2 === 0
				? 'https://claude.ai/chat/c-' + (i % 5)
				: 'https://chatgpt.com/c/g-' + (i % 5)
		}));
	}
	await seedTurns(turns);

	const result = await runOptimize({ period: 'all' });
	assert.ok(result.findings.length > 0, 'expected at least one finding');
	for (const f of result.findings) {
		assert.ok(Array.isArray(f.platforms), `${f.id} missing platforms[]`);
		assert.ok(Array.isArray(f.conversationUrls), `${f.id} missing conversationUrls[]`);
	}
});

test('multi-platform findings aggregate platforms from contributing turns', async () => {
	await resetStorage();
	const now = Date.now();
	const turns = [];
	// Identical (categoryLabel + promptHash) across two platforms and 5 sessions
	for (let i = 0; i < 6; i++) {
		turns.push(baseTurn({
			ts: now - 1000 * 60 * (i + 1),
			sessionId: 'sess-dup-' + i,
			platform: i % 2 === 0 ? 'claude' : 'chatgpt',
			model: 'Sonnet',
			category: 'coding',
			categoryLabel: 'Coding',
			promptHash: 'dup-hash',
			promptLength: 500,
			costUSD: 0.02,
			conversationUrl: i % 2 === 0
				? 'https://claude.ai/chat/d-' + i
				: 'https://chatgpt.com/c/d-' + i
		}));
	}
	await seedTurns(turns);
	const result = await runOptimize({ period: 'all' });
	const dup = result.findings.find(f => f.id.startsWith('dup:'));
	assert.ok(dup, 'expected a duplicate-prompts finding');
	assert.deepEqual(dup.platforms.slice().sort(), ['chatgpt', 'claude']);
	// All URLs should be present (de-duplicated)
	assert.ok(dup.conversationUrls.length >= 2);
});

test('single-platform finding emits a single-entry platforms array', async () => {
	await resetStorage();
	const now = Date.now();
	const turns = [];
	for (let i = 0; i < 6; i++) {
		turns.push(baseTurn({
			ts: now - 1000 * 60 * (i + 1),
			sessionId: 'sess-only-' + i,
			platform: 'claude',
			model: 'Sonnet',
			category: 'coding',
			categoryLabel: 'Coding',
			promptHash: 'solo-hash',
			promptLength: 500,
			costUSD: 0.02,
			conversationUrl: 'https://claude.ai/chat/s-' + i
		}));
	}
	await seedTurns(turns);
	const result = await runOptimize({ period: 'all' });
	const dup = result.findings.find(f => f.id.startsWith('dup:'));
	assert.ok(dup);
	assert.deepEqual(dup.platforms, ['claude']);
});

test('conversationUrls are capped at 10 per finding', async () => {
	await resetStorage();
	const now = Date.now();
	const turns = [];
	// 25 sessions, each with a unique URL, all on the same duplicate prompt
	for (let i = 0; i < 25; i++) {
		turns.push(baseTurn({
			ts: now - 1000 * 60 * (i + 1),
			sessionId: 'sess-cap-' + i,
			platform: 'claude',
			model: 'Sonnet',
			category: 'coding',
			categoryLabel: 'Coding',
			promptHash: 'cap-hash',
			promptLength: 500,
			costUSD: 0.02,
			conversationUrl: 'https://claude.ai/chat/cap-' + i
		}));
	}
	await seedTurns(turns);
	const result = await runOptimize({ period: 'all' });
	const dup = result.findings.find(f => f.id.startsWith('dup:'));
	assert.ok(dup);
	assert.ok(dup.conversationUrls.length <= 10, `expected <= 10, got ${dup.conversationUrls.length}`);
});

test('conversationUrls de-duplicate identical URLs', async () => {
	await resetStorage();
	const now = Date.now();
	const turns = [];
	for (let i = 0; i < 6; i++) {
		turns.push(baseTurn({
			ts: now - 1000 * 60 * (i + 1),
			sessionId: 'sess-d-' + i,
			platform: 'claude',
			model: 'Sonnet',
			category: 'coding',
			categoryLabel: 'Coding',
			promptHash: 'dedupe-hash',
			promptLength: 500,
			costUSD: 0.02,
			conversationUrl: 'https://claude.ai/chat/same'
		}));
	}
	await seedTurns(turns);
	const result = await runOptimize({ period: 'all' });
	const dup = result.findings.find(f => f.id.startsWith('dup:'));
	assert.ok(dup);
	assert.deepEqual(dup.conversationUrls, ['https://claude.ai/chat/same']);
});
