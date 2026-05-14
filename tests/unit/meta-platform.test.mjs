// tests/unit/meta-platform.test.mjs
// Smoke coverage for the Meta AI platform addition.
// Verifies that the platform id, pricing, intercept patterns, model tiers,
// and energy model entries are present and well-formed. These are
// guard-rail checks so a future refactor cannot accidentally drop the
// platform from one of the registries without failing CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// ── Set up a minimal global environment so the bg-components modules can
//    be imported under node --test. utils.js touches chrome.storage,
//    browser.storage, and reads navigator. None of that runs in tests; we
//    only need the shapes to exist so the top-level evaluation does not
//    throw.
globalThis.chrome = globalThis.chrome || {
	action: {},
	storage: {
		local: {
			get: async () => ({}),
			set: async () => {},
			remove: async () => {}
		},
		onChanged: { addListener: () => {}, removeListener: () => {} }
	},
	runtime: { id: 'test-extension-id' }
};
globalThis.browser = globalThis.browser || {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: { addListener: () => {}, removeListener: () => {} }
	},
	cookies: undefined,
	webRequest: { onBeforeSendHeaders: { addListener: () => {} } }
};

const { CONFIG } = await import(path.join(repoRoot, 'bg-components/utils.js'));
const { MODEL_TIERS } = await import(path.join(repoRoot, 'bg-components/decision-engine.js'));
const { MODEL_MAPPING } = await import(path.join(repoRoot, 'bg-components/carbon-energy.js'));
const { PLATFORM_INTERCEPT_PATTERNS } = await import(path.join(repoRoot, 'bg-components/platforms/intercept-patterns.js'));

test('meta: CONFIG.PLATFORMS includes meta with meta.ai hostPatterns', () => {
	const meta = CONFIG.PLATFORMS.meta;
	assert.ok(meta, 'CONFIG.PLATFORMS.meta is missing');
	assert.equal(meta.name, 'Meta AI');
	assert.ok(Array.isArray(meta.hostPatterns));
	assert.ok(meta.hostPatterns.includes('meta.ai'), 'meta.hostPatterns should include "meta.ai"');
	assert.ok(meta.hostPatterns.includes('www.meta.ai'), 'meta.hostPatterns should include "www.meta.ai"');
	assert.match(meta.color, /^#[0-9a-fA-F]{6}$/);
});

test('meta: CONFIG.PRICING.meta lists Llama models and is structurally valid', () => {
	const pricing = CONFIG.PRICING.meta;
	assert.ok(pricing, 'CONFIG.PRICING.meta is missing');
	for (const expected of ['llama-3.3-70b', 'llama-4-scout', 'llama-4-maverick', 'llama-4-behemoth']) {
		assert.ok(pricing[expected], `Expected pricing entry for "${expected}"`);
		assert.equal(typeof pricing[expected].input, 'number', `${expected}.input should be a number`);
		assert.equal(typeof pricing[expected].output, 'number', `${expected}.output should be a number`);
	}
	// Meta AI is a free consumer surface: prices must stay at zero so the
	// user-facing cost totals never report a non-zero figure based on
	// hypothetical partner-API rates.
	for (const [model, entry] of Object.entries(pricing)) {
		assert.equal(entry.input, 0, `${model} input price should be 0 on free consumer surface`);
		assert.equal(entry.output, 0, `${model} output price should be 0 on free consumer surface`);
	}
});

test('meta: intercept-patterns includes a meta.ai pattern under PLATFORM_INTERCEPT_PATTERNS.meta', () => {
	const entry = PLATFORM_INTERCEPT_PATTERNS.meta;
	assert.ok(entry, 'PLATFORM_INTERCEPT_PATTERNS.meta is missing');
	assert.ok(Array.isArray(entry.onBeforeRequest?.urls) && entry.onBeforeRequest.urls.length > 0);
	const allUrls = [...entry.onBeforeRequest.urls, ...(entry.onCompleted?.urls || [])];
	const hasMetaAi = allUrls.some(u => u.includes('meta.ai'));
	assert.ok(hasMetaAi, 'meta intercept patterns must mention meta.ai');
	// Conservative: no catch-all wildcard for the whole host.
	const tooBroad = allUrls.some(u => /\/\*$/.test(u.replace(/^\*:\/\/[^/]+/, '')) && !/\/api\//.test(u));
	assert.equal(tooBroad, false, 'meta patterns should not include a host-root catch-all');
});

test('meta: MODEL_TIERS.meta has at least one Llama entry with a numeric cost', () => {
	const tiers = MODEL_TIERS.meta;
	assert.ok(Array.isArray(tiers) && tiers.length > 0, 'MODEL_TIERS.meta must be a non-empty array');
	for (const t of tiers) {
		assert.equal(typeof t.model, 'string');
		assert.match(t.model, /^llama-/, 'meta tier model names should start with "llama-"');
		assert.equal(typeof t.costPerMTokIn, 'number');
		assert.ok(t.costPerMTokIn >= 0, 'costPerMTokIn must be non-negative');
	}
});

test('meta: MODEL_MAPPING contains Llama parametric entries', () => {
	for (const model of ['llama-3.3-70b', 'llama-4-scout', 'llama-4-maverick', 'llama-4-behemoth']) {
		const entry = MODEL_MAPPING[model];
		assert.ok(entry, `MODEL_MAPPING.${model} is missing`);
		assert.equal(entry.confidence, 'parametric');
		assert.equal(typeof entry.paramBillions, 'number');
		assert.ok(entry.paramBillions > 0);
	}
});
