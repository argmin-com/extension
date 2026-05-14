// tests/unit/copilot-platform.test.mjs
// Smoke tests for the Microsoft Copilot platform integration. These tests
// only assert the shape of the configuration so a future refactor that
// renames or drops a copilot entry breaks the unit suite rather than
// silently shipping a broken integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Minimal chrome/browser shim so utils.js loads cleanly under node --test.
// utils.js reads chrome.storage.local at import time.
globalThis.chrome = globalThis.chrome || {
	action: {},
	storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }
};
globalThis.browser = globalThis.browser || {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: { addListener() {}, removeListener() {} }
	}
};

const { CONFIG } = await import(new URL('../../bg-components/utils.js', import.meta.url).href);
const { MODEL_TIERS } = await import(new URL('../../bg-components/decision-engine.js', import.meta.url).href);
const { PLATFORM_INTERCEPT_PATTERNS } = await import(new URL('../../bg-components/platforms/intercept-patterns.js', import.meta.url).href);

test('CONFIG.PLATFORMS.copilot is registered with the expected shape', () => {
	const cfg = CONFIG.PLATFORMS.copilot;
	assert.ok(cfg, 'CONFIG.PLATFORMS.copilot must be present');
	assert.equal(cfg.name, 'Microsoft Copilot');
	assert.ok(Array.isArray(cfg.hostPatterns), 'hostPatterns must be an array');
	assert.ok(cfg.hostPatterns.includes('copilot.microsoft.com'),
		'copilot host pattern must include copilot.microsoft.com');
	assert.ok(typeof cfg.color === 'string' && cfg.color.startsWith('#'),
		'color must be a hex string');
});

test('CONFIG.PRICING.copilot has at least one model entry with input/output rates', () => {
	const pricing = CONFIG.PRICING.copilot;
	assert.ok(pricing, 'CONFIG.PRICING.copilot must be present');
	const modelNames = Object.keys(pricing);
	assert.ok(modelNames.length > 0, 'at least one copilot model must be priced');
	for (const name of modelNames) {
		const entry = pricing[name];
		assert.ok(typeof entry.input === 'number' && entry.input >= 0,
			`pricing entry ${name} must define input rate`);
		assert.ok(typeof entry.output === 'number' && entry.output >= 0,
			`pricing entry ${name} must define output rate`);
	}
});

test('intercept-patterns includes a copilot.microsoft.com URL pattern', () => {
	const block = PLATFORM_INTERCEPT_PATTERNS.copilot;
	assert.ok(block, 'PLATFORM_INTERCEPT_PATTERNS.copilot must be present');
	const allUrls = [
		...(block.onBeforeRequest?.urls || []),
		...(block.onCompleted?.urls || [])
	];
	assert.ok(
		allUrls.some(u => u.includes('copilot.microsoft.com')),
		'intercept-patterns must include at least one copilot.microsoft.com URL pattern'
	);
	// Verify the patterns target specific endpoint segments rather than a
	// catch-all `/api/` path. Anything that ends with `/api/*` (no further
	// path segment) is a red flag because it would intercept telemetry /
	// sign-in / Office surfaces that have nothing to do with inference.
	for (const url of allUrls) {
		assert.ok(
			!/copilot\.microsoft\.com\/api\/\*$/.test(url),
			`copilot URL pattern must not be a bare /api/ catch-all: ${url}`
		);
	}
});

test('MODEL_TIERS.copilot defines at least one priced tier for recommendations', () => {
	const tiers = MODEL_TIERS.copilot;
	assert.ok(Array.isArray(tiers), 'MODEL_TIERS.copilot must be an array');
	assert.ok(tiers.length > 0, 'MODEL_TIERS.copilot must contain at least one tier');
	for (const entry of tiers) {
		assert.ok(typeof entry.model === 'string', 'each tier must declare a model name');
		assert.ok(['low', 'medium', 'high'].includes(entry.tier),
			`tier entry for ${entry.model} must be low/medium/high`);
		assert.ok(typeof entry.costPerMTokIn === 'number' && entry.costPerMTokIn >= 0,
			`tier entry for ${entry.model} must define costPerMTokIn`);
	}
});

test('copilot models referenced in MODEL_TIERS are priced in CONFIG.PRICING', () => {
	const priced = new Set(Object.keys(CONFIG.PRICING.copilot || {}));
	for (const entry of MODEL_TIERS.copilot) {
		assert.ok(priced.has(entry.model),
			`MODEL_TIERS lists copilot model "${entry.model}" but CONFIG.PRICING.copilot does not price it`);
	}
});

test('stream-token-counter injection registers copilot in host detection', () => {
	const src = fs.readFileSync(
		path.join(repoRoot, 'injections/stream-token-counter.js'),
		'utf8'
	);
	assert.ok(/copilot\.microsoft\.com/.test(src),
		'stream-token-counter.js must reference copilot.microsoft.com');
	assert.ok(/return 'copilot'/.test(src),
		'stream-token-counter.js must return the copilot platform id from hostPlatform()');
	assert.ok(/copilot:\s*\(url\)\s*=>/.test(src),
		'stream-token-counter.js must register a copilot entry in urlMatchers');
});

test('manifest_chrome.json declares copilot host_permissions and content_scripts', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest_chrome.json'), 'utf8'));
	const hosts = new Set(manifest.host_permissions || []);
	assert.ok(hosts.has('*://copilot.microsoft.com/*'),
		'manifest_chrome.json must include the copilot.microsoft.com host permission');
	const contentMatches = new Set();
	for (const script of manifest.content_scripts || []) {
		for (const match of script.matches || []) contentMatches.add(match);
	}
	assert.ok(contentMatches.has('*://copilot.microsoft.com/*'),
		'manifest_chrome.json must include a content_script match for copilot.microsoft.com');
});

test('manifest_firefox.json declares copilot host_permissions and content_scripts', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest_firefox.json'), 'utf8'));
	const hosts = new Set(manifest.host_permissions || []);
	assert.ok(hosts.has('*://copilot.microsoft.com/*'),
		'manifest_firefox.json must include the copilot.microsoft.com host permission');
	const contentMatches = new Set();
	for (const script of manifest.content_scripts || []) {
		for (const match of script.matches || []) contentMatches.add(match);
	}
	assert.ok(contentMatches.has('*://copilot.microsoft.com/*'),
		'manifest_firefox.json must include a content_script match for copilot.microsoft.com');
});
